/**
 * 日報 netprint の通知先設定 (KV `netprint_targets`) を保存する endpoint
 * (Refs #874 の 12)。`/scraper` の「日報netprint」タブが叩く。
 *
 * PUT /api/netprint/targets   body: JSON 配列
 *     `[{branch_cd, channel_id | recipient_id, branch_name?}, ...]` (**全体置き換え**)
 *   200 — relay の応答 (`{ok: true, targets}` = 正規化後に KV へ書いた値)
 *   400 — body が JSON でない / relay の検証に落ちた (理由は relay の文言をそのまま)
 *   401 — 未ログイン (`requireAuth`)
 *   4xx/5xx — relay の応答をそのまま (status + `relay:` 前置のメッセージ)
 *   503 — SCRAPER_RELAY / INTERNAL_SHARED_SECRET binding 未設定
 *
 * **中身の検証は front でしない。** 宛先の排他・Uuid・`branch_cd` 必須は relay の
 * `validateNetprintTargetsPayload` (cron と同じ部品) が正で、ここは body を素通しして
 * relay の 400 の理由を画面へ運ぶだけ。同じ規則を写すと「画面では保存できたのに
 * cron が落とす」設定が作れる。ここで弾くのは **JSON として読めない body だけ**
 * (relay へ渡す形にできないため)。
 */

import { defineEventHandler, readBody, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { assertAllowedRole } from '../../utils/require-role'
import { describeNetprintTargetsFailure } from '../../utils/netprint-targets'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>
}
interface CloudflareEnv {
  SCRAPER_RELAY?: FetcherLike
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

/** body が読めなかったことを表す番兵 (`undefined` は「空 body」と区別が付かない)。 */
const UNREADABLE = Symbol('unreadable-body')

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
  const auth = await requireAuth(event, { authWorkerUrl, sharedSecret })
  assertAllowedRole(auth)

  const body = await readBody(event).catch(() => UNREADABLE) as unknown
  if (body === UNREADABLE) {
    throw createError({ statusCode: 400, statusMessage: 'body は JSON 配列で指定してください' })
  }

  const relay = env.SCRAPER_RELAY
  if (!relay) {
    throw createError({ statusCode: 503, statusMessage: 'SCRAPER_RELAY service binding が未設定です' })
  }

  const res = await relay.fetch('https://relay.internal/kintai-relay/netprint-targets', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'X-Alc-Proxy-Secret': sharedSecret },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null) as unknown
  if (!res.ok) {
    throw createError({
      statusCode: res.status,
      statusMessage: `relay: ${describeNetprintTargetsFailure(data, res.status)}`,
      data,
    })
  }
  // 2xx なのに JSON が読めない応答は relay 側の異常 (黙って null を返さない)。
  if (data === null) {
    throw createError({ statusCode: 502, statusMessage: 'relay の応答が JSON ではありません' })
  }
  return data
})
