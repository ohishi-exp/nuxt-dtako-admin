<script setup lang="ts">
/**
 * 運行手当 (デジタコ → 給与) ページ。
 *
 * 月を指定して運行を引き、各運行のイベントCSV から便を切り出して、料金・給与マスタから
 * 1 便あたりの手当を引く。**PDF の手当表を待たずにデジタコだけで給与を出す**のが狙い。
 *
 * 売上は**一番星の運転日報明細**から取る (デジタコに積載量が無いため)。便と明細を
 * 突合して `売上` を出し、`収支 = 売上 − 手当` を 3 段すべてに並べる。
 *
 * 表示は **乗務員 → 運行 → 便** の 3 段。上から順に開いて、最後は運行詳細へ飛べる。
 * マスタで金額が決まらない便 (未確定) は合計に入れず、各段に件数を出す。
 * イベントCSV が引けない運行も、**突合できなかった便・明細・単価の食い違いも**、
 * 隠さず件数と一覧で残す。
 */
import { getOperations, getOperationCsv, getDrivers } from '~/utils/api'
import { fetchAllPages } from '~/utils/paged-fetch'
import type { Driver, OperationListItem } from '~/types'
import { extractAllowanceLegs, allowanceForLegs } from '~/utils/allowance-trips'
import {
  parseTargets,
  serializeTargets,
  toggleTarget,
  driverLabel,
} from '~/utils/allowance-targets'
import {
  buildMonthlyAllowance,
  monthReadingRange,
  type OperationAllowance,
  type AllowanceReportRow,
  type DriverNode,
  type OperationNode,
} from '~/utils/allowance-report'
import { fetchVehicleDailySlips } from '~/utils/ichiban'
import {
  reconcileVehicles,
  reconcileCsvLines,
  summarizeSales,
  checkFares,
  checkLeftoverFares,
  tradableSlips,
  slipDateRange,
  vehicleCodeFromUnkoNo,
  legKey,
  margin,
  POOL_VEHICLE,
  type VehicleReconcileInput,
  type VehiclesReconcileResult,
  type LegReconcile,
} from '~/utils/allowance-ichiban'

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

const yen = (v: number | null) => (v === null ? '-' : `¥${v.toLocaleString()}`)
const tons = (v: number) => `${Math.round(v * 100) / 100}t`

const monthly = computed(() => buildMonthlyAllowance(operations.value, shownYm.value))

// --- 売上 (一番星との突合) ---
// デジタコには積載量が無いので、売上は一番星の `amount` をそのまま使う。
// 一番星が引けなくても手当は出せるので、失敗は握りつぶさず別枠で出す。
const reconciled = ref<VehiclesReconcileResult | null>(null)
const salesError = ref<string | null>(null)

const byLeg = computed(() => reconciled.value?.byLeg ?? new Map<string, LegReconcile>())
const hasSales = computed(() => reconciled.value !== null)

function allRows(): AllowanceReportRow[] {
  return monthly.value.drivers.flatMap(d => d.operations.flatMap(op => op.rows))
}

/** 便を車輌ごとに分ける。**車輌CD は運行NO から取る** (一覧の応答に列が無いため)。 */
function groupRowsByVehicle(rows: AllowanceReportRow[]): Map<string, AllowanceReportRow[]> {
  const groups = new Map<string, AllowanceReportRow[]>()
  for (const row of rows) {
    const code = vehicleCodeFromUnkoNo(row.unkoNo)
    const list = groups.get(code) ?? []
    list.push(row)
    groups.set(code, list)
  }
  return groups
}

async function runReconcile(rows: AllowanceReportRow[]) {
  const range = slipDateRange(shownYm.value)
  const inputs: VehicleReconcileInput[] = []
  for (const [vehicle, vehicleRows] of [...groupRowsByVehicle(rows)].sort()) {
    progress.value = `一番星の明細を取得中 車輌${vehicle}`
    inputs.push({
      vehicle,
      rows: vehicleRows,
      slips: tradableSlips(await fetchVehicleDailySlips(vehicle, range.from, range.to)),
    })
  }
  progress.value = `一番星の明細を取得中 受け皿(${POOL_VEHICLE})`
  const pool = tradableSlips(await fetchVehicleDailySlips(POOL_VEHICLE, range.from, range.to))
  reconciled.value = reconcileVehicles(inputs, pool)
}

const monthSales = computed(() => summarizeSales(allRows(), byLeg.value))
function driverSales(d: DriverNode) {
  return summarizeSales(d.operations.flatMap(op => op.rows), byLeg.value)
}
function opSales(op: OperationNode) {
  return summarizeSales(op.rows, byLeg.value)
}
function legHit(r: AllowanceReportRow): LegReconcile | undefined {
  return byLeg.value.get(legKey(r))
}
function legSalesYen(r: AllowanceReportRow): number | null {
  const hit = legHit(r)
  if (!hit) return null
  return hit.salesYen
}
function legMarginYen(r: AllowanceReportRow): number | null {
  const hit = legHit(r)
  if (!hit) return null
  return margin(hit.salesYen, r.allowanceYen ?? 0)
}
function legQuantityLabel(r: AllowanceReportRow): string {
  const hit = legHit(r)
  if (!hit) return '-'
  return tons(hit.quantity)
}

/** 便 1 行の「突合」欄。**テンプレートに `!` を書かずに済むよう、ここで形にする。** */
interface LegMatchLabel {
  text: string
  /** 日付ずれ / 推定 / 受け皿 のような但し書き。 */
  flags: string[]
  warn: boolean
}
function legMatchLabel(r: AllowanceReportRow): LegMatchLabel {
  const hit = legHit(r)
  if (!hit) return { text: '-', flags: [], warn: false }
  if (hit.status === 'no_slip') return { text: '一番星に無し', flags: [], warn: true }
  const flags: string[] = []
  if (hit.status === 'matched_date_shift') flags.push('日付ずれ')
  if (hit.split) flags.push('推定')
  if (hit.fromPool) flags.push('受け皿')
  return { text: `${hit.slips.length}明細`, flags, warn: false }
}

// --- 突合できなかったもの (黙って合計から抜かない) ---

/** 一番星に対応する明細が無かった便。 */
const unmatchedLegs = computed(() => (hasSales.value
  ? allRows().filter(r => byLeg.value.get(legKey(r))?.status === 'no_slip')
  : []))

/** どの便にも当たらなかった一番星明細 (車輌ごと)。 */
const leftoverSlips = computed(() => (reconciled.value?.leftovers ?? [])
  .flatMap(l => l.slips.map(slip => ({ vehicle: l.vehicle, slip })))
  .sort((a, b) => (a.slip.saleDate > b.slip.saleDate ? 1 : -1)))

const fareChecks = computed(() => [
  ...checkFares(allRows(), byLeg.value),
  ...(reconciled.value?.leftovers ?? []).flatMap(l => checkLeftoverFares(l.slips)),
])
/** マスタの運賃と単価が食い違う明細。**料金改定の検知に使う。** */
const fareMismatches = computed(() => fareChecks.value.filter(f => f.status === 'mismatch'))
/** マスタに載っていない銘柄・経路。未確定ではなく「対象外」。 */
const outOfMaster = computed(() => fareChecks.value.filter(f => f.status === 'no_master'))

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
  salesError.value = null
  operations.value = []
  reconciled.value = null
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
    operations.value = resolved
    shownYm.value = ym.value
    autoOpen()
    status.value = 'ready'
    // 一番星が落ちていても手当は出せる。売上だけ諦めて理由を画面に残す。
    try {
      await runReconcile(allRows())
    }
    catch (e) {
      salesError.value = e instanceof Error ? e.message : String(e)
    }
    progress.value = ''
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
  const blob = new Blob([`﻿${reconcileCsvLines(csvRows.value, byLeg.value).join('\r\n')}\r\n`],
    { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `運行手当収支${onlyIrregular.value ? '_未確定' : ''}_${shownYm.value}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

</script>

<template>
  <div class="p-6">
    <h1 class="text-lg font-semibold mb-1">
      運行手当 (デジタコ → 給与)
    </h1>
    <p class="text-xs text-gray-500 mb-4">
      デジタコの積み/降しから便を切り出し、料金・給与マスタで 1 便あたりの手当を引きます。
      売上はデジタコに無い (積載量を持たない) ので、<b>一番星の運転日報明細</b>と突合して
      その税抜売上をそのまま使い、<b>収支 = 売上 − 手当</b>を出します。
      乗務員 → 運行 → 便 の順に開けます。マスタで金額が決まらない便は合計に入れず「未確定」に数えます。
      突合できなかった便・明細と、マスタの運賃と単価が食い違う明細は、下に件数と一覧で出します。
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
    <p v-if="salesError" class="text-sm text-red-600 dark:text-red-400 mb-4">
      売上 (一番星) が引けませんでした — {{ salesError }} (手当だけ表示しています)
    </p>

    <template v-if="status === 'ready'">
      <p v-if="monthly.drivers.length === 0" class="text-xs text-gray-400">
        {{ shownYm }} に該当する運行が見つかりませんでした
      </p>
      <template v-else>
        <div class="mb-3 flex flex-wrap gap-6 text-sm items-center">
          <span class="font-semibold">{{ shownYm }}</span>
          <span>便 <b>{{ monthly.trips }}</b></span>
          <span>手当 <b>{{ yen(monthly.totalYen) }}</b></span>
          <span>売上 <b>{{ hasSales ? yen(monthSales.salesYen) : '-' }}</b></span>
          <span>収支 <b :class="margin(monthSales.salesYen, monthly.totalYen) < 0 ? 'text-red-600 dark:text-red-400' : ''">
            {{ hasSales ? yen(margin(monthSales.salesYen, monthly.totalYen)) : '-' }}
          </b></span>
          <span :class="monthly.irregularTrips > 0 ? 'text-amber-600 dark:text-amber-400' : ''">
            未確定 <b>{{ monthly.irregularTrips }}</b> 便
          </span>
          <span v-if="monthly.failedOperations > 0" class="text-amber-600 dark:text-amber-400">
            便を取れなかった運行 <b>{{ monthly.failedOperations }}</b>
          </span>
          <span v-if="monthly.outOfMonthTrips > 0" class="text-gray-400" title="月末の運行が翌月に食い込むぶん。この月の合計には入れていません">
            翌月にかかる便 {{ monthly.outOfMonthTrips }}
          </span>
          <span v-if="hasSales" class="text-gray-400" title="日付が1日ずれて当たった / 同日同卸地で明細を件数で分けた (内訳が推定) / 受け皿の車番から拾った">
            日付ずれ {{ monthSales.dateShiftTrips }} ・ 内訳推定 {{ monthSales.splitTrips }} ・ 受け皿 {{ monthSales.poolTrips }}
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
                <th class="text-right px-3 py-2 font-medium text-gray-500">手当</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">売上</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">収支</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">未確定</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500" title="一番星に対応する明細が無かった便">未突合</th>
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
                  <td class="px-3 py-2 text-right whitespace-nowrap">{{ yen(d.totalYen) }}</td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">
                    {{ hasSales ? yen(driverSales(d).salesYen) : '-' }}
                  </td>
                  <td
                    class="px-3 py-2 text-right whitespace-nowrap"
                    :class="margin(driverSales(d).salesYen, d.totalYen) < 0 ? 'text-red-600 dark:text-red-400' : ''"
                  >
                    {{ hasSales ? yen(margin(driverSales(d).salesYen, d.totalYen)) : '-' }}
                  </td>
                  <td
                    class="px-3 py-2 text-right"
                    :class="driverHasIssue(d) ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                  >
                    {{ d.irregularTrips }}<span v-if="d.failedOperations > 0"> + 運行{{ d.failedOperations }}</span>
                  </td>
                  <td
                    class="px-3 py-2 text-right"
                    :class="driverSales(d).unmatchedTrips > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                  >
                    {{ hasSales ? driverSales(d).unmatchedTrips : '-' }}
                  </td>
                </tr>

                <tr v-if="openDrivers[d.driverName]" class="border-t border-gray-100 dark:border-gray-800">
                  <td colspan="8" class="p-0">
                    <table class="w-full text-xs">
                      <thead class="bg-gray-100/60 dark:bg-gray-800/60">
                        <tr>
                          <th class="text-left pl-8 pr-3 py-1.5 font-medium text-gray-500">読取日</th>
                          <th class="text-left px-3 py-1.5 font-medium text-gray-500">運行NO</th>
                          <th class="text-left px-3 py-1.5 font-medium text-gray-500">車輌</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">便</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">売上</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">収支</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">未確定</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500" title="一番星に対応する明細が無かった便">未突合</th>
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
                            <td class="px-3 py-1.5 text-right whitespace-nowrap">
                              {{ hasSales ? yen(opSales(op).salesYen) : '-' }}
                            </td>
                            <td
                              class="px-3 py-1.5 text-right whitespace-nowrap"
                              :class="margin(opSales(op).salesYen, op.totalYen) < 0 ? 'text-red-600 dark:text-red-400' : ''"
                            >
                              {{ hasSales ? yen(margin(opSales(op).salesYen, op.totalYen)) : '-' }}
                            </td>
                            <td
                              class="px-3 py-1.5 text-right"
                              :class="opHasIssue(op) ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                            >
                              {{ op.irregularTrips }}
                            </td>
                            <td
                              class="px-3 py-1.5 text-right"
                              :class="opSales(op).unmatchedTrips > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                            >
                              {{ hasSales ? opSales(op).unmatchedTrips : '-' }}
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
                            <td colspan="10" class="pl-16 pr-3 py-1.5 text-amber-600 dark:text-amber-400">
                              便を取れませんでした — {{ op.error }}
                            </td>
                          </tr>

                          <tr v-else-if="openOps[op.unkoNo]" class="border-t border-gray-100 dark:border-gray-800/70">
                            <td colspan="10" class="p-0">
                              <table class="w-full text-xs">
                                <thead class="bg-gray-100/40 dark:bg-gray-800/40">
                                  <tr>
                                    <th class="text-left pl-16 pr-3 py-1 font-medium text-gray-500">日付</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">便</th>
                                    <th class="text-left px-3 py-1 font-medium text-gray-500">積地 → 卸地</th>
                                    <th class="text-left px-3 py-1 font-medium text-gray-500">マスタ卸地</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">手当</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">数量</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">売上</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">収支</th>
                                    <th class="text-left px-3 py-1 font-medium text-gray-500">突合</th>
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
                                      <span v-if="r.viaCities.includes('>')" class="text-gray-400">({{ r.viaCities }})</span>
                                    </td>
                                    <td class="px-3 py-1">{{ r.masterDest || '-' }}</td>
                                    <td class="px-3 py-1 text-right whitespace-nowrap">
                                      <span v-if="r.status === 'ok'">{{ yen(r.allowanceYen) }}</span>
                                      <span v-else class="text-amber-600 dark:text-amber-400" :title="`マスタで決まらない (${r.status})`">未確定</span>
                                    </td>
                                    <td class="px-3 py-1 text-right whitespace-nowrap text-gray-500">
                                      {{ legQuantityLabel(r) }}
                                    </td>
                                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(legSalesYen(r)) }}</td>
                                    <td
                                      class="px-3 py-1 text-right whitespace-nowrap"
                                      :class="(legMarginYen(r) ?? 0) < 0 ? 'text-red-600 dark:text-red-400' : ''"
                                    >
                                      {{ yen(legMarginYen(r)) }}
                                    </td>
                                    <td class="px-3 py-1 whitespace-nowrap">
                                      <span :class="legMatchLabel(r).warn ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500'">
                                        {{ legMatchLabel(r).text }}
                                      </span>
                                      <span
                                        v-for="flag in legMatchLabel(r).flags"
                                        :key="flag"
                                        class="ml-1 text-amber-600 dark:text-amber-400"
                                      >{{ flag }}</span>
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

        <div v-if="hasSales" class="mt-6 space-y-2 text-xs">
          <h2 class="text-sm font-semibold">突合できなかったもの</h2>
          <p class="text-gray-500">
            ここに出ているものは<b>売上・収支の合計に入っていません</b> (単価の食い違いを除く)。
            便と明細のどちらが正しいかは人が決めます。
          </p>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              一番星に対応する明細が無い便
              <b :class="unmatchedLegs.length > 0 ? 'text-amber-600 dark:text-amber-400' : ''">{{ unmatchedLegs.length }}</b> 便
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">日付</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">車輌</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">積地 → 卸地</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">マスタ卸地</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当</th>
                    <th class="px-3 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in unmatchedLegs" :key="legKey(r)" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ r.date }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ r.driverName }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ r.vehicleName }}</td>
                    <td class="px-3 py-1">{{ r.originCity || '?' }} → {{ r.destCity || '?' }}</td>
                    <td class="px-3 py-1">{{ r.masterDest || '-' }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(r.allowanceYen) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">
                      <button class="text-blue-500 hover:text-blue-700 hover:underline" @click="goToOperation(r.unkoNo)">
                        運行を開く
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              どの便にも当たらなかった一番星明細
              <b :class="leftoverSlips.length > 0 ? 'text-amber-600 dark:text-amber-400' : ''">{{ leftoverSlips.length }}</b> 本
              <span class="text-gray-400">(便に無い仕事か、便の取りこぼし。受け皿の車番の残りは含みません)</span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">車輌C</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">売上年月日</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">得意先</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">着地</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">銘柄</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">数量</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">単価</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">売上</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="l in leftoverSlips" :key="l.slip.rowId" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.vehicle }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.slip.saleDate }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.slip.customerName }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.slip.dest }}<span class="text-gray-400"> ({{ l.slip.destAreaName }})</span></td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.slip.itemName }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ tons(l.slip.quantity) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(l.slip.unitPrice) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(l.slip.amount) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              マスタの運賃と単価が食い違う明細
              <b :class="fareMismatches.length > 0 ? 'text-amber-600 dark:text-amber-400' : ''">{{ fareMismatches.length }}</b> 本
              <span class="text-gray-400">(料金改定か入力ミスの疑い。売上は一番星の金額をそのまま使っています)</span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">売上年月日</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">着地</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">銘柄</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">数量</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">一番星の単価</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">マスタの運賃</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(f, i) in fareMismatches" :key="`${f.legKey}-${f.itemName}-${i}`" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.date }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.driverName || '(便に無し)' }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.dest }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.itemName }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ tons(f.quantity) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap text-amber-600 dark:text-amber-400">{{ yen(f.unitPrice) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ f.masterFares.map(v => yen(v)).join(' / ') }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              マスタに無い銘柄・経路 (対象外) <b>{{ outOfMaster.length }}</b> 本
              <span class="text-gray-400">(肉牛・素牛・N搾乳 等。料金表が A飼料 系しか無いための対象外で、未確定とは別)</span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">売上年月日</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">着地</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">銘柄</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">数量</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">単価</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(f, i) in outOfMaster" :key="`${f.legKey}-${f.itemName}-${i}`" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.date }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.driverName || '(便に無し)' }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.dest }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.itemName }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ tons(f.quantity) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(f.unitPrice) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </template>
    </template>
  </div>
</template>
