/**
 * R2 に残した**粗利の集計の最新版**から、**その運行 1 本ぶんの便**を返す (Refs #865)。
 *
 * `GET /api/profit/operation-leg-sales?ym=&unkoNo=` →
 * `profit/{ym}/margin-summary/latest.json` を 1 つだけ読んで、
 * `cache.operations[] の unkoNo が一致するもの`の `legs` を計上額パネルの形に畳んで返す。
 *
 * ## ★ なぜ `margin-snapshot.get.ts` で足りないのか (#865 の「まず既存で足りるか確かめる」)
 *
 * 実装を読んで確かめた結果、**足りない。2 点とも構造的**:
 *
 * 1. **あの口は `latest.json` を指せない。** `?version=` は `/^v-\d{8}T\d{6}$/` の厳格一致で
 *    (これは prefix 逸脱を「判定」ではなく「組み立て」で塞ぐための設計で、緩めてはいけない)、
 *    `latest` という名前は通らない。**最新版を名指しするには、まず名前を知る必要がある**
 * 2. **名前を知る口 (`margin-snapshots.get.ts`) が重い。** 一覧は
 *    `MARGIN_VERSION_BODY_LIMIT = 20` 本ぶんの**本文を読む** (1 本が `MarginCache` 丸ごと =
 *    本番 2026-07 実測で 174 KB 規模)。**運行 1 本の計上額を出すために月の版を 20 本読む**
 *    ことになる。しかも一覧 → 本文で R2 往復が 2 回
 *
 * ⇒ **`latest.json` を 1 回 `get()` する口**を足した。**応答も運行 1 本ぶんに絞る** —
 * 版まるごと (174 KB) をブラウザへ返すと、運行詳細を開くたびにその転送が乗る。
 *
 * ## ★ 読むだけ
 *
 * **`margin-summary` の書き込み側には触っていない**し、`reconcileVehicles` も回し直さない。
 * **粗利の数字を 1 円も作らない・変えない** — 保存済みの `customers` の名前と金額を
 * そのまま抜くだけ (`code` は画面が使わないので落とす)。
 *
 * ## ★ 「無い」は 200 で返す
 *
 * `margin-snapshot.get.ts` は版を名指しで取りに行くので「無い」は 404 でよいが、こちらは
 * **「その運行の計上額が出るか」を問い合わせる口**で、**出ない理由が 4 通りある**
 * (版が無い / 本文が読めない / 版にこの運行が居ない / 居るが便が 1 本も無い)。
 * 404 に潰すと画面がそれを言い分けられず、**「粗利タブで集計すると出ます」しか言えない
 * 今の状態に戻る**。理由は `OperationLegSalesR2` の `status` で返す。
 *
 * ## ★ `unkoNo` は R2 のキーに入らない
 *
 * キーを組むのは `marginR2Paths(ym).latest` だけで、`unkoNo` は**読んだ本文の中の
 * 文字列比較にしか使わない**。だから `..` も `/` も鍵にならず、`ym` の形の検査
 * (`margin-snapshot.get.ts` と同じ) だけで境界は閉じる。**形の検査を `unkoNo` に足さない** —
 * 運行NO は 22 桁と 23 桁があり (`runDateFromUnkoNo`)、ここで桁を決め打つと将来の桁で
 * 「ありません」と嘘をつく。空でないことだけを見る。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError } from 'h3'
import { marginR2Paths } from '~/utils/margin-r2'
import { pickOperationLegSalesFromSnapshot, type OperationLegSalesR2 } from '~/utils/operation-leg-sales-r2'
import type { R2BucketLite } from '../../utils/profit-r2-io'

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { PROFIT_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.PROFIT_R2 ?? null
}

export default defineEventHandler(async (event): Promise<OperationLegSalesR2> => {
  const r2 = getR2Binding(event)
  if (!r2) {
    throw createError({ statusCode: 503, statusMessage: 'PROFIT_R2 binding が未設定です' })
  }

  const query = getQuery(event)
  const ym = typeof query.ym === 'string' ? query.ym : ''
  const unkoNo = typeof query.unkoNo === 'string' ? query.unkoNo : ''
  if (!/^\d{4}-\d{2}$/.test(ym)) {
    throw createError({ statusCode: 400, statusMessage: 'ym (YYYY-MM) が必要です' })
  }
  if (unkoNo === '') {
    throw createError({ statusCode: 400, statusMessage: 'unkoNo が必要です' })
  }

  const body = await r2.get(marginR2Paths(ym).latest)
  // **その月がまだ一度も集計されていないだけ。** 異常ではないので理由として返す
  // (本文が読めなかった `unreadable` とは別のこと)。
  if (!body) return { status: 'no-version', ym }

  let parsed: unknown
  try {
    parsed = JSON.parse(await body.text())
  }
  catch {
    // **0 円に倒さない。** 読めなかったことを画面が言えるようにする。
    return { status: 'unreadable', ym }
  }
  return pickOperationLegSalesFromSnapshot(parsed, ym, unkoNo)
})
