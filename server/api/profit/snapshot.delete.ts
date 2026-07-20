/**
 * 一番星マッチ率検証スナップショットの削除 (Refs #330 保存済み一覧からの削除アクション)。
 *
 * DELETE /api/profit/snapshot?ym=&vehicle=&unkoNo=&segmentId= → `latest.json` を削除し
 * 一覧 (`/api/profit/snapshots`) から消す。`v-*.json` の版履歴と history.jsonl は監査証跡
 * として残す (profit-r2.ts の設計方針、7日pruneを採用しない理由と同じ)。削除イベントも
 * history.jsonl に追記する。未保存 (既に削除済み等) でもエラーにせず冪等に成功扱いにする。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'
import { profitR2Paths } from '~/utils/profit-r2'
import { appendProfitHistory, type R2BucketLite } from '../../utils/profit-r2-io'

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
  await r2.delete(paths.latest)
  await appendProfitHistory(r2, paths.history, JSON.stringify({
    ts: new Date().toISOString(),
    deleted: true,
  }))

  return { deleted: true }
})
