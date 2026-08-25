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
 * 構造は `run.post.ts` と同じ (secret 未設定 503 → `requireAuth` → SCRAPER_RELAY
 * 未設定 503 → `relay.fetch` → 非 2xx は `relay:` 前置で throw)。**relay は 3 env とも
 * service binding 専用で外から叩けない**ので、この route が唯一の到達経路。
 * `X-Alc-Proxy-Secret` は worker 側で解決し、ブラウザには出さない。
 */

import type { H3Event } from 'h3'
import { defineEventHandler, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { describeNetprintTargetsFailure } from '../../utils/netprint-targets'

interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>
}
interface CloudflareEnv {
  SCRAPER_RELAY?: FetcherLike
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

function cfEnv(event: H3Event): CloudflareEnv {
  return (event.context.cloudflare as { env?: CloudflareEnv } | undefined)?.env ?? {}
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す
 * (`run.post.ts` と同実装)。 */
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

export default defineEventHandler(async (event) => {
  const env = cfEnv(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const relay = env.SCRAPER_RELAY
  if (!relay) {
    throw createError({ statusCode: 503, statusMessage: 'SCRAPER_RELAY service binding が未設定です' })
  }

  const res = await relay.fetch('https://relay.internal/kintai-relay/netprint-targets', {
    method: 'GET',
    headers: { 'X-Alc-Proxy-Secret': sharedSecret },
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
