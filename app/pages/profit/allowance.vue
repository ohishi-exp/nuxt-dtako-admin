<script setup lang="ts">
/**
 * 運行手当 (デジタコ → 給与) ページ。
 *
 * 期間で運行を引き、各運行のイベントCSV から便を切り出して、料金・給与マスタから
 * 1 便あたりの手当を引く。**PDF の手当表を待たずにデジタコだけで給与を出す**のが狙い。
 *
 * マスタで金額が決まらない便は合計に入れず「要確認」として残す (推測した数字を給与に
 * 混ぜない)。イベントCSV が引けない運行も、隠さず理由付きで表に出す。
 */
import { getOperations, getOperationCsv } from '~/utils/api'
import { extractAllowanceLegs, allowanceForLegs } from '~/utils/allowance-trips'
import {
  toReportRows,
  summarizeByDriver,
  reportRowsToCsvLines,
  type OperationAllowance,
  type AllowanceReportRow,
} from '~/utils/allowance-report'

/** イベントCSV を同時に引く本数。alc を叩きすぎないための上限。 */
const CSV_CONCURRENCY = 4

function todayYmd(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const from = ref(todayYmd(-30))
const to = ref(todayYmd())
const vehicle = ref('')
const driver = ref('')

type Status = 'idle' | 'loading' | 'ready' | 'error'
const status = ref<Status>('idle')
const errorMessage = ref<string | null>(null)
const progress = ref('')
const operations = ref<OperationAllowance[]>([])

const rows = computed<AllowanceReportRow[]>(() => toReportRows(operations.value))
const drivers = computed(() => summarizeByDriver(rows.value))
const grandTotal = computed(() => drivers.value.reduce((sum, d) => sum + d.totalYen, 0))
const irregularTotal = computed(() => drivers.value.reduce((sum, d) => sum + d.irregularTrips, 0))
const failedOperations = computed(() => operations.value.filter(op => op.error !== null))

/** 1 運行ぶんのイベントCSV を引いて便に切り出す。失敗は握りつぶさず error に残す。 */
async function resolveOperation(op: {
  unko_no: string
  reading_date: string
  operation_date: string | null
  driver_name: string | null
  vehicle_name: string | null
  has_kudgivt: boolean
}): Promise<OperationAllowance> {
  const base: OperationAllowance = {
    unkoNo: op.unko_no,
    readingDate: op.reading_date,
    operationDate: op.operation_date,
    driverName: op.driver_name,
    vehicleName: op.vehicle_name,
    legs: [],
    error: null,
  }
  if (!op.has_kudgivt) return { ...base, error: 'イベントCSV が未取り込み (has_kudgivt=false)' }
  try {
    const csv = await getOperationCsv(op.unko_no, 'events')
    return { ...base, legs: allowanceForLegs(extractAllowanceLegs(csv.headers, csv.rows)) }
  }
  catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}

async function run() {
  status.value = 'loading'
  errorMessage.value = null
  operations.value = []
  progress.value = '運行を検索中...'
  try {
    const res = await getOperations({
      date_from: from.value,
      date_to: to.value,
      vehicle_cd: vehicle.value.trim() || undefined,
      driver_cd: driver.value.trim() || undefined,
      per_page: 500,
    })
    const found = res.operations
    const resolved: OperationAllowance[] = []
    for (let i = 0; i < found.length; i += CSV_CONCURRENCY) {
      progress.value = `イベントCSV を取得中 ${resolved.length}/${found.length}`
      const chunk = found.slice(i, i + CSV_CONCURRENCY)
      resolved.push(...await Promise.all(chunk.map(resolveOperation)))
    }
    operations.value = resolved
    progress.value = ''
    status.value = 'ready'
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
  }
}

function downloadCsv() {
  const blob = new Blob([`﻿${reportRowsToCsvLines(rows.value).join('\r\n')}\r\n`],
    { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `運行手当_${from.value}_${to.value}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

const yen = (v: number | null) => (v === null ? '-' : `¥${v.toLocaleString()}`)
</script>

<template>
  <div class="p-6">
    <h1 class="text-lg font-semibold mb-1">
      運行手当 (デジタコ → 給与)
    </h1>
    <p class="text-xs text-gray-500 mb-4">
      デジタコの積み/降しから便を切り出し、料金・給与マスタで 1 便あたりの手当を引きます。
      マスタで金額が決まらない便は合計に入れず「要確認」に出します。
    </p>

    <div class="flex flex-wrap gap-3 items-end mb-4">
      <label class="text-xs text-gray-500">読取日 from
        <input v-model="from" type="date" class="block text-sm border rounded px-2 py-1 dark:bg-gray-900">
      </label>
      <label class="text-xs text-gray-500">to
        <input v-model="to" type="date" class="block text-sm border rounded px-2 py-1 dark:bg-gray-900">
      </label>
      <label class="text-xs text-gray-500">車輌CD
        <input v-model="vehicle" placeholder="1109" class="block text-sm border rounded px-2 py-1 w-28 dark:bg-gray-900">
      </label>
      <label class="text-xs text-gray-500">乗務員CD
        <input v-model="driver" placeholder="1412" class="block text-sm border rounded px-2 py-1 w-28 dark:bg-gray-900">
      </label>
      <button
        class="text-sm px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
        :disabled="status === 'loading'"
        @click="run"
      >
        {{ status === 'loading' ? '集計中...' : '集計' }}
      </button>
      <button
        v-if="rows.length > 0"
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white"
        @click="downloadCsv"
      >
        CSV出力
      </button>
    </div>

    <p v-if="progress" class="text-xs text-gray-400 mb-3">
      {{ progress }}
    </p>
    <p v-if="status === 'error'" class="text-sm text-red-600 dark:text-red-400 mb-4">
      {{ errorMessage }}
    </p>

    <template v-if="status === 'ready'">
      <p v-if="rows.length === 0" class="text-xs text-gray-400">
        条件に一致する便が見つかりませんでした
      </p>
      <template v-else>
        <div class="mb-4 flex flex-wrap gap-6 text-sm">
          <span>便 <b>{{ rows.length }}</b></span>
          <span>手当合計 <b>{{ yen(grandTotal) }}</b></span>
          <span :class="irregularTotal > 0 ? 'text-amber-600 dark:text-amber-400' : ''">
            要確認 <b>{{ irregularTotal }}</b> 便
          </span>
        </div>

        <h2 class="text-sm font-semibold mb-2">
          乗務員ごとの合計
        </h2>
        <div class="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto mb-6">
          <table class="w-full text-xs">
            <thead class="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th class="text-left px-3 py-2 font-medium text-gray-500">乗務員</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">便</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">手当合計</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">要確認</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in drivers" :key="d.driverName" class="border-t border-gray-100 dark:border-gray-800">
                <td class="px-3 py-2">{{ d.driverName || '(不明)' }}</td>
                <td class="px-3 py-2 text-right">{{ d.trips }}</td>
                <td class="px-3 py-2 text-right">{{ yen(d.totalYen) }}</td>
                <td class="px-3 py-2 text-right" :class="d.irregularTrips > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300'">
                  {{ d.irregularTrips }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2 class="text-sm font-semibold mb-2">
          便ごと
        </h2>
        <div class="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
          <table class="w-full text-xs min-w-[880px]">
            <thead class="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th class="text-left px-3 py-2 font-medium text-gray-500">日付</th>
                <th class="text-left px-3 py-2 font-medium text-gray-500">乗務員</th>
                <th class="text-left px-3 py-2 font-medium text-gray-500">車輌</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">便</th>
                <th class="text-left px-3 py-2 font-medium text-gray-500">積地 → 卸地</th>
                <th class="text-left px-3 py-2 font-medium text-gray-500">マスタ卸地</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">手当</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in rows"
                :key="`${r.unkoNo}-${r.seq}`"
                class="border-t border-gray-100 dark:border-gray-800"
                :class="r.status !== 'ok' ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
              >
                <td class="px-3 py-2 whitespace-nowrap">{{ r.date }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ r.driverName || '-' }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ r.vehicleName || '-' }}</td>
                <td class="px-3 py-2 text-right">{{ r.seq }}</td>
                <td class="px-3 py-2">
                  {{ r.originCity || '?' }} → {{ r.destCity || '?' }}
                  <span v-if="r.viaCities.includes('>')" class="text-gray-400">({{ r.viaCities }})</span>
                </td>
                <td class="px-3 py-2">{{ r.masterDest || '-' }}</td>
                <td class="px-3 py-2 text-right whitespace-nowrap">
                  <span v-if="r.status === 'ok'">{{ yen(r.allowanceYen) }}</span>
                  <span v-else class="text-amber-600 dark:text-amber-400" :title="`マスタで決まらない (${r.status})`">要確認</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <template v-if="failedOperations.length > 0">
          <h2 class="text-sm font-semibold mt-6 mb-2 text-amber-600 dark:text-amber-400">
            便を取れなかった運行 ({{ failedOperations.length }})
          </h2>
          <ul class="text-xs text-gray-500 space-y-1">
            <li v-for="op in failedOperations" :key="op.unkoNo">
              {{ op.readingDate }} {{ op.unkoNo }} — {{ op.error }}
            </li>
          </ul>
        </template>
      </template>
    </template>
  </div>
</template>
