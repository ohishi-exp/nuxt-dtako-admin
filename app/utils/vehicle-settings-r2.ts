/**
 * vehicle-settings の R2 (`DTAKO_R2`) key 設計 (pure)。
 *
 * `net780R2Paths` (workers/dtako-scraper-relay/src/theearth-net780-client.ts) と同様に、
 * キー文字列の組み立てをここに閉じることで、endpoint 側で文字列連結によるキー生成を
 * 行わないようにする (Refs #299)。
 */

export const VEHICLE_SETTINGS_R2_PREFIX = 'vehicle-settings/'

export interface VehicleSettingsR2Paths {
  /** 抽出済み設定 JSON。 */
  jsonObject(dumpDir: string): string
  /** アップロードされた .cfg 原本 (CP932 のまま)。 */
  cfgObject(dumpDir: string): string
}

export function vehicleSettingsR2Paths(vehicleCd: string): VehicleSettingsR2Paths {
  const base = `${VEHICLE_SETTINGS_R2_PREFIX}${vehicleCd}`
  return {
    jsonObject: (dumpDir) => `${base}/${dumpDir}.json`,
    cfgObject: (dumpDir) => `${base}/${dumpDir}.cfg`,
  }
}

export interface ParsedVehicleSettingsR2Key {
  vehicle_cd: string
  dump_dir: string
  ext: string
}

/**
 * `vehicle-settings/4437/20260514_093253-0-0-4437.json`
 *   → `{ vehicle_cd: '4437', dump_dir: '20260514_093253-0-0-4437', ext: 'json' }`
 */
export function parseVehicleSettingsR2Key(key: string): ParsedVehicleSettingsR2Key | null {
  if (!key.startsWith(VEHICLE_SETTINGS_R2_PREFIX)) return null
  const rest = key.slice(VEHICLE_SETTINGS_R2_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const vehicle_cd = rest.slice(0, slash)
  const file = rest.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  if (dot <= 0) return null
  return { vehicle_cd, dump_dir: file.slice(0, dot), ext: file.slice(dot + 1) }
}
