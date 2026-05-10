/**
 * Y時間 Excel 追記エクスポート (Cloudflare Worker 上で実行される Nitro server route)。
 *
 * 1. body から `{ driver_cd, from, to, template_key }` を受け取る
 * 2. backend (rust-alc-api) `/api/dtako/y-time-export` を JWT forward で叩いて JSON 取得
 * 3. R2 binding (`env.DTAKO_R2`) でテンプレ xlsx を fetch
 * 4. ExcelJS で Y時間 シートに書き込み
 * 5. xlsx binary を octet-stream で return
 *
 * R2 binding がない (ローカル `nuxt dev` 等) 環境では明示的に 503 を返す。
 */

import type { H3Event } from 'h3'
import {
  defineEventHandler,
  readBody,
  getHeader,
  createError,
  setResponseHeader,
} from 'h3'
import type { YTimeExportResponse } from '~/types'
import { writeYTimeRows, buildFilename } from '~/utils/y-time-xlsx'

interface RequestBody {
  driver_cd: string
  from: string
  to: string
  template_key: string
}

interface R2ObjectMinimal {
  arrayBuffer(): Promise<ArrayBuffer>
}
interface R2BucketMinimal {
  get(key: string): Promise<R2ObjectMinimal | null>
}
interface CloudflareEnv {
  DTAKO_R2?: R2BucketMinimal
}

function getR2Binding(event: H3Event): R2BucketMinimal | null {
  // nitro-cloudflare-pages / cloudflare-module で `event.context.cloudflare.env` に bindings が入る
  const ctx = event.context as { cloudflare?: { env?: CloudflareEnv } }
  return ctx.cloudflare?.env?.DTAKO_R2 ?? null
}

export default defineEventHandler(async (event) => {
  const body = await readBody<RequestBody>(event)
  if (!body || !body.driver_cd || !body.from || !body.to || !body.template_key) {
    throw createError({
      statusCode: 400,
      statusMessage: 'driver_cd / from / to / template_key are required',
    })
  }
  if (!body.template_key.startsWith('templates/')) {
    throw createError({
      statusCode: 400,
      statusMessage: 'template_key must start with "templates/"',
    })
  }

  const config = useRuntimeConfig()
  const apiBase = (config.public as { apiBase?: string }).apiBase
    || process.env.NUXT_PUBLIC_API_BASE
  if (!apiBase) {
    throw createError({ statusCode: 500, statusMessage: 'apiBase not configured' })
  }

  // 1. backend JSON 取得 — 認証ヘッダーをそのまま forward
  const auth = getHeader(event, 'authorization') ?? ''
  const tenantId = getHeader(event, 'x-tenant-id') ?? ''
  const headers: Record<string, string> = {}
  if (auth) headers['authorization'] = auth
  if (tenantId) headers['x-tenant-id'] = tenantId

  const params = new URLSearchParams({
    driver_cd: body.driver_cd,
    from: body.from,
    to: body.to,
  })
  const apiUrl = `${apiBase.replace(/\/$/, '')}/api/dtako/y-time-export?${params.toString()}`
  const apiRes = await fetch(apiUrl, { headers })
  if (!apiRes.ok) {
    const text = await apiRes.text().catch(() => '')
    throw createError({
      statusCode: apiRes.status,
      statusMessage: `backend error: ${text || apiRes.statusText}`,
    })
  }
  const data = (await apiRes.json()) as YTimeExportResponse

  // 2. R2 binding でテンプレ取得
  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({
      statusCode: 503,
      statusMessage:
        'R2 binding (DTAKO_R2) not available. Deploy via wrangler or set up local R2 binding.',
    })
  }
  const tplObj = await r2.get(body.template_key)
  if (!tplObj) {
    throw createError({
      statusCode: 404,
      statusMessage: `template not found in R2: ${body.template_key}`,
    })
  }
  const tplBytes = await tplObj.arrayBuffer()

  // 3. xlsx 生成
  const result = await writeYTimeRows(tplBytes, data.rows)

  if (result.missingDates.length > 0) {
    // dev でデバッグしやすいよう warning header にも入れる (本文 binary なので)
    setResponseHeader(
      event,
      'x-y-time-missing-dates',
      result.missingDates.slice(0, 30).join(','),
    )
  }
  if (data.warnings.length > 0) {
    setResponseHeader(
      event,
      'x-y-time-warnings',
      // ASCII safe にだけ落とす (ヘッダーに日本語を直接入れると 500 になる ので URI encode)
      encodeURIComponent(data.warnings.slice(0, 5).join(' / ')),
    )
  }

  // 4. response
  setResponseHeader(
    event,
    'content-type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  setResponseHeader(
    event,
    'content-disposition',
    `attachment; filename="${buildFilename(body.driver_cd, body.from, body.to)}"`,
  )
  return result.bytes
})
