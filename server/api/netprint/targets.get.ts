/**
 * 日報 netprint の通知先設定 (KV `netprint_targets`) を読む endpoint
 * (Refs #874 の 12)。`/scraper` の「日報netprint」タブが叩く。
 *
 * GET /api/netprint/targets
 *   200 — relay の応答をそのまま (JSON 配列
 *         `[{branch_cd, channel_id | recipient_id, branch_name?}, ...]`。未設定は `[]`)
 *   401 — 未ログイン (`requireAuth`)
 *   4xx/5xx — relay の応答をそのまま (status + `relay:` 前置のメッセージ)
 *   503 — SCRAPER_RELAY / INTERNAL_SHARED_SECRET binding 未設定
 *
 * 定型は `server/utils/scraper-relay.ts` に集約 (secret 未設定 503 → `requireAuth` →
 * SCRAPER_RELAY 未設定 503 → `relay.fetch` → 非 2xx は `relay:` 前置で throw)。**relay は
 * 3 env とも service binding 専用で外から叩けない**ので、この route が唯一の到達経路。
 * `X-Alc-Proxy-Secret` は worker 側で解決し、ブラウザには出さない。
 */

import { defineEventHandler } from 'h3'
import { describeNetprintTargetsFailure } from '../../utils/netprint-targets'
import { authorizeScraperRelay, sendToScraperRelay } from '../../utils/scraper-relay'

export default defineEventHandler(async (event) => {
  const auth = await authorizeScraperRelay(event)
  return sendToScraperRelay(event, auth, '/kintai-relay/netprint-targets', undefined, {
    method: 'GET',
    describeFailure: describeNetprintTargetsFailure,
  })
})
