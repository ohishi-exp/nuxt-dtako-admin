/**
 * **積み (= 便) を「便ではない」と印を付けて、集計から外す** (pure)。
 *
 * `extractAllowanceLegs` は **積みイベント 1 つ = 1 便**として切り出す。ところが
 * デジタコには「実際には積んでいない積み」が混ざる。実データの例が
 * `2607152258300000001318` (柳井 亮祐 / 帯広800か1318) で、
 *
 * ```
 *  3 積み 釧路市西港1-98-41 → 釧路市西港1     11 積み 釧路市西港1 → 釧路市西港2
 *  5 降し 浦幌町統太                          12 運転 → 音更町駒場北町 (車庫)
 *  7 積み 釧路市西港1-98-41 → 釧路市西港1     13 運行終了
 *  9 降し 上士幌町上士幌東3線
 * ```
 *
 * のように **3 つ目の積みの後に降しが 1 つも無い**。卸地が永久に決まらないので
 * `未確定 (unknown)` の便として残り続ける。`carryOverDest` (次運行の先頭の降しから
 * 引き継ぐ) も当たらない。**ユーザー判断 (2026-08-21): この便は実在しない。**
 *
 * **黙って消さない。** 除外した便は件数を画面に出し、一覧から戻せるようにするのが
 * 呼び出し側の責務 (未突合・暫定手当と同じ方針)。
 *
 * ## キーは `seq` ではなく**積みの開始日時**で持つ
 *
 * `allowance-ichiban.ts` の `legKey` = `運行NO#seq` は**その運行の中の積みの順番**なので、
 * **イベントCSV を取り直して積みが 1 つ増減すると、同じキーが別の便を指す**
 * (前に積みが挿入されれば以降の便が全部ずれる)。除外は給与に効くので、静かに
 * 別の便を落とすのは許容できない。**積みイベントの開始日時は運行の中で一意**で、
 * 取り直しても動かないので、そちらを鍵にする (`運行NO#t<epoch秒>`)。
 * 開始日時が読めない積みだけ `運行NO#s<seq>` に落とす。
 *
 * それでも当たらなくなったキーは `staleExclusionKeys` が拾う — **同じ運行が集計に
 * 居るのに、その除外がどの便にも当たっていない**なら、イベントCSV が変わったという
 * ことなので、黙って効かなくするのではなく画面に出す。
 */
import type { AllowanceReportRow, DriverNode, MonthlyAllowance, OperationNode } from './allowance-report'

/** localStorage のキー。**形を変えるときは番号を上げる。** */
export const EXCLUDED_KEY = 'dtako:allowance:excluded:v1'

/** 除外した便のキー → `true`。値を持たせていないのは「あるかないか」しか要らないため。 */
export type ExcludedMap = Record<string, true>

/** キーを組むのに要る分だけ。 */
export type ExcludableRow = Pick<AllowanceReportRow, 'unkoNo' | 'seq' | 'fromTs'>

/**
 * 便を一意に指すキー。**積みの開始日時**を鍵にして、取り直しで積みが増減しても
 * 同じ便を指し続けるようにする (上の「キーは `seq` ではなく」参照)。
 */
export function excludedKey(row: ExcludableRow): string {
  if (row.fromTs === null) return `${row.unkoNo}#s${row.seq}`
  return `${row.unkoNo}#t${row.fromTs}`
}

/** キーの運行NO 側。`staleExclusionKeys` が「同じ運行が居るか」を見るのに使う。 */
export function unkoNoOfKey(key: string): string {
  const at = key.indexOf('#')
  if (at < 0) return key
  return key.slice(0, at)
}

/**
 * 保存済みの除外を読む。**壊れていても投げない** — 空として扱う。
 * `true` 以外の値は捨てる (将来キーに理由を持たせても、古い形を誤解しないため)。
 */
export function parseExcluded(raw: string | null | undefined): ExcludedMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: ExcludedMap = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key) continue
    if (value !== true) continue
    out[key] = true
  }
  return out
}

export function serializeExcluded(map: ExcludedMap): string {
  return JSON.stringify(map)
}

/** その便が除外されているか。 */
export function isExcluded(row: ExcludableRow, map: ExcludedMap): boolean {
  return map[excludedKey(row)] === true
}

/**
 * 除外を入れる / 戻す。**同じキーをもう一度渡せば戻る** (画面の「除外」「戻す」が
 * 同じ関数で書ける)。空キーは何もしない。
 */
export function toggleExcluded(map: ExcludedMap, key: string): ExcludedMap {
  if (!key) return map
  const next = { ...map }
  if (next[key] === true) delete next[key]
  else next[key] = true
  return next
}

/** 除外を反映した集計と、外した便そのもの。 */
export interface ExclusionResult {
  /** 除外したぶんを**どの合計からも**抜いた集計。 */
  monthly: MonthlyAllowance
  /** 外した便 (一覧に出して戻すのに使う)。集計の並び順 (乗務員 → 運行 → 便)。 */
  rows: AllowanceReportRow[]
}

/** 除外が 1 件も当たらなかったときに返す配列。**毎回同じ identity を返す** —
 * 中身が同じなのに新しい配列を返すと、これを読む `computed` が作り直されて
 * 表の選択が飛ぶ。 */
const NO_ROWS: AllowanceReportRow[] = []

function rebuildOperation(op: OperationNode, map: ExcludedMap): OperationNode {
  const rows = op.rows.filter(row => !isExcluded(row, map))
  // 1 便も外れていない運行は**そのまま返す** (identity を無駄に変えない)。
  if (rows.length === op.rows.length) return op
  const next: OperationNode = { ...op, rows, trips: 0, totalYen: 0, irregularTrips: 0, carriedTrips: 0 }
  for (const row of rows) {
    if (row.destSource === 'carried') next.carriedTrips += 1
    if (row.allowanceYen === null) next.irregularTrips += 1
    else {
      next.trips += 1
      next.totalYen += row.allowanceYen
    }
  }
  return next
}

function rebuildDriver(driver: DriverNode, map: ExcludedMap): DriverNode {
  const operations = driver.operations.map(op => rebuildOperation(op, map))
  return {
    driverName: driver.driverName,
    operations,
    trips: operations.reduce((sum, op) => sum + op.trips, 0),
    totalYen: operations.reduce((sum, op) => sum + op.totalYen, 0),
    irregularTrips: operations.reduce((sum, op) => sum + op.irregularTrips, 0),
    carriedTrips: operations.reduce((sum, op) => sum + op.carriedTrips, 0),
    // 便を 1 つも取れなかった運行の本数は除外と関係ない (便が無いので外しようがない)。
    failedOperations: driver.failedOperations,
  }
}

/**
 * `buildMonthlyAllowance` の結果から、除外した便を抜く。
 *
 * **便が 0 になった運行も残す。** その運行自体は実在するので、一覧から消えると
 * 「運行を開く」で中身を確かめる手段が無くなる (`buildMonthlyAllowance` は
 * 対象月の便を持たない運行を出さないが、こちらは人が外した結果なので扱いが違う)。
 *
 * 1 件も当たらなければ**渡された集計をそのまま返す** (identity を変えない)。
 */
export function applyExclusions(monthly: MonthlyAllowance, map: ExcludedMap): ExclusionResult {
  const rows: AllowanceReportRow[] = []
  for (const driver of monthly.drivers) {
    for (const op of driver.operations) {
      for (const row of op.rows) {
        if (isExcluded(row, map)) rows.push(row)
      }
    }
  }
  if (rows.length === 0) return { monthly, rows: NO_ROWS }
  const drivers = monthly.drivers.map(driver => rebuildDriver(driver, map))
  return {
    monthly: {
      drivers,
      trips: drivers.reduce((sum, d) => sum + d.trips, 0),
      totalYen: drivers.reduce((sum, d) => sum + d.totalYen, 0),
      irregularTrips: drivers.reduce((sum, d) => sum + d.irregularTrips, 0),
      carriedTrips: drivers.reduce((sum, d) => sum + d.carriedTrips, 0),
      failedOperations: monthly.failedOperations,
      // 対象月の外の便は元から合計に入っていない。除外しても動かない。
      outOfMonthTrips: monthly.outOfMonthTrips,
    },
    rows,
  }
}

/** 除外が 1 件も当たらなかったときに返す配列 (`NO_ROWS` と同じ理由)。 */
const NO_KEYS: string[] = []

/**
 * **当たらなくなった除外のキー。**
 *
 * 同じ運行が集計に居るのに、その運行に対する除外がどの便にも当たっていないもの。
 * **イベントCSV が変わって積みが動いた**ということなので、黙って効かなくせずに
 * 画面へ出す (別の月の除外は運行ごと居ないので、ここには出ない)。
 *
 * **`applyExclusions` に通す前の集計を渡すこと。** 通した後は除外した便が消えている
 * ので、当たっていた除外まで「当たらなかった」に見える。
 */
export function staleExclusionKeys(monthly: MonthlyAllowance, map: ExcludedMap): string[] {
  const keys = Object.keys(map)
  if (keys.length === 0) return NO_KEYS
  const known = new Set<string>()
  const hit = new Set<string>()
  for (const driver of monthly.drivers) {
    for (const op of driver.operations) {
      known.add(op.unkoNo)
      for (const row of op.rows) {
        const key = excludedKey(row)
        if (map[key] === true) hit.add(key)
      }
    }
  }
  return keys.filter(key => !hit.has(key) && known.has(unkoNoOfKey(key))).sort()
}
