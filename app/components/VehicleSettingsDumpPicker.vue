<script setup lang="ts">
/**
 * 1 つの dump (R2 の VehicleSettings JSON) を選ぶためのピッカー。
 *
 * フロー:
 *   1. vehicle_cd を入力 (datalist で R2 にある車輛 cd を autocomplete サジェスト)
 *   2. `GET /api/vehicle-settings/history?vehicle_cd=...` を取得して dump 一覧を表示
 *   3. dump (uploaded_at + dump_dir) を選択 → `GET /api/vehicle-settings/object?key=...` で JSON 取得
 *   4. 完了したら `selected` イベントを発火
 *
 * 使う側 (`/vehicle-settings/diff.vue`) は 左右 2 つこのコンポーネントを並べて
 * 、両方の selected が揃ったら diff を表示する。
 * available-vehicle-cds prop で親から datalist を受け取る
 * (両 picker で共通のサマリ fetch を 1 回だけ走らせるため)。
 */

import { computed, ref, watch } from 'vue'
import type { VehicleSettings } from '~/utils/vehicle-settings-cfg'

interface HistoryItem {
  key: string
  vehicle_cd: string
  dump_dir: string
  uploaded_at: string
  size: number
  machine_id: string | null
  firm_main_app: string | null
}

const props = defineProps<{
  label: string
  initialVehicleCd?: string
  /** R2 に dump がある vehicle_cd の一覧。datalist のサジェストに使う */
  availableVehicleCds?: string[]
}>()

const emit = defineEmits<{
  (e: 'selected', payload: { key: string; settings: VehicleSettings } | null): void
}>()

const vehicleCd = ref(props.initialVehicleCd ?? '')
const items = ref<HistoryItem[]>([])
const itemsLoading = ref(false)
const itemsError = ref('')

const selectedKey = ref<string | null>(null)
const loadingDetail = ref(false)
const detailError = ref('')

// datalist の id は同ページで 2 つ使うので一意にしておく
const datalistId = computed(
  () => `vehicle-cd-options-${props.label.replace(/[^a-zA-Z0-9]/g, '-')}`,
)

async function loadHistory() {
  const cd = vehicleCd.value.trim()
  items.value = []
  selectedKey.value = null
  detailError.value = ''
  emit('selected', null)
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

async function selectDump(item: HistoryItem) {
  selectedKey.value = item.key
  detailError.value = ''
  loadingDetail.value = true
  emit('selected', null)
  try {
    const res = await fetch(`/api/vehicle-settings/object?key=${encodeURIComponent(item.key)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    const settings = (await res.json()) as VehicleSettings
    emit('selected', { key: item.key, settings })
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingDetail.value = false
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { hour12: false })
}

// initialVehicleCd が后から入るケース (反対側の値をコピーしたとき等) に対応
watch(
  () => props.initialVehicleCd,
  (v) => {
    if (v && v !== vehicleCd.value) {
      vehicleCd.value = v
      loadHistory()
    }
  },
)

// datalist から選ぶと input の change イベントが発火するので、そのタイミングで
// 自動的に履歴をロードする。手動入力は Enter またはボタンでトリガー。
function onInputChange() {
  const cd = vehicleCd.value.trim()
  if (cd && props.availableVehicleCds?.includes(cd)) {
    loadHistory()
  }
}
</script>

<template>
  <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
    <div class="flex justify-between items-baseline">
      <h3 class="font-semibold">{{ label }}</h3>
      <span v-if="selectedKey" class="font-mono text-xs text-gray-500 dark:text-gray-400">
        選択中
      </span>
    </div>

    <form class="flex gap-2 items-center" @submit.prevent="loadHistory">
      <label class="text-sm font-medium">車輛 cd</label>
      <input
        v-model="vehicleCd"
        type="text"
        :placeholder="availableVehicleCds && availableVehicleCds.length > 0 ? '例: 4437 (クリックで一覧)' : '例: 4437'"
        :list="datalistId"
        class="border rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 flex-1 font-mono"
        @change="onInputChange"
      >
      <datalist :id="datalistId">
        <option
          v-for="cd in availableVehicleCds ?? []"
          :key="cd"
          :value="cd"
        />
      </datalist>
      <button
        type="submit"
        class="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm disabled:opacity-50"
        :disabled="itemsLoading || !vehicleCd.trim()"
      >
        <span v-if="itemsLoading">読込中</span>
        <span v-else>履歴取得</span>
      </button>
    </form>

    <div v-if="itemsError" class="bg-red-50 border border-red-200 text-red-800 p-2 rounded text-xs">
      {{ itemsError }}
    </div>

    <div v-if="items.length > 0" class="max-h-72 overflow-auto border rounded">
      <table class="w-full text-xs">
        <thead class="bg-gray-50 dark:bg-gray-800 sticky top-0">
          <tr class="text-left text-gray-500 dark:text-gray-400">
            <th class="px-2 py-1">アップロード</th>
            <th class="px-2 py-1">Main App</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.key"
            class="border-t border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40"
            :class="selectedKey === item.key ? 'bg-blue-50 dark:bg-blue-950/40' : ''"
            @click="selectDump(item)"
          >
            <td class="px-2 py-1 font-mono whitespace-nowrap">
              {{ formatDate(item.uploaded_at) }}
            </td>
            <td class="px-2 py-1 font-mono">{{ item.firm_main_app ?? '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-else-if="vehicleCd.trim() && !itemsLoading && !itemsError"
      class="text-xs text-gray-500 dark:text-gray-400"
    >
      この車輛 cd の dump はありません。
    </div>

    <div v-if="loadingDetail" class="text-xs text-gray-500">JSON 読込中...</div>
    <div v-if="detailError" class="bg-red-50 border border-red-200 text-red-800 p-2 rounded text-xs">
      {{ detailError }}
    </div>
  </div>
</template>
