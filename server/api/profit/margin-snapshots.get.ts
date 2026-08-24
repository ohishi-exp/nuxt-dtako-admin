/**
 * R2 に残した**粗利の集計の版**の一覧 (Refs #833)。
 *
 * `GET /api/profit/margin-snapshots?ym=` → `profit/{ym}/margin-summary/` を列挙し、
 * **`v-*.json` だけ**を版として**新しい順**に返す (`latest.json` / `history.jsonl` は除く)。
 * 作りは `snapshots.get.ts` (検証スナップショット一覧) を踏襲する — R2 binding 未設定なら
 * 503、`listAllProfit` で prefix 全件。
 *
 * **`head()` を版の数だけ叩かない。** list 結果に `customMetadata` は載らない
 * (`R2ListOptionsLite` に `include` が無い) ので `codeVersion` を一覧に出すには版ごとに
 * `head()` が要るが、**そのためだけに N 回叩く価値は無い** — 版の名前 (`marginVersionLabel`)
 * はキーからタダで作れる。
 *
 * 本文 (`get()`) を読むのは**新しい方から `MARGIN_VERSION_BODY_LIMIT` 本まで**。版が何本
 * あるかは月によって違い事前には分からないので、**本数によらず一定の回数**で済ませる。
 * 省いた本数は `omitted` で返し、**画面がそれを人に言う**。**読めなかった版は別勘定**
 * (`unreadable`) — 読まなかった (正常) と読めなかった (異常) を 1 つの数字に混ぜない。
 *
 * **`history.jsonl` を版の一覧に使わない** (Refs #833 の条件): ① `PROFIT_HISTORY_MAX_LINES`
 * で古い行が落ちるが**版そのものは消えない** ② `changed:false` の回も 1 行使う
 * ③ `MarginSummaryHistoryLine` は `versionKey` を持たないので版を指す鍵にならない。
 *
 * **粗利の数字を 1 円も作らない・変えない。** 保存済みの `totals` から 4 つ抜くだけ。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'
import { listAllProfit, type R2BucketLite } from '../../utils/profit-r2-io'
import { marginR2Paths, type MarginSummarySnapshot } from '~/utils/margin-r2'
import {
  countUnreadableMarginVersions,
  listMarginVersionEntries,
  marginVersionOmittedCount,
  pickMarginVersionTotals,
  MARGIN_VERSION_BODY_LIMIT,
  type MarginVersionItem,
  type MarginVersionListResult,
} from '~/utils/margin-versions'

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { PROFIT_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.PROFIT_R2 ?? null
}

export default defineEventHandler(async (event): Promise<MarginVersionListResult> => {
  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const query = getQuery(event)
  const ym = typeof query.ym === 'string' ? query.ym : ''
  // **月を跨いで舐めない。** 版は月ごとの系列なので、prefix を `profit/` まで広げると
  // 別の月の版が混ざる (`marginR2Paths` が組む枝がそのまま境界)。
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    throw createError({ statusCode: 400, statusMessage: 'ym (YYYY-MM) が必要です' })
  }

  const objects = await listAllProfit(r2, `${marginR2Paths(ym).dir}/`)
  const entries = listMarginVersionEntries(objects.map(o => o.key))

  const items: MarginVersionItem[] = []
  for (const [i, entry] of entries.entries()) {
    if (i >= MARGIN_VERSION_BODY_LIMIT) {
      // **上限より古い版はラベルだけ。** 本文は読まない (省いたことは `omitted` で言う)。
      items.push({ ...entry, totals: null, totalsState: 'over-limit' })
      continue
    }
    const body = await r2.get(entry.key)
    // list に出たのに get が null になるのは削除 race 等。**金額を 0 に倒さず**
    // 「読めなかった」として null のまま出す (`snapshots.get.ts` と同じ防御)。
    // **`over-limit` と同じ形にしない** — 読まなかった (正常) と読めなかった (異常) は
    // 別のことで、同じ見た目にすると読む人が理由を判別できない。
    if (!body) {
      items.push({ ...entry, totals: null, totalsState: 'unreadable' })
      continue
    }
    const snapshot = JSON.parse(await body.text()) as MarginSummarySnapshot
    items.push({ ...entry, totals: pickMarginVersionTotals(snapshot.totals), totalsState: 'read' })
  }

  return {
    ym,
    items,
    total: entries.length,
    bodyLimit: MARGIN_VERSION_BODY_LIMIT,
    omitted: marginVersionOmittedCount(entries.length, MARGIN_VERSION_BODY_LIMIT),
    unreadable: countUnreadableMarginVersions(items),
  }
})
