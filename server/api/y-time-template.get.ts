/**
 * Y時間 テンプレ xlsx の R2 上の存在確認エンドポイント。
 *
 * GET /api/y-time-template?key=<r2_key>
 *   200 { exists: true, key, size, etag, uploaded } — 存在する
 *   200 { exists: false, key } — 存在しない (404 でなく 200 + flag で返すのは
 *     fetch で簡単に分岐できるようにするため)
 *   400 — key がない / 形式不正
 *   503 — R2 binding 未設定
 */

import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'

interface R2HeadResult {
  size: number
  etag: string
  uploaded: Date | string
}
interface R2BucketLite {
  head(key: string): Promise<R2HeadResult | null>
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

  const head = await r2.head(key)
  if (!head) {
    return { exists: false as const, key }
  }
  return {
    exists: true as const,
    key,
    size: head.size,
    etag: head.etag,
    uploaded: typeof head.uploaded === 'string' ? head.uploaded : head.uploaded.toISOString(),
  }
})
