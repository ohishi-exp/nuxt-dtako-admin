/**
 * Cloudflare Workers の env binding / Secrets Store 値を取り出す共通ヘルパ。
 * server route ごとに同じ定義がコピーされていたのを 1 本に集約する
 * (Refs ohishi-exp/nuxt-dtako-admin#999)。
 *
 * server/utils/ichiban-upstream.ts にも同名の cfEnv / resolveSecret があるが、
 * 意図的に統合していない:
 *   - あちらの resolveSecret は try/catch で .get() の reject を null に握り潰す。
 *     こちら (と他 7 箇所) は例外を伝播させる。揃えるとどちらかの挙動が変わる
 *   - あちらの cfEnv は引数型が { context: unknown } で h3 に依存しない (テスト都合)
 * 重複を消すために挙動を変えるのは本末転倒なので、差分が解消されるまで別物として残す。
 */
import type { H3Event } from 'h3'

/**
 * Cloudflare Workers の env binding を H3Event から取り出す。
 *
 * 型引数で絞り込める: 呼び出し側がローカル interface (CloudflareEnv 等) を
 * 持っている場合は cfEnv<CloudflareEnv>(event) と書くことで R2Bucket 等の
 * 絞り込みを保てる。既定は Record<string, unknown>。ランタイムの挙動は同じ。
 */
export function cfEnv<T = Record<string, unknown>>(event: H3Event): T {
  return ((event.context.cloudflare as { env?: T } | undefined)?.env ?? {}) as T
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す。 */
export async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}
