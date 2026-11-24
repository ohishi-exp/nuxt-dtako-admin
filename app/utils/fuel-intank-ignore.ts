/**
 * 誤差一覧の「無視」(D1 `fuel_intank_ignores`、migration 0020) の純粋ロジック。
 * 画面 (`app/pages/fuel/intank.vue`) と server route (`server/api/fuel/intank-ignores.*.ts`) が共有する。
 */

/** 給油行の鍵 (fuel_intank の主キー)。 */
export interface FuelIntankIgnoreKey {
  datetime: string
  fuel_card_id: number
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** 一覧で引くための文字列の鍵 (`{datetime};{fuel_card_id}`。fuel_intank の id_st と同じ形)。 */
export function ignoreKey(k: FuelIntankIgnoreKey): string {
  return `${k.datetime};${k.fuel_card_id}`
}

/** `PUT /api/fuel/intank-ignores` の本文 `{datetime, fuel_card_id, ignored}` を読む。形が違えば error。 */
export function parseIgnoreBody(
  raw: unknown,
): { ok: true, key: FuelIntankIgnoreKey, ignored: boolean } | { ok: false, error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'body がオブジェクトではありません' }
  const b = raw as Record<string, unknown>
  if (typeof b.datetime !== 'string' || !DATETIME_RE.test(b.datetime)) {
    return { ok: false, error: 'datetime は YYYY-MM-DD HH:MM:SS で指定してください' }
  }
  if (typeof b.fuel_card_id !== 'number' || !Number.isSafeInteger(b.fuel_card_id) || b.fuel_card_id < 0) {
    return { ok: false, error: 'fuel_card_id は 0 以上の整数で指定してください' }
  }
  if (typeof b.ignored !== 'boolean') return { ok: false, error: 'ignored は true か false で指定してください' }
  return { ok: true, key: { datetime: b.datetime, fuel_card_id: b.fuel_card_id }, ignored: b.ignored }
}
