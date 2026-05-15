<script setup lang="ts">
/**
 * 抽出済み VehicleSettings (machine_info + settings) を
 * Machine Information / 重要設定 (録画 ON/OFF ハイライト) / 全 settings 検索 で表示する。
 *
 * - `/vehicle-settings/index.vue` (アップロード後) と
 *   `/vehicle-settings/history.vue` (R2 から fetch した過去 dump) で共通利用。
 */

import { computed, ref } from 'vue'
import { formatSetting, type FormattedSetting } from '~/utils/vehicle-settings-labels'
import type { VehicleSettings, MachineInfo } from '~/utils/vehicle-settings-cfg'

const props = defineProps<{ data: VehicleSettings }>()

const search = ref('')

// 重要設定: 録画系の ON/OFF を最上部に固定セクション化して目立たせる。
// (録画オフのまま放置されていることが目視で気付きやすいよう、value=0 は赤系で強調)
const HIGHLIGHTED_KEYS: readonly string[] = [
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
]

const machineRows = computed<Array<{ label: string; value: string }>>(() => {
  const mi = props.data.machine_info
  const labels: Array<[keyof MachineInfo, string]> = [
    ['machine_id', 'MachineID'],
    ['main_app', 'Main App'],
    ['sub_app', 'Sub App'],
    ['etc', 'ETC'],
    ['sound', 'Sound'],
    ['u_boot', 'u-boot'],
    ['kernel', 'kernel'],
    ['ramdisk', 'ramdisk'],
    ['userdata', 'userdata'],
  ]
  return labels
    .filter(([k]) => mi[k] != null)
    .map(([k, label]) => ({ label, value: String(mi[k]) }))
})

const highlightedRows = computed<FormattedSetting[]>(() => {
  const out: FormattedSetting[] = []
  for (const key of HIGHLIGHTED_KEYS) {
    const raw = props.data.settings[key]
    if (raw == null) continue
    out.push(formatSetting(key, raw))
  }
  return out
})

interface SettingsSection {
  prefix: string
  rows: FormattedSetting[]
}
const settingsSections = computed<SettingsSection[]>(() => {
  const q = search.value.trim().toLowerCase()
  const grouped = new Map<string, FormattedSetting[]>()
  for (const [key, value] of Object.entries(props.data.settings)) {
    const formatted = formatSetting(key, value)
    if (q) {
      const hay = `${formatted.key} ${formatted.label ?? ''} ${formatted.formatted}`.toLowerCase()
      if (!hay.includes(q)) continue
    }
    const prefix = key.split('_')[0] ?? key
    if (!grouped.has(prefix)) grouped.set(prefix, [])
    grouped.get(prefix)!.push(formatted)
  }
  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, rows]) => ({ prefix, rows }))
})

const totalShown = computed(() =>
  settingsSections.value.reduce((sum, s) => sum + s.rows.length, 0),
)
const totalAll = computed(() => Object.keys(props.data.settings).length)

function copyJson() {
  navigator.clipboard.writeText(JSON.stringify(props.data, null, 2))
}
</script>

<template>
  <div class="space-y-4">
    <!-- ヘッダー: vehicle_cd / dump_dir / コピー -->
    <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow flex justify-between items-start">
      <div class="space-y-1 text-sm">
        <div>
          <span class="text-gray-500 dark:text-gray-400">車輛 cd:</span>
          <span class="font-mono font-bold ml-2">{{ data.vehicle_cd || '(不明)' }}</span>
        </div>
        <div>
          <span class="text-gray-500 dark:text-gray-400">dump dir:</span>
          <span class="font-mono ml-2">{{ data.dump_dir || '(不明)' }}</span>
        </div>
        <div>
          <span class="text-gray-500 dark:text-gray-400">cfg:</span>
          <span class="font-mono ml-2">{{ data.cfg_filename }}</span>
        </div>
      </div>
      <button
        class="px-3 py-1 text-xs bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600"
        @click="copyJson"
      >
        JSON をコピー
      </button>
    </div>

    <!-- 重要設定 (録画 ON/OFF を最上部にハイライト固定) -->
    <div
      v-if="highlightedRows.length > 0"
      class="bg-amber-50 dark:bg-amber-950/30 border-2 border-amber-300 dark:border-amber-700 p-4 rounded-lg shadow"
    >
      <h3 class="font-semibold mb-2 text-amber-900 dark:text-amber-200">
        ⚠ 重要設定 (録画 / 音声)
      </h3>
      <table class="w-full text-sm">
        <tbody>
          <tr
            v-for="row in highlightedRows"
            :key="row.key"
            class="border-b border-amber-200 dark:border-amber-800/60 last:border-0"
          >
            <td class="py-1 pr-3 align-top w-72">
              <div class="text-gray-900 dark:text-gray-100">{{ row.label ?? row.key }}</div>
              <div class="font-mono text-[10px] text-gray-500 dark:text-gray-400">
                {{ row.key }}
              </div>
            </td>
            <td class="py-1 align-top">
              <span
                class="font-mono font-bold px-2 py-0.5 rounded"
                :class="row.raw === 0
                  ? 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200'
                  : row.raw === 1
                    ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-200'
                    : 'text-gray-800 dark:text-gray-200'"
              >
                {{ row.formatted }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Machine Info -->
    <div v-if="machineRows.length > 0" class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow">
      <h3 class="font-semibold mb-2">Machine Information</h3>
      <table class="text-sm w-full">
        <tbody>
          <tr
            v-for="row in machineRows"
            :key="row.label"
            class="border-b border-gray-100 dark:border-gray-800 last:border-0"
          >
            <td class="py-1 pr-4 text-gray-500 dark:text-gray-400 w-32">{{ row.label }}</td>
            <td class="py-1 font-mono">{{ row.value }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Settings (search + section + 日本語ラベル) -->
    <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
      <div class="flex justify-between items-baseline">
        <h3 class="font-semibold">設定値</h3>
        <span class="text-xs text-gray-500 dark:text-gray-400">
          {{ totalShown }} / {{ totalAll }} 件
        </span>
      </div>
      <input
        v-model="search"
        type="text"
        placeholder="cfg key / 日本語項目名 / 値で絞り込み (例: BUTT, 副免許, 音量, 連続運転)"
        class="w-full border rounded px-3 py-2 text-sm bg-white dark:bg-gray-800"
      >
      <div v-if="settingsSections.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
        一致する設定がありません。
      </div>
      <div v-else class="space-y-4">
        <div v-for="section in settingsSections" :key="section.prefix">
          <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
            {{ section.prefix }}_<span class="text-gray-400 font-normal text-xs ml-2">
              ({{ section.rows.length }})
            </span>
          </h4>
          <table class="w-full text-xs">
            <tbody>
              <tr
                v-for="row in section.rows"
                :key="row.key"
                class="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40"
              >
                <td class="py-1 pr-3 align-top w-72">
                  <div v-if="row.label" class="text-gray-900 dark:text-gray-100">{{ row.label }}</div>
                  <div
                    class="font-mono text-[10px]"
                    :class="row.label ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300'"
                  >
                    {{ row.key }}
                  </div>
                </td>
                <td class="py-1 align-top">
                  <span
                    v-if="typeof row.raw === 'number'"
                    class="font-mono"
                    :class="row.enumMeaning ? 'text-blue-700 dark:text-blue-300' : 'text-gray-800 dark:text-gray-200'"
                  >
                    {{ row.formatted }}
                  </span>
                  <span v-else class="font-mono text-green-700 dark:text-green-400">
                    {{ row.formatted }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
