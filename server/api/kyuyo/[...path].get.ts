/**
 * rust-ichibanboshi の給与大臣読み取り API (`/api/kyuyo/*`) への thin proxy (Refs #369)。
 *
 * GET /api/kyuyo/** → <NUXT_ICHIBAN_API_URL>/api/kyuyo/** に
 * ① CF Access Service Token (トンネル通過用、server だけが持つ) と
 * ② ブラウザの `Authorization: Bearer <JWT>` (素通し転送) を付けて転送する。
 *
 * 給与データの認可は upstream 側 (rust-ichibanboshi の introspect + email allowlist、
 * ohishi-exp/rust-ichibanboshi#82) が担う — この proxy は JWT を検証しない。
 * allowlist 外ユーザーは upstream が 403 を返し、それをそのまま passthrough する。
 *
 * `/api/ichiban/**` proxy と違い upstream パスを `api/kyuyo/` 配下に固定し、
 * この route から給与以外のエンドポイントへは到達できないようにする。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getRequestURL, getRouterParam, getHeader, createError, setResponseStatus, setHeader } from 'h3'
import { fetchIchiban, cfEnv, type IchibanUpstreamError } from '../../utils/ichiban-upstream'

export default defineEventHandler(async (event: H3Event) => {
  const env = cfEnv(event)
  const pathParam = getRouterParam(event, 'path') ?? ''

  const authorization = getHeader(event, 'authorization')
  const extraHeaders: Record<string, string> = authorization ? { Authorization: authorization } : {}

  let upstreamRes: Response
  try {
    upstreamRes = await fetchIchiban(env, `api/kyuyo/${pathParam}`, getRequestURL(event).search, extraHeaders)
  }
  catch (e: unknown) {
    const err = e as IchibanUpstreamError
    throw createError({ statusCode: err.statusCode, statusMessage: err.message })
  }

  setResponseStatus(event, upstreamRes.status)
  const contentType = upstreamRes.headers.get('content-type')
  if (contentType) setHeader(event, 'Content-Type', contentType)
  return upstreamRes.text()
})
