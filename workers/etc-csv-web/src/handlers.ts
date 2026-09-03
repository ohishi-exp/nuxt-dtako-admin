/**
 * 配信 3 口 (`/list` / `/list?date=` / `/download`) の判断そのもの。
 *
 * `Request` / `Response` を触らず、偽のバケットで node からそのままテストできる形に
 * してある (`src/index.ts` は「HTTP ↔ ここ」の変換だけを持つ薄い層)。
 *
 * ★ **このファイルの 3 口はすべて読み取り専用**で、R2 へ書く経路はここにも
 * worker 全体にも無い。ただし **worker には実行の口が 1 つある** —
 * `POST /run` (`run.ts`、Refs #1111) は relay 経由で etc-meisai.jp のスクレイプを
 * 起こす。**「この worker は読むだけ」とはもう言えない。**
 */

import { isAllowedUserId } from './allowlist'
import {
  ETC_CSV_DATE_PATTERN,
  filenameFromKey,
  parseEtcCsvKey,
  resolveR2Prefix,
  userDatesPrefix,
  userDayPrefix,
} from './keys'
import { listDateDirs, listEtcCsvObjects, type R2BucketLite } from './r2'

export interface EtcCsvConfig {
  /** wrangler.toml `[vars] ETC_R2_PREFIX`。 */
  r2Prefix: string | undefined
  /** dashboard の plain 変数 `ETC_CSV_ALLOWED_USER_IDS` (カンマ区切り)。 */
  allowedUserIds: string | undefined
}

export interface JsonResult {
  status: number
  body: unknown
}

export type DownloadResult = ({ kind: 'json' } & JsonResult) | { kind: 'csv'; bytes: Uint8Array; filename: string }

const R2_MISSING: JsonResult = { status: 503, body: { error: 'R2 binding (DTAKO_R2) not available' } }
const PREFIX_INVALID: JsonResult = {
  status: 503,
  body: { error: 'ETC_R2_PREFIX must be one of etc / etc-staging / etc-preview' },
}
/** allowlist 外の `user_id` は「無い」と答える — 存在の有無すら漏らさないため。 */
const NOT_FOUND: JsonResult = { status: 404, body: { error: 'not found' } }

/**
 * `GET /list?user_id=…[&date=YYYY-MM-DD]`
 *
 * - `date` 省略 → その user の日付ディレクトリ一覧 (`delimitedPrefixes` 由来)
 * - `date` 指定 → その日のオブジェクト `[{key, size, uploaded}]`
 */
export async function listResult(
  bucket: R2BucketLite | undefined,
  config: EtcCsvConfig,
  userId: string | null,
  date: string | null,
): Promise<JsonResult> {
  if (!bucket) return R2_MISSING
  const prefix = resolveR2Prefix(config.r2Prefix)
  if (!prefix) return PREFIX_INVALID
  if (!userId) return { status: 400, body: { error: 'user_id is required' } }
  // 未設定なら `isAllowedUserId` が常に false を返す (fail-closed)。
  if (!isAllowedUserId(config.allowedUserIds, userId)) return NOT_FOUND

  if (date === null) {
    const dates = await listDateDirs(bucket, userDatesPrefix(prefix, userId))
    return { status: 200, body: { user_id: userId, dates } }
  }
  if (!ETC_CSV_DATE_PATTERN.test(date)) {
    return { status: 400, body: { error: 'invalid date (expected YYYY-MM-DD)' } }
  }
  const objects = await listEtcCsvObjects(bucket, userDayPrefix(prefix, userId, date))
  return { status: 200, body: { user_id: userId, date, objects } }
}

/**
 * `GET /download?key=<r2 key>` — R2 の本体をそのまま返す。
 *
 * Shift_JIS のまま返す (etc-meisai の CSV は Shift_JIS。UTF-8 に変換しない)。
 * 変換すると取り込み先の期待とずれるうえ、原本性も失われる。
 */
export async function downloadResult(
  bucket: R2BucketLite | undefined,
  config: EtcCsvConfig,
  key: string | null,
): Promise<DownloadResult> {
  if (!bucket) return { kind: 'json', ...R2_MISSING }
  const prefix = resolveR2Prefix(config.r2Prefix)
  if (!prefix) return { kind: 'json', ...PREFIX_INVALID }
  if (!key) return { kind: 'json', status: 400, body: { error: 'key is required' } }

  const parts = parseEtcCsvKey(key)
  if (!parts) return { kind: 'json', status: 400, body: { error: 'invalid ETC CSV key' } }
  // この worker が配れるのは自分の env の prefix だけ (鍵の形としては
  // etc-staging / etc-preview も通るが、それは別環境のデータなので配らない)。
  if (parts.prefix !== prefix) return { kind: 'json', ...NOT_FOUND }
  if (!isAllowedUserId(config.allowedUserIds, parts.userId)) return { kind: 'json', ...NOT_FOUND }

  const obj = await bucket.get(key)
  if (!obj) return { kind: 'json', ...NOT_FOUND }
  return { kind: 'csv', bytes: new Uint8Array(await obj.arrayBuffer()), filename: filenameFromKey(key) }
}
