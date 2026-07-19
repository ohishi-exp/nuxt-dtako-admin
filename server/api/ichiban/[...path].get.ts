/**
 * rust-ichibanboshi (一番星売上 API、CAPE#01 経由) への thin proxy (Refs #330)。
 *
 * GET /api/ichiban/** → <NUXT_ICHIBAN_API_URL>/** (CF Tunnel rust-ichiban.mtamaramu.com)
 * に CF Access Service Token (CF-Access-Client-Id/Secret ヘッダ) を付与して転送する。
 * Service Token は nuxt-ichibanboshi/nuxt-ichibanboshi-seikyu と共有する既存のもの
 * (`824a8b3c...`) を再利用する (新規発行しない)。client_id は公開識別子なので
 * `NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID` var、client_secret は Secrets Store binding
 * (`ICHIBAN_CF_ACCESS_CLIENT_SECRET`、secret_name="CF_ACCESS_CLIENT_SECRET" を
 * 物理共有) から解決する。追加の secrets-inventory 投入作業は不要 (wrangler.toml 参照)。
 *
 * upstream の応答 (status/body) はそのまま passthrough する — 400 等の API 側エラーも
 * 呼び出し元がそのまま受け取れるようにするための thin proxy であり、意味づけはしない。
 * binding 未設定は 503、fetch 自体の失敗 (tunnel down 等) は 502 で弾く。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getRequestURL, getRouterParam, createError, setResponseStatus, setHeader } from 'h3'

interface SecretBinding { get(): Promise<string> }

function cfEnv(event: H3Event): Record<string, unknown> {
  return (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
}

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

export default defineEventHandler(async (event) => {
  const env = cfEnv(event)
  const [clientId, clientSecret] = await Promise.all([
    resolveSecret(env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID),
    resolveSecret(env.ICHIBAN_CF_ACCESS_CLIENT_SECRET),
  ])
  if (!clientId || !clientSecret) {
    throw createError({
      statusCode: 503,
      statusMessage: 'NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID/ICHIBAN_CF_ACCESS_CLIENT_SECRET binding が未設定です',
    })
  }

  const baseUrl = (env.NUXT_ICHIBAN_API_URL as string | undefined) || DEFAULT_ICHIBAN_API_URL
  const pathParam = getRouterParam(event, 'path') ?? ''
  const upstreamUrl = new URL(`/${pathParam}`, baseUrl)
  upstreamUrl.search = getRequestURL(event).search

  let upstreamRes: Response
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
        Accept: 'application/json',
      },
    })
  }
  catch (e: unknown) {
    throw createError({
      statusCode: 502,
      statusMessage: `rust-ichibanboshi への接続に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    })
  }

  setResponseStatus(event, upstreamRes.status)
  const contentType = upstreamRes.headers.get('content-type')
  if (contentType) setHeader(event, 'Content-Type', contentType)
  return upstreamRes.text()
})
