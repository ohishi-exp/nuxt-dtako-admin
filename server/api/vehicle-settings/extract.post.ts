/**
 * NET780 デジタコ dump zip をアップロードして車輛設定 (`.cfg`) を JSON で返す endpoint。
 *
 * - multipart/form-data の `file` フィールドに zip を入れて POST
 * - 抽出に成功したら R2 (`DTAKO_R2` バケット) の `vehicle-settings/<vehicle_cd>/<dump_dir>.json`
 *   と `.cfg` (CP932 のまま原本) に保存する。R2 保存成功時は D1 検索カタログ
 *   (`dtako_uploads`、Refs #299) にも upsert し、車番横断検索できるようにする
 *   (D1 書き込みは best-effort — 失敗しても R2 保存・応答には影響しない)。
 * - R2 binding が無い環境 (vitest / dev で binding 未設定 等) や vehicle_cd / dump_dir が
 *   path から取れなかった場合は `saved_warning` を返して成功扱い (UX 互換)。
 * - parse 本体は `app/utils/vehicle-settings-cfg.ts` (pure)
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ので、A 段の `requireAuth`
 * (`allowance-override.post.ts` と同じ 2 行) をここにも入れる。**zip を読む前に**
 * 通すので、未ログインの相手に 5MB のアップロードを解かせない。
 * 呼ぶのは車輛設定タブ (`/vehicle-settings`) の**ブラウザだけ**で、relay / cron /
 * service binding からの呼び出しは無い (`git grep` で確認)。
 *
 *   401 — 未ログイン (`requireAuth`)
 *   503 — INTERNAL_SHARED_SECRET binding 未設定
 *         (**R2/D1 は従来どおり未設定でも成功扱い** — `saved_warning` で返す)
 */

import type { H3Event } from 'h3'
import { defineEventHandler, readMultipartFormData, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import {
  extractVehicleSettingsAndCfgBytes,
  type VehicleSettings,
} from '~/utils/vehicle-settings-cfg'
import { vehicleSettingsR2Paths } from '~/utils/vehicle-settings-r2'
import { resolveSecret } from '../../utils/cf-env'

const MAX_BYTES = 5 * 1024 * 1024 // 5MB — NET780 dump zip は 50KB 程度なので余裕の上限

interface R2PutOptions {
  httpMetadata?: { contentType?: string }
  customMetadata?: Record<string, string>
}
interface R2BucketLite {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: R2PutOptions,
  ): Promise<unknown>
}
interface D1PreparedStatementLite {
  bind(...values: unknown[]): D1PreparedStatementLite
  run(): Promise<unknown>
}
interface D1DatabaseLite {
  prepare(sql: string): D1PreparedStatementLite
}

interface AuthEnv {
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

function authEnv(event: H3Event): AuthEnv {
  return (event.context.cloudflare as { env?: AuthEnv } | undefined)?.env ?? {}
}

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { DTAKO_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.DTAKO_R2 ?? null
}

function getD1Binding(event: H3Event): D1DatabaseLite | null {
  const ctx = event.context as { cloudflare?: { env?: { DTAKO_DB?: D1DatabaseLite } } }
  return ctx.cloudflare?.env?.DTAKO_DB ?? null
}

/** D1 検索カタログ (`dtako_uploads`、Refs #299) へ vehicle-settings の1行を
 * upsert する。R2 保存が正、D1 はあくまで車番検索用の再構築可能インデックス
 * なので、binding 未設定・書き込み失敗は無視する (R2 保存の成否には影響しない、
 * best-effort)。 */
async function upsertVehicleSettingsCatalog(
  event: H3Event,
  vehicleCd: string,
  dumpDir: string,
  jsonKey: string,
  uploadedAt: string,
): Promise<void> {
  const db = getD1Binding(event)
  if (!db) return
  try {
    await db
      .prepare(
        `INSERT INTO dtako_uploads
           (dataset, schema_version, vehicle_cd, dump_dir, r2_key, uploaded_at)
         VALUES ('vehicle_settings', '1', ?, ?, ?, ?)
         ON CONFLICT(dataset, r2_key) DO UPDATE SET
           vehicle_cd = excluded.vehicle_cd,
           dump_dir = excluded.dump_dir,
           uploaded_at = excluded.uploaded_at`,
      )
      .bind(vehicleCd, dumpDir, jsonKey, uploadedAt)
      .run()
  } catch (e) {
    console.error(JSON.stringify({ vehicle_settings_d1: 'error', error: e instanceof Error ? e.message : String(e) }))
  }
}

export interface ExtractResponse extends VehicleSettings {
  /** 保存成功時の R2 key 情報 (binding 無し / 失敗時は null) */
  saved: { json_key: string; cfg_key: string } | null
  /** 保存できなかった場合の人間向け理由 */
  saved_warning: string | null
}

export default defineEventHandler(async (event): Promise<ExtractResponse> => {
  const env = authEnv(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **body を読む前に認証する。** 未ログインの相手に zip を展開させない。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  const parts = await readMultipartFormData(event)
  if (!parts || parts.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'multipart/form-data body が必要です',
    })
  }

  const filePart = parts.find((p) => p.name === 'file') ?? parts.find((p) => p.filename)
  if (!filePart || !filePart.data) {
    throw createError({
      statusCode: 400,
      statusMessage: 'field \"file\" に zip を添付してください',
    })
  }
  if (filePart.data.byteLength > MAX_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `zip が大きすぎます (${filePart.data.byteLength} bytes, max ${MAX_BYTES})`,
    })
  }

  let parsed: VehicleSettings
  let cfgBytes: Uint8Array
  try {
    const r = await extractVehicleSettingsAndCfgBytes(filePart.data)
    parsed = r.parsed
    cfgBytes = r.cfg_bytes
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw createError({ statusCode: 400, statusMessage: `cfg extract failed: ${msg}` })
  }

  // R2 保存。失敗しても抽出結果は返す (UX 上 zip 投げ直しで戻ると面倒なので)。
  let saved: ExtractResponse['saved'] = null
  let saved_warning: string | null = null

  if (!parsed.vehicle_cd || !parsed.dump_dir) {
    saved_warning =
      'vehicle_cd / dump_dir が取れなかったため R2 保存をスキップしました'
  } else {
    const r2 = getR2Binding(event)
    if (!r2) {
      saved_warning = 'R2 binding (DTAKO_R2) が無いため保存をスキップしました'
    } else {
      const paths = vehicleSettingsR2Paths(parsed.vehicle_cd)
      const json_key = paths.jsonObject(parsed.dump_dir)
      const cfg_key = paths.cfgObject(parsed.dump_dir)
      const meta: Record<string, string> = {
        uploaded_at: new Date().toISOString(),
        vehicle_cd: parsed.vehicle_cd,
        dump_dir: parsed.dump_dir,
      }
      if (parsed.machine_info.machine_id) meta.machine_id = parsed.machine_info.machine_id
      if (parsed.machine_info.main_app) meta.firm_main_app = parsed.machine_info.main_app
      try {
        await r2.put(json_key, JSON.stringify(parsed), {
          httpMetadata: { contentType: 'application/json; charset=utf-8' },
          customMetadata: meta,
        })
        await r2.put(cfg_key, cfgBytes, {
          httpMetadata: { contentType: 'application/octet-stream' },
          customMetadata: meta,
        })
        saved = { json_key, cfg_key }
        await upsertVehicleSettingsCatalog(event, parsed.vehicle_cd, parsed.dump_dir, json_key, meta.uploaded_at!)
      } catch (e) {
        saved_warning = `R2 保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  return { ...parsed, saved, saved_warning }
})
