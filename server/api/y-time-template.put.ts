/**
 * Y時間 テンプレ xlsx を R2 にアップロードするエンドポイント。
 *
 * PUT /api/y-time-template?key=<r2_key>
 *   body: xlsx binary (raw)
 *
 * R2 binding (`env.DTAKO_R2`) に put する。Y時間 タブ (`/y-time-export`) の
 * 「テンプレ xlsx を R2 に保存 (dev 補助)」の「R2 に保存」ボタンから叩く
 * (**画面には出ているが本番でも動く口**)。本番テンプレは
 * `templates/kyoto-soft/base.xlsx` 等を想定。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * **ここは「要 JWT」と書いてあるのに、その JWT を検証するコードが無かった**
 * (`docs/plan-922-single-signin.md` §1 が D 段の実例として名指ししている形)。
 * 前段は **Cloudflare Access だけ**で、それは edge の設定であって
 * **この repo が意図して置いた防御ではない**。A 段の `requireAuth`
 * (`allowance-override.post.ts` と同じ 2 行) を入れて、規約をコードにする。
 * 呼ぶのは Y時間 タブの**ブラウザだけ**で、relay / cron / service binding からの
 * 呼び出しは無い (`git grep` で確認)。
 *
 * **読み口 (`y-time-template.get.ts`) はこの PR では触らない** — 読み取り系は別 PR。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_R2 binding 未設定
 */

import type { H3Event } from 'h3'
import {
  defineEventHandler,
  getQuery,
  getHeader,
  readRawBody,
  createError,
} from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'

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

interface CloudflareEnv {
  DTAKO_R2?: R2BucketLite
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

function cfEnv(event: H3Event): CloudflareEnv {
  return (event.context.cloudflare as { env?: CloudflareEnv } | undefined)?.env ?? {}
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す
 * (`allowance-override.post.ts` と同実装)。 */
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

export default defineEventHandler(async (event) => {
  const env = cfEnv(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **テンプレを上書きする前に認証する。** ここに置いた xlsx が Y時間 の出力の中身になる。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

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

  const r2 = env.DTAKO_R2
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
