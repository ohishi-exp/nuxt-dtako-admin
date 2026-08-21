/**
 * 便 (デジタコ) ↔ 一番星の運転日報明細 を突合して**売上**を出す (pure)。
 *
 * 手当 (経費) はデジタコだけで出せる (`allowance-trips.ts`) が、**売上は出せない** —
 * デジタコのイベントCSV に積載量が無く、数量は一番星の明細にしかない。そこで
 * **一番星の `amount` (税抜売上) をそのまま売上として使う**。マスタの運賃
 * (`farePerT`) は掛け算には使わず、**単価の検算**に回す (料金改定・入力ミスの検知)。
 *
 * ```
 * 売上 = 突合できた一番星明細の amount の合計
 * 収支 = 売上 − 手当
 * ```
 *
 * 突合の作りは `obihiro-profit/reconcile.py` (PDF の手当表 × 一番星、2026-07 の
 * 帯広5台で 279/313) の移植。**ただし数量の部分和は使えない** — あちらは PDF が
 * 便ごとの数量を持っていたが、デジタコの便は数量を持たない。代わりに
 * **(日付 ±1 日) × (卸地) で当て、同じ枠を争う便が複数あれば明細を件数で分ける**。
 *
 * **突合できなかったものは合計から黙って抜かない。** 便側・明細側・単価の食い違いを
 * それぞれ数えて呼び出し側に返し、画面が一覧で出す (2026-08-21 ユーザー判断)。
 */
import { epochToYmd, type VehicleDailySlip } from './ichiban'
import { normalizePlace, lookupFare } from './allowance-rate'
import { RATE_MASTER, type RateRow } from './allowance-rate-master'
import { addressToCity, cityToPlace, CITY_TO_DEST } from './allowance-trips'
import { compareText, type AllowanceReportRow } from './allowance-report'

/** 一番星の売上年月日と便の日付のズレ許容 (日)。手当表が翌日に押し出されるのと同じ揺れ。 */
export const DATE_SLACK = 1

/**
 * 実車の明細が落ちる受け皿の車輌C。**自車を使い切ってからの最後の手段**に留める
 * (長崎・大阪の明細も混ざっているため。2026-07 は 1420 の 7/1〜7/8 がまるごとここ)。
 */
export const POOL_VEHICLE = '0001'

/** 一番星が「休み」を 1 明細として持っている。便ではないので突合対象から外す。 */
export const REST_ITEM_NAME = '休み'

// --- 卸地の照合 ---

const PREF_RE = /^(北海道|東京都|京都府|大阪府|.{2,3}県)/
const GUN_RE = /^[^市区町村]{1,6}郡/

/**
 * `北海道上士幌町` → `上士幌`。一番星の地域ﾏｽﾀ由来の着地域名から市区町村名を取り出す。
 *
 * 郡は一番星側が省く表記 (`北海道標茶町`)・デジタコ側が持つ表記 (`北海道川上郡標茶町`)
 * の両方が実在するので、どちらでも同じキーになるよう落とす。
 */
export function areaTown(area: string): string {
  return normalizePlace(area).replace(PREF_RE, '').replace(GUN_RE, '').replace(/(市|町|村)$/, '')
}

/**
 * 一番星 1 明細が名乗れる卸地キー。
 *
 * `dest` (着地N、自由入力) は施設名寄り (`清水　ﾉﾍﾞﾙｽﾞDF`) だが、便と同じ地名
 * (`川西`/`富士`) を持つことも多い。`destAreaName` (地域ﾏｽﾀ) は市区町村まで届くが、
 * **帯広市の中の 川西・富士・札内 は全部 `北海道帯広市` に潰れる**。
 * どちらか一方では足りないので両方を候補にする。
 */
export function slipDestKeys(slip: VehicleDailySlip): string[] {
  const keys = new Set([normalizePlace(slip.dest), areaTown(slip.destAreaName)])
  keys.delete('')
  return [...keys]
}

/**
 * 便が名乗れる卸地。デジタコの `終了市町村名` (実体は住所) と、マスタで決まった
 * 卸地の両方から作る。`松山/士幌` `清水・富士` のような複数表記は分けて展開する。
 */
export function legDestAlts(row: Pick<AllowanceReportRow, 'destCity' | 'masterDest'>): string[] {
  const parts = [addressToCity(row.destCity), row.masterDest]
    .flatMap(text => normalizePlace(text).split(/[・/]/))
  const alts = new Set(parts.flatMap(part => [part, cityToPlace(part)]))
  alts.delete('')
  return [...alts]
}

/**
 * 卸地が一致するか。**`士幌` が `上士幌` を巻き込まないよう前方一致だけを使う**
 * (部分一致にしない)。卸地の手がかりが無い便 (`alts` が空) は当てにいかない。
 */
export function destMatches(slipKeys: string[], legAlts: string[]): boolean {
  return legAlts.some(alt => slipKeys.some(key => key.startsWith(alt)))
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD` 同士の日数差 (絶対値)。時刻付きで来ても先頭 10 桁だけ見る。 */
export function dayDiff(a: string, b: string): number {
  const ms = Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)
  return Math.abs(ms) / MS_PER_DAY
}

// --- 便 ↔ 明細 ---

/** 便を一意に指すキー。運行NO は乗務員の中で一意、`seq` はその運行の中で一意。 */
export function legKey(row: Pick<AllowanceReportRow, 'unkoNo' | 'seq'>): string {
  return `${row.unkoNo}#${row.seq}`
}

export type LegMatchStatus =
  /** 同じ日・同じ卸地の明細が当たった。 */
  | 'matched'
  /** 卸地は合うが日付が 1 日ずれている。 */
  | 'matched_date_shift'
  /** 一番星に対応する明細が無い。**売上に数えない。** */
  | 'no_slip'

/** 1 便ぶんの突合結果。 */
export interface LegReconcile {
  key: string
  status: LegMatchStatus
  /** 当たった明細。`no_slip` なら空。 */
  slips: VehicleDailySlip[]
  /** 当たった明細の数量合計 (t)。 */
  quantity: number
  /** 当たった明細の `amount` 合計 = 売上 (円)。 */
  salesYen: number
  /**
   * 同じ日・同じ卸地に便が複数あり、**明細を件数で機械的に分けた**。
   * 便ごとの内訳は推定 (合計は変わらない)。
   */
  split: boolean
  /** 受け皿の車番 (`POOL_VEHICLE`) から拾った。 */
  fromPool: boolean
}

export interface ReconcileResult {
  /** `legKey()` → 突合結果。渡した便は必ず 1 つ入る。 */
  byLeg: Map<string, LegReconcile>
  /** どの便にも当たらなかった一番星明細。**便に無い仕事か、便の取りこぼし。** */
  leftovers: VehicleDailySlip[]
}

export interface PoolReconcileResult extends ReconcileResult {
  /** 受け皿のうち、まだどの便にも使われていない明細。次の車輌に回す。 */
  poolLeftovers: VehicleDailySlip[]
}

function noSlip(key: string): LegReconcile {
  return { key, status: 'no_slip', slips: [], quantity: 0, salesYen: 0, split: false, fromPool: false }
}

/** 同じ日・同じ卸地の便をひとまとめにする鍵 (明細を分け合う単位)。 */
function groupKey(row: AllowanceReportRow, alts: string[]): string {
  return `${row.date}|${[...alts].sort(compareText).join(',')}`
}

/** 便の処理順。日付 → 運行NO → 便番号。キーは一意なので同値は来ない。 */
function legSortKey(row: AllowanceReportRow): string {
  return `${row.date}|${row.unkoNo}|${String(row.seq).padStart(4, '0')}`
}

/**
 * 便に一番星明細を割り当てる。
 *
 * 同じ日の明細を優先し、無ければ ±`DATE_SLACK` 日まで広げる。**1 便 = 複数明細が
 * 普通** (標茶 8t + 4t = 12t) なので、当たった明細は既定でまとめて 1 便に付ける。
 * ただし同じ日・同じ卸地に便が複数あるときは、その本数で割って先頭から配る
 * (`split: true`)。**合計は変わらず、便ごとの内訳だけが推定になる。**
 */
export function reconcileLegs(rows: AllowanceReportRow[], slips: VehicleDailySlip[]): ReconcileResult {
  const slipKeys = slips.map(slipDestKeys)
  const used = new Set<number>()
  const ordered = [...rows].sort((a, b) => compareText(legSortKey(a), legSortKey(b)))
  const altsOf = new Map(ordered.map(row => [legKey(row), legDestAlts(row)]))

  const groupTotal = new Map<string, number>()
  for (const row of ordered) {
    const key = groupKey(row, altsOf.get(legKey(row))!)
    groupTotal.set(key, (groupTotal.get(key) ?? 0) + 1)
  }
  // 分ける割り算には「まだ配っていない便の数」を、推定の印には「その枠の便の総数」を
  // 使う。減っていく方で印を付けると、最後の 1 便だけ推定でないことになる。
  const groupLeft = new Map(groupTotal)

  function candidates(date: string, alts: string[], slack: number): number[] {
    const out: number[] = []
    for (let i = 0; i < slips.length; i++) {
      if (used.has(i)) continue
      if (dayDiff(slips[i]!.saleDate, date) > slack) continue
      if (!destMatches(slipKeys[i]!, alts)) continue
      out.push(i)
    }
    return out
  }

  const byLeg = new Map<string, LegReconcile>()
  for (const row of ordered) {
    const key = legKey(row)
    const alts = altsOf.get(key)!
    const group = groupKey(row, alts)
    const share = groupLeft.get(group)!
    groupLeft.set(group, share - 1)

    let hits = candidates(row.date, alts, 0)
    let status: LegMatchStatus = 'matched'
    if (hits.length === 0) {
      hits = candidates(row.date, alts, DATE_SLACK)
      status = 'matched_date_shift'
    }
    if (hits.length === 0) {
      byLeg.set(key, noSlip(key))
      continue
    }
    const picked = hits.slice(0, Math.ceil(hits.length / share))
    for (const i of picked) used.add(i)
    const chosen = picked.map(i => slips[i]!)
    byLeg.set(key, {
      key,
      status,
      slips: chosen,
      quantity: chosen.reduce((sum, s) => sum + s.quantity, 0),
      salesYen: chosen.reduce((sum, s) => sum + s.amount, 0),
      split: groupTotal.get(group)! > 1,
      fromPool: false,
    })
  }

  return { byLeg, leftovers: slips.filter((_, i) => !used.has(i)) }
}

/**
 * 自車の明細で突合してから、**当たらなかった便だけ**受け皿の車番の明細で拾い直す。
 *
 * 受け皿には複数の車輌の明細が混ざっているので、自車を使い切ってからの最後の手段に
 * 留める。拾えたぶんは `fromPool` で印を付ける (画面で区別して出すため)。
 * `leftovers` は**自車ぶんだけ**返す — 受け皿の残りは他の車輌の仕事。
 */
export function reconcileWithPool(
  rows: AllowanceReportRow[],
  slips: VehicleDailySlip[],
  poolSlips: VehicleDailySlip[],
): PoolReconcileResult {
  const own = reconcileLegs(rows, slips)
  const unmatched = rows.filter(row => own.byLeg.get(legKey(row))!.status === 'no_slip')
  const fromPool = reconcileLegs(unmatched, poolSlips)
  const byLeg = new Map(own.byLeg)
  for (const [key, hit] of fromPool.byLeg) {
    if (hit.status === 'no_slip') continue
    byLeg.set(key, { ...hit, fromPool: true })
  }
  return { byLeg, leftovers: own.leftovers, poolLeftovers: fromPool.leftovers }
}

/** 突合に掛ける 1 車輌ぶん。 */
export interface VehicleReconcileInput {
  vehicle: string
  rows: AllowanceReportRow[]
  slips: VehicleDailySlip[]
}

export interface VehiclesReconcileResult {
  byLeg: Map<string, LegReconcile>
  /** 車輌ごとの未突合明細。 */
  leftovers: { vehicle: string, slips: VehicleDailySlip[] }[]
}

/**
 * 複数車輌ぶんをまとめて突合する。
 *
 * **受け皿の明細を車輌どうしで取り合わせない** — 先に拾われたぶんを次の車輌に回さない
 * ので、同じ売上が 2 台に二重計上されることがない。
 */
export function reconcileVehicles(
  groups: VehicleReconcileInput[],
  poolSlips: VehicleDailySlip[],
): VehiclesReconcileResult {
  const byLeg = new Map<string, LegReconcile>()
  const leftovers: { vehicle: string, slips: VehicleDailySlip[] }[] = []
  let pool = poolSlips
  for (const group of groups) {
    const res = reconcileWithPool(group.rows, group.slips, pool)
    for (const [key, hit] of res.byLeg) byLeg.set(key, hit)
    leftovers.push({ vehicle: group.vehicle, slips: res.leftovers })
    pool = res.poolLeftovers
  }
  return { byLeg, leftovers }
}

const ONE_DAY_SECONDS = 24 * 60 * 60

/**
 * 一番星の明細を引く期間 (`from` 以上 `to` 未満)。
 * **月の前後に 1 日ずつ広げる** — 便の日付は ±`DATE_SLACK` 日ずれうるので、
 * 月内で閉じると月初・月末の便が当たらない。
 */
export function slipDateRange(ym: string): { from: string, to: string } {
  const [year, month] = ym.split('-').map(Number) as [number, number]
  return {
    from: epochToYmd(Date.UTC(year, month - 1, 1) / 1000 - ONE_DAY_SECONDS),
    to: epochToYmd(Date.UTC(year, month, 1) / 1000 + ONE_DAY_SECONDS),
  }
}

/** 突合対象の明細。「休み」行は便ではないので落とす。 */
export function tradableSlips(slips: VehicleDailySlip[]): VehicleDailySlip[] {
  return slips.filter(s => s.itemName !== REST_ITEM_NAME)
}

// --- 運賃の検算 (料金改定・入力ミスの検知) ---

/**
 * デジタコの `開始/終了市町村名` (実体は住所) と銘柄から、マスタの運賃 (円/t) を引く。
 * `lookupAllowanceByCity` と同じ寄せ方 (`CITY_TO_DEST` → 市町村名) を運賃側に当てたもの。
 */
export function lookupFareByCity(originCity: string, destCity: string, brand: string): number | null {
  const origin = addressToCity(originCity)
  const dest = addressToCity(destCity)
  const mapped = CITY_TO_DEST[`${origin}|${dest}`]
  return lookupFare(cityToPlace(origin), mapped ?? cityToPlace(dest), brand)
}

/**
 * その銘柄でマスタに載っている運賃 (円/t)。**銘柄名だけで引く。**
 *
 * 経路 (積地・卸地) から引く `lookupFareByCity` だけに頼ると、卸地の寄せが外れた
 * ときに「別の契約の運賃」と比べてしまい、**料金改定でも何でもない食い違いを
 * 大量に出す** (2026-07 の実データで `ときめき300` が 卸地だけで運賃が決まる契約の
 * 2,520 円と比べられ、正しい 6,000 円が食い違い扱いになった)。銘柄側からも候補を
 * 出して、**どれとも一致しないときだけ食い違いとする。**
 *
 * 銘柄が空のマスタ行は「卸地だけで運賃が決まる契約」なので、銘柄名では引かない。
 */
export function brandFares(brand: string, master: RateRow[] = RATE_MASTER): number[] {
  const key = normalizePlace(brand)
  if (!key) return []
  const fares = master
    .filter(r => normalizePlace(r.brand) === key)
    .map(r => r.farePerT)
    .filter((f): f is number => f !== null)
  return [...new Set(fares)].sort((a, b) => a - b)
}

/** その明細に当てはまりうるマスタの運賃 (経路から引いたもの + 銘柄から引いたもの)。 */
export function fareCandidates(originCity: string, destCity: string, brand: string): number[] {
  const fares = new Set(brandFares(brand))
  const route = lookupFareByCity(originCity, destCity, brand)
  if (route !== null) fares.add(route)
  return [...fares].sort((a, b) => a - b)
}

export type FareCheckStatus =
  /** マスタの運賃と一番星の単価が一致。 */
  | 'match'
  /** **どのマスタ運賃とも一致しない。** 料金改定か入力ミスの疑いとして人が見る。 */
  | 'mismatch'
  /** マスタに載っていない銘柄・経路 (肉牛・N搾乳 等)。**対象外**で、食い違いとは別に数える。 */
  | 'no_master'

export function fareStatus(candidates: number[], unitPrice: number): FareCheckStatus {
  if (candidates.length === 0) return 'no_master'
  if (candidates.includes(unitPrice)) return 'match'
  return 'mismatch'
}

/** 単価を検算した明細 1 本。 */
export interface FareCheck {
  legKey: string
  unkoNo: string
  date: string
  driverName: string
  itemName: string
  /** 一番星の着地N。どの卸し先かを人が見るための表示用。 */
  dest: string
  quantity: number
  /** 一番星の単価 (円/t)。 */
  unitPrice: number
  /** マスタ側の運賃候補 (円/t)。マスタに無ければ空。 */
  masterFares: number[]
  status: FareCheckStatus
}

/** 突合できた明細の単価をマスタの運賃と突き合わせる。 */
export function checkFares(rows: AllowanceReportRow[], byLeg: Map<string, LegReconcile>): FareCheck[] {
  const out: FareCheck[] = []
  for (const row of rows) {
    const hit = byLeg.get(legKey(row))
    if (!hit) continue
    for (const slip of hit.slips) {
      const masterFares = fareCandidates(row.originCity, row.destCity, slip.itemName)
      out.push({
        legKey: hit.key,
        unkoNo: row.unkoNo,
        date: row.date,
        driverName: row.driverName,
        itemName: slip.itemName,
        dest: slip.dest,
        quantity: slip.quantity,
        unitPrice: slip.unitPrice,
        masterFares,
        status: fareStatus(masterFares, slip.unitPrice),
      })
    }
  }
  return out
}

/**
 * 便に当たらなかった明細も検算する。**積地が分からないので銘柄だけで引く。**
 * 料金改定は「便に当たらなかった明細」の側にも出る (2026-07 の `ミライコーン` が
 * まさにこれで、便に当たらないまま単価が 3,900 / マスタ 3,500 になっていた)。
 */
export function checkLeftoverFares(slips: VehicleDailySlip[]): FareCheck[] {
  return slips.map((slip) => {
    const masterFares = brandFares(slip.itemName)
    return {
      legKey: '',
      unkoNo: '',
      date: slip.saleDate,
      driverName: '',
      itemName: slip.itemName,
      dest: slip.dest,
      quantity: slip.quantity,
      unitPrice: slip.unitPrice,
      masterFares,
      status: fareStatus(masterFares, slip.unitPrice),
    }
  })
}

// --- 集計 ---

/** 便のまとまり (乗務員 / 運行 / 月) ぶんの売上。 */
export interface SalesTotals {
  salesYen: number
  quantity: number
  /** 明細が当たった便。 */
  matchedTrips: number
  /** 一番星に対応する明細が無かった便。**売上に入っていない。** */
  unmatchedTrips: number
  /** 日付が 1 日ずれて当たった便。 */
  dateShiftTrips: number
  /** 明細を件数で分けた (内訳が推定の) 便。 */
  splitTrips: number
  /** 受け皿の車番から拾った便。 */
  poolTrips: number
}

export function emptySalesTotals(): SalesTotals {
  return {
    salesYen: 0,
    quantity: 0,
    matchedTrips: 0,
    unmatchedTrips: 0,
    dateShiftTrips: 0,
    splitTrips: 0,
    poolTrips: 0,
  }
}

/**
 * 便の売上を合計する。**日付ずれも受け皿由来も売上には数える** (根拠のある明細な
 * ので) が、それぞれ何便あったかを併せて返して画面に出す。
 */
export function summarizeSales(
  rows: Pick<AllowanceReportRow, 'unkoNo' | 'seq'>[],
  byLeg: Map<string, LegReconcile>,
): SalesTotals {
  const totals = emptySalesTotals()
  for (const row of rows) {
    const hit = byLeg.get(legKey(row))
    if (!hit) continue
    totals.salesYen += hit.salesYen
    totals.quantity += hit.quantity
    if (hit.status === 'no_slip') totals.unmatchedTrips += 1
    else totals.matchedTrips += 1
    if (hit.status === 'matched_date_shift') totals.dateShiftTrips += 1
    if (hit.split) totals.splitTrips += 1
    if (hit.fromPool) totals.poolTrips += 1
  }
  return totals
}

/** 収支 = 売上 − 手当。 */
export function margin(salesYen: number, allowanceYen: number): number {
  return salesYen - allowanceYen
}

// --- CSV ---

const CSV_HEADER = [
  '運行NO', '日付', '乗務員', '車輌', '便', '積地(市町村)', '卸地(市町村)', '途中卸し',
  'マスタ卸地', '手当', '数量t', '売上', '収支', '突合', '内訳推定', '受け皿', '一番星明細',
]

/** 便 1 行ずつの収支 CSV。値にカンマが入りうるので必ず引用する。 */
export function reconcileCsvLines(
  rows: AllowanceReportRow[],
  byLeg: Map<string, LegReconcile>,
): string[] {
  const quote = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [
    CSV_HEADER.map(quote).join(','),
    ...rows.map((r) => {
      const hit = byLeg.get(legKey(r)) ?? noSlip(legKey(r))
      return [
        r.unkoNo, r.date, r.driverName, r.vehicleName, r.seq, r.originCity, r.destCity,
        r.viaCities, r.masterDest, r.allowanceYen, hit.quantity, hit.salesYen,
        margin(hit.salesYen, r.allowanceYen ?? 0), hit.status,
        hit.split ? '推定' : '', hit.fromPool ? POOL_VEHICLE : '',
        hit.slips.map(s => s.itemName).join('|'),
      ].map(quote).join(',')
    }),
  ]
}

// --- 車輌C ---

/**
 * 運行NO から一番星の車輌C を取り出す。
 *
 * **運行NO は 開始日時 12 桁 + 車輌CD 10 桁 + 対象CD (22 桁の実物もいる)。**
 * 一番星の車輌C は **4 桁ゼロ埋め** (`16` は `0016`) なので、そこまで揃える。
 * 生値で引くと 0 件が返り「売上 0 円」に見える (2026-08-21 に踏んだ)。
 */
export function vehicleCodeFromUnkoNo(unkoNo: string): string {
  return unkoNo.slice(12, 22).replace(/^0+/, '').padStart(4, '0')
}
