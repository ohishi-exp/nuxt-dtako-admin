/**
 * 車輌+月単位の一番星マッチ率検証サマリ (Refs #330 PR4、Task #1 実データマッチ率検証の集計本体)。
 *
 * GET /api/profit/monthly?vehicle=&ym=YYYY-MM
 *   (a) 一番星側月計: vehicle-daily を月全体 (from=月初, to=翌月初) で1回呼び amount を合算
 *       (月計一致ルールは vehicle-daily の amount に適用済みなので単純合算でよい)
 *   (b) 保存済み検証スナップショット (`PROFIT_R2` の `profit/{ym}/{vehicle}/`配下) の
 *       confirmedAmount を合算
 *   (c) 差額 (a-b)
 *   (d) 確認済み伝票の積地・卸地マッチレベル内訳 (exact/partial/none)
 * 集計の純粋部分は `app/utils/profit-r2.ts::summarizeMonthly`。
 *
 * 得意先・積地卸地・品目でのグルーピングは今回スコープ外 (ユーザー未確定のため)。
 * 保存済みスナップショットに必要な生データは含まれているので、キー設計が決まれば
 * 後から追加できる。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'
import { fetchIchiban, cfEnv, type IchibanUpstreamError } from '../../utils/ichiban-upstream'
import { listAllProfit, type R2BucketLite } from '../../utils/profit-r2-io'
import { monthRange, summarizeMonthly, type ProfitSnapshot } from '~/utils/profit-r2'
import { mapVehicleDailyApiRow, type VehicleDailyApiRow } from '~/utils/ichiban'

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { PROFIT_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.PROFIT_R2 ?? null
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const vehicle = typeof query.vehicle === 'string' ? query.vehicle : ''
  const ym = typeof query.ym === 'string' ? query.ym : ''
  if (!vehicle || !/^\d{4}-\d{2}$/.test(ym)) {
    throw createError({ statusCode: 400, statusMessage: 'vehicle/ym (YYYY-MM) が必要です' })
  }

  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const env = cfEnv(event)
  const { from, to } = monthRange(ym)
  const search = `?${new URLSearchParams({ vehicle, from, to }).toString()}`

  let upstreamRes: Response
  try {
    upstreamRes = await fetchIchiban(env, 'api/sales/vehicle-daily', search)
  }
  catch (e: unknown) {
    const err = e as IchibanUpstreamError
    throw createError({ statusCode: err.statusCode, statusMessage: err.message })
  }
  if (!upstreamRes.ok) {
    throw createError({ statusCode: upstreamRes.status, statusMessage: await upstreamRes.text() })
  }
  const upstreamJson = await upstreamRes.json() as { data: VehicleDailyApiRow[] }
  const ichibanRows = upstreamJson.data.map(mapVehicleDailyApiRow)

  const objects = await listAllProfit(r2, `profit/${ym}/${vehicle}/`)
  const snapshots: ProfitSnapshot[] = []
  for (const obj of objects) {
    if (!obj.key.endsWith('/latest.json')) continue // v-*.json/history.jsonl は集計対象外
    const body = await r2.get(obj.key)
    if (body) snapshots.push(JSON.parse(await body.text()))
  }

  return summarizeMonthly(ichibanRows, snapshots)
})
