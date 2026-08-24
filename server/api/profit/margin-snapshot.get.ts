/**
 * R2 に残した**粗利の集計の版 1 本の本文**を返す (Refs #834)。
 *
 * `GET /api/profit/margin-snapshot?ym=&version=` → `profit/{ym}/margin-summary/{version}.json`
 * を 1 つだけ読んでそのまま返す。**差分ビュー (`app/utils/margin-diff.ts`) が 2 回叩き、
 * 突き合わせるのは画面**。作りは `snapshot.get.ts` (キーを組んで `get()`、無ければ 404) の踏襲。
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
 * `profit/` 配下の任意のオブジェクトを読める口になる。**`ym` と版の名前を受けて
 * `marginR2Paths` で組み直す** (キーの組み立てを再発明しない、が同時に境界にもなる)。
 * 版の名前は `profitVersionTimestamp` が作る `YYYYMMDDTHHMMSS` しか無いので厳格一致で見る。
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
 * 版の名前 (`v-20260824T190153`)。**`isMarginVersionKey` (`/^v-.+\.json$/`) より厳しい** —
 * あちらは R2 の list を絞る側で、こちらは**外から来た文字列**を鍵に変える側。
 * `/` や `..` を通さないことがそのまま境界になる。
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
