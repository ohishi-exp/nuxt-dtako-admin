/**
 * 運行手当の集計 (pure)。`allowance-trips.ts` が切り出した便を、画面の表・CSV・
 * 乗務員ごとの月合計に組み替える。
 *
 * **金額が決まらなかった便は合計に入れない。** 推測した数字を給与に混ぜるより、
 * 「何便が未確定か」を出して人に見せる (2026-08-21 ユーザー判断)。
 */
import { epochToYmd } from './ichiban'
import { carryOverDest, type CarryInUnload, type DestSource, type LegAllowance } from './allowance-trips'

/** 1 運行ぶんの引き当て結果。 */
export interface OperationAllowance {
  unkoNo: string
  /** タコグラフの読取日 (`YYYY-MM-DD`)。 */
  readingDate: string
  /** 運行日。alc が持っていなければ null。 */
  operationDate: string | null
  driverName: string | null
  vehicleName: string | null
  legs: LegAllowance[]
  /** その運行の**先頭**にある降し (前の運行の積み残し)。`applyCarryOver` が使う。 */
  carryIn: CarryInUnload
  /** イベントCSV が引けなかった等の理由。引けていれば null。 */
  error: string | null
}

/**
 * **運行をまたいで積み残しの卸地を埋める。**
 *
 * 積んだまま帰庫し、翌朝の運行の頭で降ろす便がある。その降しは次の運行のイベントCSV
 * に入るので、運行 1 本だけを見ていると卸地が永久に決まらない (2026-07 の帯広 5 台で
 * 12 便、うち 10 便がこれで埋まる)。
 *
 * 同じ **乗務員 + 車輌**の運行を運行NO順 (= 開始日時順) に並べ、隣り合う 2 本の間で
 * `carryOverDest` を当てる。**引いた範囲の最後の運行は埋まらない** — 次の運行を
 * 持っていないため。その便は翌月ぶんなので、対象月の合計には効かない。
 */
export function applyCarryOver(ops: OperationAllowance[]): OperationAllowance[] {
  const byTruck = new Map<string, OperationAllowance[]>()
  for (const op of ops) {
    const key = `${op.driverName ?? ''}|${op.vehicleName ?? ''}`
    const list = byTruck.get(key) ?? []
    list.push(op)
    byTruck.set(key, list)
  }
  const filled = new Map<string, LegAllowance[]>()
  for (const list of byTruck.values()) {
    const sorted = [...list].sort((a, b) => compareText(a.unkoNo, b.unkoNo))
    for (let i = 0; i < sorted.length - 1; i++) {
      const op = sorted[i]!
      filled.set(op.unkoNo, carryOverDest(op.legs, sorted[i + 1]!.carryIn))
    }
  }
  return ops.map(op => ({ ...op, legs: filled.get(op.unkoNo) ?? op.legs }))
}

/**
 * **区間提案 (②) が「次の運行」を引くための隣接判定** (Refs #926)。
 *
 * `applyCarryOver` は**その月ぶんの運行を全部持っている**前提で隣接を取るが、運行詳細
 * (`/operations/[unko_no]`) は `getOperation(unkoNo)` で**単一運行しか持たない**。
 * そこで「一覧から引いてきた候補の中から、①と同じ規則で次の 1 本を選ぶ」ところだけを
 * 切り出す。**①の `applyCarryOver` / `carryOverDest` には触っていない。**
 *
 * ①と同じ規則: **同一車輌 + 同一乗務員**を、**運行NO順 (= 開始日時順)** に並べた隣接。
 *
 * ★ **乗務員・車輌の絞り込みは呼び出し側の責任**。運行一覧 (`OperationListItem`) は
 * `raw_data` を持たず車輌CD/乗務員CD が読めないので、**一覧を引く時点で
 * `vehicle_cd` / `driver_cd` を指定して絞る**。ここで再度絞れるふりをすると、
 * 「絞ったつもりで絞れていない」形になる。
 */
export interface CarryNeighborPick {
  /**
   * - `'ok'` … 次の運行が決まった
   * - `'none'` … 窓の中に**同じ乗務員・車輌の**次の運行が無い (月末・退職・車輌入替・連休)
   */
  status: 'ok' | 'none'
  unkoNo: string | null
  /**
   * 代用元が**暦月をまたぐ**か。
   *
   * ★ **止める条件ではない。注記に出すための事実。** 一度これを「またぐなら代用しない」
   * の条件にしかけたが、**そう作ると #926 が代表例に挙げている便
   * (`26073104154100000011091`、07-31 開始 → 降しは 08-01 の運行の先頭) が構造的に
   * 対象外**になる。①が暦月で切れるのは `applyCarryOver` が**その月ぶんしか
   * fetch していない実装の副作用**であって、代用の規則 (同一乗務員+車輌で運行NO順に
   * 隣接) は暦月と無関係 — 07-31→08-01 の隣接は 07-06→07-08 の隣接より近い。
   * **確度は落ちないが、またいだ事実は必ず読ませる。**
   */
  crossesMonth: boolean
}

/** 運行NO の先頭 22 桁 = 運行の identity (23 桁目の対象CD は乗務員の別)。 */
function opeNo22(unkoNo: string): string {
  return unkoNo.slice(0, 22)
}

/**
 * `currentUnkoNo` の**次の運行**を `candidates` から選ぶ。
 * `candidates` は**同一車輌 + 同一乗務員に絞ってあること** (上の doc)。
 *
 * **先頭 22 桁で比べる。** 23 桁目 (対象CD) だけが違う行は**同じ運行の相方 (2マンの
 * 助手枠)** なので、23 桁で比べると相方を「次の運行」に選んでしまう。
 */
export function pickNextOperationForCarry(
  currentUnkoNo: string,
  candidates: { unkoNo: string }[],
): CarryNeighborPick {
  const cur22 = opeNo22(currentUnkoNo)
  // **返すのは一覧が持っていた運行NO そのまま** — 22 桁に切ったものを返すと、
  // イベントCSV を引くときに存在しない運行NO を叩く。
  const next = candidates
    .filter(op => opeNo22(op.unkoNo) > cur22)
    .sort((a, b) => compareText(opeNo22(a.unkoNo), opeNo22(b.unkoNo)))[0]
  if (next === undefined) return { status: 'none', unkoNo: null, crossesMonth: false }
  // 運行NO の先頭 4 桁 = YYMM。暦月をまたぐかはここだけで決まる。
  return { status: 'ok', unkoNo: next.unkoNo, crossesMonth: next.unkoNo.slice(0, 4) !== cur22.slice(0, 4) }
}

/**
 * 運行NO の先頭 12 桁 (`YYMMDDHHmmss`) → 注記用の短い開始日時 (`MM-DD HH:mm`)。
 * 22 桁でも 23 桁でもなければ `null`。
 *
 * `kintai-unko-gaps.ts` の `kintaiUnkoGapsDeriveStartOpe` が似た変換を持っているが、
 * **独立に書く** — あちらは勤怠 (オンプレの③フォームへ見せる `YYYY/MM/DD H:mm:ss`) の
 * 口で、ここは手当・粗利の注記。`runDateFromUnkoNo` を別に持っているのと同じ理由。
 */
export function carryStartLabel(unkoNo: string): string | null {
  if (!/^\d{22}$/.test(unkoNo) && !/^\d{23}$/.test(unkoNo)) return null
  return `${unkoNo.slice(2, 4)}-${unkoNo.slice(4, 6)} ${unkoNo.slice(6, 8)}:${unkoNo.slice(8, 10)}`
}

/** 表と CSV の 1 行 = 1 便。 */
export interface AllowanceReportRow {
  unkoNo: string
  /** 便の日付。積みの時刻が読めなければ運行日、それも無ければ読取日。 */
  date: string
  driverName: string
  vehicleName: string
  /** その運行の中で何便目か (1 始まり)。 */
  seq: number
  /**
   * 積みイベントの `開始日時` (epoch 秒)。読めなければ null。
   *
   * **便を取り直しに強く名指しするための鍵。** `seq` は積みが 1 つ増減するとずれるが、
   * 開始日時は運行の中で一意で、イベントCSV を取り直しても動かない
   * (`allowance-excluded.ts` の `excludedKey`)。
   */
  fromTs: number | null
  originCity: string
  destCity: string
  /** 途中で降ろした市町村を `>` で連ねたもの (複数卸しの便だけ埋まる)。 */
  viaCities: string
  /** 引き当てたマスタの卸地。決まらなければ空。 */
  masterDest: string
  /** 決まらなければ null。 */
  allowanceYen: number | null
  status: 'ok' | 'ambiguous' | 'unknown'
  /**
   * `carried` は卸地を**次の運行の先頭の降しから引き継いだ推定**、
   * `forced` は**人が結んだ一番星の明細から決めたもの** (強制突合)。
   */
  destSource: DestSource
}

/**
 * 文字列の昇順比較。**`localeCompare` は使わない** — ICU の照合順が Windows と Linux で
 * 逆転し CI だけ落ちる事故がある。
 *
 * 同値は -1 を返す。並べ替えのキーはどれも一意 (乗務員名は Map のキー、運行NO は
 * 乗務員の中で一意) なので同値は来ない。
 */
export function compareText(a: string, b: string): number {
  return a > b ? 1 : -1
}

/** 便の日付。積みの時刻が読めなければ運行日 → 読取日 の順に落とす。 */
export function legDate(op: OperationAllowance, fromTs: number | null): string {
  if (fromTs !== null) return epochToYmd(fromTs)
  return op.operationDate ?? op.readingDate
}

/**
 * **運行を月に振り分けるための日付** (`YYYY-MM-DD`)。粗利タブが使う (Refs #760 の 16)。
 *
 * `legDate` (便の日付) とは目的が違う — あちらは便 1 本がいつの仕事かで、こちらは
 * **運行 1 本をどの月に数えるか**。月末に始まって翌月へ食い込む運行を、便ごとに
 * 割らずに**まるごと開始月へ**入れるために使う。
 *
 * 1. **運行開始** (`OperationIdle.startTs` = イベントCSV の `運行開始` 行)
 * 2. 運行日 (`operationDate`。alc が持っていれば)
 * 3. 運行NO の先頭 6 桁 (`YYMMDD`)
 *
 * **読取日には落とさない。** 日跨ぎ運行は翌日に読まれる (2026-05 実測で 52.8%) ので、
 * 月末の運行が読取日だと翌月に着いてしまい、月の切り方としては使えない。
 * どれも読めなければ `null` — **どの月にも入れない** (推測で振り分けない)。
 */
export function operationRunDate(startTs: number | null, operationDate: string | null, unkoNo: string): string | null {
  if (startTs !== null) return epochToYmd(startTs)
  if (operationDate !== null) return operationDate
  return runDateFromUnkoNo(unkoNo)
}

/**
 * 運行NO の先頭 6 桁 (`YYMMDD`) → `YYYY-MM-DD`。22 桁でも 23 桁でもなければ `null`。
 *
 * `kintai-candidate-diff.ts` の `kintaiCandidateDiffDateFromUnkoNo` が同じ変換を
 * 持っているが、**独立に書く** — あちらは勤怠 (オンプレ/GCP の突合) の口で、ここは
 * 手当・粗利の口。同じ理由で `kintai-diff-view.ts` も乗務員CD の正規化を書き直している。
 */
function runDateFromUnkoNo(unkoNo: string): string | null {
  if (!/^\d{22}$/.test(unkoNo) && !/^\d{23}$/.test(unkoNo)) return null
  return `${2000 + Number(unkoNo.slice(0, 2))}-${unkoNo.slice(2, 4)}-${unkoNo.slice(4, 6)}`
}

/** 運行ごとの引き当て結果を、便 1 行ずつの表に開く。 */
export function toReportRows(ops: OperationAllowance[]): AllowanceReportRow[] {
  const rows: AllowanceReportRow[] = []
  for (const op of ops) {
    op.legs.forEach((item, i) => {
      const { leg, lookup } = item
      rows.push({
        unkoNo: op.unkoNo,
        date: legDate(op, leg.fromTs),
        driverName: op.driverName ?? '',
        vehicleName: op.vehicleName ?? '',
        seq: i + 1,
        fromTs: leg.fromTs,
        originCity: leg.originCity,
        destCity: leg.destCity,
        viaCities: leg.viaCities.join('>'),
        masterDest: lookup.status === 'ok' ? lookup.dest : '',
        allowanceYen: lookup.status === 'ok' ? lookup.allowanceYen : null,
        status: lookup.status,
        destSource: item.destSource,
      })
    })
  }
  return rows
}

/** 乗務員ごとの合計。給与計算に渡す形。 */
export interface DriverAllowanceTotal {
  driverName: string
  /** 金額が決まった便数。 */
  trips: number
  totalYen: number
  /** 金額が決まらなかった便数。**人が見る対象**。 */
  irregularTrips: number
}

/**
 * 乗務員ごとに合計する。名前は表示順を安定させるためコード順ではなく文字列順で返す
 * (`localeCompare` は使わない — ICU の照合順が環境で入れ替わり CI だけ落ちる)。
 */
export function summarizeByDriver(rows: AllowanceReportRow[]): DriverAllowanceTotal[] {
  const map = new Map<string, DriverAllowanceTotal>()
  for (const row of rows) {
    const entry = map.get(row.driverName)
      ?? { driverName: row.driverName, trips: 0, totalYen: 0, irregularTrips: 0 }
    if (row.allowanceYen === null) entry.irregularTrips += 1
    else {
      entry.trips += 1
      entry.totalYen += row.allowanceYen
    }
    map.set(row.driverName, entry)
  }
  return [...map.values()].sort((a, b) => compareText(a.driverName, b.driverName))
}

/**
 * 卸地の出どころの表示。**CSV は 2 か所ある** (ここと `allowance-ichiban.ts` の
 * `reconcileCsvLines`) ので、語彙はここに 1 つだけ置く。三項で書き分けると
 * `forced` を足したときに片方だけ `イベント` と嘘をつく。
 */
const DEST_SOURCE_LABEL: Record<DestSource, string> = {
  event: 'イベント',
  carried: '次運行の先頭の降し (推定)',
  forced: '一番星の明細 (強制突合)',
}

export function destSourceLabel(source: DestSource): string {
  return DEST_SOURCE_LABEL[source]
}

const CSV_HEADER = [
  '運行NO', '日付', '乗務員', '車輌', '便', '積地(市町村)', '卸地(市町村)',
  '途中卸し', 'マスタ卸地', '手当', '状態', '卸地の出どころ',
]

/** CSV の各行 (先頭はヘッダ)。値にカンマが入りうるので必ず引用する。 */
export function reportRowsToCsvLines(rows: AllowanceReportRow[]): string[] {
  const quote = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [
    CSV_HEADER.map(quote).join(','),
    ...rows.map(r => [
      r.unkoNo, r.date, r.driverName, r.vehicleName, r.seq, r.originCity, r.destCity,
      r.viaCities, r.masterDest, r.allowanceYen, r.status, destSourceLabel(r.destSource),
    ].map(quote).join(',')),
  ]
}

// --- 月単位の集計 (乗務員 → 運行 → 便 の 3 段、Refs 運行手当タブ) ---

/** 月の運行を引くための読取日レンジ。 */
export interface ReadingRange {
  from: string
  to: string
}

/**
 * `2026-07` → 読取日 `2026-07-01` 〜 `2026-08-01`。
 *
 * **翌月 1 日まで含める。** 日跨ぎ勤務は翌日に読まれるので、月末の運行は翌月 1 日の
 * 読取日で入ってくる。ここを月内で閉じると月末の便がまるごと落ちる。
 */
export function monthReadingRange(ym: string): ReadingRange {
  const [year, month] = ym.split('-').map(Number) as [number, number]
  return { from: `${ym}-01`, to: epochToYmd(Date.UTC(year, month, 1) / 1000) }
}

/** 運行 1 本ぶんのまとめ (展開すると便が見える)。 */
export interface OperationNode {
  unkoNo: string
  readingDate: string
  vehicleName: string
  /** 便が取れなかった理由。取れていれば null。 */
  error: string | null
  /** 対象月に入る便だけ。 */
  rows: AllowanceReportRow[]
  /** 金額が決まった便数。 */
  trips: number
  totalYen: number
  /**
   * **マスタで**金額が決まらなかった便数。
   *
   * 画面の「未確定」とは**別物**。あちらは「手当が 1 円も決まっていない便」で、
   * 暫定手当 (`allowance-provisional.ts`) が当たった便は数えない。ここは
   * マスタしか知らないので、暫定が当たる便も入る。
   */
  irregularTrips: number
  /** 卸地を次の運行から引き継いだ便数 (= **推定**)。合計には入るが印を出す。 */
  carriedTrips: number
}

/** 乗務員 1 人ぶんの月まとめ (展開すると運行が見える)。 */
export interface DriverNode {
  driverName: string
  operations: OperationNode[]
  trips: number
  totalYen: number
  irregularTrips: number
  carriedTrips: number
  /** 便を 1 つも取れなかった運行の本数。 */
  failedOperations: number
}

export interface MonthlyAllowance {
  drivers: DriverNode[]
  trips: number
  totalYen: number
  irregularTrips: number
  carriedTrips: number
  failedOperations: number
  /**
   * 引いた運行に含まれるが、便の日付が対象月の外だったもの。**合計には入れない。**
   * 月末の運行が翌月に食い込むぶんで、その月の給与ではない。
   */
  outOfMonthTrips: number
}

function emptyOperationNode(op: OperationAllowance): OperationNode {
  return {
    unkoNo: op.unkoNo,
    readingDate: op.readingDate,
    vehicleName: op.vehicleName ?? '',
    error: op.error,
    rows: [],
    trips: 0,
    totalYen: 0,
    irregularTrips: 0,
    carriedTrips: 0,
  }
}

/**
 * 運行の引き当て結果を 乗務員 → 運行 → 便 の 3 段にまとめる。
 *
 * **対象月の便が 1 つも無く、かつ失敗でもない運行は出さない** (月跨ぎで翌月ぶんしか
 * 持たない運行が空行として並ぶのを防ぐ)。
 */
export function buildMonthlyAllowance(ops: OperationAllowance[], ym: string): MonthlyAllowance {
  const allRows = toReportRows(ops)
  const inMonth = allRows.filter(r => r.date.startsWith(ym))
  return aggregateMonthly(ops, groupRowsByUnko(inMonth), allRows.length - inMonth.length)
}

/** 便を運行NO ごとに束ねる (順は入力のまま)。 */
function groupRowsByUnko(rows: AllowanceReportRow[]): Map<string, AllowanceReportRow[]> {
  const rowsByUnko = new Map<string, AllowanceReportRow[]>()
  for (const row of rows) {
    const list = rowsByUnko.get(row.unkoNo) ?? []
    list.push(row)
    rowsByUnko.set(row.unkoNo, list)
  }
  return rowsByUnko
}

/**
 * 乗務員 → 運行 → 便 の 3 段に畳む。**どの便を対象月と見るかは呼び出し側が決める**
 * (`rowsByUnko` に入れて渡す) — 月の切り方が 2 つある (便の積み日 / 運行の開始日) ので、
 * 畳み方だけをここに 1 つ置く。
 */
function aggregateMonthly(
  ops: OperationAllowance[],
  rowsByUnko: Map<string, AllowanceReportRow[]>,
  outOfMonthTrips: number,
): MonthlyAllowance {
  const byDriver = new Map<string, DriverNode>()
  for (const op of ops) {
    const rows = rowsByUnko.get(op.unkoNo) ?? []
    if (rows.length === 0 && op.error === null) continue
    const node = emptyOperationNode(op)
    node.rows = rows
    for (const row of rows) {
      if (row.destSource === 'carried') node.carriedTrips += 1
      if (row.allowanceYen === null) node.irregularTrips += 1
      else {
        node.trips += 1
        node.totalYen += row.allowanceYen
      }
    }
    const name = op.driverName ?? ''
    const driver = byDriver.get(name)
      ?? { driverName: name, operations: [], trips: 0, totalYen: 0, irregularTrips: 0, carriedTrips: 0, failedOperations: 0 }
    driver.operations.push(node)
    driver.trips += node.trips
    driver.totalYen += node.totalYen
    driver.irregularTrips += node.irregularTrips
    driver.carriedTrips += node.carriedTrips
    if (op.error !== null) driver.failedOperations += 1
    byDriver.set(name, driver)
  }

  const drivers = [...byDriver.values()].sort((a, b) => compareText(a.driverName, b.driverName))
  for (const driver of drivers) {
    driver.operations.sort((a, b) => compareText(a.readingDate, b.readingDate))
  }
  return {
    drivers,
    trips: drivers.reduce((sum, d) => sum + d.trips, 0),
    totalYen: drivers.reduce((sum, d) => sum + d.totalYen, 0),
    irregularTrips: drivers.reduce((sum, d) => sum + d.irregularTrips, 0),
    carriedTrips: drivers.reduce((sum, d) => sum + d.carriedTrips, 0),
    failedOperations: drivers.reduce((sum, d) => sum + d.failedOperations, 0),
    outOfMonthTrips,
  }
}

/**
 * **運行が月を跨いだぶん** (`buildMonthlyAllowanceByOperationDate` が返す注記の材料)。
 *
 * 運行の開始日で月を切ると、**便の日付は月からはみ出す**。何本・いくらぶんはみ出した
 * のかを画面に出さないと、運行手当タブ (便の積み日で切る) との差が読めない。
 */
export interface CrossMonthLegs {
  /** 対象月の運行が持つ、**翌月日付の便**の数。合計には入っている。 */
  nextMonthLegs: number
  /** その便の手当 (マスタで決まったぶんだけ。決まらなかった便は 0)。 */
  nextMonthAllowanceYen: number
  /** **前月 (以前) 開始の運行**が持つ、対象月日付の便の数。合計には入っていない。 */
  prevMonthOpsLegsInMonth: number
  /** その便の手当。 */
  prevMonthOpsAllowanceYen: number
}

export interface MonthlyAllowanceByOperationDate extends MonthlyAllowance {
  crossMonth: CrossMonthLegs
}

/** 便の手当の合計。**マスタで決まらなかった便は 0** (暫定はここでは足さない)。 */
function sumAllowanceYen(rows: AllowanceReportRow[]): number {
  return rows.reduce((sum, r) => sum + (r.allowanceYen ?? 0), 0)
}

/**
 * **運行の開始日**で月を切る (Refs #760 の 16)。粗利タブ専用で、運行手当タブは
 * `buildMonthlyAllowance` (便の積み日) のまま。
 *
 * 粗利は**運行を単位**にしていて、燃料代は運行まるごとの走行km から出る。便だけを
 * 積み日で切ると、月末に始まって翌月へ食い込む運行が「当月の売上・手当」と
 * 「運行まるごとの燃料」を一緒に抱え、**取引先別の検算が必ずその運行のぶんだけ
 * 合わない** (2026-07 帯広5台で 運行 2 本・¥38,295)。**運行を丸ごと開始月に入れれば、
 * 便の側も運行の側も同じ範囲を見る**ので検算は自然に閉じる (2026-08-23 オーナー判断)。
 *
 * `startTsByUnko` は運行NO → 運行開始の epoch 秒 (イベントCSV 由来)。**入っていない
 * 運行は `operationRunDate` が運行日 → 運行NO に落とす。**
 *
 * 選んだ運行の便は**日付で切らない** (翌月日付の便も合計に入る) ので
 * `outOfMonthTrips` は常に 0 — はみ出したぶんは `crossMonth` で数える。
 */
export function buildMonthlyAllowanceByOperationDate(
  ops: OperationAllowance[],
  ym: string,
  startTsByUnko: ReadonlyMap<string, number | null>,
): MonthlyAllowanceByOperationDate {
  const selected: OperationAllowance[] = []
  const others: OperationAllowance[] = []
  for (const op of ops) {
    const date = operationRunDate(startTsByUnko.get(op.unkoNo) ?? null, op.operationDate, op.unkoNo)
    if (date !== null && date.startsWith(ym)) selected.push(op)
    else others.push(op)
  }
  const rows = toReportRows(selected)
  const nextMonth = rows.filter(r => !r.date.startsWith(ym))
  const prevMonthOps = toReportRows(others).filter(r => r.date.startsWith(ym))
  return {
    ...aggregateMonthly(selected, groupRowsByUnko(rows), 0),
    crossMonth: {
      nextMonthLegs: nextMonth.length,
      nextMonthAllowanceYen: sumAllowanceYen(nextMonth),
      prevMonthOpsLegsInMonth: prevMonthOps.length,
      prevMonthOpsAllowanceYen: sumAllowanceYen(prevMonthOps),
    },
  }
}
