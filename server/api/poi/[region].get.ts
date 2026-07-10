/**
 * トラック休憩ポイント POI GeoJSON 配信エンドポイント (Refs #198 Phase 1)。
 *
 * GET /api/poi/:region → R2 (DTAKO_R2) の `poi/<region>.geojson` を返す。
 * データは scripts/poi/build-poi.ts (月次バッチ) が生成し、
 * `wrangler r2 object put dtako-uploads/poi/<region>.geojson --file=... --remote`
 * で配置する (scripts/poi/README.md 参照)。
 *
 *   200 — GeoJSON (application/geo+json、Cache-Control 1h)
 *   400 — region 形式不正
 *   404 — R2 に未配置 (loud fail: 配置手順をメッセージに含める)
 *   503 — R2 binding 未設定
 */

import type { H3Event } from 'h3'
import { defineEventHandler, getRouterParam, createError, setHeader } from 'h3'

interface R2ObjectBodyLite {
  text(): Promise<string>
}
interface R2BucketLite {
  get(key: string): Promise<R2ObjectBodyLite | null>
}

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { DTAKO_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.DTAKO_R2 ?? null
}

export default defineEventHandler(async (event) => {
  const region = getRouterParam(event, 'region')
  // R2 key に埋め込むので形式を厳しく検証する (path traversal / key injection 防止)
  if (typeof region !== 'string' || !/^[a-z0-9-]{1,32}$/.test(region)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid region' })
  }

  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'R2 binding (DTAKO_R2) not available' })
  }

  const key = `poi/${region}.geojson`
  const obj = await r2.get(key)
  if (!obj) {
    throw createError({
      statusCode: 404,
      statusMessage: `POI data not found: ${key} (run "npm run poi:build" and upload per scripts/poi/README.md)`,
    })
  }

  setHeader(event, 'Content-Type', 'application/geo+json; charset=utf-8')
  // 月次バッチ由来の静的データなので edge/browser 側で 1h キャッシュしてよい
  setHeader(event, 'Cache-Control', 'public, max-age=3600')
  return obj.text()
})
