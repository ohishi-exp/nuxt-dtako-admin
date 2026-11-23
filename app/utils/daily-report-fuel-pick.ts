/**
 * 日報編集 (`/daily-report-edit`) の給油モーダルで、fuel (インタンク、rust-fuel-worker `/api/fuel/*`) の
 * 給油記録から 1 件選んで新規給油行の日時・数量を埋めるための純粋ロジック。
 *
 * fuel 側は「start 単位」でしか車輌CD (`car.vehicle_cd`) 付きの行を返さないので、運行の時間帯に
 * かかる start を選んで読み、同じ車輌CD の行を候補にする。
 */
import type { FuelIntankRow, FuelStart } from '~/types'
import { formatShortDatetime, normalizeVehicleCd } from '~/utils/fuel-intank'
import { isTargetRow, parseTargetOpeNo } from '~/utils/daily-report-target'

/**
 * theearth の日時 (`YYYY/MM/DD H:mm:ss`・`YYYY/MM/DD HH:mm`) と fuel の日時 (`YYYY-MM-DD HH:MM:SS`) を
 * 比べられる形 (`YYYY-MM-DD HH:MM`、ゼロ埋め = 辞書順が時系列順) にする。読めない形は null。
 */
export function comparableDatetime(s: string | null | undefined): string | null {
  const m = s ? /^(\d{4})[/-](\d{2})[/-](\d{2}) (\d{1,2}):(\d{2})/.exec(s) : null
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]!.padStart(2, '0')}:${m[5]}` : null
}

/**
 * 運行の時間帯 [from, to] にかかる start の datetime。start の窓は「その start から 1 つ新しい start の
 * 直前まで」(最新の start は終わり無し)。`starts` は新しい順 (`/api/fuel/starts` の順)。
 */
export function startsCovering(starts: readonly FuelStart[], from: string, to: string): string[] {
  // 読めない start は窓の境目にもしない (飛ばした隣の start の終わりが「無し」にならないように)
  const readable = starts.flatMap((s) => {
    const begin = comparableDatetime(s.datetime)
    return begin === null ? [] : [{ datetime: s.datetime, begin }]
  })
  return readable
    .filter(({ begin }, i) => begin <= to && (i === 0 || readable[i - 1]!.begin > from))
    .map(s => s.datetime)
}

export interface FuelPickCandidate {
  /** 選択肢の値 (`{datetime};{fuel_card_id}`) */
  key: string
  /** 新規行の日時欄に入れる値 (theearth の `YY/MM/DD HH:mm`) */
  dateTime: string
  /** 新規行の数量欄に入れる値 (小数 1 桁以上。`330` → `330.0`、`330.25` はそのまま) */
  quantity: string
  /** fuel 側がこの運行に紐づけている (`dtako_row_id` の先頭 22 桁 = 運行No) か */
  linked: boolean
  /** 運行の時間帯 (出庫〜退社) の中か */
  inOperation: boolean
  /** モーダルの給油行に同じ日時が既にあるか */
  alreadyEntered: boolean
  label: string
}

/** 数量 (リットル) を theearth の数量欄の形に。小数 2 桁に丸め、末尾の 0 は小数 1 桁まで落とす */
export function fuelQuantityText(qt: number): string {
  const s = (Math.round(qt * 100) / 100 + 0).toFixed(2)
  return s.endsWith('0') ? s.slice(0, -1) : s
}

/**
 * 候補: 車輌CD が一致し数量のある行。この運行に紐づく行 → 運行の時間帯の中 → それ以外の順、
 * 同じ順位の中は日時順。同じ行 (キー) が複数の start から来ても 1 つにする。
 * `enteredDateTimes` はモーダルの給油行の日時 (`YY/MM/DD HH:mm`)。
 */
export function fuelPickCandidates(
  rows: readonly FuelIntankRow[],
  operationNo: string,
  vehicleCd: string | null,
  from: string,
  to: string,
  enteredDateTimes: readonly string[],
): FuelPickCandidate[] {
  const want = normalizeVehicleCd(vehicleCd)
  if (want === null) return []
  const entered = new Set(enteredDateTimes.map(d => d.trim()))
  const seen = new Set<string>()
  const out: (FuelPickCandidate & { at: string })[] = []
  for (const r of rows) {
    const key = `${r.datetime};${r.fuel_card_id}`
    const at = comparableDatetime(r.datetime)
    if (r.qt == null || at === null || seen.has(key) || normalizeVehicleCd(r.car?.vehicle_cd) !== want) continue
    seen.add(key)
    const dateTime = formatShortDatetime(r.datetime)
    const quantity = fuelQuantityText(r.qt)
    const linked = isTargetRow(operationNo, parseTargetOpeNo(r.dtako_row_id))
    const inOperation = at >= from && at <= to
    const alreadyEntered = entered.has(dateTime)
    const marks = [
      linked ? 'この運行' : inOperation ? '運行中' : '運行外',
      ...(alreadyEntered ? ['入力済み'] : []),
    ]
    out.push({ key, at, dateTime, quantity, linked, inOperation, alreadyEntered, label: `${dateTime} ${quantity}L (${marks.join('・')})` })
  }
  const rank = (c: { linked: boolean, inOperation: boolean }) => (c.linked ? 2 : c.inOperation ? 1 : 0)
  out.sort((a, b) => rank(b) - rank(a) || a.at.localeCompare(b.at))
  return out.map(({ at: _at, ...c }) => c)
}
