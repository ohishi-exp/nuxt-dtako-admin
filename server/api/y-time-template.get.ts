/**
 * Y時間 テンプレ xlsx の R2 上の存在確認エンドポイント。
 *
 * GET /api/y-time-template?key=<r2_key>
 *   200 { exists: true, key, size, etag, uploaded } — 存在する
 *   200 { exists: false, key } — 存在しない (404 でなく 200 + flag で返すのは
 *     fetch で簡単に分岐できるようにするため)
 *   400 — key がない / 形式不正
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ので、A 段の `requireAuth` を入れる。
 *
 * **書き口 (`y-time-template.put.ts`) は #988 の 1 本目で塞いだのに、読み口である
 * ここは残っていた。**「存在するか」しか返さないが、`size` / `etag` / `uploaded` は
 * **テンプレの差し替えを外から観測できる情報**で、`templates/` 配下の key を
 * 総当たりすれば配置も判る。
 * 呼ぶのは Y時間 タブ (`/y-time-export`) の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_R2 binding 未設定
 */

import { defineEventHandler, getQuery, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { assertAllowedRole } from '../utils/require-role'
import { cfEnv, resolveSecret } from '../utils/cf-env'

interface R2HeadResult {
  size: number
  etag: string
  uploaded: Date | string
}
interface R2BucketLite {
  head(key: string): Promise<R2HeadResult | null>
}

interface CloudflareEnv {
  DTAKO_R2?: R2BucketLite
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

export default defineEventHandler(async (event) => {
  const env = cfEnv<CloudflareEnv>(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **query を読む前に認証する** (書き口 `y-time-template.put.ts` と同じ順序)。
  const auth = await requireAuth(event, { authWorkerUrl, sharedSecret })
  assertAllowedRole(auth)

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
