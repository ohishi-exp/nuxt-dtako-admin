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
