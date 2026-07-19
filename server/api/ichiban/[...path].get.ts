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
 *
 * CF Access トークン付与ロジック本体は `server/utils/ichiban-upstream.ts` に集約
 * (server/api/profit/monthly.get.ts と共有、Refs #330 PR4)。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getRequestURL, getRouterParam, createError, setResponseStatus, setHeader } from 'h3'
import { fetchIchiban, cfEnv, type IchibanUpstreamError } from '../../utils/ichiban-upstream'

export default defineEventHandler(async (event: H3Event) => {
  const env = cfEnv(event)
  const pathParam = getRouterParam(event, 'path') ?? ''

  let upstreamRes: Response
  try {
    upstreamRes = await fetchIchiban(env, pathParam, getRequestURL(event).search)
  }
  // fetchIchiban は IchibanUpstreamError (503/502) のみを throw する契約 (同ファイルの JSDoc 参照)。
  catch (e: unknown) {
    const err = e as IchibanUpstreamError
    throw createError({ statusCode: err.statusCode, statusMessage: err.message })
  }

  setResponseStatus(event, upstreamRes.status)
  const contentType = upstreamRes.headers.get('content-type')
  if (contentType) setHeader(event, 'Content-Type', contentType)
  return upstreamRes.text()
})
