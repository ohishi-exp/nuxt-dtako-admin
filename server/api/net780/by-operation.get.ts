/**
 * D1 検索カタログ (`dtako_uploads`、Refs #299) を運行No (operationNo) で
 * 引き、アーカイブ済みなら R2 (`DTAKO_R2`) から NET780 生データ ZIP を
 * そのまま返す。theearth セッションは不要 — `/net780-api/*` (DO 側、要
 * theearth ログイン) と違い、既にアーカイブ済みのデータを読むだけなので
 * Nitro から D1/R2 に直接アクセスする (vehicle-settings と同じパターン)。
 *
 * `/operations/{unko_no}` の NET780 タブから、運行詳細と同じ画面で使う想定。
 * unko_no (rust-alc-api の運行No) は NET780 の operationNo と同一キー空間
 * (22桁) であることを確認済み。
 *
 * GET /api/net780/by-operation?operationNo=2607141234560000001726
 *   200 — ZIP バイナリ (extractSingleOperationZip + parseNet780Zip はフロント側)
 *   400 — operationNo 形式不正
 *   404 — カタログ未登録・R2 オブジェクト欠落・または operation_count !== 1
 *         (複数運行まとめて archive された zip は個別運行を安全に取り出せない
 *         — DO 側の handleNet780R2View と同じガード、Refs #299 実害修正)
 *   503 — DTAKO_DB / DTAKO_R2 binding 未設定
 */

import type { H3Event } from 'h3'
import { defineEventHandler, getQuery, createError, setResponseHeader } from 'h3'

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

function getBindings(event: H3Event): { db: D1DatabaseLite | null; r2: R2BucketLite | null } {
  const ctx = event.context as {
    cloudflare?: { env?: { DTAKO_DB?: D1DatabaseLite; DTAKO_R2?: R2BucketLite } }
  }
  return {
    db: ctx.cloudflare?.env?.DTAKO_DB ?? null,
    r2: ctx.cloudflare?.env?.DTAKO_R2 ?? null,
  }
}

export default defineEventHandler(async (event) => {
  const { operationNo } = getQuery(event)
  if (typeof operationNo !== 'string' || !/^\d{22}$/.test(operationNo)) {
    throw createError({ statusCode: 400, statusMessage: 'operationNo は22桁の数値で指定してください' })
  }

  const { db, r2 } = getBindings(event)
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
