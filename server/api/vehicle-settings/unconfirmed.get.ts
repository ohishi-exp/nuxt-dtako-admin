/**
 * 設定未確認車輛抽出 endpoint。
 *
 * GET /api/vehicle-settings/unconfirmed
 *
 * 1. backend (rust-alc-api) `/api/dtako/vehicles` を auth-worker `/alc-proxy`
 *    経由でフェッチ → 全車輛マスタ [{ id, tenant_id, vehicle_cd, vehicle_name }, ...]
 * 2. R2 (`DTAKO_R2`) の `vehicle-settings/` prefix を listing して
 *    dump が存在する vehicle_cd 集合を作る
 * 3. (1) - (2) = 未確認車輛
 *
 * レスポンス: [{ vehicle_cd, vehicle_name }, ...]
 * vehicle_cd でソートされて返る。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * **ここは D 段 (認可ゼロ) ではなく B 段だった** — `alcProxyFetch` が browser JWT を
 * cookie / `Authorization: Bearer` から拾って転送し、上流の auth-worker `/alc-proxy`
 * が **token 不在を fail-closed で 401 にする** (`ippoan/auth-worker@dd220b2`
 * `src/handlers/alc-proxy.ts` の `if (!token) return jsonError(401, "Unauthorized")`)。
 * `X-Alc-Proxy-Secret` は consumer proof であって身元ではないので、secret だけでは
 * 通らない。**`/api/ichiban/**` (Service Token を無条件に付け、呼び出し元の身元を
 * 一切見ない) とは型が違う** — 誤読しやすいのでここに書いておく。
 *
 * それでも A 段に上げる理由が 2 つある:
 *
 * 1. **B 段の防御は上流の実装依存**で、この repo からは保証できない
 *    (`docs/plan-922-single-signin.md` §1 が `/api/ichiban/**` の項で書いている性質と
 *    同じ)。Nitro 側で確定させれば、上流が変わっても規約が残る。
 * 2. **上流 401 を待つ前に R2 list が走ってしまう** — 下の `Promise.all` は
 *    `listConfirmedVehicleCds` を並行で回すので、**未ログインの相手でも R2 の
 *    listing (最大 50 往復) だけは実行される**。`requireAuth` を先に置けば止まる。
 *
 * 呼ぶのは `/vehicle-settings/unconfirmed` の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_R2 binding 未設定
 */

import { defineEventHandler, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { alcProxyFetch } from '../../utils/alc-proxy'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

const R2_PREFIX = 'vehicle-settings/'

interface R2Object {
  key: string
}
interface R2ListResult {
  objects: R2Object[]
  truncated: boolean
  cursor?: string
}
interface R2ListOptions {
  prefix?: string
  cursor?: string
  limit?: number
}
interface R2BucketLite {
  list(options?: R2ListOptions): Promise<R2ListResult>
}

interface CloudflareEnv {
  DTAKO_R2?: R2BucketLite
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

// `vehicle-settings/4437/...` → '4437'
function extractVehicleCdFromKey(key: string): string | null {
  if (!key.startsWith(R2_PREFIX)) return null
  const rest = key.slice(R2_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  return rest.slice(0, slash)
}

async function listConfirmedVehicleCds(r2: R2BucketLite): Promise<Set<string>> {
  const cds = new Set<string>()
  let cursor: string | undefined = undefined
  // R2 list は 1 回 1000 件上限。全件拾うため cursor でストリーム。
  for (let i = 0; i < 50; i += 1) {
    const res: R2ListResult = await r2.list({
      prefix: R2_PREFIX,
      cursor,
      limit: 1000,
    })
    for (const o of res.objects) {
      const cd = extractVehicleCdFromKey(o.key)
      if (cd) cds.add(cd)
    }
    if (!res.truncated || !res.cursor) break
    cursor = res.cursor
  }
  return cds
}

interface DtakoVehicle {
  id: string
  tenant_id: string
  vehicle_cd: string
  vehicle_name: string
}

export interface UnconfirmedVehicle {
  vehicle_cd: string
  vehicle_name: string
}

export default defineEventHandler(async (event): Promise<UnconfirmedVehicle[]> => {
  const env = cfEnv<CloudflareEnv>(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **R2 list と上流フェッチを始める前に認証する。** 上流も未ログインを 401 に
  // するが、それを待つ間に下の `Promise.all` が R2 listing を回してしまう。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const r2 = env.DTAKO_R2
  if (!r2) {
    throw createError({
      statusCode: 503,
      statusMessage: 'R2 binding (DTAKO_R2) not available',
    })
  }

  // backend フェッチと R2 list を並行。#434 step 3 (方式 B): rust-alc-api を直叩き
  // せず auth-worker `/alc-proxy` に委譲する (OIDC mint は auth-worker、lockdown 対応)。
  const [vehiclesRes, confirmedCds] = await Promise.all([
    alcProxyFetch(event, { path: '/api/dtako/vehicles' }),
    listConfirmedVehicleCds(r2),
  ])

  if (!vehiclesRes.ok) {
    const text = await vehiclesRes.text().catch(() => '')
    throw createError({
      statusCode: vehiclesRes.status,
      statusMessage: `backend /api/dtako/vehicles エラー: ${text || vehiclesRes.statusText}`,
    })
  }
  const allVehicles = (await vehiclesRes.json()) as DtakoVehicle[]

  const unconfirmed: UnconfirmedVehicle[] = []
  for (const v of allVehicles) {
    if (!v.vehicle_cd) continue
    if (confirmedCds.has(v.vehicle_cd)) continue
    unconfirmed.push({ vehicle_cd: v.vehicle_cd, vehicle_name: v.vehicle_name ?? '' })
  }
  unconfirmed.sort((a, b) => a.vehicle_cd.localeCompare(b.vehicle_cd))
  return unconfirmed
})
