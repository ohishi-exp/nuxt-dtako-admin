/**
 * ETC 明細 CSV (R2 `DTAKO_R2` 保存済み) のダウンロード endpoint。
 *
 * GET /api/etc-csv/download?key=<r2_key>
 *
 * key は `etc-meisai-client.ts` の `etcCsvKey()` / `dtako-scraper-relay-do.ts`
 * の `performEtcScrape()` が生成する `{etc|etc-staging}/{user_id}/{date}/{time}.csv`
 * 形式のみ許可する (任意の R2 path を読ませない、path traversal / 他 prefix への
 * アクセス防止。セグメント文字種も絞ることで Content-Disposition header injection
 * も同時に防ぐ)。管理タブ (`/scraper` ETC タブ) の実行結果ログから `key` を受け
 * 取ってこの endpoint に誘導する。
 *
 * `requireAuth` で auth-worker ログイン必須にする — R2 read はここでしか gate
 * されないため (`/api/proxy` 等と違い backend への forward が無く、認証を backend
 * に委譲できない)。この admin 画面は「ログイン済み管理者は任意の comp_id/ETC
 * アカウントを操作できる」設計 (dtako 側の comp_id トリガーと同じモデル、Refs
 * #134 の DTAKO_ACCOUNTS/ETC_ACCOUNTS がテナント非依存の共有リストであることに
 * 対応) なので、user_id と session の tenant を突き合わせる追加チェックは行わない。
 */

import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError, setResponseHeader } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'

interface R2ObjectMinimal {
  arrayBuffer(): Promise<ArrayBuffer>
}
interface R2BucketMinimal {
  get(key: string): Promise<R2ObjectMinimal | null>
}
interface CloudflareEnv {
  DTAKO_R2?: R2BucketMinimal
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

function cfEnv(event: H3Event): CloudflareEnv {
  return (event.context.cloudflare as { env?: CloudflareEnv } | undefined)?.env ?? {}
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す。 */
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

/** `{etc|etc-staging}/{user_id}/{YYYY-MM-DD}/{HHmmss}.csv` のみ許可
 * (`etcCsvKey()` の生成形式と一致、セグメント文字種を絞って header injection も防ぐ)。 */
const ETC_CSV_KEY_PATTERN = /^etc(?:-staging)?\/[A-Za-z0-9_-]+\/\d{4}-\d{2}-\d{2}\/\d{6}\.csv$/

export default defineEventHandler(async (event) => {
  const env = cfEnv(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl =
    typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const { key } = getQuery(event)
  if (typeof key !== 'string' || !key) {
    throw createError({ statusCode: 400, statusMessage: 'key (string) is required' })
  }
  if (!ETC_CSV_KEY_PATTERN.test(key)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid ETC CSV key' })
  }

  const r2 = env.DTAKO_R2
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

  // key はここまでで ETC_CSV_KEY_PATTERN 検証済み ([A-Za-z0-9_-] + 固定形式の
  // 日付/時刻のみ) なので、そのまま filename に使っても header injection しない。
  const filename = key.split('/').slice(1).join('_')
  setResponseHeader(event, 'content-type', 'text/csv; charset=shift_jis')
  setResponseHeader(event, 'content-disposition', `attachment; filename="${filename}"`)
  return bytes
})
