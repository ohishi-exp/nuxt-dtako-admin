/**
 * NET780 デジタコ dump zip をアップロードして車輛設定 (`.cfg`) を JSON で返す endpoint。
 *
 * - multipart/form-data の `file` フィールドに zip を入れて POST
 * - backend (rust-alc-api) / R2 は使わず、Worker 内で完結
 * - parse 本体は `app/utils/vehicle-settings-cfg.ts` (pure)
 */

import { defineEventHandler, readMultipartFormData, createError } from 'h3'
import { extractVehicleSettingsFromZip } from '~/utils/vehicle-settings-cfg'

const MAX_BYTES = 5 * 1024 * 1024 // 5MB — NET780 dump zip は 50KB 程度なので余裕の上限

export default defineEventHandler(async (event) => {
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
      statusMessage: 'field "file" に zip を添付してください',
    })
  }
  if (filePart.data.byteLength > MAX_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `zip が大きすぎます (${filePart.data.byteLength} bytes, max ${MAX_BYTES})`,
    })
  }

  try {
    // filePart.data は Buffer (extends Uint8Array)。extractVehicleSettingsFromZip は
    // Uint8Array を直接受け付けるので buffer.slice 不要。
    return await extractVehicleSettingsFromZip(filePart.data)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw createError({ statusCode: 400, statusMessage: `cfg extract failed: ${msg}` })
  }
})
