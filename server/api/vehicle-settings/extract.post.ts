/**
 * NET780 デジタコ dump zip をアップロードして車輛設定 (`.cfg`) を JSON で返す endpoint。
 *
 * - multipart/form-data の `file` フィールドに zip を入れて POST
 * - 抽出に成功したら R2 (`DTAKO_R2` バケット) の `vehicle-settings/<vehicle_cd>/<dump_dir>.json`
 *   と `.cfg` (CP932 のまま原本) に保存する。
 * - R2 binding が無い環境 (vitest / dev で binding 未設定 等) や vehicle_cd / dump_dir が
 *   path から取れなかった場合は `saved_warning` を返して成功扱い (UX 互換)。
 * - parse 本体は `app/utils/vehicle-settings-cfg.ts` (pure)
 */

import type { H3Event } from 'h3'
import { defineEventHandler, readMultipartFormData, createError } from 'h3'
import {
  extractVehicleSettingsAndCfgBytes,
  type VehicleSettings,
} from '~/utils/vehicle-settings-cfg'
import { vehicleSettingsR2Paths } from '~/utils/vehicle-settings-r2'

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

function getR2Binding(event: H3Event): R2BucketLite | null {
  const ctx = event.context as { cloudflare?: { env?: { DTAKO_R2?: R2BucketLite } } }
  return ctx.cloudflare?.env?.DTAKO_R2 ?? null
}

export interface ExtractResponse extends VehicleSettings {
  /** 保存成功時の R2 key 情報 (binding 無し / 失敗時は null) */
  saved: { json_key: string; cfg_key: string } | null
  /** 保存できなかった場合の人間向け理由 */
  saved_warning: string | null
}

export default defineEventHandler(async (event): Promise<ExtractResponse> => {
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
      } catch (e) {
        saved_warning = `R2 保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  return { ...parsed, saved, saved_warning }
})
