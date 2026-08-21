/**
 * 運行手当の集計 (pure)。`allowance-trips.ts` が切り出した便を、画面の表・CSV・
 * 乗務員ごとの月合計に組み替える。
 *
 * **金額が決まらなかった便は合計に入れない。** 推測した数字を給与に混ぜるより、
 * 「何便が未確定か」を出して人に見せる (2026-08-21 ユーザー判断)。
 */
import { epochToYmd } from './ichiban'
import type { LegAllowance } from './allowance-trips'

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
  /** イベントCSV が引けなかった等の理由。引けていれば null。 */
  error: string | null
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
  originCity: string
  destCity: string
  /** 途中で降ろした市町村を `>` で連ねたもの (複数卸しの便だけ埋まる)。 */
  viaCities: string
  /** 引き当てたマスタの卸地。決まらなければ空。 */
  masterDest: string
  /** 決まらなければ null。 */
  allowanceYen: number | null
  status: 'ok' | 'ambiguous' | 'unknown'
}

/** 便の日付。積みの時刻が読めなければ運行日 → 読取日 の順に落とす。 */
export function legDate(op: OperationAllowance, fromTs: number | null): string {
  if (fromTs !== null) return epochToYmd(fromTs)
  return op.operationDate ?? op.readingDate
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
        originCity: leg.originCity,
        destCity: leg.destCity,
        viaCities: leg.viaCities.join('>'),
        masterDest: lookup.status === 'ok' ? lookup.dest : '',
        allowanceYen: lookup.status === 'ok' ? lookup.allowanceYen : null,
        status: lookup.status,
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
  // 乗務員名は Map のキーなので重複しない。`localeCompare` は使わない
  // (ICU の照合順が Windows と Linux で逆転し CI だけ落ちる事故がある)。
  return [...map.values()].sort((a, b) => (a.driverName > b.driverName ? 1 : -1))
}

const CSV_HEADER = [
  '運行NO', '日付', '乗務員', '車輌', '便', '積地(市町村)', '卸地(市町村)',
  '途中卸し', 'マスタ卸地', '手当', '状態',
]

/** CSV の各行 (先頭はヘッダ)。値にカンマが入りうるので必ず引用する。 */
export function reportRowsToCsvLines(rows: AllowanceReportRow[]): string[] {
  const quote = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [
    CSV_HEADER.map(quote).join(','),
    ...rows.map(r => [
      r.unkoNo, r.date, r.driverName, r.vehicleName, r.seq, r.originCity, r.destCity,
      r.viaCities, r.masterDest, r.allowanceYen, r.status,
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
  /** 金額が決まらなかった便数 (= 未確定)。 */
  irregularTrips: number
}

/** 乗務員 1 人ぶんの月まとめ (展開すると運行が見える)。 */
export interface DriverNode {
  driverName: string
  operations: OperationNode[]
  trips: number
  totalYen: number
  irregularTrips: number
  /** 便を 1 つも取れなかった運行の本数。 */
  failedOperations: number
}

export interface MonthlyAllowance {
  drivers: DriverNode[]
  trips: number
  totalYen: number
  irregularTrips: number
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
  const rowsByUnko = new Map<string, AllowanceReportRow[]>()
  for (const row of inMonth) {
    const list = rowsByUnko.get(row.unkoNo) ?? []
    list.push(row)
    rowsByUnko.set(row.unkoNo, list)
  }

  const byDriver = new Map<string, DriverNode>()
  for (const op of ops) {
    const rows = rowsByUnko.get(op.unkoNo) ?? []
    if (rows.length === 0 && op.error === null) continue
    const node = emptyOperationNode(op)
    node.rows = rows
    for (const row of rows) {
      if (row.allowanceYen === null) node.irregularTrips += 1
      else {
        node.trips += 1
        node.totalYen += row.allowanceYen
      }
    }
    const name = op.driverName ?? ''
    const driver = byDriver.get(name)
      ?? { driverName: name, operations: [], trips: 0, totalYen: 0, irregularTrips: 0, failedOperations: 0 }
    driver.operations.push(node)
    driver.trips += node.trips
    driver.totalYen += node.totalYen
    driver.irregularTrips += node.irregularTrips
    if (op.error !== null) driver.failedOperations += 1
    byDriver.set(name, driver)
  }

  // 乗務員名は Map のキーなので重複しない。`localeCompare` は使わない
  // (ICU の照合順が環境で入れ替わり CI だけ落ちる)。
  const drivers = [...byDriver.values()].sort((a, b) => (a.driverName > b.driverName ? 1 : -1))
  for (const driver of drivers) {
    driver.operations.sort((a, b) => (a.readingDate > b.readingDate ? 1 : -1))
  }
  return {
    drivers,
    trips: drivers.reduce((sum, d) => sum + d.trips, 0),
    totalYen: drivers.reduce((sum, d) => sum + d.totalYen, 0),
    irregularTrips: drivers.reduce((sum, d) => sum + d.irregularTrips, 0),
    failedOperations: drivers.reduce((sum, d) => sum + d.failedOperations, 0),
    outOfMonthTrips: allRows.length - inMonth.length,
  }
}
