/**
 * 一番星マッチ率検証スナップショットの取得 (Refs #330 PR3)。
 *
 * GET /api/profit/snapshot?ym=&vehicle=&unkoNo=&segmentId= → 保存済みなら
 * `latest.json` を返す (ProfitPanel の確認状態復元用)。未保存は 404。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'
import { profitR2Paths } from '~/utils/profit-r2'
import type { R2BucketLite } from '../../utils/profit-r2-io'

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { PROFIT_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.PROFIT_R2 ?? null
}

export default defineEventHandler(async (event) => {
  const r2 = getR2Binding(event)
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
