<script setup lang="ts">
/**
 * 車輛設定 履歴ビューア — R2 に保存済みの dump を vehicle_cd で絞り込んで一覧 + 個別表示。
 *
 * - 引数なし `GET /api/vehicle-settings/history` → 全車輛 cd の集計 (件数 / 最新)
 * - vehicle_cd 入力後 `?vehicle_cd=XXXX` → 該当車輛の dump 一覧
 * - 一覧 行クリック → `?key=...` で JSON 取得 → `<VehicleSettingsDisplay>` で表示
 *
 * URL の `?vehicle_cd=...` を onMount で拾うようにして、
 * `/vehicle-settings/unconfirmed` など他ページからディープリンクで飛べるようにしてある。
 */

import { computed, ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import VehicleSettingsDisplay from '~/components/VehicleSettingsDisplay.vue'
import type { VehicleSettings } from '~/utils/vehicle-settings-cfg'

interface VehicleSummary {
  vehicle_cd: string
  count: number
  latest_uploaded_at: string
}
interface HistoryItem {
  key: string
  vehicle_cd: string
  dump_dir: string
  uploaded_at: string
  size: number
  machine_id: string | null
  firm_main_app: string | null
}

const route = useRoute()

const summary = ref<VehicleSummary[]>([])
const summaryLoading = ref(false)
const summaryError = ref('')

const vehicleCd = ref('')
const items = ref<HistoryItem[]>([])
const itemsLoading = ref(false)
const itemsError = ref('')

const selectedKey = ref<string | null>(null)
const detail = ref<VehicleSettings | null>(null)
const detailLoading = ref(false)
const detailError = ref('')

const summaryFilter = ref('')
const filteredSummary = computed(() => {
  const q = summaryFilter.value.trim().toLowerCase()
  if (!q) return summary.value
  return summary.value.filter((s) => s.vehicle_cd.toLowerCase().includes(q))
})

async function loadSummary() {
  summaryLoading.value = true
  summaryError.value = ''
  try {
    const res = await fetch('/api/vehicle-settings/history')
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    summary.value = (await res.json()) as VehicleSummary[]
  } catch (e) {
    summaryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    summaryLoading.value = false
  }
}

async function loadHistory(cd: string) {
  vehicleCd.value = cd
  items.value = []
  selectedKey.value = null
  detail.value = null
  if (!cd) return
  itemsLoading.value = true
  itemsError.value = ''
  try {
    const res = await fetch(`/api/vehicle-settings/history?vehicle_cd=${encodeURIComponent(cd)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    items.value = (await res.json()) as HistoryItem[]
  } catch (e) {
    itemsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    itemsLoading.value = false
  }
}

async function loadDetail(key: string) {
  selectedKey.value = key
  detail.value = null
  detailLoading.value = true
  detailError.value = ''
  try {
    const res = await fetch(`/api/vehicle-settings/object?key=${encodeURIComponent(key)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    detail.value = (await res.json()) as VehicleSettings
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    detailLoading.value = false
  }
}

function submitVehicleCd(e: Event) {
  e.preventDefault()
  loadHistory(vehicleCd.value.trim())
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { hour12: false })
}

onMounted(() => {
  loadSummary()
  // ?vehicle_cd= クエリで初期値セット + 自動ロード (未確認ページからのディープリンク)
  const q = route.query.vehicle_cd
  const initialCd = typeof q === 'string' ? q : Array.isArray(q) ? (q[0] ?? '') : ''
  if (initialCd) loadHistory(initialCd)
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold">車輛設定 履歴</h2>
      <div class="flex gap-3 text-sm">
        <NuxtLink
          to="/vehicle-settings"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          ← 抽出に戻る
        </NuxtLink>
        <NuxtLink
          :to="vehicleCd ? `/vehicle-settings/diff?left=${encodeURIComponent(vehicleCd)}&right=${encodeURIComponent(vehicleCd)}` : '/vehicle-settings/diff'"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          差分比較 →
        </NuxtLink>
        <NuxtLink
          to="/vehicle-settings/unconfirmed"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          未確認車輛 →
        </NuxtLink>
      </div>
    </div>

    <p class="text-sm text-gray-600 dark:text-gray-400">
      過去にアップロードされた車輛設定 dump (R2 <code>vehicle-settings/</code>) を
      vehicle_cd ごとに参照します。
    </p>

    <!-- 検索 -->
    <form
      class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow flex gap-2 items-center"
      @submit="submitVehicleCd"
    >
      <label for="vehicle-cd" class="text-sm font-medium">車輛 cd</label>
      <input
        id="vehicle-cd"
        v-model="vehicleCd"
        type="text"
        placeholder="例: 4437"
        class="border rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 flex-1 max-w-xs font-mono"
      >
      <button
        type="submit"
        class="px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm disabled:opacity-50"
        :disabled="itemsLoading || !vehicleCd.trim()"
      >
        <span v-if="itemsLoading">読込中...</span>
        <span v-else>履歴を取得</span>
      </button>
    </form>

    <div v-if="itemsError" class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
      {{ itemsError }}
    </div>

    <!-- 該当車輛の dump 一覧 -->
    <div v-if="items.length > 0" class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow">
      <h3 class="font-semibold mb-2">
        {{ vehicleCd }} の dump ({{ items.length }} 件)
      </h3>
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-gray-500 dark:text-gray-400 border-b">
          <tr>
            <th class="py-2 pr-3">アップロード日時</th>
            <th class="py-2 pr-3">dump dir</th>
            <th class="py-2 pr-3">MachineID</th>
            <th class="py-2 pr-3">Main App</th>
            <th class="py-2 pr-3 text-right">size</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.key"
            class="border-b border-gray-100 dark:border-gray-800 last:border-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40"
            :class="selectedKey === item.key ? 'bg-blue-50 dark:bg-blue-950/40' : ''"
            @click="loadDetail(item.key)"
          >
            <td class="py-2 pr-3 font-mono text-xs whitespace-nowrap">
              {{ formatDate(item.uploaded_at) }}
            </td>
            <td class="py-2 pr-3 font-mono text-xs">{{ item.dump_dir }}</td>
            <td class="py-2 pr-3 font-mono text-xs">{{ item.machine_id ?? '-' }}</td>
            <td class="py-2 pr-3 font-mono text-xs">{{ item.firm_main_app ?? '-' }}</td>
            <td class="py-2 pr-3 font-mono text-xs text-right">{{ item.size }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-else-if="vehicleCd && !itemsLoading && !itemsError"
      class="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-300 dark:border-yellow-700 text-yellow-900 dark:text-yellow-200 p-3 rounded text-sm"
    >
      この車輛 cd の dump はまだ R2 にありません。
    </div>

    <!-- 個別 dump 詳細 -->
    <div v-if="detailLoading" class="text-sm text-gray-500 dark:text-gray-400">
      dump JSON を読み込み中...
    </div>
    <div v-if="detailError" class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
      {{ detailError }}
    </div>
    <VehicleSettingsDisplay v-if="detail" :data="detail" />

    <!-- 全車輛集計 (画面下部、参考情報) -->
    <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
      <div class="flex justify-between items-baseline">
        <h3 class="font-semibold">登録済み車輛一覧</h3>
        <span class="text-xs text-gray-500 dark:text-gray-400">
          {{ filteredSummary.length }} / {{ summary.length }} 車輛
        </span>
      </div>
      <input
        v-model="summaryFilter"
        type="text"
        placeholder="vehicle_cd で絞り込み"
        class="w-full border rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 font-mono"
      >
      <div v-if="summaryLoading" class="text-sm text-gray-500 dark:text-gray-400">
        集計を読み込み中...
      </div>
      <div
        v-else-if="summaryError"
        class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm"
      >
        {{ summaryError }}
      </div>
      <div
        v-else-if="filteredSummary.length === 0"
        class="text-sm text-gray-500 dark:text-gray-400"
      >
        R2 にまだ dump がありません。
      </div>
      <table v-else class="w-full text-sm">
        <thead class="text-left text-xs text-gray-500 dark:text-gray-400 border-b">
          <tr>
            <th class="py-2 pr-3">vehicle_cd</th>
            <th class="py-2 pr-3 text-right">件数</th>
            <th class="py-2 pr-3">最新アップロード</th>
            <th class="py-2 pr-3" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in filteredSummary"
            :key="s.vehicle_cd"
            class="border-b border-gray-100 dark:border-gray-800 last:border-0"
          >
            <td class="py-2 pr-3 font-mono">{{ s.vehicle_cd }}</td>
            <td class="py-2 pr-3 font-mono text-right">{{ s.count }}</td>
            <td class="py-2 pr-3 font-mono text-xs">{{ formatDate(s.latest_uploaded_at) }}</td>
            <td class="py-2 pr-3 text-right">
              <button
                class="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                @click="loadHistory(s.vehicle_cd)"
              >
                履歴を開く →
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
