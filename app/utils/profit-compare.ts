/**
 * 類似運行検索・比較ページ (`/profit/compare`、Refs #330 PR5) の pure ロジック。
 *
 * 一番星をインデックスに使う設計 (#198・issue #330 本文): まず一番星で伝票を検索し
 * (車番, 売上年月日) を確定してから、その分だけ dtako 運行 (rust-alc-api
 * `/api/operations`) とイベントCSVを引く。ネットワーク呼び出し (伝票検索・運行検索・
 * CSV取得) はページ側の async 処理に任せ、ここでは純粋な組み立て・変換のみを担う。
 */
import type { VehicleDailySlip } from './ichiban'
import { calcProfitEfficiency, epochToYmd, type ProfitEfficiency } from './ichiban'
import type { SelectedRowsSummary } from './event-data-table'
import type { ProfitSnapshot } from './profit-r2'
import type { OperationListItem } from '~/types'

// --- 伝票のグルーピング (車番+売上年月日、同日複数伝票は運行に集約) ---

export interface SlipGroup {
  vehicleNumber: string
  saleDate: string
  customerName: string
  originLabel: string
  destLabel: string
  /** グループ内の伝票金額合計 (税抜)。 */
  amount: number
  rowIds: string[]
}

/**
 * 車番+売上年月日で伝票をグルーピングし、同日複数伝票は運行 (=グループ) に集約する
 * (#198 で決定済みの紐付けキー)。得意先名・積地・卸地ラベルはグループ内で最初に
 * 出現した伝票の値を代表として使う (表示用途、按分はしない設計)。
 */
export function groupSlipsByVehicleDate(slips: VehicleDailySlip[]): SlipGroup[] {
  const map = new Map<string, SlipGroup>()
  for (const slip of slips) {
    const key = `${slip.vehicleNumber} ${slip.saleDate}`
    let group = map.get(key)
    if (!group) {
      group = {
        vehicleNumber: slip.vehicleNumber,
        saleDate: slip.saleDate,
        customerName: slip.customerName,
        originLabel: slip.originAreaName || slip.origin,
        destLabel: slip.destAreaName || slip.dest,
        amount: 0,
        rowIds: [],
      }
      map.set(key, group)
    }
    group.amount += slip.amount
    group.rowIds.push(slip.rowId)
  }
  return [...map.values()]
}

// --- dtako 運行検索の日付レンジ・候補選定 ---

/** `YYYY-MM-DD` を UTC 壁時計のまま日単位でシフトする (project 全体の TZ シフト回避規約)。
 * 保存済み検証スナップショット (`profit/monthly.vue`) から比較ページへ遷移する際の
 * `to` (半開区間、翌日を指定) 算出にも使うため export する。 */
export function shiftYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number]
  return epochToYmd(Date.UTC(y, m - 1, d + deltaDays) / 1000)
}

/**
 * `/api/operations` の `date_from`/`date_to` は `reading_date` (タコグラフのカード
 * 読み取り日、両端含む) に対するフィルタで、一番星の `売上年月日` と必ずしも一致しない
 * (翌朝読み取り等のズレがありうる) ため前後 1 日ずつ広げて検索し、結果は
 * `pickOperationForDate` で `operation_date`/`reading_date` が `saleDate` と一致する
 * ものに絞り込む。
 */
export function operationSearchDateRange(saleDate: string): { date_from: string, date_to: string } {
  return { date_from: shiftYmd(saleDate, -1), date_to: shiftYmd(saleDate, 1) }
}

/**
 * 検索結果 (前後1日を含む) から `saleDate` に一致する運行を選ぶ。`operation_date` が
 * 無い行は `reading_date` にフォールバックする。複数該当時は最初の1件を採用する
 * (同一車輌・同一日の複数運行は稀、かつ按分しない設計のため代表1件で十分)。
 */
export function pickOperationForDate(
  operations: OperationListItem[],
  saleDate: string,
): OperationListItem | null {
  return operations.find(op => (op.operation_date ?? op.reading_date) === saleDate) ?? null
}

// --- 保存済み検証スナップショットの有無判定 ---

/** 保存済みスナップショット (ProfitPanel で保存、`SnapshotListItem`) の車輌+運行番号を
 * 比較行の車輌+運行番号と突き合わせるためのキー。区切りに使う制御文字はどちらの値にも
 * 現れないコード体系のため単純結合で衝突しない。 */
export function savedSnapshotKey(vehicleCode: string, unkoNo: string): string {
  return `${vehicleCode} ${unkoNo}`
}

/** 年月 (`YYYY-MM`) をキーに、(車輌, 年月) の組み合わせを重複なく列挙する。保存済み
 * スナップショット一覧 (`GET /api/profit/snapshots?vehicle=&ym=`) を年月単位でしか
 * 効率的に絞り込めないため、伝票グループ (運行解決前、`vehicleNumber`/`saleDate` を
 * 持つ最小限の形なら `SlipGroup` にも `CompareRowView` にも使える) から検索対象を
 * 事前に列挙するのに使う。 */
export function uniqueVehicleYmPairs(
  rows: { vehicleNumber: string, saleDate: string }[],
): { vehicle: string, ym: string }[] {
  const seen = new Set<string>()
  const pairs: { vehicle: string, ym: string }[] = []
  for (const r of rows) {
    const ym = r.saleDate.slice(0, 7)
    const key = `${r.vehicleNumber} ${ym}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push({ vehicle: r.vehicleNumber, ym })
  }
  return pairs
}

// --- 比較行の組み立て ---

export interface CompareRow {
  group: SlipGroup
  /** 一致する dtako 運行 (見つからなければ null = 「運行データなし」)。 */
  operation: OperationListItem | null
  /** 該当運行のイベントCSV全体を集計した距離・時間内訳 (`snapshot` が無い場合のみ使う
   * フォールバック。CSV未取得/取得失敗なら null)。 */
  segment: SelectedRowsSummary | null
  /** 該当運行に対して ProfitPanel で既に確認・保存済みのスナップショット (無ければ null)。
   * 存在する場合、距離・時間・売上・効率指標は全て CSV 全行集計ではなくこちらを優先する
   * (ユーザーが手動で選択・確認した区間・伝票の方が正確なため。Refs #330 実運用フィードバック:
   * 「イベントで選択した行が使われず無駄」)。 */
  snapshot: ProfitSnapshot | null
}

export interface CompareRowView {
  vehicleNumber: string
  saleDate: string
  customerName: string
  originLabel: string
  destLabel: string
  amount: number
  unkoNo: string | null
  driverName: string | null
  distanceKm: number | null
  boundMin: number | null
  driveMin: number | null
  efficiency: ProfitEfficiency
  /** ProfitPanel で確認済みのスナップショットがあるか (一覧での「保存済み」表示用)。 */
  isSaved: boolean
}

/** `CompareRow` (グループ+運行+CSV集計 or 保存済みスナップショット) から表示用の1行を
 * 組み立てる。`snapshot` があればそちらを優先し (手動確認済みのため信頼度が高い)、
 * 無ければ CSV 全行集計 (`segment`) + 伝票金額の単純合算にフォールバックする。 */
export function buildCompareRowView(row: CompareRow): CompareRowView {
  const distanceKm = row.snapshot?.dtakoSummary.distanceKm ?? row.segment?.distanceKm ?? null
  const boundMin = row.snapshot?.dtakoSummary.durationMin ?? row.segment?.durationMin ?? null
  const driveMin = row.snapshot?.dtakoSummary.byCategory.drive ?? row.segment?.byCategory.drive ?? null
  const amount = row.snapshot?.confirmedAmount ?? row.group.amount
  return {
    vehicleNumber: row.group.vehicleNumber,
    saleDate: row.group.saleDate,
    customerName: row.group.customerName,
    originLabel: row.group.originLabel,
    destLabel: row.group.destLabel,
    amount,
    unkoNo: row.operation?.unko_no ?? null,
    driverName: row.operation?.driver_name ?? null,
    distanceKm,
    boundMin,
    driveMin,
    efficiency: row.snapshot?.efficiency
      ?? calcProfitEfficiency(amount, distanceKm ?? 0, boundMin ?? 0, driveMin ?? 0),
    isSaved: row.snapshot !== null,
  }
}

// --- 検索フォームの既定値 ---

const ONE_DAY_SECONDS = 24 * 60 * 60

/** 検索フォームの既定期間 (直近1か月、`to` は vehicle-daily API と同じ半開区間)。 */
export function defaultCompareDateRange(nowTs: number): { from: string, to: string } {
  return {
    from: epochToYmd(nowTs - 30 * ONE_DAY_SECONDS),
    to: epochToYmd(nowTs + ONE_DAY_SECONDS),
  }
}

// --- CSV 出力 ---

const CSV_HEADER = [
  '日付', '車輌', '乗務員', '得意先', '積地', '卸地',
  '売上(税抜)', '距離(km)', '拘束時間(分)', '運転時間(分)', '円/km', '円/時間(拘束)', '円/時間(運転)', '運行番号',
]

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 比較テーブルの CSV 出力用の行配列 (BOM無し、呼び出し側で結合・Blob化する)。 */
export function compareRowsToCsvLines(rows: CompareRowView[]): string[] {
  const lines = [CSV_HEADER.map(csvCell).join(',')]
  for (const r of rows) {
    lines.push([
      r.saleDate,
      r.vehicleNumber,
      r.driverName ?? '',
      r.customerName,
      r.originLabel,
      r.destLabel,
      r.amount,
      r.distanceKm === null ? '' : r.distanceKm.toFixed(1),
      r.boundMin === null ? '' : r.boundMin,
      r.driveMin === null ? '' : r.driveMin,
      r.efficiency.yenPerKm === null ? '' : Math.round(r.efficiency.yenPerKm),
      r.efficiency.yenPerHourBound === null ? '' : Math.round(r.efficiency.yenPerHourBound),
      r.efficiency.yenPerHourDrive === null ? '' : Math.round(r.efficiency.yenPerHourDrive),
      r.unkoNo ?? '',
    ].map(csvCell).join(','))
  }
  return lines
}
