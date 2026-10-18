/**
 * 給油 (インタンク) 画面の純粋ロジック (Refs yhonda-ohishi/nginx#814)。
 * 移植元は CakePHP の `templates/FuelIntank/index.php` と `FuelIntankController::index`。
 * 画面 (`app/pages/fuel/intank.vue`) はここで組んだ文字列と判定を並べるだけ。
 */
import type { FuelIntankRow, FuelStart, FuelUploadResponse } from '~/types'

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
 */
export function dtakoRowOptions(array: Record<string, string[]> | null | undefined, current?: string | null): DtakoRowOption[] {
  const options = Object.entries(array ?? {}).flatMap(([id, entries]) => entries.map((raw) => {
    const e = parseFuelArrayEntry(raw)
    const what = e ? `${e.datetime} ${formatQuantity(e.quantity)}` : raw
    return { value: id, label: `${what} (${id === '' ? '運行なし' : id})` }
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
 * 差異を強調するか。0 でなければ強調し、dtako の合計が無い行も強調する
 * (CakePHP は `Qt - null` を差異とみなすので、数量が 0 でない限り強調していた)。
 */
export function isDiffHighlighted(row: FuelIntankRow): boolean {
  const d = quantityDiff(row)
  return d === null ? (row.qt ?? 0) !== 0 : d !== 0
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
