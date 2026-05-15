/**
 * NET780 デジタコ dump zip に含まれる `*.cfg` (車輛設定) のパーサ。
 *
 * `.cfg` は CP932 / CRLF / INI 風のフラット `KEY = VALUE` 形式 (約 600 行)。
 * 先頭ブロックの "Machine Infomation" だけは `#   MachineID : Lrbn06U06Q` のように
 * コメント行に値が埋まっており、ここから本体 ID / ファーム ver を抽出する。
 *
 * server route と vitest の両方から呼ばれる pure ロジック。
 */

import JSZip from 'jszip'

export interface MachineInfo {
  machine_id?: string
  main_app?: string
  sub_app?: string
  etc?: string
  sound?: string
  u_boot?: string
  kernel?: string
  ramdisk?: string
  userdata?: string
}

export interface VehicleSettings {
  vehicle_cd: string
  dump_dir: string
  cfg_filename: string
  machine_info: MachineInfo
  settings: Record<string, string | number>
}

// Machine Infomation セクションのコメント行から拾う key → JSON key のマッピング
const MACHINE_INFO_KEYS: Record<string, keyof MachineInfo> = {
  MachineID: 'machine_id',
  'Main App': 'main_app',
  'Sub  App': 'sub_app',
  'Sub App': 'sub_app',
  ETC: 'etc',
  Sound: 'sound',
  'u-boot': 'u_boot',
  kernel: 'kernel',
  ramdisk: 'ramdisk',
  userdata: 'userdata',
}

/**
 * `.cfg` テキスト (UTF-8 decode 済み) を JSON 構造にパースする。
 *
 * - `#   MachineID : Lrbn06U06Q` → machine_info.machine_id
 * - `# ` で始まるコメント行は (Machine Infomation 抽出後は) 無視
 * - `KEY = 4437` → number
 * - `KEY = "..."` → string (両端ダブルクオート除去、内側はそのまま)
 * - それ以外 (引用なし非数値) → string
 */
export function parseCfg(text: string): {
  machine_info: MachineInfo
  settings: Record<string, string | number>
} {
  const machine_info: MachineInfo = {}
  const settings: Record<string, string | number> = {}

  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line) continue

    if (line.startsWith('#')) {
      // `#   MachineID : Lrbn06U06Q` 形式を Machine Infomation 値として吸う
      const m = line.match(/^#\s+([A-Za-z][A-Za-z0-9 _\-]*?)\s*:\s*(.+?)\s*$/)
      if (m) {
        const rawKey = m[1]?.trimEnd() ?? ''
        const rawValue = m[2] ?? ''
        const jsonKey = MACHINE_INFO_KEYS[rawKey]
        if (jsonKey) {
          // バージョン値 "1. 0.93" のように空白入り → "1.0.93" に正規化
          machine_info[jsonKey] = rawValue.replace(/\s+/g, '')
        }
      }
      continue
    }

    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const v = (m[2] ?? '').trim()
    if (!key) continue
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      settings[key] = v.slice(1, -1)
    } else if (/^-?\d+$/.test(v)) {
      settings[key] = Number(v)
    } else {
      settings[key] = v
    }
  }

  return { machine_info, settings }
}

/**
 * NET780 dump zip (ArrayBuffer) から `*.cfg` を見つけ、CP932 decode → parseCfg。
 * R2 への原本保存に使うため raw bytes (CP932 のまま) も併せて返す。
 *
 * zip 構造想定:
 *   <vehicle_cd>/<dump_dir>/<dump_dir>.cfg
 * (例: `4437/20260514_093253-0-0-4437/20260514_093253-0-0-4437.cfg`)
 */
export async function extractVehicleSettingsAndCfgBytes(
  zipBytes: ArrayBuffer | Uint8Array,
): Promise<{ parsed: VehicleSettings; cfg_bytes: Uint8Array }> {
  const zip = await JSZip.loadAsync(zipBytes)

  const cfgEntries = Object.values(zip.files).filter(
    (f) => !f.dir && f.name.toLowerCase().endsWith('.cfg'),
  )
  if (cfgEntries.length === 0) {
    throw new Error('zip に .cfg ファイルが見つかりません')
  }
  if (cfgEntries.length > 1) {
    throw new Error(
      `zip に .cfg が複数あります (${cfgEntries.length} 件): 1 車輛分の dump のみ受け付けます`,
    )
  }
  const cfgFile = cfgEntries[0]!
  const cfg_bytes = await cfgFile.async('uint8array')

  // CP932 (Shift_JIS) → UTF-8
  // Workers runtime / Node 22+ どちらも 'shift-jis' エイリアスを TextDecoder が受け付ける
  const decoder = new TextDecoder('shift-jis', { fatal: false })
  const text = decoder.decode(cfg_bytes)

  const { machine_info, settings } = parseCfg(text)

  // path から vehicle_cd / dump_dir を best-effort で取り出す
  const parts = cfgFile.name.split('/').filter(Boolean)
  const cfgFilename = parts[parts.length - 1] ?? cfgFile.name
  const dumpDir = parts.length >= 2 ? (parts[parts.length - 2] ?? '') : ''
  const vehicleCdFromPath = parts.length >= 3 ? (parts[parts.length - 3] ?? '') : ''
  // settings 側に BASE_VEHICLECD があればそちらを優先 (path は欠けてても拾える)
  const vehicleCdFromSettings = settings.BASE_VEHICLECD
  const vehicleCd =
    typeof vehicleCdFromSettings === 'number'
      ? String(vehicleCdFromSettings)
      : typeof vehicleCdFromSettings === 'string' && vehicleCdFromSettings
        ? vehicleCdFromSettings
        : vehicleCdFromPath

  return {
    parsed: {
      vehicle_cd: vehicleCd,
      dump_dir: dumpDir,
      cfg_filename: cfgFilename,
      machine_info,
      settings,
    },
    cfg_bytes,
  }
}

/**
 * Backward-compat ラッパ。raw bytes が要らない呼び出し元向け。
 */
export async function extractVehicleSettingsFromZip(
  zipBytes: ArrayBuffer | Uint8Array,
): Promise<VehicleSettings> {
  const { parsed } = await extractVehicleSettingsAndCfgBytes(zipBytes)
  return parsed
}
