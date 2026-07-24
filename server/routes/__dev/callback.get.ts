/**
 * dev-login callback (issue ippoan/auth-worker#423/#425)。ローカル
 * `wrangler dev --remote -e dev` 専用: MCP `issue_dev_login_url` が返す
 * `http://localhost:<port>/__dev/callback?code=...` を人間が開いたときに
 * 叩かれる。`DEV_LOGIN` env var (env.dev のみ、[[env.dev.vars]] 参照) が
 * "true" の時だけルートとして機能し、それ以外 (本番/staging/preview) は 404。
 */
import type { H3Event } from 'h3'
import { createDevLoginCallbackHandler } from '@ippoan/auth-client/server'

function cfEnv(event: H3Event): Record<string, unknown> {
  return (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
}

export default defineEventHandler((event) => {
  const env = cfEnv(event)
  if (env.DEV_LOGIN !== 'true') {
    throw createError({ statusCode: 404 })
  }

  const authWorkerUrl =
    typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' ? env.NUXT_PUBLIC_AUTH_WORKER_URL : ''

  return createDevLoginCallbackHandler({ authWorkerUrl })(event)
})
