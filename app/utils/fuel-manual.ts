/**
 * 給油の手入力画面と再照合の純粋ロジック (Refs yhonda-ohishi/nginx#814)。
 * 移植元は CakePHP の `templates/FuelIntank/add_manual.php` と `FuelIntankController` の addNew・recheck。
 * 画面 (`app/pages/fuel/manual.vue`・`intank.vue`) はここで組んだ本文・文・判定を並べるだけ。
 */
import type { FuelCard, FuelIntankCreate, FuelIntankRow, FuelManualCandidatesResponse, FuelStart } from '~/types'
import { fromDatetimeLocal } from '~/utils/fuel-cards'
import { formatShortDatetime } from '~/utils/fuel-intank'

/** カードの選択肢の「start 行 (カード無し)」の値。reka の選択欄は空文字の値を持てない */
export const START_CARD = '__start__'

/** start 行の fuel_card_id (上流の `START_CARD_ID`)。手入力の fuel 行には使えない */
const START_CARD_ID = 9999

/** 上流の数量の上限 (未満)。 */
const QUANTITY_MAX = 1_000_000

/**
 * カードの選択肢 (`USelectMenu` の items)。先頭に start 行、続けて card を id 順に
 * (CakePHP は id を 4 桁 0 埋めで出していた)。車両名があれば後ろに付ける。
 */
export function manualCardItems(cards: FuelCard[]): { label: string, value: string }[] {
  const sorted = [...cards].sort((a, b) => a.id - b.id)
  return [
    { label: 'start 行 (カード無し)', value: START_CARD },
    ...sorted.map((c) => {
      const id = String(c.id).padStart(4, '0')
      return { label: c.car?.name ? `${id} ${c.car.name}` : id, value: String(c.id) }
    }),
  ]
}

/**
 * fuel 行の slip_num_parent (CakePHP の「type=start の最大値」)。start が無ければ undefined (送らない)。
 * start 行には付けない (CakePHP の JS も start を選ぶと hidden を消す。上流も start 行では使わない)。
 */
export function slipNumParent(starts: FuelStart[]): number | undefined {
  return starts.length > 0 ? Math.max(...starts.map(s => s.slip_num)) : undefined
}

/** 手入力の欄の値 (画面の ref のまま) */
export interface ManualInput {
  slipNum: string
  /** `<input type="datetime-local">` の値 */
  datetimeLocal: string
  /** `START_CARD` か card id の文字列。未選択は undefined */
  card: string | undefined
  /**
   * リットル。★ 数値も来る — Nuxt UI の `UInput type="number"` は打った値を `looseToNumber` で数値にして
   * emit する (読めなければ文字列のまま、空は `''`)
   */
  quantity: string | number
}

export type ManualBodyResult = { ok: true, body: FuelIntankCreate } | { ok: false, error: string }

/**
 * 入力を検査して `POST /api/fuel/intank` の本文を組む。読めない欄があれば、その欄の文を返す。
 * カード無し (start 行) は fuel_card_id・数量・slip_num_parent を送らない。
 */
export function buildManualBody(input: ManualInput, starts: FuelStart[]): ManualBodyResult {
  if (!/^\d+$/.test(input.slipNum.trim())) return { ok: false, error: '伝票番号を 0 以上の整数で入れてください' }
  const slip_num = Number(input.slipNum.trim())
  const datetime = fromDatetimeLocal(input.datetimeLocal)
  if (!datetime) return { ok: false, error: '日時を入れてください' }
  if (!input.card) return { ok: false, error: 'カードを選んでください (start 行ならカード無しを選ぶ)' }
  if (input.card === START_CARD) return { ok: true, body: { datetime, slip_num } }
  const q = String(input.quantity).trim()
  if (!/^\d+(\.\d{1,2})?$/.test(q) || Number(q) >= QUANTITY_MAX) {
    return { ok: false, error: '数量 (L) を 0 以上 1000000 未満・小数 2 桁までで入れてください' }
  }
  const body: FuelIntankCreate = { datetime, slip_num, fuel_card_id: Number(input.card), quantity_decimal: Number(q) }
  const parent = slipNumParent(starts)
  if (parent !== undefined) body.slip_num_parent = parent
  return { ok: true, body }
}

/** 上流の `error` の値ごとの文 (400・404・409)。 */
const ERROR_TEXT: Record<string, string> = {
  not_manual: 'CSV から取り込んだ行は手入力で上書きできません',
  not_found: 'その行は見つかりませんでした (削除されたかもしれません。一覧を読み直してください)',
  datetime: '日時が読めません',
  slip_num: '伝票番号は 0 以上の整数で入れてください',
  fuel_card_id: 'そのカードの番号は使えません (0 と 9999 は不可)',
  quantity_decimal: '数量 (L) は 0 以上 1000000 未満で入れてください',
  slip_num_parent: 'start の伝票番号 (slip_num_parent) が読めません',
  unknown_field: '画面が送った本文を上流が受け付けませんでした (画面の不具合です)',
  invalid_json: '画面が送った本文を上流が受け付けませんでした (画面の不具合です)',
}

/**
 * 手入力・再照合の失敗の 1 文。上流の `{ok:false, error:<code>}` を読めて、文の対応があるときだけ返す。
 * それ以外は null (呼び手が `describeCaughtError` の汎用の文にする)。
 * `request()` の Error は `API エラー (<status>): <本文>` の形で本文を持つ。
 */
export function describeManualError(message: string): string | null {
  const m = /\((?:400|404|409)\): (\{.*\})$/s.exec(message)
  if (!m) return null
  let body: unknown
  try {
    body = JSON.parse(m[1]!)
  }
  catch {
    return null
  }
  const code = (body as { error?: unknown }).error
  // `ERROR_TEXT[code]` だけだと `toString` 等の組み込みの名前が関数を返すので、自前の鍵だけを見る
  return typeof code === 'string' && Object.hasOwn(ERROR_TEXT, code) ? ERROR_TEXT[code]! : null
}

/** 再照合のボタンを出すか: dtako_row_id が空の fuel 行 (start 行は照合しない)。 */
export function canRecheck(row: FuelIntankRow): boolean {
  return row.fuel_card_id !== START_CARD_ID && !row.dtako_row_id
}

/** 手入力の行 (`manual` が真の行)。 */
export function manualRows(rows: FuelIntankRow[]): FuelIntankRow[] {
  return rows.filter(r => r.manual === true)
}

/** 一覧のカードの欄 (4 桁 0 埋め。start 行は `(start)`)。 */
export function rowCardLabel(fuelCardId: number): string {
  return fuelCardId === START_CARD_ID ? '(start)' : String(fuelCardId).padStart(4, '0')
}

/** 「最新の行」の 1 文。行が無ければ null。 */
export function lastInsertedText(last: FuelManualCandidatesResponse['last_inserted']): string | null {
  if (!last) return null
  const card = last.fuel_card_id === START_CARD_ID ? 'start 行' : `card ${last.fuel_card_id}`
  return `${formatShortDatetime(last.datetime)} / ${card} / 伝票番号 ${last.slip_num ?? '(なし)'}`
}
