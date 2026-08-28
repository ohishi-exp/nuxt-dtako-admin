/**
 * D1 検索カタログ (`dtako_uploads`、Refs #299) を運行No (operationNo) で
 * 引き、アーカイブ済みなら R2 (`DTAKO_R2`) から NET780 生データ ZIP を
 * そのまま返す。theearth セッションは不要 — `/net780-api/*` (DO 側、要
 * theearth ログイン) と違い、既にアーカイブ済みのデータを読むだけなので
 * Nitro から D1/R2 に直接アクセスする (vehicle-settings と同じパターン)。
 *
 * `/operations/{unko_no}` の NET780 タブから、運行詳細と同じ画面で使う想定。
 * 用途は 2 つ: ①画面内で解いて表示する (wasm parse はフロント側) ②**そのまま
 * ダウンロードさせる** (Refs #873。NET780 タブの「zip をダウンロード」が同じ口を
 * 叩き、**この応答のバイトをそのまま**ファイルにする — 解いて詰め直さない)。
 * unko_no (rust-alc-api の運行No) は NET780 の operationNo と**同一キー空間 (22桁)**。
 *
 * ## 「確認済み」の測定条件 (Refs #1011)
 *
 * 以前ここには「同一キー空間 (22桁) であることを確認済み」とだけ書いてあり、**いつ・
 * 何を数えたのかが無かった**。2026-08-28 に測り直した実測を条件ごと残す:
 *
 * - **母集団**: 本番 `/api/operations` (rust-alc-api の運行一覧) を**日付フィルタ無し**で
 *   読んだ**全 8,037 件**。読むだけの GET で、本番へは 1 バイトも書いていない。
 * - **桁の内訳**: **22 桁 8,037 件 / 23 桁 0 件**。
 * - **期間**: 先頭 6 桁 (`YYMMDD`) の範囲は `180101`〜`260827`
 *   = **2018-01-01 〜 2026-08-27 を覆う** (直近だけを見た数字ではない)。
 *
 * ⇒ **23 桁の運行NO は本番に 1 件も無い**ので、ここは 22 桁だけを受ける。
 *
 * ## `app/utils/allowance-report.ts` が 22/23 の両方を受けているのと矛盾しない
 *
 * 同じ運行NO を、**22 桁だけ受ける口**と**22/23 の両方を受ける util** が同居している
 * (#1011 の指摘)。両方が正しい — **役割が違う**:
 *
 * - **ここは実データの検証**。引く先は D1 `dtako_uploads` の `operation_no` で、上の
 *   実測どおり 22 桁しか存在しない。**桁を広げても通る件数は 1 件も増えず** (23 桁が
 *   0 件)、**存在しないキーで D1 を引いて「まだアーカイブされていません」と返す逆方向の
 *   嘘**が増えるだけになる。だから広げない。
 * - **あちら (`runDateFromUnkoNo` / `carryStartLabel`) は将来の桁への防御**。運行NO から
 *   日付・ラベルを**導くだけで存在検証をしない**ので、桁を決め打つと
 *   `server/api/profit/operation-leg-sales.get.ts` の JSDoc が言うとおり「将来の桁で
 *   『ありません』と嘘をつく」。受けておくのが正しい。
 *
 * **勤怠 (`app/pages/restraint-wage.vue` / `app/utils/kintai-*.ts`) の 22桁/23桁 は別の軸**
 * (オンプレ 23 桁 / GCP 22 桁 の取り込み) で、上の母集団ではない。混ぜて読まないこと。
 *
 * GET /api/net780/by-operation?operationNo=2607141234560000001726
 *   200 — ZIP バイナリ (extractSingleOperationZip + parseNet780Zip はフロント側)
 *   400 — operationNo が 22 桁の運行NO ではない (**利用者の入力ミスではない** — 下記)
 *   401 — 未ログイン (`requireAuth`、Refs #988)
 *   404 — カタログ未登録・R2 オブジェクト欠落・または operation_count !== 1
 *         (複数運行まとめて archive された zip は個別運行を安全に取り出せない
 *         — DO 側の handleNet780R2View と同じガード、Refs #299 実害修正)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_DB / DTAKO_R2 binding 未設定
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない** — 外した瞬間、運行NO を 22 桁総当たり
 * するだけで**運行の生データ ZIP** (速度・位置の秒単位の原本) が誰でも落とせる。
 * **「theearth セッションは不要」は上流の話で、こちら側の認可が要らない理由ではない。**
 * 書き込み側 (#995) と同じ A 段の `requireAuth` (`margin-summary.post.ts` と同じ 2 行)
 * をここにも入れる。呼ぶのは運行詳細の NET780 タブ
 * (`Net780OperationSummary.vue` / `useNet780OperationData.ts`) の**ブラウザだけ**で、
 * relay / cron / service binding からの呼び出しは無い (`git grep` で確認)。
 *
 * **`/net780-api/*` (DO 側) には足していない** — あちらは `worker/index.ts` が Nitro を
 * 迂回させる prefix なので、この handler を通らない。
 */

import { defineEventHandler, getQuery, createError, setResponseHeader } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

interface D1PreparedStatementLite {
  bind(...values: unknown[]): D1PreparedStatementLite
  first<T>(): Promise<T | null>
}
interface D1DatabaseLite {
  prepare(sql: string): D1PreparedStatementLite
}
interface R2ObjectLite {
  arrayBuffer(): Promise<ArrayBuffer>
  httpMetadata?: { contentType?: string }
}
interface R2BucketLite {
  get(key: string): Promise<R2ObjectLite | null>
}

interface CloudflareEnv {
  DTAKO_DB?: D1DatabaseLite
  DTAKO_R2?: R2BucketLite
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

export default defineEventHandler(async (event) => {
  const env = cfEnv<CloudflareEnv>(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **運行NO を 1 つも受け取る前に認証する。** 22 桁の総当たりで生データを
  // 引ける口だったので、形の検査より先に置く。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const { operationNo } = getQuery(event)
  if (typeof operationNo !== 'string' || !/^\d{22}$/.test(operationNo)) {
    // ★ **利用者の入力ミスとして書かない** (Refs #1011)。運行NO を手で入れる画面は無く、
    // ここへ来る `operationNo` は運行詳細 (`/operations/{unko_no}`) の route param を
    // 呼び出し側 2 本がそのまま渡している — 「22桁の数値で指定してください」と言われても
    // **利用者には直しようが無い**。書くのは「この形の運行NO では NET780 を引けない」まで。
    //
    // ★ **理由は本文 (`message`) の側に置き、`statusMessage` は ASCII に留める**
    // (Refs #886)。本番 (h3/workerd) の reason phrase は非 ASCII を落とすので、日本語を
    // `statusMessage` に載せると `400 operationNo 22` のような**単語に見える断片**が
    // 残る (`/api/ichiban/**` で `403 proxy` になった実例と同じ形)。同ファイルの他の
    // `createError` は日本語の `statusMessage` 1 本だが、**この 400 だけは穴を踏まない側に
    // 揃える** — ASCII なら reason phrase も無傷で、日本語は本文で読める。
    // なお呼び出し側 2 本 (`useNet780OperationData.ts` / `Net780OperationSummary.vue`) は
    // `responseType: 'blob'` で、ofetch がエラー本文を Blob のまま渡すので
    // `describeApiError` は届かない。本文は **devtools と Worker ログで理由が読める**
    // ための置き場である。
    throw createError({
      statusCode: 400,
      statusMessage: 'operationNo is not a 22-digit NET780 archive key',
      message: 'NET780 のアーカイブは 22 桁の運行NO でしか引けません (受け取った operationNo はその形ではありません)。運行NO は画面が渡しているので、利用者の入力の誤りではありません。',
    })
  }

  const db = env.DTAKO_DB ?? null
  const r2 = env.DTAKO_R2 ?? null
  if (!db || !r2) {
    throw createError({
      statusCode: 503,
      statusMessage: 'DTAKO_DB / DTAKO_R2 binding が未設定です',
    })
  }

  const row = await db
    .prepare(
      `SELECT r2_key, operation_count FROM dtako_uploads WHERE dataset = 'net780' AND operation_no = ? LIMIT 1`,
    )
    .bind(operationNo)
    .first<{ r2_key: string; operation_count: number | null }>()
  if (!row) {
    throw createError({
      statusCode: 404,
      statusMessage: 'この運行の NET780 データはまだアーカイブされていません',
    })
  }
  // operation_count が 1 でない (旧データで不明 = null 含む) 場合、その zip から
  // この operationNo のフォルダだけを安全に取り出せる保証が無い (r2-view の
  // 同種ガードと同じ理由)。無理に返して呼び出し側の parse エラーに繋げるより
  // 404 として明示的にフォールバックさせる。
  if (row.operation_count !== 1) {
    throw createError({
      statusCode: 404,
      statusMessage:
        '複数運行がまとめてアーカイブされているため、この運行だけを安全に表示できません。NET780 検索から再ダウンロードしてください',
    })
  }

  const obj = await r2.get(row.r2_key)
  if (!obj) {
    throw createError({
      statusCode: 404,
      statusMessage: '検索カタログにはありますが R2 オブジェクトが見つかりません',
    })
  }

  setResponseHeader(event, 'content-type', obj.httpMetadata?.contentType ?? 'application/zip')
  // H3 (Nitro) のハンドラが生の ArrayBuffer をそのまま return すると、バイナリ
  // 応答としてではなく JSON シリアライズされ `{}` (2 バイト) になってしまう
  // (実害: 2026-07-19、ZIP が2バイトの空応答になり net780-wasm 側で
  // "Corrupted zip" エラーになった)。Buffer でラップしてバイナリ応答にする。
  return Buffer.from(await obj.arrayBuffer())
})
