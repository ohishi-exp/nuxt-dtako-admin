/**
 * ETC 明細 CSV の R2 鍵まわり (pure ロジック)。
 *
 * この worker は **任意の R2 prefix を外から渡せる汎用 lister ではない**。
 * 読める鍵は `{etc|etc-staging|etc-preview}/{user_id}/{YYYY-MM-DD}/{HHMMSS}.csv`
 * の形だけで、prefix は `ETC_R2_PREFIX` (wrangler.toml の [vars]) で固定する。
 */

/**
 * `{etc|etc-staging|etc-preview}/{user_id}/{YYYY-MM-DD}/{HHMMSS}.csv` のみ許可
 * (`workers/dtako-scraper-relay/src/cron.ts` の `etcCsvKey()` が生成する形式と一致。
 * セグメント文字種を絞ることで path traversal と Content-Disposition header
 * injection の両方を防ぐ)。
 *
 * ★ 出どころ: `server/api/etc-csv/download.get.ts` の `ETC_CSV_KEY_PATTERN` の写し。
 * 同じ R2 オブジェクトを返す口が 2 つある以上、片方だけを緩めると
 * 「admin 画面では弾かれるのにこの worker では通る鍵」が生まれる。
 * `test/key-pattern-parity.test.ts` が両者の `source` / `flags` の一致を検査するので、
 * 変えるときは必ず両方を同時に変えること
 * (`server/` と `workers/` の間に実コードの import 前例が 0 件なので、
 *  共有モジュールへの切り出しではなく「写し + 一致テスト」で担保している)。
 */
export const ETC_CSV_KEY_PATTERN =
  /^etc(?:-staging|-preview)?\/[A-Za-z0-9_-]+\/\d{4}-\d{2}-\d{2}\/\d{6}\.csv$/

/** `YYYY-MM-DD` の日付ディレクトリ名。 */
export const ETC_CSV_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** `ETC_R2_PREFIX` として受け付ける値。これ以外は設定ミスとして fail-closed する
 * (ここを自由にすると「汎用の R2 lister」になってしまう)。 */
const ALLOWED_R2_PREFIXES: readonly string[] = ['etc', 'etc-staging', 'etc-preview']

export interface EtcCsvKeyParts {
  prefix: string
  userId: string
  date: string
  time: string
}

/** 鍵を分解する。形が合わなければ `null` (= 読ませない)。 */
export function parseEtcCsvKey(key: string): EtcCsvKeyParts | null {
  if (!ETC_CSV_KEY_PATTERN.test(key)) return null
  const [prefix, userId, date, file] = key.split('/') as [string, string, string, string]
  return { prefix, userId, date, time: file.slice(0, 6) }
}

/** ダウンロード時の filename。鍵は検証済みなので header injection しない
 * (`server/api/etc-csv/download.get.ts` と同じ組み立て)。 */
export function filenameFromKey(key: string): string {
  return key.split('/').slice(1).join('_')
}

/** 設定された prefix を検証して返す。未知の値なら `null` (fail-closed)。 */
export function resolveR2Prefix(raw: string | undefined): string | null {
  const value = (raw ?? 'etc').trim()
  return ALLOWED_R2_PREFIXES.includes(value) ? value : null
}

/** `{prefix}/{user_id}/` — 日付ディレクトリ一覧を引くための prefix。 */
export function userDatesPrefix(r2Prefix: string, userId: string): string {
  return `${r2Prefix}/${userId}/`
}

/** `{prefix}/{user_id}/{date}/` — その日のオブジェクトを引くための prefix。 */
export function userDayPrefix(r2Prefix: string, userId: string, date: string): string {
  return `${r2Prefix}/${userId}/${date}/`
}
