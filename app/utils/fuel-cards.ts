/**
 * 給油カード画面の純粋ロジック (Refs yhonda-ohishi/nginx#814)。
 * 移植元は CakePHP の `templates/FuelCards/index.php`・`edit.php`。
 */
import type { FuelCar, FuelCard, FuelCardPatch } from '~/types'

/** 車両の選択肢 (`USelect` の items)。名前が無い車両は id を出す。 */
export function carOptions(cars: FuelCar[]): { label: string, value: string }[] {
  return cars.map(c => ({ label: c.name ? `${c.name} (${c.id})` : c.id, value: c.id }))
}

/**
 * API の日時 (`YYYY-MM-DD HH:MM:SS`) を `<input type="datetime-local">` の値 (`YYYY-MM-DDTHH:MM`) にする。
 * null・読めない形は空 (= 未設定)。
 */
export function toDatetimeLocal(s: string | null): string {
  const m = s ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}$/.exec(s) : null
  return m ? `${m[1]}T${m[2]}` : ''
}

/**
 * `<input type="datetime-local">` の値を API の日時にする。空は null (= 終了日時の解除)。
 * 秒まで入っている値 (`YYYY-MM-DDTHH:MM:SS`) もそのまま受ける。読めない形は undefined (送らない)。
 */
export function fromDatetimeLocal(v: string): string | null | undefined {
  if (v === '') return null
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/.exec(v)
  return m ? `${m[1]} ${m[2]}${m[3] ?? ':00'}` : undefined
}

/**
 * 編集中の値から、変わった欄だけの PATCH を組む。何も変わっていなければ null (「保存」を押させない)。
 * 車両は選ばれていて今と違うときだけ、終了日時は `fromDatetimeLocal` が読めて今と違うときだけ載せる
 * (空は null = 終了日時の解除)。
 */
export function cardPatch(card: FuelCard, carId: string | undefined, endLocal: string): FuelCardPatch | null {
  const patch: FuelCardPatch = {}
  if (carId && carId !== card.car_id) patch.car_id = carId
  const end = fromDatetimeLocal(endLocal)
  if (end !== undefined && end !== card.end_datetime) patch.end_datetime = end
  return Object.keys(patch).length > 0 ? patch : null
}
