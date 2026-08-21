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
import { provisionalFor, routeKey, type ProvisionalMap } from '~/utils/allowance-provisional'

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
  /** 経路キー → 暫定の手当。マスタに無い経路の金額を手で入れたもの。 */
  provisional: ProvisionalMap
}>()

const emit = defineEmits<{
  close: []
  /** 暫定の手当を入れ直した (保存は呼び出し側)。 */
  'update-provisional': [key: string, raw: string]
}>()

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

/** 1 便の暫定手当。マスタで決まっている便には当たらない。 */
function legProvisionalYen(e: AllowanceModalEntry): number | null {
  return provisionalFor(e.row, props.provisional)
}

/** 1 便の「支払う手当」= 確定があればそれ、無ければ暫定。 */
function legPayYen(e: AllowanceModalEntry): number | null {
  if (e.row.allowanceYen !== null) return e.row.allowanceYen
  return legProvisionalYen(e)
}

const totals = computed(() => {
  let allowanceYen = 0
  let provisionalYen = 0
  let salesYen = 0
  for (const e of props.entries) {
    allowanceYen += e.row.allowanceYen ?? 0
    provisionalYen += legProvisionalYen(e) ?? 0
    salesYen += e.hit?.salesYen ?? 0
  }
  return {
    allowanceYen: allowanceYen + provisionalYen,
    provisionalYen,
    salesYen,
    marginYen: margin(salesYen, allowanceYen + provisionalYen),
  }
})

const yen = (v: number | null) => (v === null ? '-' : `¥${v.toLocaleString()}`)
const tons = (v: number) => `${Math.round(v * 100) / 100}t`

function legSales(e: AllowanceModalEntry): number | null {
  if (!e.hit) return null
  return e.hit.salesYen
}
function legMargin(e: AllowanceModalEntry): number | null {
  if (!e.hit) return null
  return margin(e.hit.salesYen, legPayYen(e) ?? 0)
}

/** 手当が決まらない便かどうか (暫定の入力欄を出す対象)。 */
function isUnresolved(e: AllowanceModalEntry): boolean {
  return e.row.allowanceYen === null
}
function legRouteKey(e: AllowanceModalEntry): string {
  return routeKey(e.row)
}
/** 未確定の理由。**`unknown` と `ambiguous` は直し方が正反対**なので分けて出す。 */
function unresolvedReason(e: AllowanceModalEntry): string {
  if (e.row.status === 'ambiguous') return '未確定 (ambiguous) マスタに同じ経路で違う金額があります'
  return '未確定 (unknown) マスタにこの経路がありません'
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
            <span>
              手当 <b>{{ yen(totals.allowanceYen) }}</b>
              <span
                v-if="totals.provisionalYen > 0"
                class="text-amber-600 dark:text-amber-400"
                title="マスタに無いので手で入れた暫定額。上の手当・収支に含まれています"
              >うち暫定 {{ yen(totals.provisionalYen) }}</span>
            </span>
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
                  <td class="px-3 py-1 whitespace-nowrap">
                    <span v-if="!isUnresolved(e)">{{ yen(e.row.allowanceYen) }}</span>
                    <span v-else class="flex items-center justify-end gap-1.5">
                      <span class="text-amber-600 dark:text-amber-400" :title="unresolvedReason(e)">
                        {{ unresolvedReason(e).split(' ')[0] }} {{ unresolvedReason(e).split(' ')[1] }}
                      </span>
                      <input
                        :value="legProvisionalYen(e) ?? ''"
                        type="number"
                        min="0"
                        step="500"
                        placeholder="暫定"
                        class="w-20 border rounded px-1.5 py-0.5 text-right dark:bg-gray-900"
                        :title="`${legRouteKey(e)} の暫定手当。同じ経路の便すべてに効きます`"
                        @change="emit('update-provisional', legRouteKey(e), ($event.target as HTMLInputElement).value)"
                      >
                    </span>
                  </td>
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
