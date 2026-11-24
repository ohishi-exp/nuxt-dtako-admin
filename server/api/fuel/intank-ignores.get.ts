/**
 * 誤差一覧で「無視」にした給油行の一覧 (D1 `fuel_intank_ignores`、migration 0020)。
 * ログインしているテナントの行だけ返す。`{ignores: [{datetime, fuel_card_id, created_by, created_at}]}`
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_DB binding 未設定
 */
import { defineEventHandler, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { assertAllowedRole } from '../../utils/require-role'
import { getKyuyoDb } from '../../utils/kyuyo-master-db'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

interface AuthEnv {
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

interface IgnoreRow {
  datetime: string
  fuel_card_id: number
  created_by: string | null
  created_at: string
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
  const auth = await requireAuth(event, { authWorkerUrl, sharedSecret })
  assertAllowedRole(auth)

  const db = getKyuyoDb(event)
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'DTAKO_DB binding が未設定です' })
  }
  const { results } = await db
    .prepare('SELECT datetime, fuel_card_id, created_by, created_at FROM fuel_intank_ignores WHERE tenant_id = ?')
    .bind(auth.tenant_id)
    .all<IgnoreRow>()
  return { ignores: results }
})
