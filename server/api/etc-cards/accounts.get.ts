/**
 * ETC アカウントの記録 (種別・ログイン後のパス・機能コード一覧・最後の取得) と、「今すぐ登録」の担当 (Refs #1287)。
 * relay (`workers/dtako-scraper-relay`) の `GET /etc-card/accounts` へ SCRAPER_RELAY service binding で転送して
 * そのまま返す。user_id は relay 側で末尾 4 文字に伏せ済み (password・cookie は relay の応答に無い)。
 * 「ETC アカウントを取り直す」(`accounts-recheck.post.ts`) は 202 で受けるだけなので、結果はここで読む。
 */
import { defineEventHandler } from 'h3'
import type { EtcAccountsResponse } from '~/utils/etc-cards'
import { etcCardsContext } from '../../utils/etc-scan'
import { sendToScraperRelay } from '../../utils/scraper-relay'

export default defineEventHandler(async (event): Promise<EtcAccountsResponse> => {
  const { auth } = await etcCardsContext(event)
  return await sendToScraperRelay(event, auth, '/etc-card/accounts', null, { method: 'GET' }) as EtcAccountsResponse
})
