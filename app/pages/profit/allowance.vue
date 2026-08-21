<script setup lang="ts">
/**
 * 運行手当 (デジタコ → 給与) ページ。
 *
 * 月を指定して運行を引き、各運行のイベントCSV から便を切り出して、料金・給与マスタから
 * 1 便あたりの手当を引く。**PDF の手当表を待たずにデジタコだけで給与を出す**のが狙い。
 *
 * 表示は **乗務員 → 運行 → 便** の 3 段。上から順に開いて、最後は運行詳細へ飛べる。
 * マスタで金額が決まらない便 (未確定) は合計に入れず、各段に件数を出す。
 * イベントCSV が引けない運行も、隠さず理由付きで残す。
 */
import { getOperations, getOperationCsv, getDrivers } from '~/utils/api'
import { fetchAllPages } from '~/utils/paged-fetch'
import type { Driver, OperationListItem } from '~/types'
import { extractAllowanceLegs, extractCarryInUnloads, allowanceForLegs } from '~/utils/allowance-trips'
import {
  parseTargets,
  serializeTargets,
  toggleTarget,
  driverLabel,
} from '~/utils/allowance-targets'
import {
  applyCarryOver,
  buildMonthlyAllowance,
  monthReadingRange,
  reportRowsToCsvLines,
  type OperationAllowance,
  type AllowanceReportRow,
  type DriverNode,
  type OperationNode,
} from '~/utils/allowance-report'

/** イベントCSV を同時に引く本数。alc を叩きすぎないための上限。 */
const CSV_CONCURRENCY = 4
/** 対象乗務員 (乗務員CD) の保存先。ブラウザごとに残る。
 * **氏名で保存していた旧版とはキーを分ける** — 同じキーのまま意味を変えると、
 * 氏名が `driver_cd` として API に渡って 0 件になる (2026-08-21 に踏んだ)。 */
const TARGETS_KEY = 'dtako:allowance:driver-cds'


function currentYm(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const ym = ref(currentYm())
const vehicle = ref('')

type Status = 'idle' | 'loading' | 'ready' | 'error'
const status = ref<Status>('idle')
const errorMessage = ref<string | null>(null)
const progress = ref('')
const operations = ref<OperationAllowance[]>([])
/** 集計を実行したときの月。表と入力欄がずれないように保持する。 */
const shownYm = ref('')

/** 未確定 (金額が決まらない便 / 便を取れなかった運行) だけに絞る。 */
const onlyIrregular = ref(false)

// --- 対象乗務員 ---
// 全乗務員を集計すると帯広のバルク車以外まで引き当てにいって未確定が数百件になるので、
// **対象を保存して、その乗務員の運行だけ `/api/operations` に引かせる**。
// 名前で全件取ってから絞る作りは誤り — `per_page` は 200 に丸められるため、
// 月の後ろ 200 件しか返らず前半がまるごと落ちる (2026-07 は全社 1142 運行)。
const targets = ref<string[]>([])
const drivers = ref<Driver[]>([])
const pendingDriver = ref('')

onMounted(async () => {
  targets.value = parseTargets(localStorage.getItem(TARGETS_KEY))
  try {
    drivers.value = await getDrivers()
  }
  catch {
    // 乗務員マスタが引けなくても CD だけで動く (表示が CD のままになるだけ)
  }
})

function toggle(cd: string) {
  targets.value = toggleTarget(targets.value, cd)
  localStorage.setItem(TARGETS_KEY, serializeTargets(targets.value))
}

/** セレクタで選ばれたら対象に足して、次の選択に備えて空に戻す。 */
watch(pendingDriver, (cd) => {
  if (!cd) return
  toggle(cd)
  pendingDriver.value = ''
})

function labelOf(cd: string): string {
  return driverLabel(drivers.value, cd)
}

/** 乗務員マスタに無い CD。指定ミスか、マスタが引けていないかのどちらか。 */
function isUnknownDriver(cd: string): boolean {
  return drivers.value.length > 0 && !drivers.value.some(d => d.driver_cd.trim() === cd)
}

/** 1 乗務員ぶんの運行をページングで全部取る。 */
function fetchOperationsFor(range: { from: string, to: string }, driverCd?: string) {
  return fetchAllPages<OperationListItem>(async (page) => {
    const res = await getOperations({
      date_from: range.from,
      date_to: range.to,
      driver_cd: driverCd,
      vehicle_cd: vehicle.value.trim() || undefined,
      page,
      per_page: 200,
    })
    return { items: res.operations, total: res.total }
  })
}

const monthly = computed(() => buildMonthlyAllowance(operations.value, shownYm.value))

function opHasIssue(op: OperationNode): boolean {
  return op.irregularTrips > 0 || op.error !== null
}
function driverHasIssue(d: DriverNode): boolean {
  return d.irregularTrips > 0 || d.failedOperations > 0
}

const visibleDrivers = computed(() => (onlyIrregular.value
  ? monthly.value.drivers.filter(driverHasIssue)
  : monthly.value.drivers))

function visibleOperations(d: DriverNode): OperationNode[] {
  return onlyIrregular.value ? d.operations.filter(opHasIssue) : d.operations
}
function visibleRows(op: OperationNode): AllowanceReportRow[] {
  return onlyIrregular.value ? op.rows.filter(r => r.status !== 'ok') : op.rows
}

const csvRows = computed(() => visibleDrivers.value
  .flatMap(d => visibleOperations(d).flatMap(op => visibleRows(op))))

// --- 開閉 ---
const openDrivers = reactive<Record<string, boolean>>({})
const openOps = reactive<Record<string, boolean>>({})

/** 1 人だけなら最初から開いておく (毎回クリックさせない)。 */
function autoOpen() {
  for (const key of Object.keys(openDrivers)) delete openDrivers[key]
  for (const key of Object.keys(openOps)) delete openOps[key]
  const only = monthly.value.drivers
  if (only.length === 1) openDrivers[only[0]!.driverName] = true
}

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
    carryIn: { cities: [], toTs: null },
    error: null,
  }
  if (!op.has_kudgivt) return { ...base, error: 'イベントCSV が未取り込み (has_kudgivt=false)' }
  try {
    const csv = await getOperationCsv(op.unko_no, 'events')
    return {
      ...base,
      legs: allowanceForLegs(extractAllowanceLegs(csv.headers, csv.rows)),
      carryIn: extractCarryInUnloads(csv.headers, csv.rows),
    }
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
    const range = monthReadingRange(ym.value)
    const found: OperationListItem[] = []
    if (targets.value.length === 0) {
      found.push(...await fetchOperationsFor(range))
    }
    else {
      for (const cd of targets.value) {
        progress.value = `運行を検索中 ${labelOf(cd)}`
        found.push(...await fetchOperationsFor(range, cd))
      }
    }
    const resolved: OperationAllowance[] = []
    for (let i = 0; i < found.length; i += CSV_CONCURRENCY) {
      progress.value = `イベントCSV を取得中 ${resolved.length}/${found.length}`
      const chunk = found.slice(i, i + CSV_CONCURRENCY)
      resolved.push(...await Promise.all(chunk.map(resolveOperation)))
    }
    // 積んだまま帰庫した便の卸地は次の運行の先頭にある。全運行を引き終えてから当てる。
    operations.value = applyCarryOver(resolved)
    shownYm.value = ym.value
    autoOpen()
    progress.value = ''
    status.value = 'ready'
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
  }
}

const router = useRouter()

/** その便を含む運行の詳細へ飛ぶ (`類似運行検索・比較` と同じ作法)。 */
function goToOperation(unkoNo: string) {
  router.push(`/operations/${unkoNo}`)
}

function downloadCsv() {
  const blob = new Blob([`﻿${reportRowsToCsvLines(csvRows.value).join('\r\n')}\r\n`],
    { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `運行手当${onlyIrregular.value ? '_未確定' : ''}_${shownYm.value}.csv`
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
      乗務員 → 運行 → 便 の順に開けます。マスタで金額が決まらない便は合計に入れず「未確定」に数えます。
    </p>

    <div class="flex flex-wrap gap-3 items-end mb-4">
      <label class="text-xs text-gray-500">月
        <input v-model="ym" type="month" class="block text-sm border rounded px-2 py-1 dark:bg-gray-900">
      </label>
      <label class="text-xs text-gray-500">車輌CD
        <input v-model="vehicle" placeholder="1109" class="block text-sm border rounded px-2 py-1 w-28 dark:bg-gray-900">
      </label>
      <button
        class="text-sm px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
        :disabled="status === 'loading'"
        @click="run"
      >
        {{ status === 'loading' ? '集計中...' : '集計' }}
      </button>
      <button
        v-if="csvRows.length > 0"
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white"
        @click="downloadCsv"
      >
        CSV出力{{ onlyIrregular ? ' (未確定のみ)' : '' }}
      </button>
    </div>

    <div class="mb-4 text-xs">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-gray-500">対象乗務員</span>
        <DriverSearchSelect
          v-model="pendingDriver"
          :drivers="drivers"
          value-key="driver_cd"
          placeholder="乗務員を追加"
        />
        <span v-if="targets.length === 0" class="text-amber-600 dark:text-amber-400">
          未設定 — 全乗務員を集計します (時間がかかり、未確定が大量に出ます)
        </span>
        <button
          v-for="cd in targets"
          :key="cd"
          class="px-2 py-0.5 rounded-full hover:line-through"
          :class="isUnknownDriver(cd)
            ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
            : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'"
          :title="isUnknownDriver(cd) ? '乗務員マスタに無い CD です' : 'クリックで対象から外す'"
          @click="toggle(cd)"
        >
          {{ labelOf(cd) }} ✕
        </button>
      </div>
    </div>

    <p v-if="progress" class="text-xs text-gray-400 mb-3">
      {{ progress }}
    </p>
    <p v-if="status === 'error'" class="text-sm text-red-600 dark:text-red-400 mb-4">
      {{ errorMessage }}
    </p>

    <template v-if="status === 'ready'">
      <p v-if="monthly.drivers.length === 0" class="text-xs text-gray-400">
        {{ shownYm }} に該当する運行が見つかりませんでした
      </p>
      <template v-else>
        <div class="mb-3 flex flex-wrap gap-6 text-sm items-center">
          <span class="font-semibold">{{ shownYm }}</span>
          <span>便 <b>{{ monthly.trips }}</b></span>
          <span>手当合計 <b>{{ yen(monthly.totalYen) }}</b></span>
          <span :class="monthly.irregularTrips > 0 ? 'text-amber-600 dark:text-amber-400' : ''">
            未確定 <b>{{ monthly.irregularTrips }}</b> 便
          </span>
          <span
            v-if="monthly.carriedTrips > 0"
            class="text-sky-600 dark:text-sky-400"
            title="卸地をその次の運行の先頭にある降しから引き継いだ便 (積んだまま帰庫して翌朝降ろす形)。金額は合計に入れています"
          >
            推定卸地 <b>{{ monthly.carriedTrips }}</b> 便
          </span>
          <span v-if="monthly.failedOperations > 0" class="text-amber-600 dark:text-amber-400">
            便を取れなかった運行 <b>{{ monthly.failedOperations }}</b>
          </span>
          <span v-if="monthly.outOfMonthTrips > 0" class="text-gray-400" title="月末の運行が翌月に食い込むぶん。この月の合計には入れていません">
            翌月にかかる便 {{ monthly.outOfMonthTrips }}
          </span>
          <label class="text-xs text-gray-500 flex items-center gap-1.5 cursor-pointer select-none">
            <input v-model="onlyIrregular" type="checkbox" class="cursor-pointer">
            未確定だけ表示
          </label>
        </div>

        <p v-if="visibleDrivers.length === 0" class="text-xs text-gray-400">
          未確定の便はありません
        </p>
        <div v-else class="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th class="text-left px-3 py-2 font-medium text-gray-500">乗務員</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">運行</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">便</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">手当合計</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">未確定</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="d in visibleDrivers" :key="d.driverName">
                <tr
                  class="border-t border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  @click="openDrivers[d.driverName] = !openDrivers[d.driverName]"
                >
                  <td class="px-3 py-2 font-medium">
                    <span class="text-gray-400 mr-1">{{ openDrivers[d.driverName] ? '▾' : '▸' }}</span>
                    {{ d.driverName || '(不明)' }}
                  </td>
                  <td class="px-3 py-2 text-right">{{ d.operations.length }}</td>
                  <td class="px-3 py-2 text-right">{{ d.trips }}</td>
                  <td class="px-3 py-2 text-right">{{ yen(d.totalYen) }}</td>
                  <td
                    class="px-3 py-2 text-right"
                    :class="driverHasIssue(d) ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                  >
                    {{ d.irregularTrips }}<span v-if="d.failedOperations > 0"> + 運行{{ d.failedOperations }}</span>
                  </td>
                </tr>

                <tr v-if="openDrivers[d.driverName]" class="border-t border-gray-100 dark:border-gray-800">
                  <td colspan="5" class="p-0">
                    <table class="w-full text-xs">
                      <thead class="bg-gray-100/60 dark:bg-gray-800/60">
                        <tr>
                          <th class="text-left pl-8 pr-3 py-1.5 font-medium text-gray-500">読取日</th>
                          <th class="text-left px-3 py-1.5 font-medium text-gray-500">運行NO</th>
                          <th class="text-left px-3 py-1.5 font-medium text-gray-500">車輌</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">便</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">未確定</th>
                          <th class="px-3 py-1.5" />
                        </tr>
                      </thead>
                      <tbody>
                        <template v-for="op in visibleOperations(d)" :key="op.unkoNo">
                          <tr
                            class="border-t border-gray-100 dark:border-gray-800/70 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40"
                            :class="op.error ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
                            @click="openOps[op.unkoNo] = !openOps[op.unkoNo]"
                          >
                            <td class="pl-8 pr-3 py-1.5 whitespace-nowrap">
                              <span class="text-gray-400 mr-1">{{ openOps[op.unkoNo] ? '▾' : '▸' }}</span>
                              {{ op.readingDate }}
                            </td>
                            <td class="px-3 py-1.5 font-mono text-[11px] whitespace-nowrap">{{ op.unkoNo }}</td>
                            <td class="px-3 py-1.5 whitespace-nowrap">{{ op.vehicleName || '-' }}</td>
                            <td class="px-3 py-1.5 text-right">{{ op.rows.length }}</td>
                            <td class="px-3 py-1.5 text-right whitespace-nowrap">{{ yen(op.totalYen) }}</td>
                            <td
                              class="px-3 py-1.5 text-right"
                              :class="opHasIssue(op) ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                            >
                              {{ op.irregularTrips }}
                            </td>
                            <td class="px-3 py-1.5 text-right whitespace-nowrap">
                              <button
                                class="text-blue-500 hover:text-blue-700 hover:underline"
                                @click.stop="goToOperation(op.unkoNo)"
                              >
                                運行を開く
                              </button>
                            </td>
                          </tr>

                          <tr v-if="op.error" class="border-t border-gray-100 dark:border-gray-800/70">
                            <td colspan="7" class="pl-16 pr-3 py-1.5 text-amber-600 dark:text-amber-400">
                              便を取れませんでした — {{ op.error }}
                            </td>
                          </tr>

                          <tr v-else-if="openOps[op.unkoNo]" class="border-t border-gray-100 dark:border-gray-800/70">
                            <td colspan="7" class="p-0">
                              <table class="w-full text-xs">
                                <thead class="bg-gray-100/40 dark:bg-gray-800/40">
                                  <tr>
                                    <th class="text-left pl-16 pr-3 py-1 font-medium text-gray-500">日付</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">便</th>
                                    <th class="text-left px-3 py-1 font-medium text-gray-500">積地 → 卸地</th>
                                    <th class="text-left px-3 py-1 font-medium text-gray-500">マスタ卸地</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">手当</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  <tr
                                    v-for="r in visibleRows(op)"
                                    :key="`${r.unkoNo}-${r.seq}`"
                                    class="border-t border-gray-100 dark:border-gray-800/50 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                                    :class="r.status !== 'ok' ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
                                    :title="`運行 ${r.unkoNo} を開く`"
                                    @click="goToOperation(r.unkoNo)"
                                  >
                                    <td class="pl-16 pr-3 py-1 whitespace-nowrap">{{ r.date }}</td>
                                    <td class="px-3 py-1 text-right">{{ r.seq }}</td>
                                    <td class="px-3 py-1">
                                      {{ r.originCity || '?' }} → {{ r.destCity || '?' }}
                                      <span
                                        v-if="r.destSource === 'carried'"
                                        class="ml-1 px-1 rounded text-[10px] bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300"
                                        title="この便に降しイベントが無く、卸地を次の運行の先頭の降しから引き継いでいます (推定)"
                                      >推定</span>
                                      <span v-if="r.viaCities.includes('>')" class="text-gray-400">({{ r.viaCities }})</span>
                                    </td>
                                    <td class="px-3 py-1">{{ r.masterDest || '-' }}</td>
                                    <td class="px-3 py-1 text-right whitespace-nowrap">
                                      <span v-if="r.status === 'ok'">{{ yen(r.allowanceYen) }}</span>
                                      <span v-else class="text-amber-600 dark:text-amber-400" :title="`マスタで決まらない (${r.status})`">未確定</span>
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        </template>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </div>
</template>
