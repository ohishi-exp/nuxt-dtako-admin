import { defineEventHandler, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

/**
 * `/vid-check` (VidMap.vue) 用の Google Maps JS API key 取得 endpoint。
 *
 * `GOOGLEMAP_KEY_SECRET` は Cloudflare Secrets Store binding (`.get()` を持つ
 * オブジェクト、文字列ではない)。これを Nuxt の public runtimeConfig 自動 env
 * 上書き (`NUXT_PUBLIC_*` 命名) に直接載せると、起動時の Nitro deepFreeze が
 * このオブジェクトを frozen にしようとして `Cannot freeze` (code 10021) で
 * `wrangler deploy` ごと fail する (2026-07-03 実害)。値自体は referrer 制限
 * 済みの client-exposed 値なので、素朴に `.get()` して JSON で返すだけで足りる。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ので、A 段の `requireAuth`
 * (`y-time-template.put.ts` と同じ 2 行) をここにも入れる。
 *
 * **この口は D 段の中で唯一「秘密そのものを平文で返す」**ので、理由を厚く書く。
 *
 * - **「referrer 制限があるから無認証でよい」は成り立たない。** `Referer` は
 *   **呼び出し元が自由に名乗れるヘッダ**で、ブラウザの外 (curl / server-side fetch /
 *   拡張) からは任意の値を付けられる。Google 側の HTTP referrer 制限は
 *   「うっかり別サイトに貼られた」事故を減らす**課金の保険**であって、
 *   **鍵を配ってよい相手を判定する認証ではない**。上の doc コメントが
 *   「値自体は referrer 制限済みの client-exposed 値なので、素朴に返すだけで足りる」
 *   と書いているのは **`NUXT_PUBLIC_*` に載せずに済ませる方法**の話で、
 *   **誰に返すか**の話ではない — ここを取り違えないこと。
 * - 鍵が漏れて困るのは「地図が出る」ことではなく **Maps Platform の課金が
 *   他人に回せる**こと。referrer を名乗るだけで回せる以上、**口の側で相手を見る**
 *   のが唯一効く手当てになる。
 * - **画面はログイン済みでしか地図を出さない**ので、認証を足しても人の体験は
 *   変わらない (`DvrMap` / `EventSpeedMapPanel` / `Net780Map` / `OperationRouteMap` /
 *   `VidMap` / `/rest-map` の**ブラウザだけ**が呼ぶ。relay / cron /
 *   service binding からの呼び出しは無い — `git grep` で確認)。
 *
 * **`process.env.NUXT_PUBLIC_GOOGLEMAP_KEY` フォールバックは残す** — ローカル
 * `nuxt dev` で値が無いときの挙動を変えないため。ただし `INTERNAL_SHARED_SECRET`
 * が無い環境では 503 で止まるので、**素の `nuxt dev` では地図が出なくなる**
 * (`dev-login-local-verify` skill の wrangler dev なら binding が載るので従来どおり)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET binding 未設定
 */

interface SecretBinding { get(): Promise<string> }

interface CloudflareEnv {
  GOOGLEMAP_KEY_SECRET?: SecretBinding | string
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
  // **鍵を読み出す前に認証する。** referrer は名乗れるので、ここが唯一の関門。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const binding = env.GOOGLEMAP_KEY_SECRET
  let key: string | null = null
  if (typeof binding === 'string') {
    key = binding
  }
  else if (binding && typeof binding.get === 'function') {
    try {
      key = (await binding.get()) ?? null
    }
    catch {
      // ローカル `nuxt dev` の miniflare 版 Secrets Store binding は、実値が無いと
      // undefined ではなく `Secret "..." not found` で reject する。値未設定として
      // process.env フォールバックに落とす (下と同じ扱い)。
      key = process.env.NUXT_PUBLIC_GOOGLEMAP_KEY || null
    }
  }
  else {
    // ローカル開発 (`nuxt dev`、CF binding 無し) 用フォールバック。
    key = process.env.NUXT_PUBLIC_GOOGLEMAP_KEY || null
  }
  return { key }
})
