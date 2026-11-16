/**
 * 給油 (インタンク) 画面の純粋ロジック (Refs yhonda-ohishi/nginx#814)。
 * 移植元は CakePHP の `templates/FuelIntank/index.php` と `FuelIntankController::index`。
 * 画面 (`app/pages/fuel/intank.vue`) はここで組んだ文字列と判定を並べるだけ。
 */
import type { DtakoRowTimes, FuelIntankRow, FuelStart, FuelUploadResponse } from '~/types'

/** `YYYY-MM-DD HH:MM:SS` を数字だけに分ける。形が違えば null。 */
function splitDatetime(s: string): string[] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s)
  return m ? m.slice(1) : null
}

/**
 * start の選択肢の表示 (CakePHP の `slip_num . " " . i18nformat("yyMMdd_HHmmss")`)。
 * datetime の形が読めなければ原文のまま後ろに付ける。
 */
export function startLabel(start: FuelStart): string {
  const p = splitDatetime(start.datetime)
  const stamp = p ? `${p[0]!.slice(2)}${p[1]}${p[2]}_${p[3]}${p[4]}${p[5]}` : start.datetime
  return `${start.slip_num} ${stamp}`
}

/** 表の日時 (CakePHP の `yy/MM/dd HH:mm`)。null は空、読めない形は原文のまま。 */
export function formatShortDatetime(s: string | null | undefined): string {
  if (!s) return ''
  const p = splitDatetime(s)
  return p ? `${p[0]!.slice(2)}/${p[1]}/${p[2]} ${p[3]}:${p[4]}` : s
}

/** 小数 2 桁に丸める。`-0` は `+0` に寄せる (`(-0).toLocaleString()` は `"-0"` を出す)。 */
function round2(x: number): number {
  return Math.round(x * 100) / 100 + 0
}

/**
 * 数量の表示 (小数 2 桁・3 桁ごとに `,`。CakePHP の `Number::format($q, ["places" => 2])`)。
 * 先に 2 桁へ丸めるので `-0.001` は `-0.00` ではなく `0.00` になる。
 */
export function formatQuantity(q: number): string {
  return round2(q).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** `dtako_fuel_array` の 1 件 (`yyyyMMddHHmm_1,234.50`) を読んだもの。 */
export interface FuelArrayEntry {
  /** `yyyy/MM/dd HH:mm` */
  datetime: string
  quantity: number
}

/** `dtako_fuel_array` の 1 件を日時と数量に分ける。形が違えば null。 */
export function parseFuelArrayEntry(s: string): FuelArrayEntry | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})_(-?[\d,]+(?:\.\d+)?)$/.exec(s)
  if (!m) return null
  return {
    datetime: `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}`,
    quantity: Number(m[6]!.replace(/,/g, '')),
  }
}

/** dtako_row_id の付け替えの選択肢 1 件。`value` が空文字なら NULL に戻す。 */
export interface DtakoRowOption {
  value: string
  label: string
}

/**
 * `dtako_fuel_array` を付け替えの選択肢にする (CakePHP の `<select name="dtako_row_id">`)。
 * 1 つの運行に給油が複数あれば同じ value が複数並ぶ (CakePHP と同じ)。読めない項目は原文を表示する。
 * `current` (いま紐づいている dtako_row_id) が選択肢に無ければ先頭に足す — 無いままだと select が
 * 別の項目を選んだ見た目になり、「保存」で黙って付け替わる。
 * `times` (`dtako_row_times`) にその運行があれば、運行の出庫・帰庫日時も並べる (null の側は「—」)。
 */
export function dtakoRowOptions(
  array: Record<string, string[]> | null | undefined,
  current?: string | null,
  times?: Record<string, DtakoRowTimes> | null,
): DtakoRowOption[] {
  const options = Object.entries(array ?? {}).flatMap(([id, entries]) => entries.map((raw) => {
    const e = parseFuelArrayEntry(raw)
    const what = e ? `${e.datetime} ${formatQuantity(e.quantity)}` : raw
    const idText = id === '' ? '運行なし' : id
    const t = times?.[id]
    if (!t) return { value: id, label: `${what} (${idText})` }
    const span = `出庫 ${formatShortDatetime(t.departed_at) || '—'} 〜 帰庫 ${formatShortDatetime(t.returned_at) || '—'}`
    return { value: id, label: `給油 ${what} ｜ ${span} ｜ ${idText}` }
  }))
  if (current && !options.some(o => o.value === current)) {
    options.unshift({ value: current, label: `${current} (いまの値・当日の給油に無し)` })
  }
  return options
}

/**
 * 差異 (給油の数量 − dtako の合計)。dtako の合計が無い行は null (CakePHP は「error」と出す)。
 * 小数 2 桁に丸める (浮動小数の誤差で 0 が 0 でなくならないように)。
 */
export function quantityDiff(row: FuelIntankRow): number | null {
  if (row.dtako_fuel_sum == null) return null
  return round2((row.qt ?? 0) - row.dtako_fuel_sum)
}

/**
 * Dtako とずれている行か (画面は行ごと色付けする)。差異が 0 でなければ true、dtako の合計が無い
 * (集計なし) 行は数量が 0 でも true。ユーザーの依頼 (nginx#814) で、集計なしは常に強調する
 * — CakePHP は `Qt - null` を差異とみなしたので数量 0 の集計なしを強調しなかったが、そこは変えた。
 */
export function isDiffHighlighted(row: FuelIntankRow): boolean {
  const d = quantityDiff(row)
  return d === null || d !== 0
}

/** `YYYY-MM-DD…` の日付に日数を足して `YYYY-MM-DD` にする (暦の計算だけなので UTC で数える)。 */
function shiftDate(ymd: string, days: number): string {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10)
}

/**
 * 「日報を直す」で開く `/daily-report-edit` の query。値は日報編集の期間欄 (datetime-local の
 * `YYYY-MM-DDTHH:mm`) の形。日報の一覧は読取日 (退社日時) で絞るので、`to` は帰庫日の**翌日** 23:59
 * にして、読取日が帰庫より後になる運行を落とさない。出庫・帰庫が無い (集計なし) 行は給油日の
 * 前日 00:00 〜 翌日 23:59。`driver` は乗務員名 (無ければ付けない)。`vehicleCd` は車輌CD
 * (`normalizeVehicleCd` で 1〜8 桁になるときだけ。日報編集の車輌CD 欄の形)。
 */
export function dailyReportEditQuery(row: FuelIntankRow): Record<string, string> {
  const departed = row.dtako_row?.departed_at || row.dtako_row?.returned_at
  const returned = row.dtako_row?.returned_at || row.dtako_row?.departed_at
  const from = departed ? shiftDate(departed, 0) : shiftDate(row.datetime, -1)
  const to = returned ? shiftDate(returned, 1) : shiftDate(row.datetime, 1)
  const query: Record<string, string> = { from: `${from}T00:00`, to: `${to}T23:59` }
  const driver = row.dtako_row?.driver_name?.trim()
  if (driver) query.driver = driver
  const vehicleCd = normalizeVehicleCd(row.car?.vehicle_cd)
  if (vehicleCd && vehicleCd.length <= 8) query.vehicleCd = vehicleCd
  return query
}

/**
 * 車輌CD の比較・受け渡し用の形。数字だけなら先頭ゼロを落とした文字列 (全部 0 なら `"0"`)、
 * それ以外 (空・null・数字以外を含む) は null。DB の値 (`"0000002158"`) と theearth の
 * masters の code (`"2158"`) の先頭ゼロの差は、ここ 1 か所だけで吸収する。
 */
export function normalizeVehicleCd(v: string | null | undefined): string | null {
  if (!v || !/^\d+$/.test(v)) return null
  return v.replace(/^0+(?=\d)/, '')
}

/**
 * 「位置を見る」で開く `/dvr-map` の query。`vehicle` は車輌CD、`at` は給油日時 (`YYYY-MM-DDTHH:mm`)。
 * 車輌CD が無い・読めない行は null (ボタンを出さない)。`at` の形は dvr-map 側が検査する。
 */
export function dvrMapQuery(row: FuelIntankRow): { vehicle: string, at: string } | null {
  const vehicle = normalizeVehicleCd(row.car?.vehicle_cd)
  if (!vehicle) return null
  return { vehicle, at: row.datetime.slice(0, 16).replace(' ', 'T') }
}

/** 数量の合計 (表の最下行。CakePHP の `$sum += $fuelIntank->Qt`)。小数 2 桁に丸める。 */
export function totalQuantity(rows: FuelIntankRow[]): number {
  return round2(rows.reduce((s, r) => s + (r.qt ?? 0), 0))
}

/** アップロード結果の 1 文。 */
export function uploadResultText(res: Pick<FuelUploadResponse, 'inserted' | 'skipped'>): string {
  return `追加 ${res.inserted} 件 / 既存 ${res.skipped} 件`
}

/** 応答の `key` (`utran/<sha256>.csv`) から sha256 を取り出す。形が違えば null。 */
export function sha256FromKey(key: string): string | null {
  const m = /^utran\/([0-9a-f]{64})\.csv$/.exec(key)
  return m ? m[1]! : null
}

/**
 * アップロードの失敗の 1 文。CSV の誤り (400 `{error:"csv", line, reason}`) だけは
 * 何行目の何が悪いかを出す。それ以外は null (呼び手が汎用の文にする)。
 * `request()` の Error は `API エラー (400): <本文>` の形で本文を持つ。
 */
export function describeCsvError(message: string): string | null {
  const m = /\(400\): (\{.*\})$/s.exec(message)
  if (!m) return null
  let body: unknown
  try {
    body = JSON.parse(m[1]!)
  }
  catch {
    return null
  }
  const b = body as { error?: unknown, line?: unknown, reason?: unknown }
  if (b.error !== 'csv') return null
  const where = typeof b.line === 'number' ? `${b.line} 行目` : '行不明'
  const why = typeof b.reason === 'string' ? b.reason : '理由不明'
  return `CSV の ${where}が読めません: ${why}`
}
