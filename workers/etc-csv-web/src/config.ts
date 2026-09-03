/**
 * allowlist 2 つ (`user_id` / 許可オリジン) の解決。**KV が正、無ければ plain 変数**。
 *
 * 流儀は `auth-worker/src/lib/config.ts` (`KV-backed allowlist with in-memory cache`)
 * から借りている — キー名の `<scope>:<name>` 形式・60 秒の in-memory cache・
 * 「allowlist は秘密の値ではない」という置き場所の根拠。**コードは共通化しない**
 * (別 repo。`keys.ts` の正規表現と同じ判断で、新しいパッケージ境界を作るコストのほうが
 * 大きい)。あちらの doc から:
 *
 * > Secrets Store は使わない — 中身は「誰が管理者アカウントか」という設定であって
 * > 秘密の値ではなく (…)、既存の origins:* / app-orgs と同じ KV allowlist 規約に
 * > 揃える方が GCP Secret Manager 側の provisioning が要らず単純。
 *
 * ここも同じで、許可 `user_id` と許可オリジンは**秘密の値ではない**。
 *
 * ★★ 不変条件: **KV のキーはコンパイル時定数の 2 つだけ。**
 * この namespace (`AUTH_CONFIG`) には OAuth の refresh token・DCR・device 系が
 * 同居している。**リクエスト由来の文字列が `.get()` に到達する経路を 1 本も作らない。**
 * そのために `readKey` は module-private かつ引数の型が `EtcCsvConfigKey`
 * (2 つのリテラルの union) に絞ってある — 外から任意のキーを差し込めないだけでなく、
 * **このファイルの中でも 2 つ以外は型検査で通らない**。
 * `test/config.test.ts` が「リクエストを変えても `.get()` に渡る引数が変わらない」を
 * fake KV の呼び出し記録で検査する。
 */

/** KV binding の最小形 (cloudflare:workers の型に依存しないための構造的型)。 */
export interface EtcCsvConfigKvBinding {
  get(key: string): Promise<string | null>
}

/** 許可オリジン (1 件)。**README / wrangler.toml と一致させること。** */
export const ALLOWED_ORIGIN_KV_KEY = 'etc-csv:allowed-origin'

/** 許可する `user_id` (カンマ区切り)。**README / wrangler.toml と一致させること。** */
export const ALLOWED_USER_IDS_KV_KEY = 'etc-csv:allowed-user-ids'

/** この worker が `AUTH_CONFIG` から読んでよいキーの全体。**増やさないこと。** */
type EtcCsvConfigKey = typeof ALLOWED_ORIGIN_KV_KEY | typeof ALLOWED_USER_IDS_KV_KEY

/** `auth-worker/src/lib/config.ts` の `CACHE_TTL_MS` と同じ 60 秒。 */
const CACHE_TTL_MS = 60_000

interface CacheEntry {
  value: string
  expiresAt: number
}
const cache = new Map<string, CacheEntry>()

/**
 * KV から 1 キー読む。60 秒 in-memory cache。
 *
 * ★ **KV の読み取りが例外で失敗したら握らずそのまま投げる。** ここは
 * `auth-worker` の `readKey` (失敗を `""` に畳む) と**意図的に違える**:
 * あちらは `""` がそのまま「誰も許可しない」なので畳んでも fail-closed だが、
 * ここは `""` にすると**下の plain 変数へフォールバックしてしまう**。
 * 「値があるか分からない」ときに古い plain で走ると、**取り下げたはずの
 * `user_id` / オリジンに配り続ける**。読めなければ配らない (5xx) 方を選ぶ。
 * (この方針は relay の `cron.ts` `resolveKvConfigRaw` と同じ。)
 *
 * ★ cache の代償: **投入も取り下げも最大 60 秒遅れる。** allowlist は日常的に
 * 動かす値ではないのでこれを受け入れる (`auth-worker` が `origins:wt` だけ
 * `readKeyNoCache` にしているのは、あちらが秒単位で書き換わるため)。
 * **取り下げを即時にしたいときは worker を再 deploy すれば isolate ごと消える。**
 */
async function readKey(kv: unknown, key: EtcCsvConfigKey): Promise<string> {
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) return cached.value

  let value = ''
  if (kv && typeof (kv as EtcCsvConfigKvBinding).get === 'function') {
    value = (await (kv as EtcCsvConfigKvBinding).get(key)) ?? ''
  }
  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS })
  return value
}

/** 許可オリジン。KV `etc-csv:allowed-origin` が正、無ければ plain 変数。
 * どちらにも無ければ `undefined` (呼び出し側は CORS ヘッダを付けない = fail-closed)。 */
export async function resolveAllowedOrigin(
  kv: unknown,
  plain: string | undefined,
): Promise<string | undefined> {
  return (await readKey(kv, ALLOWED_ORIGIN_KV_KEY)) || plain
}

/** 許可 `user_id` (カンマ区切り)。KV `etc-csv:allowed-user-ids` が正、無ければ plain 変数。
 * どちらにも無ければ `undefined` (呼び出し側は誰も通さない = fail-closed)。 */
export async function resolveAllowedUserIds(
  kv: unknown,
  plain: string | undefined,
): Promise<string | undefined> {
  return (await readKey(kv, ALLOWED_USER_IDS_KV_KEY)) || plain
}

/** テスト専用の cache クリア (`auth-worker` の `_clearAllowedOriginsCache` と同じ位置づけ)。 */
export function _clearConfigCacheForTest(): void {
  cache.clear()
}
