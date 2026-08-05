/**
 * rust-ichibanboshi の給与系 API (`/api/kyuyo/*`) への **書き込み** thin proxy
 * (Refs #467, #677)。
 *
 * POST /api/kyuyo/** → <NUXT_ICHIBAN_API_URL>/api/kyuyo/** に
 * ① CF Access Service Token (トンネル通過用、server だけが持つ) と
 * ② ブラウザの `Authorization: Bearer <JWT>` (素通し転送) を付けて転送する。
 *
 * GET 版 (`[...path].get.ts`) と対になる。**認可は upstream 側**
 * (rust-ichibanboshi の introspect + email allowlist) が担い、この proxy は JWT を
 * 検証しない — allowlist 外は upstream が 403 を返し、それをそのまま passthrough する。
 *
 * ## なぜ必要だったか
 *
 * `fetchIchiban` は長らく `method: 'GET'` 固定で、書き込み系の口 (`POST /kyuyo/sync`)
 * は rust 側に在るのに**画面から叩けなかった** (#467 の調査)。賃金スナップショットの
 * 保存 (`POST /api/kyuyo/wage-snapshot`、ohishi-exp/rust-ichibanboshi#292) も同じ口が要る。
 *
 * ## upstream パスは `api/kyuyo/` 配下に固定する
 *
 * GET 版と同じ理由 — この route から給与以外のエンドポイントへ到達させない。
 * **書き込みなので固定の意味はさらに重い**: ここが自由パスだと、CF Access Service
 * Token を持つ server 経由で rust 側の任意の POST 口を叩けることになる。
 *
 * ## body は素通し (検証しない)
 *
 * thin proxy なので中身は見ない。形の検証は upstream の責務 (400 をそのまま返す)。
 * 読み取りは 1MB 上限 — 賃金スナップショット 1 か月ぶん (112 名 × 15 列) で
 * 数十 KB なので充分だが、青天井にはしない。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getRequestURL, getRouterParam, getHeader, readRawBody, createError, setResponseStatus, setHeader } from 'h3'
import { fetchIchiban, cfEnv, type IchibanUpstreamError } from '../../utils/ichiban-upstream'

/** 転送する body の上限 (bytes)。 */
export const MAX_BODY_BYTES = 1024 * 1024

export default defineEventHandler(async (event: H3Event) => {
  const env = cfEnv(event)
  const pathParam = getRouterParam(event, 'path') ?? ''

  const raw = await readRawBody(event, 'utf8')
  const body = typeof raw === 'string' ? raw : ''
  if (body.length > MAX_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'body が大きすぎます' })
  }

  const authorization = getHeader(event, 'authorization')
  const extraHeaders: Record<string, string> = authorization ? { Authorization: authorization } : {}

  let upstreamRes: Response
  try {
    upstreamRes = await fetchIchiban(
      env,
      `api/kyuyo/${pathParam}`,
      getRequestURL(event).search,
      extraHeaders,
      { method: 'POST', body },
    )
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
