<script setup lang="ts">
/**
 * 粗利 (売上 − 手当 − 経費) ページ。
 *
 * 運行手当タブで**売上と手当は揃った** (2026-07 / 帯広5台で手当表PDF 313 便と
 * 突合し、差は PDF 側の誤り 1 件のみ)。**残っていたのは経費**で、
 * rust-ichibanboshi#305 が `経費明細` を読む口を足したので、ここで運行 1 本ごとの
 * 粗利まで持っていく (Refs #760)。
 *
 * **運行手当タブとは独立したタブ**にしてある (オーナー決定)。あちらの中の節にすると、
 * ただでさえ長い画面がさらに縦に伸びて、手当の突合と粗利のどちらを見ているのか
 * 分からなくなる。
 *
 * ## 粗利に入れないもの (オーナー決定)
 *
 * - **`01 燃料ｵｲﾙ代` / `15 アドブルー`** … 一番星から取らず、
 *   **走行距離 ÷ 燃費 × 単価**で出す。給油日と運行日がずれるので、一番星の燃料費を
 *   そのまま運行に乗せると給油した日の運行だけが赤くなる
 * - **`08 給与(人件費)` / `11 賞与・調整金`** … 運行手当と二重になる。
 *   **別枠で「一番星の人件費」と「運行手当」を並べて出し**、どちらが正しいかは人が判断する
 *
 * ## 按分
 *
 * **固定費と、日・車輌が運行に一致しない経費は走行距離の比で按分する** (オーナー決定)。
 * 分母はその月・その車輌の運行の走行距離の合計、分子はその運行の走行距離。
 * **どちらも表に出す** — 按分は人が検算できないと信用されない。
 * **分母が 0 なら按分しない** (0 除算を粗利に混ぜるくらいなら「配れなかった額」と書く)。
 *
 * ## 燃費と単価
 *
 * 既定値は**一番星の燃料実績** (`Σamount ÷ Σquantity` と `ΣtotalKm ÷ Σquantity`)。
 * 単月では給油日と運行日のずれで燃費が振れるので、**確定値は人が入れられる**
 * (localStorage、`allowance-provisional.ts` と同じ方式)。
 * **分母が 0 の車輌は燃料代を出さず、粗利も `-` にする。**
 */
import { getOperations, getOperationCsv, getDrivers } from '~/utils/api'
import { fetchAllPages } from '~/utils/paged-fetch'
import type { Driver, OperationListItem } from '~/types'
import { extractAllowanceLegs, allowanceForLegs } from '~/utils/allowance-trips'
import { extractOperationIdle } from '~/utils/allowance-idle'
import { parseTargets, serializeTargets, toggleTarget, driverLabel } from '~/utils/allowance-targets'
import {
  applyCarryOver,
  buildMonthlyAllowance,
  monthReadingRange,
  type OperationAllowance,
  type AllowanceReportRow,
} from '~/utils/allowance-report'
import { fetchVehicleDailySlips, fetchDriverDailySlips, type VehicleDailySlip } from '~/utils/ichiban'
import { PROVISIONAL_KEY, parseProvisional, provisionalFor, type ProvisionalMap } from '~/utils/allowance-provisional'
import { EXCLUDED_KEY, parseExcluded, isExcluded, type ExcludedMap } from '~/utils/allowance-excluded'
import { LAST_SEARCH_KEY, parseLastSearch, serializeLastSearch } from '~/utils/allowance-last-search'
import { savedAtLabel } from '~/utils/allowance-cache'
import {
  reconcileVehicles,
  tradableSlips,
  slipDateRange,
  vehicleCodeFromUnkoNo,
  legKey,
  POOL_VEHICLE,
  type VehicleReconcileInput,
} from '~/utils/allowance-ichiban'
import {
  FUEL_RATE_KEY,
  MARGIN_CACHE_KEY,
  monthCostRange,
  fetchVehicleCosts,
  parseFuelRates,
  serializeFuelRates,
  setFuelRate,
  parseMarginCache,
  serializeMarginCache,
  buildOperationMargins,
  summarizeMargins,
  groupMarginsByDriver,
  marginRate,
  marginCsvLines,
  type CostRow,
  type FuelRateMap,
  type MarginCache,
  type MarginOperationInput,
  type OperationMargin,
} from '~/utils/margin'

/** イベントCSV を同時に引く本数。alc を叩きすぎないための上限 (運行手当タブと同じ)。 */
const CSV_CONCURRENCY = 4
/** 対象乗務員 (乗務員CD)。**運行手当タブと同じキーを読む** — 対象は同じ人たちなので、
 * 2 つの画面で別々に選び直させる意味が無い。 */
const TARGETS_KEY = 'dtako:allowance:driver-cds'

function currentYm(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const ym = ref(currentYm())
const vehicle = ref('')
const shownYm = ref('')

type Status = 'idle' | 'loading' | 'ready' | 'error'
const status = ref<Status>('idle')
const errorMessage = ref<string | null>(null)
const salesError = ref<string | null>(null)
const costError = ref<string | null>(null)
const cacheNote = ref<string | null>(null)
const progress = ref('')
/** 前回の集計をキャッシュから出しているだけ (= 通信していない) か。画面に出す。 */
const restoredFromCache = ref(false)
const savedAt = ref('')

/** 粗利の入力 (運行 1 本 = 1 行) と、対象月・対象車輌の経費明細。 */
const inputs = ref<MarginOperationInput[]>([])
const costs = ref<CostRow[]>([])
/** 車輌C → 人が入れた燃費・単価 (localStorage)。既定値は実績。 */
const fuelRates = ref<FuelRateMap>({})

const targets = ref<string[]>([])
const drivers = ref<Driver[]>([])
const pendingDriver = ref('')

/** 粗利を出せない運行だけに絞る (燃費が出せない / 経費が配れない)。 */
const onlyIssues = ref(false)

const yen = (v: number | null) => (v === null ? '-' : `¥${Math.round(v).toLocaleString()}`)
const km = (v: number) => `${Math.round(v * 10) / 10}km`
const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 1000) / 10}%`)
const num = (v: number | null, digits = 1) => (v === null ? '-' : String(Math.round(v * 10 ** digits) / 10 ** digits))

onMounted(async () => {
  targets.value = parseTargets(localStorage.getItem(TARGETS_KEY))
  const last = parseLastSearch(localStorage.getItem(LAST_SEARCH_KEY))
  if (last) {
    ym.value = last.ym
    vehicle.value = last.vehicle
  }
  fuelRates.value = parseFuelRates(localStorage.getItem(FUEL_RATE_KEY))
  try {
    drivers.value = await getDrivers()
  }
  catch {
    // 乗務員マスタが引けなくても CD だけで動く (表示が CD のままになるだけ)
  }
  restoreFromCache()
})

/** **前回の集計をそのまま出す (通信しない)。** 月・車輌が違うキャッシュは使わない。 */
function restoreFromCache() {
  let cache: MarginCache | null
  try {
    cache = parseMarginCache(localStorage.getItem(MARGIN_CACHE_KEY))
  }
  catch (e) {
    cacheNote.value = `キャッシュを読めませんでした — ${e instanceof Error ? e.message : String(e)}`
    return
  }
  if (!cache || cache.ym !== ym.value) return
  inputs.value = cache.operations
  costs.value = cache.costs
  shownYm.value = cache.ym
  savedAt.value = cache.savedAt
  restoredFromCache.value = true
  status.value = 'ready'
}

function writeCache() {
  const now = new Date().toISOString()
  try {
    localStorage.setItem(MARGIN_CACHE_KEY, serializeMarginCache({
      ym: shownYm.value,
      savedAt: now,
      operations: inputs.value,
      costs: costs.value,
    }))
    savedAt.value = now
  }
  catch (e) {
    // 容量超過が現実的な失敗。次回また全部引くだけで、画面の数字は正しい。
    cacheNote.value = `キャッシュを保存できませんでした (次回も取り直します) — ${e instanceof Error ? e.message : String(e)}`
  }
}

function toggle(cd: string) {
  targets.value = toggleTarget(targets.value, cd)
  localStorage.setItem(TARGETS_KEY, serializeTargets(targets.value))
}

watch(pendingDriver, (cd) => {
  if (!cd) return
  toggle(cd)
  pendingDriver.value = ''
})

function labelOf(cd: string): string {
  return driverLabel(drivers.value, cd)
}

const driverCdByName = computed(() => {
  const map = new Map<string, string>()
  for (const d of drivers.value) map.set(d.driver_name.trim(), d.driver_cd.trim())
  return map
})

/** 燃費・単価の上書きを保存する。保存に失敗しても画面の数字は正しいので握る。 */
function onFuelRateInput(vehicleCode: string, field: 'yenPerLiter' | 'kmPerLiter', raw: string) {
  fuelRates.value = setFuelRate(fuelRates.value, vehicleCode, field, Number(raw) || 0)
  try {
    localStorage.setItem(FUEL_RATE_KEY, serializeFuelRates(fuelRates.value))
  }
  catch (e) {
    cacheNote.value = `燃費・単価の上書きを保存できませんでした — ${e instanceof Error ? e.message : String(e)}`
  }
}

// --- 集計 ---

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

/**
 * 1 運行ぶんのイベントCSV を引いて、**便 (手当) と走行距離を一度に**取り出す。
 *
 * `extractAllowanceLegs` と `extractOperationIdle` は同じ CSV を読むので、
 * 2 回引かない (運行手当タブの実測で 90 本引くのに数分かかる)。
 */
async function resolveOperation(op: OperationListItem): Promise<{ allowance: OperationAllowance, totalKm: number }> {
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
  if (!op.has_kudgivt) {
    return { allowance: { ...base, error: 'イベントCSV が未取り込み (has_kudgivt=false)' }, totalKm: 0 }
  }
  try {
    const csv = await getOperationCsv(op.unko_no, 'events')
    const idle = extractOperationIdle(csv.headers, csv.rows)
    return {
      allowance: { ...base, legs: allowanceForLegs(extractAllowanceLegs(csv.headers, csv.rows)) },
      totalKm: idle.totalKm,
    }
  }
  catch (e) {
    return { allowance: { ...base, error: e instanceof Error ? e.message : String(e) }, totalKm: 0 }
  }
}

/** 便 1 本の「払う手当」= マスタで決まった額、無ければ暫定。どちらも無ければ 0。 */
function legPayYen(row: AllowanceReportRow, provisional: ProvisionalMap): number {
  return row.allowanceYen ?? provisionalFor(row, provisional) ?? 0
}

/** 一番星を乗務員CD で引けるか。**車番で引くと別の車番で走った日の売上が丸ごと落ちる。** */
function canFetchByDriver(names: string[]): boolean {
  return targets.value.length > 0 && names.every(name => driverCdByName.value.has(name))
}

/** 便を乗務員ごとに分けて乗務員CD の昇順に並べる (突合の入力の順を固定する)。 */
function orderedDriverRows(rows: AllowanceReportRow[]): [string, AllowanceReportRow[]][] {
  const groups = new Map<string, AllowanceReportRow[]>()
  for (const row of rows) {
    const cd = driverCdByName.value.get(row.driverName) ?? ''
    const list = groups.get(cd) ?? []
    list.push(row)
    groups.set(cd, list)
  }
  return [...groups].sort((a, b) => (a[0] > b[0] ? 1 : -1))
}

/** 便を車輌C ごとに分けて車輌C の昇順に並べる。 */
function orderedVehicleRows(rows: AllowanceReportRow[]): [string, AllowanceReportRow[]][] {
  const groups = new Map<string, AllowanceReportRow[]>()
  for (const row of rows) {
    const code = vehicleCodeFromUnkoNo(row.unkoNo)
    const list = groups.get(code) ?? []
    list.push(row)
    groups.set(code, list)
  }
  return [...groups].sort((a, b) => (a[0] > b[0] ? 1 : -1))
}

/** 便 → 売上。一番星が引けなければ空の Map (売上 0 として粗利は出さない)。 */
async function fetchSales(rows: AllowanceReportRow[], driverNames: string[]): Promise<Map<string, number>> {
  const range = slipDateRange(shownYm.value)
  const inputsForReconcile: VehicleReconcileInput[] = []
  let pool: VehicleDailySlip[] = []
  if (canFetchByDriver(driverNames)) {
    for (const [cd, driverRows] of orderedDriverRows(rows)) {
      progress.value = `一番星の売上を取得中 ${labelOf(cd)}`
      inputsForReconcile.push({ vehicle: cd, rows: driverRows, slips: tradableSlips(await fetchDriverDailySlips(cd, range.from, range.to)) })
    }
  }
  else {
    for (const [code, vehicleRows] of orderedVehicleRows(rows)) {
      progress.value = `一番星の売上を取得中 車輌${code}`
      inputsForReconcile.push({ vehicle: code, rows: vehicleRows, slips: tradableSlips(await fetchVehicleDailySlips(code, range.from, range.to)) })
    }
    progress.value = `一番星の売上を取得中 受け皿(${POOL_VEHICLE})`
    pool = tradableSlips(await fetchVehicleDailySlips(POOL_VEHICLE, range.from, range.to))
  }
  const res = reconcileVehicles(inputsForReconcile, pool)
  const salesByLeg = new Map<string, number>()
  for (const [key, hit] of res.byLeg) salesByLeg.set(key, hit.salesYen)
  return salesByLeg
}

async function run() {
  status.value = 'loading'
  restoredFromCache.value = false
  errorMessage.value = null
  salesError.value = null
  costError.value = null
  cacheNote.value = null
  inputs.value = []
  costs.value = []
  progress.value = '運行を検索中...'
  try {
    localStorage.setItem(LAST_SEARCH_KEY, serializeLastSearch({ ym: ym.value, vehicle: vehicle.value }))
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

    const resolved: { allowance: OperationAllowance, totalKm: number }[] = []
    for (let i = 0; i < found.length; i += CSV_CONCURRENCY) {
      progress.value = `イベントCSV を取得中 ${resolved.length}/${found.length}`
      resolved.push(...await Promise.all(found.slice(i, i + CSV_CONCURRENCY).map(resolveOperation)))
    }
    const kmByUnko = new Map(resolved.map(r => [r.allowance.unkoNo, r.totalKm]))
    // 積んだまま帰庫した便の卸地は次の運行の先頭にある。全運行を引き終えてから当てる。
    const ops = applyCarryOver(resolved.map(r => r.allowance))
    shownYm.value = ym.value

    // **手当は運行手当タブと同じ基準にする** — 暫定を足し、除外した便は落とす。
    // 基準がずれると「手当タブと粗利タブで手当が違う」という直しようのない話になる。
    const provisional = parseProvisional(localStorage.getItem(PROVISIONAL_KEY))
    const excluded: ExcludedMap = parseExcluded(localStorage.getItem(EXCLUDED_KEY))
    const monthly = buildMonthlyAllowance(ops, shownYm.value)
    const rowsByUnko = new Map<string, AllowanceReportRow[]>()
    const driverNames: string[] = []
    for (const d of monthly.drivers) {
      driverNames.push(d.driverName)
      for (const op of d.operations) {
        rowsByUnko.set(op.unkoNo, op.rows.filter(r => !isExcluded(r, excluded)))
      }
    }
    const allRows = [...rowsByUnko.values()].flat()

    // 一番星が落ちていても経費と手当は出せる。売上だけ諦めて理由を画面に残す。
    let salesByLeg = new Map<string, number>()
    try {
      salesByLeg = await fetchSales(allRows, driverNames)
    }
    catch (e) {
      salesError.value = e instanceof Error ? e.message : String(e)
    }

    inputs.value = monthly.drivers.flatMap(d => d.operations.map((op) => {
      const rows = rowsByUnko.get(op.unkoNo) ?? []
      return {
        unkoNo: op.unkoNo,
        // **経費の `運行年月日` と突き合わせる鍵**。便の日付 (積みの時刻) を使う。
        date: rows[0]?.date ?? op.readingDate,
        driverName: d.driverName,
        vehicleCode: vehicleCodeFromUnkoNo(op.unkoNo),
        totalKm: kmByUnko.get(op.unkoNo) ?? 0,
        salesYen: rows.reduce((sum, r) => sum + (salesByLeg.get(legKey(r)) ?? 0), 0),
        allowanceYen: rows.reduce((sum, r) => sum + legPayYen(r, provisional), 0),
      }
    }))

    // 経費は車輌ごとに引く (按分の分母が「月・その車輌の Σ走行距離」なので対応が取れる)。
    const costRange = monthCostRange(shownYm.value)
    const vehicles = [...new Set(inputs.value.map(i => i.vehicleCode))].sort()
    const gathered: CostRow[] = []
    try {
      for (const code of vehicles) {
        progress.value = `一番星の経費を取得中 車輌${code}`
        gathered.push(...await fetchVehicleCosts(code, costRange.from, costRange.to))
      }
      costs.value = gathered
    }
    catch (e) {
      costError.value = e instanceof Error ? e.message : String(e)
    }

    status.value = 'ready'
    progress.value = ''
    writeCache()
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
  }
}

// --- 表示 ---

const result = computed(() => buildOperationMargins(inputs.value, costs.value, fuelRates.value))
const totals = computed(() => summarizeMargins(result.value.operations))
const monthMarginRate = computed(() => marginRate({
  salesYen: totals.value.salesYen - totals.value.unknownFuelSalesYen,
  marginYen: totals.value.marginYen,
}))

/** 車輌ごとの燃費・単価の欄 (実績と上書き)。**車輌C 順に固定する。** */
const vehicleRates = computed(() => [...result.value.kmByVehicle.keys()].sort().map(code => ({
  code,
  totalKm: result.value.kmByVehicle.get(code)!,
  derived: result.value.derivedByVehicle.get(code)!,
  effective: result.value.ratesByVehicle.get(code)!,
  override: fuelRates.value[code],
})))

function hasIssue(m: OperationMargin): boolean {
  return m.fuelYen === null
}

/**
 * 表示する乗務員。**社員番号 (乗務員CD) 順に並べる** — `margin.ts` は乗務員CD を
 * 持っていないので氏名順で返す。給与まわりの画面としては社員番号順が自然。
 */
const visibleDrivers = computed(() => {
  const groups = groupMarginsByDriver(onlyIssues.value
    ? result.value.operations.filter(hasIssue)
    : result.value.operations)
  const keyOf = (name: string) => {
    const cd = driverCdByName.value.get(name)
    return cd === undefined ? `9${name}` : `0${cd.padStart(8, '0')}`
  }
  return [...groups].sort((a, b) => (keyOf(a.driverName) > keyOf(b.driverName) ? 1 : -1))
})

const openDrivers = reactive<Record<string, boolean>>({})

function downloadCsv() {
  const rows = visibleDrivers.value.flatMap(d => d.operations)
  const blob = new Blob([`﻿${marginCsvLines(rows).join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `粗利_${shownYm.value}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="p-6">
    <h1 class="text-lg font-semibold mb-1">
      粗利 (売上 − 手当 − 経費)
    </h1>
    <p class="text-xs text-gray-500 mb-4">
      運行 1 本ごとに <b>売上 − 手当 − 燃料代 − 直課経費 − 按分経費</b> を出します。
      売上は<b>一番星の運転日報明細</b>、手当は<b>料金・給与マスタ</b> (運行手当タブと同じ基準。
      暫定手当を足し、除外した便は落とします)、経費は<b>一番星の経費明細</b>です。
      <b>燃料代は一番星から取らず、走行距離 ÷ 燃費 × 単価で出します</b> —
      給油日と運行日がずれるので、燃料費をそのまま乗せると給油した日の運行だけが赤くなるためです。
      <b>固定費と、日・車輌が運行に一致しない経費は走行距離の比で按分</b>します
      (分母・分子とも表に出しているので検算できます)。
      <b>燃費が出せない車輌の運行は粗利も「-」</b>にします (0 で割った値を混ぜないため)。
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
        v-if="result.operations.length > 0"
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white"
        @click="downloadCsv"
      >
        CSV出力
      </button>
      <NuxtLink
        to="/profit/allowance"
        class="text-sm px-4 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
        title="手当そのものの突合 (手当表PDF との比較・未確定の便・暫定手当の入力) は運行手当タブです"
      >
        運行手当タブ
      </NuxtLink>
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
          未設定 — 全乗務員を集計します (時間がかかります)。売上も車番引きに落ちます
        </span>
        <button
          v-for="cd in targets"
          :key="cd"
          class="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:line-through"
          title="クリックで対象から外す (運行手当タブと共通の設定です)"
          @click="toggle(cd)"
        >
          {{ labelOf(cd) }} ✕
        </button>
      </div>
    </div>

    <p v-if="progress" class="text-xs text-gray-400 mb-3">
      {{ progress }}
    </p>
    <p v-if="restoredFromCache" class="text-xs text-sky-600 dark:text-sky-400 mb-3">
      前回の集計 (<b>{{ shownYm }}</b>{{ savedAt ? ` ${savedAtLabel(savedAt)} 保存` : '' }}) を
      <b>そのまま表示</b>しています — <b>通信していない</b>ので、保存後に取り込み直しがあれば
      古いままです。最新にするには <b>集計</b> を押してください。
    </p>
    <p v-if="cacheNote" class="text-xs text-amber-600 dark:text-amber-400 mb-3">
      {{ cacheNote }}
    </p>
    <p v-if="status === 'error'" class="text-sm text-red-600 dark:text-red-400 mb-4">
      {{ errorMessage }}
    </p>
    <p v-if="salesError" class="text-sm text-red-600 dark:text-red-400 mb-4">
      売上 (一番星) が引けませんでした — {{ salesError }} (売上 0 として扱っているので<b>粗利は正しくありません</b>)
    </p>
    <p v-if="costError" class="text-sm text-red-600 dark:text-red-400 mb-4">
      経費 (一番星) が引けませんでした — {{ costError }} (経費 0 として扱っているので<b>粗利は正しくありません</b>)
    </p>

    <template v-if="status === 'ready'">
      <p v-if="result.operations.length === 0" class="text-xs text-gray-400">
        {{ shownYm }} に該当する運行が見つかりませんでした
      </p>
      <template v-else>
        <!-- 月の合計 -->
        <div class="mb-3 flex flex-wrap gap-x-6 gap-y-2 text-sm items-center">
          <span class="font-semibold">{{ shownYm }}</span>
          <span>運行 <b>{{ totals.operations }}</b> 本</span>
          <span>走行 <b>{{ km(totals.totalKm) }}</b></span>
          <span>売上 <b>{{ yen(totals.salesYen) }}</b></span>
          <span>手当 <b>{{ yen(totals.allowanceYen) }}</b></span>
          <span>燃料代 <b>{{ yen(totals.fuelYen) }}</b></span>
          <span>直課経費 <b>{{ yen(totals.directCostYen) }}</b></span>
          <span>按分経費 <b>{{ yen(totals.allocatedCostYen) }}</b></span>
          <span>
            粗利
            <b :class="totals.marginYen < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'">
              {{ yen(totals.marginYen) }}
            </b>
            <span class="text-gray-400">({{ pct(monthMarginRate) }})</span>
          </span>
          <span
            v-if="totals.unknownFuelOperations > 0"
            class="text-amber-600 dark:text-amber-400"
            title="燃費が出せず粗利を出せなかった運行。上の粗利・粗利率にはこの運行の売上も入っていません"
          >
            粗利を出せず <b>{{ totals.unknownFuelOperations }}</b> 本 (売上 {{ yen(totals.unknownFuelSalesYen) }})
          </span>
          <span
            v-if="result.unallocatedCostYen > 0"
            class="text-amber-600 dark:text-amber-400"
            title="その車輌の運行が 1 本も無い / 走行距離が 0 で按分できなかった経費。上の粗利から抜けています"
          >
            配れなかった経費 <b>{{ yen(result.unallocatedCostYen) }}</b>
          </span>
          <label class="text-xs text-gray-500 flex items-center gap-1.5 cursor-pointer select-none">
            <input v-model="onlyIssues" type="checkbox" class="cursor-pointer">
            粗利を出せない運行だけ表示
          </label>
        </div>

        <!-- 人件費の別枠 -->
        <div class="mb-4 p-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30">
          <p class="text-xs font-medium mb-2">
            人件費 — <b>どちらも上の粗利には入れていません</b>
          </p>
          <div class="flex flex-wrap gap-x-8 gap-y-1 text-sm">
            <span>一番星の人件費 (08 給与 + 11 賞与・調整金) <b>{{ yen(result.ichibanLaborYen) }}</b></span>
            <span>運行手当 <b>{{ yen(totals.allowanceYen) }}</b></span>
            <span class="text-gray-500">差 <b>{{ yen(result.ichibanLaborYen - totals.allowanceYen) }}</b></span>
          </div>
          <p class="text-xs text-gray-500 mt-2">
            この 2 つは<b>同じものを 2 通りに数えたもの</b>で、両方を引くと二重になります。
            上の粗利は<b>運行手当のほうだけ</b>を引いています。
            <b>どちらが正しいかは人が判断してください</b> — 一番星の人件費には運行手当以外
            (基本給・社会保険・賞与) も入っているので、額はふつう一致しません。
            <span v-if="result.unallocatedLaborYen > 0" class="text-amber-600 dark:text-amber-400">
              うち {{ yen(result.unallocatedLaborYen) }} は運行に配れていません
              (その車輌の運行が無い / 走行距離が 0)。
            </span>
          </p>
          <p class="text-xs text-gray-500 mt-1">
            参考 — 一番星の燃料系 (01 燃料ｵｲﾙ代 + 15 アドブルー) の実績は
            <b>{{ yen(result.ichibanFuelYen) }}</b>。上の燃料代
            <b>{{ yen(totals.fuelYen) }}</b> は<b>走行距離から出した額</b>で、これとは別物です。
          </p>
        </div>

        <!-- 燃費・単価 -->
        <div class="mb-4">
          <p class="text-xs font-medium mb-1">
            燃費・単価 (車輌ごと)
          </p>
          <p class="text-xs text-gray-500 mb-2">
            <b>既定値は一番星の燃料実績</b> (単価 = Σ税抜金額 ÷ Σ給油量、燃費 = Σ走行距離 ÷ Σ給油量)。
            <b>給油日と運行日がずれる</b>ので単月では燃費が振れます。<b>確定値は下の欄に入れてください</b>
            (このブラウザに保存され、実績より優先します。空にすると実績に戻ります)。
            <b>軽油引取税は単価に入っていません</b> — 実際に払っている 円/L は「単価 + 軽油引取税」です。
          </p>
          <div class="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="text-left px-3 py-2 font-medium text-gray-500">車輌C</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">月の走行km</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">実績 単価(円/L)</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">軽油引取税(円/L)</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">実績 燃費(km/L)</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">上書き 単価</th>
                  <th class="text-right px-3 py-2 font-medium text-gray-500">上書き 燃費</th>
                  <th class="text-left px-3 py-2 font-medium text-gray-500">使う値</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="v in vehicleRates" :key="v.code" class="border-t border-gray-100 dark:border-gray-800">
                  <td class="px-3 py-1.5">{{ v.code }}</td>
                  <td class="px-3 py-1.5 text-right">{{ km(v.totalKm) }}</td>
                  <td class="px-3 py-1.5 text-right">{{ num(v.derived.yenPerLiter) }}</td>
                  <td class="px-3 py-1.5 text-right text-gray-400">{{ num(v.derived.dieselTaxPerLiter) }}</td>
                  <td class="px-3 py-1.5 text-right">{{ num(v.derived.kmPerLiter, 2) }}</td>
                  <td class="px-3 py-1.5 text-right">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      class="w-24 text-right border rounded px-1 py-0.5 dark:bg-gray-900"
                      :value="v.override?.yenPerLiter ?? ''"
                      placeholder="実績"
                      @input="onFuelRateInput(v.code, 'yenPerLiter', ($event.target as HTMLInputElement).value)"
                    >
                  </td>
                  <td class="px-3 py-1.5 text-right">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      class="w-24 text-right border rounded px-1 py-0.5 dark:bg-gray-900"
                      :value="v.override?.kmPerLiter ?? ''"
                      placeholder="実績"
                      @input="onFuelRateInput(v.code, 'kmPerLiter', ($event.target as HTMLInputElement).value)"
                    >
                  </td>
                  <td
                    class="px-3 py-1.5"
                    :class="v.effective.kmPerLiter === null || v.effective.yenPerLiter === null
                      ? 'text-amber-600 dark:text-amber-400'
                      : ''"
                  >
                    <template v-if="v.effective.kmPerLiter === null || v.effective.yenPerLiter === null">
                      燃費が出せない — {{ v.derived.yenPerLiter === null
                        ? 'この月・この車輌に燃料 (01) の給油実績がありません'
                        : '走行距離が 0 です' }}。この車輌の運行は燃料代も粗利も「-」になります
                    </template>
                    <template v-else>
                      {{ num(v.effective.yenPerLiter) }} 円/L ・ {{ num(v.effective.kmPerLiter, 2) }} km/L
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 乗務員 → 運行 -->
        <p v-if="visibleDrivers.length === 0" class="text-xs text-gray-400">
          粗利を出せない運行はありません
        </p>
        <div v-else class="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th class="text-left px-3 py-2 font-medium text-gray-500">乗務員 / 運行</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">走行km</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">売上</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">手当</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">燃料代</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">直課経費</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">按分経費</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">粗利</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">粗利率</th>
                <th class="text-left px-3 py-2 font-medium text-gray-500">按分 (分子/分母)</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">人件費(参考)</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="d in visibleDrivers" :key="d.driverName">
                <tr
                  class="border-t border-gray-100 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
                  @click="openDrivers[d.driverName] = !openDrivers[d.driverName]"
                >
                  <td class="px-3 py-2 font-medium">
                    {{ openDrivers[d.driverName] ? '▾' : '▸' }} {{ d.driverName }}
                    <span class="text-gray-400">({{ d.totals.operations }}運行)</span>
                  </td>
                  <td class="px-3 py-2 text-right">{{ km(d.totals.totalKm) }}</td>
                  <td class="px-3 py-2 text-right">{{ yen(d.totals.salesYen) }}</td>
                  <td class="px-3 py-2 text-right">{{ yen(d.totals.allowanceYen) }}</td>
                  <td class="px-3 py-2 text-right">{{ yen(d.totals.fuelYen) }}</td>
                  <td class="px-3 py-2 text-right">{{ yen(d.totals.directCostYen) }}</td>
                  <td class="px-3 py-2 text-right">{{ yen(d.totals.allocatedCostYen) }}</td>
                  <td
                    class="px-3 py-2 text-right font-medium"
                    :class="d.totals.marginYen < 0 ? 'text-red-600 dark:text-red-400' : ''"
                  >
                    {{ yen(d.totals.marginYen) }}
                  </td>
                  <td class="px-3 py-2 text-right">
                    {{ pct(marginRate({
                      salesYen: d.totals.salesYen - d.totals.unknownFuelSalesYen,
                      marginYen: d.totals.marginYen,
                    })) }}
                  </td>
                  <td class="px-3 py-2 text-amber-600 dark:text-amber-400">
                    <span v-if="d.totals.unknownFuelOperations > 0">
                      粗利を出せず {{ d.totals.unknownFuelOperations }} 本
                    </span>
                  </td>
                  <td class="px-3 py-2 text-right text-gray-400">{{ yen(d.totals.laborYen) }}</td>
                </tr>
                <tr
                  v-for="m in (openDrivers[d.driverName] ? d.operations : [])"
                  :key="m.unkoNo"
                  class="border-t border-gray-100 dark:border-gray-800"
                >
                  <td class="px-3 py-1.5 pl-8">
                    <NuxtLink
                      :to="`/operations/${m.unkoNo}`"
                      target="_blank"
                      class="text-blue-500 hover:text-blue-700 hover:underline"
                    >
                      {{ m.date }}
                    </NuxtLink>
                    <span class="text-gray-400 ml-2">車輌{{ m.vehicleCode }}</span>
                  </td>
                  <td class="px-3 py-1.5 text-right">{{ km(m.totalKm) }}</td>
                  <td class="px-3 py-1.5 text-right">{{ yen(m.salesYen) }}</td>
                  <td class="px-3 py-1.5 text-right">{{ yen(m.allowanceYen) }}</td>
                  <td
                    class="px-3 py-1.5 text-right"
                    :class="m.fuelYen === null ? 'text-amber-600 dark:text-amber-400' : ''"
                    :title="m.fuelYen === null ? 'この車輌の燃費が出せないので燃料代を出していません' : ''"
                  >
                    {{ yen(m.fuelYen) }}
                  </td>
                  <td class="px-3 py-1.5 text-right">{{ yen(m.directCostYen) }}</td>
                  <td class="px-3 py-1.5 text-right">{{ yen(m.allocatedCostYen) }}</td>
                  <td
                    class="px-3 py-1.5 text-right font-medium"
                    :class="m.marginYen !== null && m.marginYen < 0 ? 'text-red-600 dark:text-red-400' : ''"
                    :title="m.marginYen === null ? '燃費が出せないので粗利を出していません' : ''"
                  >
                    {{ yen(m.marginYen) }}
                  </td>
                  <td class="px-3 py-1.5 text-right">{{ pct(marginRate(m)) }}</td>
                  <td class="px-3 py-1.5 text-gray-500" :title="'按分 = 車輌の按分対象の経費 × (この運行の走行km ÷ 月・この車輌の走行km)'">
                    {{ num(m.totalKm) }} / {{ num(m.vehicleTotalKm) }} km
                    <span v-if="m.vehicleTotalKm > 0" class="text-gray-400">
                      = {{ pct(m.totalKm / m.vehicleTotalKm) }}
                    </span>
                    <span v-else class="text-amber-600 dark:text-amber-400">— 分母 0 なので按分していません</span>
                  </td>
                  <td class="px-3 py-1.5 text-right text-gray-400">{{ yen(m.laborYen) }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </div>
</template>
