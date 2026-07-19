/**
 * rust-ichibanboshi (一番星売上 API、CAPE#01 経由) への upstream fetch 共通処理
 * (Refs #330 PR4)。CF Access Service Token 付与ロジックが
 * `server/api/ichiban/[...path].get.ts` (thin proxy) と `server/api/profit/monthly.get.ts`
 * (月次集計、vehicle-daily を直接叩く) の両方で重複していたため抽出した。
 */

interface SecretBinding { get(): Promise<string> }

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す。 */
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as SecretBinding).get === 'function') {
    try {
      return (await (binding as SecretBinding).get()) ?? null
    }
    catch {
      return null
    }
  }
  return null
}

const DEFAULT_ICHIBAN_API_URL = 'https://rust-ichiban.mtamaramu.com'

/** binding未設定 (503相当) / fetch失敗 (502相当) を呼び出し元に伝える。
 * h3 の `createError` に依存しないのは、このモジュールが server route 外
 * (テスト等) からも使えるようにするため — 呼び出し元で `createError` に変換する。 */
export class IchibanUpstreamError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}

/**
 * `<NUXT_ICHIBAN_API_URL>/{path}{search}` に CF Access Service Token 付きで GET する。
 * upstream の応答 (2xx/非2xx問わず) はそのまま `Response` として返す — 意味づけ
 * (passthrough か JSON parse して検証するか) は呼び出し元の責務。
 */
export async function fetchIchiban(env: Record<string, unknown>, path: string, search: string): Promise<Response> {
  const [clientId, clientSecret] = await Promise.all([
    resolveSecret(env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID),
    resolveSecret(env.ICHIBAN_CF_ACCESS_CLIENT_SECRET),
  ])
  if (!clientId || !clientSecret) {
    throw new IchibanUpstreamError(503, 'NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID/ICHIBAN_CF_ACCESS_CLIENT_SECRET binding が未設定です')
  }

  const baseUrl = (env.NUXT_ICHIBAN_API_URL as string | undefined) || DEFAULT_ICHIBAN_API_URL
  const upstreamUrl = new URL(`/${path}`, baseUrl)
  upstreamUrl.search = search

  try {
    return await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
        Accept: 'application/json',
      },
    })
  }
  catch (e: unknown) {
    throw new IchibanUpstreamError(502, `rust-ichibanboshi への接続に失敗しました: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** `event.context.cloudflare.env` を取り出す (未設定なら空オブジェクト)。 */
export function cfEnv(event: { context: unknown }): Record<string, unknown> {
  return (event.context as { cloudflare?: { env?: Record<string, unknown> } }).cloudflare?.env ?? {}
}
