/**
 * dtako 実運行 (距離・日付・車番) を service-to-service で配信する endpoint。
 * nuxt-ichibanboshi が一番星の売上明細と突合するために service binding で
 * 叩く想定 (ohishi-exp/nuxt-dtako-admin#198 Phase 8)。
 *
 * GET /api/tariff/dtako-operations?tenant_id=&from=&to=&vehicleCd=
 *   認証: `X-Internal-Shared-Secret` (INTERNAL_SHARED_SECRET と constant-time
 *   比較) + `tenant_id` 明示パラメータ (ブラウザ JWT が無い呼び出しのため
 *   2026-07-10 ユーザー決定)。
 *
 *   200 { operations: [{ unkoNo, vehicleCd, date, distanceKm }] }
 *   400 — tenant_id / distanceKm 変換不能等
 *   401 — X-Internal-Shared-Secret 不一致・欠落
 *   502/503 — upstream (rust-alc-api 経由) エラー
 *
 * rust-alc-api 到達は `alcInternalProxyFetch` (auth-worker `/alc-internal-proxy`
 * 経由、Refs ippoan/auth-worker#362 / ippoan/rust-alc-api#562)。
 */

import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'
import { alcInternalProxyFetch } from '../../utils/alc-internal-proxy'

function cfEnv(event: H3Event): Record<string, unknown> {
  return (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
}

async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

/** timing-safe な文字列比較 (auth-worker alc-internal-proxy.ts と同実装)。 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

interface UpstreamOperationItem {
  unko_no: string
  vehicle_cd: string | null
  operation_date: string | null
  reading_date: string
  total_distance: number | null
}

interface UpstreamOperationsResponse {
  operations: UpstreamOperationItem[]
}

export interface DtakoOperationSlim {
  unkoNo: string
  vehicleCd: string | null
  date: string
  distanceKm: number | null
}

export default defineEventHandler(async (event) => {
  const env = cfEnv(event)
  const expectedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!expectedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }

  const provided = event.node.req.headers['x-internal-shared-secret']
  const providedSecret = Array.isArray(provided) ? (provided[0] ?? '') : (provided ?? '')
  if (!providedSecret || !constantTimeEquals(providedSecret, expectedSecret)) {
    throw createError({ statusCode: 401, statusMessage: 'X-Internal-Shared-Secret が不正です' })
  }

  const q = getQuery(event)
  const tenantId = typeof q.tenant_id === 'string' ? q.tenant_id : ''
  if (!tenantId) {
    throw createError({ statusCode: 400, statusMessage: 'tenant_id (query) は必須です' })
  }

  let res: Response
  try {
    res = await alcInternalProxyFetch(event, {
      path: '/api/internal/operations',
      tenantId,
      query: {
        date_from: typeof q.from === 'string' ? q.from : undefined,
        date_to: typeof q.to === 'string' ? q.to : undefined,
        vehicle_cd: typeof q.vehicleCd === 'string' ? q.vehicleCd : undefined,
      },
    })
  }
  catch (e: unknown) {
    if (e && typeof e === 'object' && 'statusCode' in e) throw e
    throw createError({ statusCode: 502, statusMessage: 'rust-alc-api への到達に失敗しました' })
  }

  if (!res.ok) {
    throw createError({
      statusCode: res.status === 401 || res.status === 403 ? 502 : res.status,
      statusMessage: `upstream error: HTTP ${res.status}`,
    })
  }

  const body = (await res.json()) as UpstreamOperationsResponse
  const operations: DtakoOperationSlim[] = body.operations.map(op => ({
    unkoNo: op.unko_no,
    vehicleCd: op.vehicle_cd,
    date: op.operation_date ?? op.reading_date,
    distanceKm: op.total_distance,
  }))

  return { operations }
})
