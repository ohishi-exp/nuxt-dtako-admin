<script setup lang="ts">
/**
 * 車輛設定 差分比較 ページ。
 *
 * 使い方:
 * - 左ペインと右ペインでそれぞれ車輛 cd を入れて dump を選択する
 * - 両方選択されると diff を下に表示 (重要設定の変化があれば最上部にハイライト)
 *
 * 同一車輛の時系列 diff (両ペイン同じ vehicle_cd) も、車輛間 diff (異なる vehicle_cd) も
 * 同じ UI で扱う。
 *
 * ディープリンク: `?left=<cd>&right=<cd>` で初期 vehicle_cd を与えられる。
 */

import { computed, ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import VehicleSettingsDumpPicker from '~/components/VehicleSettingsDumpPicker.vue'
import VehicleSettingsDiffTable from '~/components/VehicleSettingsDiffTable.vue'
import { diffVehicleSettings, type FullDiff } from '~/utils/vehicle-settings-diff'
import type { VehicleSettings } from '~/utils/vehicle-settings-cfg'

const route = useRoute()

interface Selection {
  key: string
  settings: VehicleSettings
}

const left = ref<Selection | null>(null)
const right = ref<Selection | null>(null)

const initialLeftCd = ref('')
const initialRightCd = ref('')

function firstString(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return ''
}

onMounted(() => {
  initialLeftCd.value = firstString(route.query.left)
  initialRightCd.value = firstString(route.query.right)
})

function onLeftSelected(payload: Selection | null) {
  left.value = payload
}
function onRightSelected(payload: Selection | null) {
  right.value = payload
}

const diff = computed<FullDiff | null>(() => {
  if (!left.value || !right.value) return null
  return diffVehicleSettings(left.value.settings, right.value.settings)
})

function labelOf(s: Selection | null, fallback: string): string {
  if (!s) return fallback
  return `${s.settings.vehicle_cd} / ${s.settings.dump_dir}`
}

function swap() {
  const a = left.value
  const b = right.value
  left.value = b
  right.value = a
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold">車輛設定 差分比較</h2>
      <div class="flex gap-3 text-sm">
        <NuxtLink
          to="/vehicle-settings"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          抽出へ
        </NuxtLink>
        <NuxtLink
          to="/vehicle-settings/history"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          履歴へ
        </NuxtLink>
        <NuxtLink
          to="/vehicle-settings/unconfirmed"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          未確認車輛へ
        </NuxtLink>
      </div>
    </div>

    <p class="text-sm text-gray-600 dark:text-gray-400">
      2 つの dump (同一車輛の異なる時点、または異なる車輛の任意の時点) を選んで
      差分を表示します。重要設定 (録画 ENABLE 系) に変化があれば最上部で強調します。
    </p>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <VehicleSettingsDumpPicker
        label="左 (Before)"
        :initial-vehicle-cd="initialLeftCd"
        @selected="onLeftSelected"
      />
      <VehicleSettingsDumpPicker
        label="右 (After)"
        :initial-vehicle-cd="initialRightCd"
        @selected="onRightSelected"
      />
    </div>

    <div v-if="left || right" class="flex justify-end">
      <button
        class="px-3 py-1 text-xs bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600"
        :disabled="!left || !right"
        @click="swap"
      >
        ↔ 左右入れ替え
      </button>
    </div>

    <div
      v-if="!diff && (left || right)"
      class="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-3 rounded text-sm text-gray-500 dark:text-gray-400"
    >
      両ペインで dump を選ぶと diff を表示します。
      (現在: 左 = {{ labelOf(left, '未選択') }} / 右 = {{ labelOf(right, '未選択') }})
    </div>

    <VehicleSettingsDiffTable
      v-if="diff"
      :diff="diff"
      :left-label="labelOf(left, '左')"
      :right-label="labelOf(right, '右')"
    />
  </div>
</template>
