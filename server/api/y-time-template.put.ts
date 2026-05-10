/**
 * Y時間 テンプレ xlsx を R2 にアップロードする dev 補助エンドポイント。
 *
 * PUT /api/y-time-template?key=<r2_key>
 *   body: xlsx binary (raw)
 *
 * R2 binding (`env.DTAKO_R2`) に直接 put するだけ。dtako-admin の管理者専用画面 (要 JWT) で
 * 1 度だけ叩いて使う想定。本番テンプレは `templates/kyoto-soft/base.xlsx` 等を想定。
 */

import type { H3Event } from 'h3'
import {
  defineEventHandler,
  getQuery,
  getHeader,
  readRawBody,
  createError,
} from 'h3'

interface R2Object {
  arrayBuffer(): Promise<ArrayBuffer>
}
interface R2BucketLite {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | Buffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<R2Object | null>
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
  if (!key.startsWith('templates/')) {
    throw createError({
      statusCode: 400,
      statusMessage: 'key must start with "templates/"',
    })
  }

  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({
      statusCode: 503,
      statusMessage: 'R2 binding (DTAKO_R2) not available',
    })
  }

  const body = await readRawBody(event, false)
  if (!body) {
    throw createError({ statusCode: 400, statusMessage: 'request body is empty' })
  }
  // Buffer → ArrayBuffer に変換 (miniflare R2 binding 越しに渡すとき
  // Node の Buffer は serialize できないので、view を独立した ArrayBuffer に切り出す)
  const arrayBuffer: ArrayBuffer = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer
  const contentType =
    getHeader(event, 'content-type')
    ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

  await r2.put(key, arrayBuffer, { httpMetadata: { contentType } })
  return { ok: true, key, size: arrayBuffer.byteLength }
})
