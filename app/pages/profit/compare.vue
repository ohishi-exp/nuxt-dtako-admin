<script setup lang="ts">
/**
 * 類似運行検索・比較ページ (Refs #330 PR5)。
 *
 * 一番星をインデックスに使う設計 (#198・issue #330 本文): まず一番星の伝票を
 * 積地・卸地/得意先/車輌で検索し (車番, 売上年月日) を確定させてから、その分だけ
 * dtako 運行 (`/api/operations`) とイベントCSV (区間距離・時間の集計元) を引く。
 * ichiban 検索は CF Access が要るため server proxy (`/api/ichiban/**`) 経由、
 * dtako 側は他ページと同じく rust-alc-api を直 fetch する (`app/utils/api.ts`)。
 */
import { searchVehicleDailySlips } from '~/utils/ichiban'
import { getOperations, getOperationCsv } from '~/utils/api'
import { summarizeSelectedRows, type SelectedRowsSummary } from '~/utils/event-data-table'
import {
  groupSlipsByVehicleDate,
  operationSearchDateRange,
  pickOperationForDate,
  buildCompareRowView,
  defaultCompareDateRange,
  compareRowsToCsvLines,
  type SlipGroup,
  type CompareRow,
  type CompareRowView,
} from '~/utils/profit-compare'
import type { OperationListItem } from '~/types'

/** クエリの値を trim して空文字なら undefined 扱いにする (route.query は string|string[]|null も来うる)。 */
function queryString(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' && s.trim() ? s.trim() : undefined
}

const route = useRoute()
const defaultRange = defaultCompareDateRange(Math.floor(Date.now() / 1000))
// `/profit/monthly` の保存済み検証一覧から「この車輌・期間で比較」遷移してきた場合、
// クエリ (vehicle/customer/origin/dest/from/to) をそのまま検索条件の初期値にする。
const from = ref(queryString(route.query.from) ?? defaultRange.from)
const to = ref(queryString(route.query.to) ?? defaultRange.to)
const vehicle = ref(queryString(route.query.vehicle) ?? '')
const customer = ref(queryString(route.query.customer) ?? '')
const origin = ref(queryString(route.query.origin) ?? '')
const dest = ref(queryString(route.query.dest) ?? '')

type Status = 'idle' | 'loading' | 'ready' | 'error'
const status = ref<Status>('idle')
const errorMessage = ref<string | null>(null)
const rows = ref<CompareRowView[]>([])

function hasAnyFilter(): boolean {
  return !!(vehicle.value.trim() || customer.value.trim() || origin.value.trim() || dest.value.trim())
}

async function resolveCompareRow(group: SlipGroup): Promise<CompareRow> {
  const { date_from, date_to } = operationSearchDateRange(group.saleDate)
  let operation: OperationListItem | null = null
  try {
    const res = await getOperations({ vehicle_cd: group.vehicleNumber, date_from, date_to, per_page: 20 })
    operation = pickOperationForDate(res.operations, group.saleDate)
  }
  catch {
    // 運行検索失敗は「運行データなし」行として表示する (issue #330 リスク表: 欠損は隠さない)
  }

  let segment: SelectedRowsSummary | null = null
  if (operation?.has_kudgivt) {
    try {
      const csv = await getOperationCsv(operation.unko_no, 'events')
      segment = summarizeSelectedRows(csv.headers, csv.rows, csv.rows.keys())
    }
    catch {
      // CSV取得失敗も距離・時間なしの行として表示する (運行自体は見つかっているので unkoNo は残る)
    }
  }

  return { group, operation, segment }
}

async function search() {
  if (!hasAnyFilter()) {
    errorMessage.value = '積地・卸地・得意先・車輌のいずれか1つ以上を指定してください'
    status.value = 'error'
    return
  }
  status.value = 'loading'
  errorMessage.value = null
  rows.value = []
  try {
    const slips = await searchVehicleDailySlips({
      from: from.value,
      to: to.value,
      vehicle: vehicle.value.trim() || undefined,
      customer: customer.value.trim() || undefined,
      origin: origin.value.trim() || undefined,
      dest: dest.value.trim() || undefined,
    })
    const groups = groupSlipsByVehicleDate(slips)
    const resolved = await Promise.all(groups.map(resolveCompareRow))
    rows.value = resolved.map(buildCompareRowView)
    status.value = 'ready'
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
  }
}

// クエリ付きで遷移してきた場合 (保存済み検証一覧からの「比較」リンク等) は自動検索する
if (hasAnyFilter()) search()

// --- ソート ---

type SortKey = 'saleDate' | 'amount' | 'distanceKm' | 'yenPerKm' | 'yenPerHourBound'
const sortKey = ref<SortKey>('saleDate')
const sortDesc = ref(true)

function sortValue(r: CompareRowView, key: SortKey): number | string {
  if (key === 'saleDate') return r.saleDate
  if (key === 'amount') return r.amount
  if (key === 'distanceKm') return r.distanceKm ?? -Infinity
  if (key === 'yenPerKm') return r.efficiency.yenPerKm ?? -Infinity
  return r.efficiency.yenPerHourBound ?? -Infinity
}

function toggleSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDesc.value = !sortDesc.value
  }
  else {
    sortKey.value = key
    sortDesc.value = true
  }
}

const sortedRows = computed(() => {
  const copy = [...rows.value]
  copy.sort((a, b) => {
    const av = sortValue(a, sortKey.value)
    const bv = sortValue(b, sortKey.value)
    if (av === bv) return 0
    const cmp = av < bv ? -1 : 1
    return sortDesc.value ? -cmp : cmp
  })
  return copy
})

// --- CSV 出力 ---

function downloadCsv() {
  const lines = compareRowsToCsvLines(sortedRows.value)
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `類似運行比較_${from.value}_${to.value}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// --- 表示整形 ---

function formatYen(v: number | null): string {
  return v === null ? '-' : `${Math.round(v).toLocaleString('ja-JP')} 円`
}

function formatKm(v: number | null): string {
  return v === null ? '-' : `${v.toFixed(1)} km`
}

function formatMin(v: number | null): string {
  if (v === null) return '-'
  const h = Math.floor(v / 60)
  const m = v % 60
  return h > 0 ? `${h}時間${m}分` : `${m}分`
}
</script>

<template>
  <div class="max-w-6xl mx-auto p-6">
    <h1 class="text-xl font-bold mb-1">類似運行検索・比較</h1>
    <p class="text-xs text-gray-500 mb-4">
      一番星の伝票を積地・卸地/得意先/車輌で検索し、対応する dtako 運行の距離・時間実績と並べて比較します。
      積地・卸地・得意先・車輌のいずれか1つ以上の指定が必要です。
    </p>

    <div class="flex flex-wrap items-end gap-3 mb-6">
      <div>
        <label class="text-xs text-gray-500 block mb-1">期間 (from)</label>
        <input v-model="from" type="date" class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">期間 (to、翌日を含まない)</label>
        <input v-model="to" type="date" class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">車輌CD</label>
        <input v-model="vehicle" type="text" placeholder="例: 8504" class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900 w-28" @keyup.enter="search">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">得意先C</label>
        <input v-model="customer" type="text" placeholder="例: 000001" class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900 w-28" @keyup.enter="search">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">積地</label>
        <input v-model="origin" type="text" placeholder="例: 長崎" class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900 w-28" @keyup.enter="search">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">卸地</label>
        <input v-model="dest" type="text" placeholder="例: 北九州" class="border border-gray-300 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-900 w-28" @keyup.enter="search">
      </div>
      <button
        class="text-sm px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
        :disabled="status === 'loading'"
        @click="search"
      >
        {{ status === 'loading' ? '検索中...' : '検索' }}
      </button>
      <button
        v-if="rows.length > 0"
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white"
        @click="downloadCsv"
      >
        CSV出力
      </button>
    </div>

    <p v-if="status === 'error'" class="text-sm text-red-600 dark:text-red-400 mb-4">
      {{ errorMessage }}
    </p>

    <template v-if="status === 'ready'">
      <p v-if="rows.length === 0" class="text-xs text-gray-400">
        条件に一致する伝票が見つかりませんでした
      </p>
      <div v-else class="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
        <table class="w-full text-xs min-w-[960px]">
          <thead class="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th class="text-left px-3 py-2 font-medium text-gray-500 cursor-pointer select-none" @click="toggleSort('saleDate')">
                日付 <span v-if="sortKey === 'saleDate'">{{ sortDesc ? '▼' : '▲' }}</span>
              </th>
              <th class="text-left px-3 py-2 font-medium text-gray-500">車輌</th>
              <th class="text-left px-3 py-2 font-medium text-gray-500">乗務員</th>
              <th class="text-left px-3 py-2 font-medium text-gray-500">得意先</th>
              <th class="text-left px-3 py-2 font-medium text-gray-500">積地→卸地</th>
              <th class="text-right px-3 py-2 font-medium text-gray-500 cursor-pointer select-none" @click="toggleSort('amount')">
                売上(税抜) <span v-if="sortKey === 'amount'">{{ sortDesc ? '▼' : '▲' }}</span>
              </th>
              <th class="text-right px-3 py-2 font-medium text-gray-500 cursor-pointer select-none" @click="toggleSort('distanceKm')">
                距離 <span v-if="sortKey === 'distanceKm'">{{ sortDesc ? '▼' : '▲' }}</span>
              </th>
              <th class="text-right px-3 py-2 font-medium text-gray-500">拘束/運転</th>
              <th class="text-right px-3 py-2 font-medium text-gray-500 cursor-pointer select-none" @click="toggleSort('yenPerKm')">
                円/km <span v-if="sortKey === 'yenPerKm'">{{ sortDesc ? '▼' : '▲' }}</span>
              </th>
              <th class="text-right px-3 py-2 font-medium text-gray-500 cursor-pointer select-none" @click="toggleSort('yenPerHourBound')">
                円/時間(拘束) <span v-if="sortKey === 'yenPerHourBound'">{{ sortDesc ? '▼' : '▲' }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <NuxtLink
              v-for="r in sortedRows"
              :key="`${r.vehicleNumber}-${r.saleDate}`"
              :to="r.unkoNo ? `/operations/${r.unkoNo}` : undefined"
              custom
            >
              <template #default="{ navigate }">
                <tr
                  class="border-t border-gray-100 dark:border-gray-800"
                  :class="r.unkoNo ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50' : ''"
                  @click="r.unkoNo && navigate()"
                >
                  <td class="px-3 py-2 whitespace-nowrap">{{ r.saleDate }}</td>
                  <td class="px-3 py-2 whitespace-nowrap">{{ r.vehicleNumber }}</td>
                  <td class="px-3 py-2 whitespace-nowrap">{{ r.driverName ?? '-' }}</td>
                  <td class="px-3 py-2">{{ r.customerName || '-' }}</td>
                  <td class="px-3 py-2">{{ r.originLabel || '?' }} → {{ r.destLabel || '?' }}</td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">{{ formatYen(r.amount) }}</td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">{{ formatKm(r.distanceKm) }}</td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">{{ formatMin(r.boundMin) }} / {{ formatMin(r.driveMin) }}</td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">{{ formatYen(r.efficiency.yenPerKm) }}</td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">{{ formatYen(r.efficiency.yenPerHourBound) }}</td>
                </tr>
              </template>
            </NuxtLink>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
