/**
 * R2 上の dump JSON を読み出す endpoint。
 *
 * GET /api/vehicle-settings/object?key=vehicle-settings/4437/20260514_093253-0-0-4437.json
 *   200 — JSON (= VehicleSettings) をそのまま返す
 *   400 — key 形式不正
 *   404 — オブジェクト無し
 *   503 — R2 binding 未設定
 *
 * key prefix を `vehicle-settings/` に強制することで、本 endpoint 経由で
 * 他用途 (テンプレ xlsx 等) のオブジェクトを引けないようにする。
 */

import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError, setResponseHeader } from 'h3'
import { VEHICLE_SETTINGS_R2_PREFIX } from '~/utils/vehicle-settings-r2'

interface R2Object {
  body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
  size: number
  etag: string
  uploaded: Date | string
  customMetadata?: Record<string, string>
  httpMetadata?: { contentType?: string }
}
interface R2BucketLite {
  get(key: string): Promise<R2Object | null>
}

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { DTAKO_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.DTAKO_R2 ?? null
}

export default defineEventHandler(async (event) => {
  const { key } = getQuery(event)
  if (typeof key !== 'string' || !key) {
    throw createError({ statusCode: 400, statusMessage: 'key (string) is required' })
  }
  if (!key.startsWith(VEHICLE_SETTINGS_R2_PREFIX)) {
    throw createError({
      statusCode: 400,
      statusMessage: `key must start with \"${VEHICLE_SETTINGS_R2_PREFIX}\"`,
    })
  }
  // path traversal 系をシャットアウト
  if (key.includes('..')) {
    throw createError({ statusCode: 400, statusMessage: 'key must not contain \"..\"' })
  }
  if (!key.endsWith('.json')) {
    throw createError({ statusCode: 400, statusMessage: 'key must end with .json' })
  }

  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({
      statusCode: 503,
      statusMessage: 'R2 binding (DTAKO_R2) not available',
    })
  }

  const obj = await r2.get(key)
  if (!obj) {
    throw createError({ statusCode: 404, statusMessage: `object not found: ${key}` })
  }

  setResponseHeader(
    event,
    'content-type',
    obj.httpMetadata?.contentType ?? 'application/json; charset=utf-8',
  )
  return await obj.text()
})
