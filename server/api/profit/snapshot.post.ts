/**
 * 一番星マッチ率検証スナップショットの保存 (Refs #330 PR3)。
 *
 * POST /api/profit/snapshot に `ProfitSnapshot` (savedAt 抜き) を投げると、
 * サーバー側で `savedAt` を今回時刻で埋めて `PROFIT_R2` にバージョン管理保存する
 * (`putVersionedProfit`、内容不変なら版を増やさず lastVerifiedAt のみ更新)。
 * 確認履歴 (history.jsonl) にも 1 行追記する。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, readBody, createError } from 'h3'
import { profitR2Paths, profitVersionTimestamp, type ProfitSnapshot } from '~/utils/profit-r2'
import { putVersionedProfit, appendProfitHistory, type R2BucketLite } from '../../utils/profit-r2-io'

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { PROFIT_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.PROFIT_R2 ?? null
}

type SnapshotInput = Omit<ProfitSnapshot, 'savedAt'>

function isValidInput(body: unknown): body is SnapshotInput {
  if (!body || typeof body !== 'object') return false
  const b = body as Partial<SnapshotInput>
  return typeof b.vehicleCode === 'string' && b.vehicleCode.length > 0
    && typeof b.unkoNo === 'string' && b.unkoNo.length > 0
    && typeof b.segmentId === 'string' && b.segmentId.length > 0
    && typeof b.ym === 'string' && /^\d{4}-\d{2}$/.test(b.ym)
    && Array.isArray(b.confirmedSlips)
}

export default defineEventHandler(async (event) => {
  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const body = await readBody(event)
  if (!isValidInput(body)) {
    throw createError({ statusCode: 400, statusMessage: 'vehicleCode/unkoNo/segmentId/ym/confirmedSlips が必要です' })
  }

  const savedAt = new Date().toISOString()
  const snapshot: ProfitSnapshot = { ...body, savedAt }
  const paths = profitR2Paths(snapshot.ym, snapshot.vehicleCode, snapshot.unkoNo, snapshot.segmentId)
  const ts = profitVersionTimestamp(new Date())
  const json = JSON.stringify(snapshot)
  // savedAt は呼び出す度に変わるためハッシュ対象から除く (putVersionedProfit のコメント参照)
  const hashInput = JSON.stringify(body)

  const result = await putVersionedProfit(r2, paths.latest, paths.version(ts), json, hashInput, savedAt)
  await appendProfitHistory(r2, paths.history, JSON.stringify({
    ts: savedAt,
    changed: result.changed,
    confirmedAmount: snapshot.confirmedAmount,
    confirmedCount: snapshot.confirmedSlips.length,
  }))

  return { saved: true, changed: result.changed, savedAt }
})
