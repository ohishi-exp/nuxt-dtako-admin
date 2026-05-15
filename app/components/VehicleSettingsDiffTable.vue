<script setup lang="ts">
/**
 * 2 つの VehicleSettings の diff を表示するコンポーネント。
 *
 * - 重要設定 (DVR_*_ENABLE) に差分があれば最上部にハイライトセクション
 * - machine_info diff
 * - settings diff (prefix ごとに group)
 *
 * 値の表示は `formatSetting()` で日本語ラベル + 単位付きにして読んでわかりやすくする。
 */

import { computed } from 'vue'
import { formatSetting } from '~/utils/vehicle-settings-labels'
import { HIGHLIGHTED_DIFF_KEYS, type FullDiff, type SettingDiff } from '~/utils/vehicle-settings-diff'

const props = defineProps<{
  diff: FullDiff
  leftLabel: string
  rightLabel: string
}>()

interface DisplayRow {
  key: string
  jpLabel: string | null
  leftText: string
  rightText: string
  changeType: SettingDiff['changeType']
  isHighlighted: boolean
}

function renderValue(key: string, v: string | number | undefined): string {
  if (v === undefined) return '—'
  return formatSetting(key, v).formatted
}

function toRow(d: SettingDiff): DisplayRow {
  // 日本語ラベルは存在する側の値で取る (両方 undefined はあり得ない)
  const sample = d.left ?? d.right ?? ''
  const formatted = formatSetting(d.key, sample)
  return {
    key: d.key,
    jpLabel: formatted.label ?? null,
    leftText: renderValue(d.key, d.left),
    rightText: renderValue(d.key, d.right),
    changeType: d.changeType,
    isHighlighted: HIGHLIGHTED_DIFF_KEYS.has(d.key),
  }
}

const highlightedRows = computed<DisplayRow[]>(() =>
  props.diff.highlighted.map(toRow),
)

interface DisplaySection {
  prefix: string
  rows: DisplayRow[]
}
const sections = computed<DisplaySection[]>(() => {
  const grouped = new Map<string, DisplayRow[]>()
  for (const d of props.diff.settings) {
    const row = toRow(d)
    const prefix = d.key.split('_')[0] ?? d.key
    if (!grouped.has(prefix)) grouped.set(prefix, [])
    grouped.get(prefix)!.push(row)
  }
  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, rows]) => ({ prefix, rows }))
})

const noDiff = computed(
  () =>
    props.diff.machine_info.length === 0
    && props.diff.settings.length === 0,
)
</script>

<template>
  <div class="space-y-4">
    <div
      v-if="noDiff"
      class="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200 p-4 rounded text-sm"
    >
      ✓ 2 つの dump に差分はありません。
    </div>

    <!-- 重要設定 diff (録画 ENABLE 系) -->
    <div
      v-if="highlightedRows.length > 0"
      class="bg-amber-50 dark:bg-amber-950/30 border-2 border-amber-400 dark:border-amber-600 p-4 rounded-lg shadow"
    >
      <h3 class="font-semibold mb-2 text-amber-900 dark:text-amber-200">
        ⚠ 重要設定の変化 ({{ highlightedRows.length }} 件)
      </h3>
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-amber-900/70 dark:text-amber-300/70 border-b border-amber-300 dark:border-amber-700">
          <tr>
            <th class="py-1 pr-3">設定</th>
            <th class="py-1 pr-3">{{ leftLabel }}</th>
            <th class="py-1 pr-3">{{ rightLabel }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in highlightedRows"
            :key="row.key"
            class="border-b border-amber-200 dark:border-amber-800/60 last:border-0"
          >
            <td class="py-1 pr-3 align-top w-72">
              <div class="text-gray-900 dark:text-gray-100">{{ row.jpLabel ?? row.key }}</div>
              <div class="font-mono text-[10px] text-gray-500 dark:text-gray-400">
                {{ row.key }}
              </div>
            </td>
            <td class="py-1 pr-3 font-mono">{{ row.leftText }}</td>
            <td class="py-1 pr-3 font-mono font-bold text-amber-900 dark:text-amber-200">
              {{ row.rightText }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Machine Info diff -->
    <div
      v-if="diff.machine_info.length > 0"
      class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow"
    >
      <h3 class="font-semibold mb-2">
        Machine Information diff ({{ diff.machine_info.length }} 件)
      </h3>
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-gray-500 dark:text-gray-400 border-b">
          <tr>
            <th class="py-1 pr-3">項目</th>
            <th class="py-1 pr-3">{{ leftLabel }}</th>
            <th class="py-1 pr-3">{{ rightLabel }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="mi in diff.machine_info"
            :key="mi.field"
            class="border-b border-gray-100 dark:border-gray-800 last:border-0"
          >
            <td class="py-1 pr-3 font-mono text-xs">{{ mi.field }}</td>
            <td class="py-1 pr-3 font-mono">{{ mi.left ?? '—' }}</td>
            <td class="py-1 pr-3 font-mono">{{ mi.right ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Settings diff -->
    <div
      v-if="diff.settings.length > 0"
      class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3"
    >
      <div class="flex justify-between items-baseline">
        <h3 class="font-semibold">設定値 diff ({{ diff.settings.length }} 件)</h3>
      </div>
      <div v-for="section in sections" :key="section.prefix">
        <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
          {{ section.prefix }}_<span class="text-gray-400 font-normal text-xs ml-2">
            ({{ section.rows.length }})
          </span>
        </h4>
        <table class="w-full text-xs">
          <thead class="text-left text-[10px] text-gray-500 dark:text-gray-400 border-b">
            <tr>
              <th class="py-1 pr-3">設定</th>
              <th class="py-1 pr-3">{{ leftLabel }}</th>
              <th class="py-1 pr-3">{{ rightLabel }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in section.rows"
              :key="row.key"
              class="border-b border-gray-100 dark:border-gray-800 last:border-0"
            >
              <td class="py-1 pr-3 align-top w-72">
                <div v-if="row.jpLabel" class="text-gray-900 dark:text-gray-100">
                  {{ row.jpLabel }}
                </div>
                <div
                  class="font-mono text-[10px]"
                  :class="row.jpLabel ? 'text-gray-400 dark:text-gray-500' : 'text-gray-700 dark:text-gray-300'"
                >
                  {{ row.key }}
                </div>
              </td>
              <td
                class="py-1 pr-3 align-top font-mono"
                :class="row.changeType === 'added' ? 'text-gray-400 italic' : ''"
              >
                {{ row.leftText }}
              </td>
              <td
                class="py-1 pr-3 align-top font-mono"
                :class="[
                  row.changeType === 'removed' ? 'text-gray-400 italic' : '',
                  row.changeType === 'changed' ? 'font-bold text-blue-700 dark:text-blue-300' : '',
                  row.changeType === 'added' ? 'font-bold text-emerald-700 dark:text-emerald-300' : '',
                ]"
              >
                {{ row.rightText }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
