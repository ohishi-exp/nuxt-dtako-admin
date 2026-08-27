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
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ので、A 段の `requireAuth`
 * (`y-time-template.put.ts` と同じ 2 行) をここにも入れる。
 *
 * **中身は OSM 由来の公開 POI なので、秘密が漏れる口ではない。**それでも塞ぐのは、
 * ① region ごとに数 MB の GeoJSON を R2 から出す口が無認証だと**帯域と R2 の
 * class-B 課金を誰にでも回せる**、② 画面 (`/rest-map`) は**ログイン済みでしか
 * 開かない**ので人の体験が変わらない、の 2 点。
 * 呼ぶのは `/rest-map` の**ブラウザだけ**で、relay / cron / service binding からの
 * 呼び出しは無い (`git grep` で確認)。
 *
 * **`Cache-Control: public, max-age=3600` はそのまま残す** — 認証を足しても
 * 返す中身は利用者によらず同じ (公開 POI) で、キャッシュされて困る個人情報は無い。
 * 「認証を足したから `private` にする」は**ここでは不要**で、変えると
 * 月次バッチ由来の静的データを毎回 R2 から出すことになる。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_R2 binding 未設定
 */

import { defineEventHandler, getRouterParam, createError, setHeader } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

interface R2ObjectBodyLite {
  text(): Promise<string>
}
interface R2BucketLite {
  get(key: string): Promise<R2ObjectBodyLite | null>
}

interface CloudflareEnv {
  DTAKO_R2?: R2BucketLite
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

export default defineEventHandler(async (event) => {
  const env = cfEnv<CloudflareEnv>(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **region を読む前に認証する。**
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const region = getRouterParam(event, 'region')
  // R2 key に埋め込むので形式を厳しく検証する (path traversal / key injection 防止)
  if (typeof region !== 'string' || !/^[a-z0-9-]{1,32}$/.test(region)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid region' })
  }

  const r2 = env.DTAKO_R2
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
