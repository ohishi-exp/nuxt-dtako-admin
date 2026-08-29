/**
 * R2 上の dump JSON を読み出す endpoint。
 *
 * GET /api/vehicle-settings/object?key=vehicle-settings/4437/20260514_093253-0-0-4437.json
 *   200 — JSON (= VehicleSettings) をそのまま返す
 *   400 — key 形式不正
 *   404 — オブジェクト無し
 *   503 — R2 binding 未設定
 *
 * key prefix を `vehicle-settings/` に強制することで、本 endpoint 経由で
 * 他用途 (テンプレ xlsx 等) のオブジェクトを引けないようにする。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ので、A 段の `requireAuth`
 * (`y-time-template.put.ts` と同じ 2 行) をここにも入れる。
 *
 * **key prefix の強制は「別用途のオブジェクトを引かせない」ための制限で、
 * 呼び出し元が誰かは一切見ていない** — 認可の代わりにはならない。dump JSON は
 * 車輛のデジタコ設定そのもの (機器 ID・ファーム・しきい値) なので、
 * 「Access を通れる誰か」ではなく「ログインしている人」に限る。
 * 呼ぶのは車輛設定タブ (`/vehicle-settings/history` と
 * `VehicleSettingsDumpPicker`) の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET / DTAKO_R2 binding 未設定
 */

import { defineEventHandler, getQuery, createError, setResponseHeader } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { assertAllowedRole } from '../../utils/require-role'
import { VEHICLE_SETTINGS_R2_PREFIX } from '~/utils/vehicle-settings-r2'
import { cfEnv, resolveSecret } from '../../utils/cf-env'

interface R2Object {
  body: ReadableStream<Uint8Array> | null
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
  size: number
  etag: string
  uploaded: Date | string
  customMetadata?: Record<string, string>
  httpMetadata?: { contentType?: string }
}
interface R2BucketLite {
  get(key: string): Promise<R2Object | null>
}

interface CloudflareEnv {
  DTAKO_R2?: R2BucketLite
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

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
  // **query を読む前に認証する。** key の形を検査するより先に身元を見る。
  const auth = await requireAuth(event, { authWorkerUrl, sharedSecret })
  assertAllowedRole(auth)

  const { key } = getQuery(event)
  if (typeof key !== 'string' || !key) {
    throw createError({ statusCode: 400, statusMessage: 'key (string) is required' })
  }
  if (!key.startsWith(VEHICLE_SETTINGS_R2_PREFIX)) {
    throw createError({
      statusCode: 400,
      statusMessage: `key must start with \"${VEHICLE_SETTINGS_R2_PREFIX}\"`,
    })
  }
  // path traversal 系をシャットアウト
  if (key.includes('..')) {
    throw createError({ statusCode: 400, statusMessage: 'key must not contain \"..\"' })
  }
  if (!key.endsWith('.json')) {
    throw createError({ statusCode: 400, statusMessage: 'key must end with .json' })
  }

  const r2 = env.DTAKO_R2
  if (!r2) {
    throw createError({
      statusCode: 503,
      statusMessage: 'R2 binding (DTAKO_R2) not available',
    })
  }

  const obj = await r2.get(key)
  if (!obj) {
    throw createError({ statusCode: 404, statusMessage: `object not found: ${key}` })
  }

  setResponseHeader(
    event,
    'content-type',
    obj.httpMetadata?.contentType ?? 'application/json; charset=utf-8',
  )
  return await obj.text()
})
