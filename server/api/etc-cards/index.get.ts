/**
 * ETC カードの登録待ち一覧 (Refs #1287)。D1 `etc_card_registrations` をテナントの scan で絞って返す。
 * カード番号は末尾 5 桁 (`card_last5`) だけ返す — 全桁はブラウザへ出さない。
 * OCR に失敗した scan (画面の「再 OCR」の対象) も添える。
 *
 *   200 — `{registrations, failed_scans}`
 *   401 / 403 — 未ログイン / role 不許可 / tenant 不明
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_DB 未設定
 */
import { defineEventHandler } from 'h3'
import { etcCardsContext, listForTenant } from '../../utils/etc-scan'
import type { EtcCardsResponse } from '~/utils/etc-cards'

export default defineEventHandler(async (event): Promise<EtcCardsResponse> => {
  const { tenantId, db } = await etcCardsContext(event)
  return listForTenant(db, tenantId)
})
