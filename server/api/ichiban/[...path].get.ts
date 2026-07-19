/**
 * rust-ichibanboshi (一番星売上 API、CAPE#01 経由) への thin proxy (Refs #330)。
 *
 * GET /api/ichiban/** → <NUXT_ICHIBAN_API_URL>/** (CF Tunnel rust-ichiban.mtamaramu.com)
 * に CF Access Service Token (CF-Access-Client-Id/Secret ヘッダ) を付与して転送する。
 * Service Token は Secrets Store binding (ICHIBAN_ACCESS_CLIENT_ID/SECRET) から解決し、
 * wrangler.toml / git には平文を置かない (値の投入は secrets-inventory 経由の別手順)。
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
    resolveSecret(env.ICHIBAN_ACCESS_CLIENT_ID),
    resolveSecret(env.ICHIBAN_ACCESS_CLIENT_SECRET),
  ])
  if (!clientId || !clientSecret) {
    throw createError({
      statusCode: 503,
      statusMessage: 'ICHIBAN_ACCESS_CLIENT_ID/ICHIBAN_ACCESS_CLIENT_SECRET binding が未設定です',
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
