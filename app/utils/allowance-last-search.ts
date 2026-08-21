/**
 * 運行手当タブの**前回の検索条件**をブラウザに残す (pure)。
 *
 * 月は既定で「今月」になるが、給与を見るのはたいてい**先月**で、開くたびに月を
 * 選び直すことになる。車輌CD も同じ。**対象乗務員は既に保存している**
 * (`allowance-targets.ts`) のに、月と車輌CD だけ毎回消えるのは筋が通らない。
 *
 * 条件を戻せば、`allowance-cache.ts` に**その月の取得結果が残っている**ので、
 * 通信せずに前回の集計をそのまま出せる (呼び出し側の責務)。
 *
 * **キャッシュ本体とはキーを分ける。** キャッシュは月を 3 つまで持ち古い順に捨てるが、
 * 「最後に見た条件」は 1 つしかなく、捨てる規則も違う。同じ入れ物に混ぜると、
 * キャッシュが溢れて捨てられたときに条件まで一緒に消える。
 */

/** localStorage のキー。**形を変えるときは番号を上げる。** */
export const LAST_SEARCH_KEY = 'dtako:allowance:last-search:v1'

export interface LastSearch {
  /** `YYYY-MM`。 */
  ym: string
  /** 車輌CD。未指定なら空文字。 */
  vehicle: string
}

/** `2026-07` の形か。**月は 01〜12 だけ通す** — `2026-13` を復元すると 0 件になる。 */
const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * 保存済みの条件を読む。**壊れていても投げない** — 「無かった」として扱い、
 * 呼び出し側は既定 (今月) のままにする。
 */
export function parseLastSearch(raw: string | null | undefined): LastSearch | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { ym, vehicle } = parsed as Partial<Record<keyof LastSearch, unknown>>
  if (typeof ym !== 'string' || !YM_RE.test(ym)) return null
  return { ym, vehicle: typeof vehicle === 'string' ? vehicle.trim() : '' }
}

export function serializeLastSearch(search: LastSearch): string {
  return JSON.stringify({ ym: search.ym, vehicle: search.vehicle.trim() })
}
