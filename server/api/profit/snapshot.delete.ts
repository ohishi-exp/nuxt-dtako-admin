/**
 * 検証スナップショットの削除 (Refs #330 保存済み一覧からの削除アクション)。
 *
 * DELETE /api/profit/snapshot?ym=&vehicle=&unkoNo=&segmentId= → `latest.json` を削除し
 * 一覧 (`/api/profit/snapshots`) から消す。`v-*.json` の版履歴と history.jsonl は監査証跡
 * として残す (profit-r2.ts の設計方針、7日pruneを採用しない理由と同じ)。削除イベントも
 * history.jsonl に追記する。未保存 (既に削除済み等) でもエラーにせず冪等に成功扱いにする。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ので、A 段の `requireAuth`
 * (`allowance-override.post.ts` と同じ 2 行) をここにも入れる。
 * 呼ぶのは保存済み一覧 (`/profit/monthly`) の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / PROFIT_R2 binding 未設定
 */
import { defineEventHandler, getQuery, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { assertAllowedRole } from '../../utils/require-role'
import { profitR2Paths } from '~/utils/profit-r2'
import { appendProfitHistory, type R2BucketLite } from '../../utils/profit-r2-io'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

interface CloudflareEnv {
  PROFIT_R2?: R2BucketLite
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
  // **消す前に認証する。** 消えるのは人が確認した作業の記録なので、
  // 「Access を通れる誰か」ではなく「ログインしている人」に限る。
  const auth = await requireAuth(event, { authWorkerUrl, sharedSecret })
  assertAllowedRole(auth)

  const r2 = env.PROFIT_R2
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const query = getQuery(event)
  const ym = typeof query.ym === 'string' ? query.ym : ''
  const vehicle = typeof query.vehicle === 'string' ? query.vehicle : ''
  const unkoNo = typeof query.unkoNo === 'string' ? query.unkoNo : ''
  const segmentId = typeof query.segmentId === 'string' ? query.segmentId : ''
  if (!ym || !vehicle || !unkoNo || !segmentId) {
    throw createError({ statusCode: 400, statusMessage: 'ym/vehicle/unkoNo/segmentId が必要です' })
  }

  const paths = profitR2Paths(ym, vehicle, unkoNo, segmentId)
  await r2.delete(paths.latest)
  await appendProfitHistory(r2, paths.history, JSON.stringify({
    ts: new Date().toISOString(),
    deleted: true,
  }))

  return { deleted: true }
})
