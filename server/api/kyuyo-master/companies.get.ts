/**
 * D1 `kyuyo_companies` の一覧を返す (Refs #369)。
 *
 * 給与DB取得ページの初期表示用 — rust API (給与大臣 PC) には触らないので常に高速。
 * リストの更新は refresh.post (差分) / refresh-full.post (フル)。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ので、A 段の `requireAuth`
 * (`y-time-template.put.ts` と同じ 2 行) をここにも入れる。
 *
 * **更新の口 (`refresh.post` / `refresh-full.post`) は browser JWT を上流に渡して
 * 上流が弾く形 (B 段) なのに、読み口だけが素通しだった。** 返るのは金額ではなく
 * 会社名 × 年度の識別情報だが (#367 と同方針で金額は D1 に入れていない)、
 * **取引先の一覧そのもの**なので誰にでも見せるものではない。
 * 呼ぶのは給与DB取得ページ (`/kyuyo-fetch`) の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_DB binding 未設定
 */
import { defineEventHandler, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { getKyuyoDb, listKyuyoCompanies } from '../../utils/kyuyo-master-db'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

interface AuthEnv {
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

export default defineEventHandler(async (event) => {
  const env = cfEnv<AuthEnv>(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **D1 を読む前に認証する。** 更新の口と同じ相手だけに読ませる。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const db = getKyuyoDb(event)
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'DTAKO_DB binding が未設定です' })
  }
  try {
    return { companies: await listKyuyoCompanies(db) }
  }
  catch (e: unknown) {
    // "no such table" = migration 0005 未適用
    throw createError({
      statusCode: 503,
      statusMessage: `kyuyo_companies を読めません (migration 0005 適用済みか確認): ${e instanceof Error ? e.message : String(e)}`,
    })
  }
})
