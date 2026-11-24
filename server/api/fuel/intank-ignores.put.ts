/**
 * 誤差一覧の給油行を「無視」にする / 戻す (D1 `fuel_intank_ignores`、migration 0020)。
 * 本文 `{datetime, fuel_card_id, ignored}`。1 行ずつ (全体の一覧を受け取らない — 別の人が同時に押しても
 * 相手の印を消さない)。`ignored: true` は INSERT (既にあれば何もしない)、false は DELETE。
 * 誰が無視にしたか (`created_by` = ログインの email) を残す。
 *
 *   200 — `{ok: true, datetime, fuel_card_id, ignored}`
 *   400 — 本文の形が違う
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_DB binding 未設定
 */
import { defineEventHandler, readBody, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { assertAllowedRole } from '../../utils/require-role'
import { getKyuyoDb } from '../../utils/kyuyo-master-db'
import { cfEnv, resolveSecret } from '../../utils/cf-env'
import { parseIgnoreBody } from '~/utils/fuel-intank-ignore'

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
  const auth = await requireAuth(event, { authWorkerUrl, sharedSecret })
  assertAllowedRole(auth)

  const db = getKyuyoDb(event)
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'DTAKO_DB binding が未設定です' })
  }
  const parsed = parseIgnoreBody(await readBody(event).catch(() => null))
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.error })
  }
  const { datetime, fuel_card_id } = parsed.key
  if (parsed.ignored) {
    await db
      .prepare('INSERT OR IGNORE INTO fuel_intank_ignores (tenant_id, datetime, fuel_card_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(auth.tenant_id, datetime, fuel_card_id, auth.email ?? null, new Date().toISOString())
      .run()
  }
  else {
    await db
      .prepare('DELETE FROM fuel_intank_ignores WHERE tenant_id = ? AND datetime = ? AND fuel_card_id = ?')
      .bind(auth.tenant_id, datetime, fuel_card_id)
      .run()
  }
  return { ok: true, datetime, fuel_card_id, ignored: parsed.ignored }
})
