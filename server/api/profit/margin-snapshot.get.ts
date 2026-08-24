/**
 * R2 に残した**粗利の集計の版 1 本の本文**を返す (Refs #834)。
 *
 * `GET /api/profit/margin-snapshot?ym=&version=` → `profit/{ym}/margin-summary/{version}.json`
 * を 1 つだけ読んでそのまま返す。**差分ビュー (`app/utils/margin-diff.ts`) が 2 回叩き、
 * 突き合わせるのは画面**。作りは `snapshot.get.ts` (キーを組んで `get()`、無ければ 404) の踏襲。
 *
 * ## ★ `snapshot.get.ts` (検証スナップショット) と名前は似ているが別系統
 *
 * 突合は 2 系統ある (map skill)。あちらは **`/profit/monthly` のマッチ率**だけに効く
 * `profit/{ym}/{車輌CD}/{運行NO}/{segmentId}/latest.json` で、こちらは**粗利タブの月次突合
 * そのもの**を畳んだ `profit/{ym}/margin-summary/v-{ts}.json`。**同じ口にしない・混ぜない** —
 * 混ぜるとマッチ率の側が粗利の数字を読み始める。**この口が読むのは
 * `marginR2Paths(ym).dir` 配下だけ**で、その境界は下のキーの組み立て方が担保する。
 *
 * ## ★ 差分のロジックをここに持たせない (Refs #834 の条件)
 *
 * 2 版の本文を画面が取り、画面から `margin-diff.ts` を呼ぶ。ここで差分を作ると
 * ① 版を選び直すたびに 2 本とも読み直すことになり ② pure な差分がテストしにくくなり
 * ③ `app/utils` と server の分け方 (`margin-r2.ts` / `margin-versions.ts` と同じ) が崩れる。
 *
 * ## ★ 画面が持っている R2 のキーをそのまま受けない
 *
 * `MarginVersionEntry.key` は R2 のキーそのものだが、**クエリで受けたキーで `get()` しない** —
 * `PROFIT_R2` には検証スナップショットなど**別系統のものが同居**しているので、キーを無検証で
 * 通すと `profit/` 配下の任意のオブジェクトを読める口になる。
 *
 * **「受けたキーを検証する」ではなく「キーを受けない」方を採った。** `ym` と版の名前だけを
 * 受けて `marginR2Paths(ym).version(ts)` で**組み立てるのは常にサーバー側**にする —
 * prefix (`marginR2Paths(ym).dir` 配下) は組み立ての結果として**必ず**満たされるので、
 * 「prefix の中か」を後から確かめる判定そのものが要らない (**通らない判定を書かずに済む**)。
 * 残る検証は「版の名前の形」だけで、それは `/` も `..` も通さない厳格一致 1 本で足りる。
 * 版の名前は `profitVersionTimestamp` が作る `YYYYMMDDTHHMMSS` しか無い。
 *
 * **粗利の数字を 1 円も作らない・変えない。** 保存済みの JSON をそのまま返すだけ。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'
import { marginR2Paths, type MarginSummarySnapshot } from '~/utils/margin-r2'
import type { R2BucketLite } from '../../utils/profit-r2-io'

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { PROFIT_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.PROFIT_R2 ?? null
}

/**
 * 版の名前 (`v-20260824T190153`)。
 *
 * **`isMarginVersionKey` (`margin-versions.ts`、`/^v-.+\.json$/`) を使い回さない。**
 * あちらは**R2 の list が返したキー**を絞る側 (`.json` 付きのキー全体を受け、`v-` の後ろは
 * 何でも通す) で、こちらは**外から来た文字列**を鍵に変える側。ここで `.+` を許すと `/` も
 * `..` も通ってしまい、境界にならない。**判定の向きが逆なので、同じ関数にはできない。**
 */
const VERSION_LABEL_RE = /^v-\d{8}T\d{6}$/

export default defineEventHandler(async (event): Promise<MarginSummarySnapshot> => {
  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const query = getQuery(event)
  const ym = typeof query.ym === 'string' ? query.ym : ''
  const version = typeof query.version === 'string' ? query.version : ''
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    throw createError({ statusCode: 400, statusMessage: 'ym (YYYY-MM) が必要です' })
  }
  if (!VERSION_LABEL_RE.test(version)) {
    throw createError({ statusCode: 400, statusMessage: 'version (v-YYYYMMDDTHHMMSS) が必要です' })
  }

  // `marginR2Paths(ym).version(ts)` が `{dir}/v-{ts}.json` を組む。名前から `v-` を外して渡す。
  const key = marginR2Paths(ym).version(version.slice('v-'.length))
  const body = await r2.get(key)
  // **一覧に出ていても本文が無いことはある** (削除 race 等)。**空の版に倒さない** —
  // 中身が空の版と読めなかった版は別のこと (`margin-snapshots.get.ts` の `unreadable` と同じ)。
  if (!body) {
    throw createError({ statusCode: 404, statusMessage: `版 ${version} の本文を R2 から読めませんでした` })
  }
  return JSON.parse(await body.text()) as MarginSummarySnapshot
})
