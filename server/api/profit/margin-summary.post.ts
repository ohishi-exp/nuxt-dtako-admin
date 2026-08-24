/**
 * 粗利の集計結果 (`MarginCache`) の版管理保存 (Refs #826)。
 *
 * `POST /api/profit/margin-summary` に画面の集計 (`MarginSummaryInput`) を投げると、
 * サーバー側で `savedAt` (時計) を埋めて `PROFIT_R2` にバージョン管理保存する
 * (`putVersionedProfit`、**内容不変なら版を増やさず** `lastVerifiedAt` /
 * `lastVerifiedCodeVersion` のみ更新)。履歴 (`history.jsonl`) にも 1 行追記する。
 * **確定ボタンは無い** — 粗利タブが再計算するたびにここへ来る。
 *
 * `codeVersion` (ビルド時定数) は**画面が名乗る** — 数字を計算するのは画面なので、
 * 画面の版がその数字を作った版そのものになる。ここでは `resolveCodeVersion` で
 * 正規化するだけで、**空文字や undefined を版に混ぜない**。
 *
 * 作りは `snapshot.post.ts` (検証スナップショット) と同じ。**別の口にしてある**のは
 * 突合が 2 系統あるためで、混ぜると `/profit/monthly` のマッチ率が粗利の数字を
 * 読み始める (map skill「突合は 2 系統ある — 混ぜない」)。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, readBody, createError } from 'h3'
import {
  marginR2Paths,
  marginSummaryHashInput,
  marginSummaryHistoryLine,
  resolveCodeVersion,
  MARGIN_SUMMARY_SCHEMA_VERSION,
  type MarginSummaryInput,
  type MarginSummarySnapshot,
} from '~/utils/margin-r2'
import { profitVersionTimestamp } from '~/utils/profit-r2'
import { putVersionedProfit, appendProfitHistory, type R2BucketLite } from '../../utils/profit-r2-io'

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { PROFIT_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.PROFIT_R2 ?? null
}

/**
 * **月の集計そのもの**が要る。`cache.ym` が body の `ym` と違うものは受けない —
 * 保存先 (`profit/{ym}/margin-summary/`) と中身の月がずれると、後から版を読んだ側が
 * 別の月の数字を見る。
 */
function isValidInput(body: unknown): body is MarginSummaryInput {
  if (!body || typeof body !== 'object') return false
  const b = body as Partial<MarginSummaryInput>
  if (b.schemaVersion !== MARGIN_SUMMARY_SCHEMA_VERSION) return false
  if (typeof b.ym !== 'string' || !/^\d{4}-\d{2}$/.test(b.ym)) return false
  if (!b.totals || typeof b.totals !== 'object') return false
  if (!b.cache || typeof b.cache !== 'object') return false
  if (b.cache.ym !== b.ym) return false
  return Array.isArray(b.cache.operations) && Array.isArray(b.cache.costs)
}

export default defineEventHandler(async (event) => {
  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const body = await readBody(event)
  if (!isValidInput(body)) {
    throw createError({ statusCode: 400, statusMessage: 'schemaVersion/ym/totals/cache (ym 一致) が必要です' })
  }

  // 画面が名乗るビルド時定数。タグリリース以外のビルドでは空で来るので、
  // **空文字や undefined を版に混ぜず**「不明」に倒してから使う。
  const codeVersion = resolveCodeVersion(body.codeVersion)
  const savedAt = new Date().toISOString()
  const snapshot: MarginSummarySnapshot = { ...body, codeVersion, savedAt }
  const paths = marginR2Paths(snapshot.ym)
  const ts = profitVersionTimestamp(new Date())
  // savedAt / codeVersion は毎回変わりうるのでハッシュ対象から除く (marginSummaryHashInput)。
  const result = await putVersionedProfit(
    r2,
    paths.latest,
    paths.version(ts),
    JSON.stringify(snapshot),
    marginSummaryHashInput(snapshot),
    savedAt,
    codeVersion,
  )
  await appendProfitHistory(r2, paths.history, JSON.stringify(marginSummaryHistoryLine(snapshot, result.changed)))

  return { saved: true, changed: result.changed, savedAt, codeVersion }
})
