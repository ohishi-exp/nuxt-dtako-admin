/**
 * VehicleSettings (machine_info + settings) 2 つの差分を計算する pure ロジック。
 *
 * - `diffSettings()`: settings (Record<string, string | number>) の diff
 * - `diffMachineInfo()`: machine_info (MachineInfo) の diff
 *
 * 比較は raw value (number / string) で行う。 `formatSetting()` で整形した代わりには
 * しない (「30 秒」と「30 分」を同一視しないため)。
 */

import type { MachineInfo, VehicleSettings } from '~/utils/vehicle-settings-cfg'

export type DiffChangeType = 'added' | 'removed' | 'changed'

export interface SettingDiff {
  key: string
  left: string | number | undefined
  right: string | number | undefined
  changeType: DiffChangeType
}

export interface MachineInfoDiff {
  field: keyof MachineInfo
  left: string | undefined
  right: string | undefined
  changeType: DiffChangeType
}

/**
 * 2 つの settings dict を比較して、差分のあるエントリのみを返す。
 *
 * - 両方に存在して値が違う → 'changed'
 * - left にしか無い → 'removed'
 * - right にしか無い → 'added'
 * - 同じ値 (`===`) は返さない。`4437` (number) と `"4437"` (string) は
 *   型不一致なので changed 扱い、意図したとおり。
 *
 * 返りは cfg key の辞書順ソート。
 */
export function diffSettings(
  a: Record<string, string | number>,
  b: Record<string, string | number>,
): SettingDiff[] {
  const keys = new Set<string>()
  for (const k of Object.keys(a)) keys.add(k)
  for (const k of Object.keys(b)) keys.add(k)

  const out: SettingDiff[] = []
  for (const key of keys) {
    const left = Object.prototype.hasOwnProperty.call(a, key) ? a[key] : undefined
    const right = Object.prototype.hasOwnProperty.call(b, key) ? b[key] : undefined
    if (left === undefined && right === undefined) continue
    if (left === undefined) {
      out.push({ key, left, right, changeType: 'added' })
      continue
    }
    if (right === undefined) {
      out.push({ key, left, right, changeType: 'removed' })
      continue
    }
    if (left !== right) {
      out.push({ key, left, right, changeType: 'changed' })
    }
  }
  out.sort((x, y) => x.key.localeCompare(y.key))
  return out
}

const MACHINE_INFO_FIELDS: readonly (keyof MachineInfo)[] = [
  'machine_id',
  'main_app',
  'sub_app',
  'etc',
  'sound',
  'u_boot',
  'kernel',
  'ramdisk',
  'userdata',
]

export function diffMachineInfo(a: MachineInfo, b: MachineInfo): MachineInfoDiff[] {
  const out: MachineInfoDiff[] = []
  for (const field of MACHINE_INFO_FIELDS) {
    const left = a[field]
    const right = b[field]
    if (left == null && right == null) continue
    if (left == null) {
      out.push({ field, left: undefined, right, changeType: 'added' })
      continue
    }
    if (right == null) {
      out.push({ field, left, right: undefined, changeType: 'removed' })
      continue
    }
    if (left !== right) {
      out.push({ field, left, right, changeType: 'changed' })
    }
  }
  return out
}

// 重要設定 (録画 ENABLE 系) — これらが diff に出たら強調表示するための key set。
// VehicleSettingsDisplay.vue と同じリスト。
export const HIGHLIGHTED_DIFF_KEYS: ReadonlySet<string> = new Set([
  'DVR_INFREC_ENABLE',
  'DVR_EVTREC_ENABLE',
  'DVR_PRKREC_ENABLE',
  'DVR_AUDIO_ENABLE',
  'DVR_INFCAM0_ENABLE',
  'DVR_INFCAM1_ENABLE',
  'DVR_INFCAM2_ENABLE',
  'DVR_INFCAM3_ENABLE',
  'DVR_INFCAM4_ENABLE',
  'DVR_EVTCAM0_ENABLE',
  'DVR_EVTCAM1_ENABLE',
  'DVR_EVTCAM2_ENABLE',
  'DVR_EVTCAM3_ENABLE',
  'DVR_EVTCAM4_ENABLE',
])

/** 両 dump の VehicleSettings 一括 diff */
export interface FullDiff {
  machine_info: MachineInfoDiff[]
  settings: SettingDiff[]
  highlighted: SettingDiff[]
}

export function diffVehicleSettings(left: VehicleSettings, right: VehicleSettings): FullDiff {
  const machine_info = diffMachineInfo(left.machine_info, right.machine_info)
  const settings = diffSettings(left.settings, right.settings)
  const highlighted = settings.filter((d) => HIGHLIGHTED_DIFF_KEYS.has(d.key))
  return { machine_info, settings, highlighted }
}
