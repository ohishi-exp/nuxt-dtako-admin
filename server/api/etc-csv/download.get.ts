/**
 * ETC 明細 CSV (R2 `DTAKO_R2` 保存済み) のダウンロード endpoint。
 *
 * GET /api/etc-csv/download?key=<r2_key>
 *
 * key は `etc-meisai-client.ts` の `etcCsvKey()` / `dtako-scraper-relay-do.ts`
 * の `performEtcScrape()` が生成する `{etc|etc-staging}/{user_id}/{date}/{time}.csv`
 * 形式のみ許可する (任意の R2 path を読ませない、path traversal / 他 prefix への
 * アクセス防止)。管理タブ (`/scraper` ETC タブ) の実行結果ログから
 * `key` を受け取ってこの endpoint に誘導する。
 */

import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError, setResponseHeader } from 'h3'

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
  const ctx = event.context as { cloudflare?: { env?: CloudflareEnv } }
  return ctx.cloudflare?.env?.DTAKO_R2 ?? null
}

/** `{etc|etc-staging}/{user_id}/{YYYY-MM-DD}/{HHmmss}.csv` のみ許可。 */
const ETC_CSV_KEY_PATTERN = /^etc(?:-staging)?\/[^/]+\/[^/]+\/[^/]+\.csv$/

export default defineEventHandler(async (event) => {
  const { key } = getQuery(event)
  if (typeof key !== 'string' || !key) {
    throw createError({ statusCode: 400, statusMessage: 'key (string) is required' })
  }
  if (!ETC_CSV_KEY_PATTERN.test(key)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid ETC CSV key' })
  }

  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({
      statusCode: 503,
      statusMessage: 'R2 binding (DTAKO_R2) not available. Deploy via wrangler or set up local R2 binding.',
    })
  }

  const obj = await r2.get(key)
  if (!obj) {
    throw createError({ statusCode: 404, statusMessage: `not found in R2: ${key}` })
  }
  const bytes = await obj.arrayBuffer()

  const filename = key.split('/').slice(1).join('_')
  setResponseHeader(event, 'content-type', 'text/csv; charset=shift_jis')
  setResponseHeader(event, 'content-disposition', `attachment; filename="${filename}"`)
  return bytes
})
