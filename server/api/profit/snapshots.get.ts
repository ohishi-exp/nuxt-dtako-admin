/**
 * 保存済み検証スナップショットの一覧 (Refs #330)。
 *
 * GET /api/profit/snapshots?ym=&vehicle=&limit= → 車輌・年月を指定しなくても保存済み
 * スナップショットを保存日時の新しい順に一覧表示できるようにする (「マッチ率(月次集計)
 * より先に、まず保存したものから検索したい」というユーザー要望)。
 *
 * - `ym` を指定すると R2 prefix (`profit/{ym}/`) で絞り込む (効率的)。
 * - `vehicle` は `ym` と同時指定なら prefix (`profit/{ym}/{vehicle}/`) で絞り込めるが、
 *   単独指定の場合は R2 のキー構造上 (`profit/{ym}/{vehicle}/...`) prefix 検索できないため、
 *   全件取得後にメモリ上でフィルタする (現状の保存件数規模では許容範囲)。
 * - どちらも未指定なら `profit/` 配下を全件取得する。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'
import { listAllProfit, type R2BucketLite } from '../../utils/profit-r2-io'
import { toSnapshotListItem, sortSnapshotListBySavedAtDesc, type ProfitSnapshot, type SnapshotListItem } from '~/utils/profit-r2'

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { PROFIT_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.PROFIT_R2 ?? null
}

const DEFAULT_LIMIT = 200

export default defineEventHandler(async (event) => {
  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const query = getQuery(event)
  const ym = typeof query.ym === 'string' ? query.ym : ''
  const vehicle = typeof query.vehicle === 'string' ? query.vehicle : ''
  const limitParam = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : NaN
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, DEFAULT_LIMIT) : DEFAULT_LIMIT

  const prefix = ym && vehicle ? `profit/${ym}/${vehicle}/` : ym ? `profit/${ym}/` : 'profit/'
  const objects = await listAllProfit(r2, prefix)

  const snapshots: ProfitSnapshot[] = []
  for (const obj of objects) {
    if (!obj.key.endsWith('/latest.json')) continue // v-*.json/history.jsonl は除く
    const body = await r2.get(obj.key)
    if (body) snapshots.push(JSON.parse(await body.text()))
  }

  let items: SnapshotListItem[] = snapshots.map(toSnapshotListItem)
  if (vehicle && !ym) {
    items = items.filter(i => i.vehicleCode === vehicle)
  }
  items = sortSnapshotListBySavedAtDesc(items)

  return { items: items.slice(0, limit), total: items.length }
})
