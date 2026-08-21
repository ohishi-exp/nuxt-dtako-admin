<script setup lang="ts">
/**
 * 運行手当タブから 1 運行を開くモーダル。
 *
 * **ページ遷移にしない。** 集計はイベントCSV を運行の本数だけ引くので重く
 * (2026-07 の帯広5台で 90 本)、`/operations/{運行NO}` へ飛んで戻ると作り直しになる。
 * 同じ画面に重ねれば集計を保ったまま中身を見て閉じられる。
 *
 * 便・売上は**呼び出し側が集計で既に持っているものをそのまま受け取る** (引き直さない)。
 * イベントCSV だけ開いたときに 1 本引く。
 */
import { getOperationCsv } from '~/utils/api'
import type { CsvJsonResponse } from '~/types'
import type { AllowanceReportRow } from '~/utils/allowance-report'
import { margin, type LegReconcile } from '~/utils/allowance-ichiban'

/** 便 1 行と、その突合結果。`<script setup>` は export を持てないのでローカル型。 */
interface AllowanceModalEntry {
  row: AllowanceReportRow
  hit: LegReconcile | undefined
}

const props = defineProps<{
  unkoNo: string
  readingDate: string
  vehicleName: string
  driverName: string
  /** 便が取れなかった理由。取れていれば null。 */
  error: string | null
  entries: AllowanceModalEntry[]
}>()

const emit = defineEmits<{ close: [] }>()

const csv = ref<CsvJsonResponse | null>(null)
const csvError = ref<string | null>(null)
const csvLoading = ref(false)

async function loadCsv() {
  csv.value = null
  csvError.value = null
  if (props.error !== null) return
  csvLoading.value = true
  try {
    csv.value = await getOperationCsv(props.unkoNo, 'events')
  }
  catch (e) {
    csvError.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    csvLoading.value = false
  }
}

watch(() => props.unkoNo, loadCsv, { immediate: true })

/** Esc で閉じる。モーダルの外に出る唯一の副作用なので、外したら必ず戻す。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const totals = computed(() => {
  let allowanceYen = 0
  let salesYen = 0
  for (const e of props.entries) {
    allowanceYen += e.row.allowanceYen ?? 0
    salesYen += e.hit?.salesYen ?? 0
  }
  return { allowanceYen, salesYen, marginYen: margin(salesYen, allowanceYen) }
})

const yen = (v: number | null) => (v === null ? '-' : `¥${v.toLocaleString()}`)
const tons = (v: number) => `${Math.round(v * 100) / 100}t`

function legSales(e: AllowanceModalEntry): number | null {
  if (!e.hit) return null
  return e.hit.salesYen
}
function legMargin(e: AllowanceModalEntry): number | null {
  if (!e.hit) return null
  return margin(e.hit.salesYen, e.row.allowanceYen ?? 0)
}
function legSlipLabel(e: AllowanceModalEntry): string {
  if (!e.hit) return '-'
  if (e.hit.status === 'no_slip') return '一番星に無し'
  return e.hit.slips.map(s => `${s.dest} ${s.itemName} ${tons(s.quantity)} ${yen(s.amount)}`).join(' / ')
}
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto"
    @click.self="emit('close')"
  >
    <div class="w-full max-w-6xl my-8 rounded-lg bg-white dark:bg-gray-900 shadow-xl">
      <div class="flex flex-wrap items-center gap-3 border-b border-gray-200 dark:border-gray-800 px-4 py-3">
        <h2 class="text-sm font-semibold">
          {{ driverName || '(乗務員不明)' }}
          <span class="text-gray-500 font-normal">{{ vehicleName || '(車輌不明)' }}</span>
        </h2>
        <span class="text-xs text-gray-500">読取日 {{ readingDate }}</span>
        <span class="font-mono text-[11px] text-gray-500">{{ unkoNo }}</span>
        <span class="ml-auto flex items-center gap-3 text-xs">
          <NuxtLink
            :to="`/operations/${unkoNo}`"
            target="_blank"
            class="text-blue-500 hover:text-blue-700 hover:underline"
          >
            運行詳細を別タブで開く
          </NuxtLink>
          <button
            class="rounded px-2 py-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
            aria-label="閉じる"
            @click="emit('close')"
          >
            ✕
          </button>
        </span>
      </div>

      <div class="px-4 py-3 space-y-4">
        <p v-if="error" class="text-xs text-amber-600 dark:text-amber-400">
          便を取れませんでした — {{ error }}
        </p>

        <div v-else>
          <div class="mb-2 flex flex-wrap gap-4 text-xs">
            <span>便 <b>{{ entries.length }}</b></span>
            <span>手当 <b>{{ yen(totals.allowanceYen) }}</b></span>
            <span>売上 <b>{{ yen(totals.salesYen) }}</b></span>
            <span>収支 <b :class="totals.marginYen < 0 ? 'text-red-600 dark:text-red-400' : ''">{{ yen(totals.marginYen) }}</b></span>
          </div>
          <div class="overflow-x-auto rounded border border-gray-200 dark:border-gray-800">
            <table class="w-full text-xs">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">日付</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">便</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">積地 → 卸地</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">マスタ卸地</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">売上</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">収支</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">一番星の明細</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="e in entries"
                  :key="`${e.row.unkoNo}-${e.row.seq}`"
                  class="border-t border-gray-100 dark:border-gray-800/70"
                >
                  <td class="px-3 py-1 whitespace-nowrap">{{ e.row.date }}</td>
                  <td class="px-3 py-1 text-right">{{ e.row.seq }}</td>
                  <td class="px-3 py-1">{{ e.row.originCity || '?' }} → {{ e.row.destCity || '?' }}</td>
                  <td class="px-3 py-1">{{ e.row.masterDest || '-' }}</td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(e.row.allowanceYen) }}</td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(legSales(e)) }}</td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(legMargin(e)) }}</td>
                  <td class="px-3 py-1">{{ legSlipLabel(e) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="csvError" class="text-xs text-red-600 dark:text-red-400">
          イベントCSV が引けませんでした — {{ csvError }}
        </div>
        <EventDataTable v-else-if="csv || csvLoading" :data="csv ?? { headers: [], rows: [] }" :loading="csvLoading" />
      </div>
    </div>
  </div>
</template>
