/**
 * 検証スナップショットの取得 (Refs #330 PR3、**#859 より前の名前は「一番星マッチ率検証
 * スナップショット」**)。
 *
 * GET /api/profit/snapshot?ym=&vehicle=&unkoNo=&segmentId= → 保存済みなら
 * `latest.json` を返す (ProfitPanel の確認状態復元用)。未保存は 404。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない** — 外した瞬間、保存済み検証の本文
 * (確定伝票と確定金額) がそのまま公開される。**削除の口 (`snapshot.delete.ts`) は
 * #995 で既に塞いだ**ので、同じ鍵を読む側にも掛ける。A 段の `requireAuth`
 * (`margin-summary.post.ts` と同じ 2 行)。
 * 呼ぶのは `/profit/compare` の**ブラウザだけ**で、relay / cron / service binding
 * からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / PROFIT_R2 binding 未設定
 */
import { defineEventHandler, getQuery, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { profitR2Paths } from '~/utils/profit-r2'
import { cfEnv, resolveSecret } from '../../utils/cf-env'
import type { R2BucketLite } from '../../utils/profit-r2-io'

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
  // **R2 を読む前に認証する。** 返すのは確定伝票と確定金額そのもの。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

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
  const obj = await r2.get(paths.latest)
  if (!obj) {
    throw createError({ statusCode: 404, statusMessage: 'この区間の検証スナップショットはまだ保存されていません' })
  }
  return JSON.parse(await obj.text())
})
