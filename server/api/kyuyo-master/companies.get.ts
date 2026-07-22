/**
 * D1 `kyuyo_companies` の一覧を返す (Refs #369)。
 *
 * 給与DB取得ページの初期表示用 — rust API (給与大臣 PC) には触らないので常に高速。
 * リストの更新は refresh.post (差分) / refresh-full.post (フル)。
 */
import { defineEventHandler, createError } from 'h3'
import { getKyuyoDb, listKyuyoCompanies } from '../../utils/kyuyo-master-db'

export default defineEventHandler(async (event) => {
  const db = getKyuyoDb(event)
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'DTAKO_DB binding が未設定です' })
  }
  try {
    return { companies: await listKyuyoCompanies(db) }
  }
  catch (e: unknown) {
    // "no such table" = migration 0005 未適用
    throw createError({
      statusCode: 503,
      statusMessage: `kyuyo_companies を読めません (migration 0005 適用済みか確認): ${e instanceof Error ? e.message : String(e)}`,
    })
  }
})
