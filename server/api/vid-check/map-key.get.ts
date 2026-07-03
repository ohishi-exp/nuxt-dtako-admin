import type { H3Event } from 'h3'
import { defineEventHandler } from 'h3'

/**
 * `/vid-check` (VidMap.vue) 用の Google Maps JS API key 取得 endpoint。
 *
 * `GOOGLEMAP_KEY_SECRET` は Cloudflare Secrets Store binding (`.get()` を持つ
 * オブジェクト、文字列ではない)。これを Nuxt の public runtimeConfig 自動 env
 * 上書き (`NUXT_PUBLIC_*` 命名) に直接載せると、起動時の Nitro deepFreeze が
 * このオブジェクトを frozen にしようとして `Cannot freeze` (code 10021) で
 * `wrangler deploy` ごと fail する (2026-07-03 実害)。値自体は referrer 制限
 * 済みの client-exposed 値なので、素朴に `.get()` して JSON で返すだけで足りる。
 */

interface SecretBinding { get(): Promise<string> }

function resolveGoogleMapKeyBinding(event: H3Event): SecretBinding | string | undefined {
  const ctx = event.context as { cloudflare?: { env?: { GOOGLEMAP_KEY_SECRET?: SecretBinding | string } } }
  return ctx.cloudflare?.env?.GOOGLEMAP_KEY_SECRET
}

export default defineEventHandler(async (event) => {
  const binding = resolveGoogleMapKeyBinding(event)
  let key: string | null = null
  if (typeof binding === 'string') {
    key = binding
  }
  else if (binding && typeof binding.get === 'function') {
    key = (await binding.get()) ?? null
  }
  else {
    // ローカル開発 (`nuxt dev`、CF binding 無し) 用フォールバック。
    key = process.env.NUXT_PUBLIC_GOOGLEMAP_KEY || null
  }
  return { key }
})
