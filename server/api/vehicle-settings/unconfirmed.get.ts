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
 */

import type { H3Event } from 'h3'
import { defineEventHandler, createError } from 'h3'
import { alcProxyFetch } from '../../utils/alc-proxy'

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

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { DTAKO_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.DTAKO_R2 ?? null
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
  const r2 = getR2Binding(event)
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
