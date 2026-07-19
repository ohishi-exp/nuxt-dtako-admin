/**
 * 一番星売上 (rust-ichibanboshi `/api/sales/vehicle-daily`、`/api/ichiban/*` proxy 経由)
 * との突合ロジック (Refs #330 PR4)。
 *
 * 積地・卸地の突合キーは `origin_area_name`/`dest_area_name` (地域ﾏｽﾀ由来、市区町村
 * レベルまで届く) を優先し、空なら `origin`/`dest` (発地N/着地N、自由入力) にフォール
 * バックする (rust-ichibanboshi#76 の設計、issue #330 コメント参照)。
 */

// --- API レスポンス (snake_case) → クライアント側の型 (camelCase) ---

export interface VehicleDailyApiRow {
  sale_date: string
  vehicle_number: string
  customer_code: string
  customer_name: string
  origin_area_name: string
  dest_area_name: string
  origin: string
  dest: string
  is_subcontracted: boolean
  amount: number
  /** 品名C。rust-ichibanboshi#78 未デプロイの間は応答に含まれずundefinedになりうる。 */
  item_code?: string
  /** 品名N。同一日でも複数明細で単価が異なりうるため、突合の妥当性判断に使う。 */
  item_name?: string
  quantity?: number
  unit_price?: number
  unit?: string
  row_id: string
}

export interface VehicleDailySlip {
  saleDate: string
  vehicleNumber: string
  customerCode: string
  customerName: string
  originAreaName: string
  destAreaName: string
  origin: string
  dest: string
  isSubcontracted: boolean
  amount: number
  itemCode: string
  itemName: string
  quantity: number
  unitPrice: number
  unit: string
  rowId: string
}

export function mapVehicleDailyApiRow(row: VehicleDailyApiRow): VehicleDailySlip {
  return {
    saleDate: row.sale_date,
    vehicleNumber: row.vehicle_number,
    customerCode: row.customer_code,
    customerName: row.customer_name,
    originAreaName: row.origin_area_name,
    destAreaName: row.dest_area_name,
    origin: row.origin,
    dest: row.dest,
    isSubcontracted: row.is_subcontracted,
    amount: row.amount,
    itemCode: row.item_code ?? '',
    itemName: row.item_name ?? '',
    quantity: row.quantity ?? 0,
    unitPrice: row.unit_price ?? 0,
    unit: row.unit ?? '',
    rowId: row.row_id,
  }
}

// --- 選択区間 (epoch秒、JST壁時計をそのまま読む net780/event-data-table と同じ規約) →
//     API の from/to (YYYY-MM-DD、半開区間) ---

function epochToYmd(ts: number): string {
  const d = new Date(ts * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const ONE_DAY_SECONDS = 24 * 60 * 60

/**
 * vehicle-daily API の `from`/`to` (半開区間、`to` は含まない) を選択区間の
 * epoch 秒レンジから算出する。`toTs` の翌日を `to` にすることで `toTs` 当日分まで含める。
 */
export function vehicleDailyDateRange(fromTs: number, toTs: number): { from: string, to: string } {
  return {
    from: epochToYmd(fromTs),
    to: epochToYmd(toTs + ONE_DAY_SECONDS),
  }
}

// --- 地名突合 (NFKC正規化 + 部分一致) ---

export type LocationMatchLevel = 'exact' | 'partial' | 'none'

/**
 * API 応答は境界を越えるため `string` 型注釈があっても実際には null/undefined が
 * 来うる (rust-ichibanboshi の未マージフィールドで実際に発生、Refs #330)。
 */
export function normalizeLocationName(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').trim()
}

/**
 * dtako の市町村名と一番星側の地名を突合する。どちらかが空文字なら判定不能 (`none`)。
 * 完全一致 (正規化後) は `exact`、どちらかがもう片方を部分文字列として含むなら
 * `partial` (dtako「北九州市」⊂ 一番星「福岡県北九州市」等)。
 */
export function matchLocationLevel(dtakoName: string | null | undefined, ichibanName: string | null | undefined): LocationMatchLevel {
  const a = normalizeLocationName(dtakoName)
  const b = normalizeLocationName(ichibanName)
  if (!a || !b) return 'none'
  if (a === b) return 'exact'
  if (a.includes(b) || b.includes(a)) return 'partial'
  return 'none'
}

/** `origin_area_name` (地域ﾏｽﾀ由来) を優先し、空文字なら `origin` (発地N) で判定する。 */
function bestMatch(dtakoName: string, areaName: string, freeText: string): LocationMatchLevel {
  const primary = matchLocationLevel(dtakoName, areaName)
  if (primary !== 'none') return primary
  return matchLocationLevel(dtakoName, freeText)
}

export interface ScoredVehicleDailySlip {
  slip: VehicleDailySlip
  originMatch: LocationMatchLevel
  destMatch: LocationMatchLevel
  /** exact=2 / partial=1 / none=0 を積地・卸地で合算 (0〜4)。ソート用。 */
  score: number
  /** 積地・卸地の両方が none でない (= 何らかの根拠がある) 場合に自動チェック候補にする。 */
  suggested: boolean
}

const MATCH_LEVEL_SCORE: Record<LocationMatchLevel, number> = { exact: 2, partial: 1, none: 0 }

/**
 * 伝票候補を dtako 側の積地・卸地でスコアリングし、スコア降順に並べる
 * (同スコアは元の並び順を維持、`Array.prototype.sort` の安定ソートに依存)。
 */
export function scoreVehicleDailySlips(
  originCity: string,
  destCity: string,
  slips: VehicleDailySlip[],
): ScoredVehicleDailySlip[] {
  return slips
    .map((slip) => {
      const originMatch = bestMatch(originCity, slip.originAreaName, slip.origin)
      const destMatch = bestMatch(destCity, slip.destAreaName, slip.dest)
      return {
        slip,
        originMatch,
        destMatch,
        score: MATCH_LEVEL_SCORE[originMatch] + MATCH_LEVEL_SCORE[destMatch],
        suggested: originMatch !== 'none' && destMatch !== 'none',
      }
    })
    .sort((a, b) => b.score - a.score)
}

// --- 効率指標 (円/km・円/時間) ---

export interface ProfitEfficiency {
  yenPerKm: number | null
  /** 拘束ベース (選択区間の総時間、分)。 */
  yenPerHourBound: number | null
  /** 運転ベース (運転区分のみの時間、分)。 */
  yenPerHourDrive: number | null
}

/** ゼロ除算を避けるため分母が 0 以下の指標は null にする。 */
export function calcProfitEfficiency(
  confirmedAmount: number,
  distanceKm: number,
  boundMin: number,
  driveMin: number,
): ProfitEfficiency {
  return {
    yenPerKm: distanceKm > 0 ? confirmedAmount / distanceKm : null,
    yenPerHourBound: boundMin > 0 ? confirmedAmount / (boundMin / 60) : null,
    yenPerHourDrive: driveMin > 0 ? confirmedAmount / (driveMin / 60) : null,
  }
}

// --- fetch ---

/**
 * `/api/ichiban/api/sales/vehicle-daily` (proxy 経由、CF Access は server route 側で付与) を叩く。
 * proxy (`server/api/ichiban/[...path].get.ts`) はパスをそのまま upstream に転送する thin
 * passthrough で、rust-ichibanboshi 側の実エンドポイントは axum で `/api` 配下に nest されて
 * いる (`/api/sales/vehicle-daily`) ため、client 側も `api/` を含めて呼ぶ必要がある。
 */
export async function fetchVehicleDailySlips(
  vehicle: string,
  from: string,
  to: string,
): Promise<VehicleDailySlip[]> {
  const res = await $fetch<{ source_table: string, data: VehicleDailyApiRow[] }>(
    '/api/ichiban/api/sales/vehicle-daily',
    { query: { vehicle, from, to } },
  )
  return res.data.map(mapVehicleDailyApiRow)
}
