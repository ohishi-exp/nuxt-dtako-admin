<script setup lang="ts">
import { getOperations, getDrivers, getVehicles, splitCsvAllStream } from '~/utils/api'
import type { OperationListItem, Driver, Vehicle } from '~/types'
import { describeListFailure } from '~/utils/api-error'

const router = useRouter()

// Filters
const dateFrom = ref('')
const dateTo = ref('')
const selectedDriverCd = ref('')
const selectedVehicleCd = ref('')
const page = ref(1)
const perPage = 50

// Data
const operations = ref<OperationListItem[]>([])
const total = ref(0)
const drivers = ref<Driver[]>([])
const vehicles = ref<Vehicle[]>([])
// 一覧が**取得できなかった**理由 (Refs #920)。**空配列だけでは「0 人」「0 台」と
// 区別が付かない**ので、「読めなかった」ことを状態として持つ。**乗務員と車両は
// 別々に持つ** — 片方だけ落ちたときに、落ちていない側まで疑わせないため。
const driversError = ref<string | null>(null)
const vehiclesError = ref<string | null>(null)
// 表そのものが**取得できなかった**理由 (Refs #1008)。上の 2 本と同じ理由で
// **別に持つ** — 落ちたときの表は `operations.length === 0` の枝に入って
// **「データがありません」**と出るので、**空配列だけでは「本当に 0 件」と
// 区別が付かない**。絞り込みの選択肢とは落ちる口が違うので 1 本にまとめない。
const fetchError = ref<string | null>(null)
const loading = ref(false)
const splitLoading = ref(false)
const splitResult = ref('')

// Table columns
const columns = [
  { key: 'operation_date', label: '運行日' },
  { key: 'reading_date', label: '読取日' },
  { key: 'unko_no', label: '運行NO' },
  { key: 'driver_name', label: 'ドライバー' },
  { key: 'vehicle_name', label: '車両' },
  { key: 'total_distance', label: '走行距離' },
  { key: 'has_kudgivt', label: 'IVT' },
  { key: 'safety_score', label: '安全' },
  { key: 'economy_score', label: '省エネ' },
  { key: 'total_score', label: '総合' },
]

async function fetchData() {
  loading.value = true
  // **取り直しごとに消す** — 絞り込みやページ送りで走り直して成功した回に、
  // 前回の失敗が残っていると「いま落ちている」と読める。
  fetchError.value = null
  try {
    const res = await getOperations({
      date_from: dateFrom.value || undefined,
      date_to: dateTo.value || undefined,
      driver_cd: selectedDriverCd.value || undefined,
      vehicle_cd: selectedVehicleCd.value || undefined,
      page: page.value,
      per_page: perPage,
    })
    operations.value = res.operations
    total.value = res.total
  } catch (e) {
    console.error('Failed to fetch operations:', e)
    // ★ **console だけだと画面には何も出ない** (Refs #1008)。`loading` が終わって
    //   表が「データがありません」になるだけなので、**「取得に失敗した」と
    //   「本当に 0 件」が人には区別できない**。理由と次の一手を状態に持つ。
    fetchError.value = describeListFailure(e, RETRY_RELOAD)
  } finally {
    loading.value = false
  }
}

/** 一覧を取り直す口が `onMounted` にしかない画面の「やり直し方」 (Refs #1008)。 */
const RETRY_RELOAD = 'ページを再読み込みしてください'

async function loadDrivers() {
  try {
    drivers.value = await getDrivers()
  }
  catch (e) {
    // 一覧は空に戻すが、**空にした理由を必ず持つ** — 空配列だけだと選択肢が出ないのを
    // 「乗務員が 0 人」と読まれ、読めなかっただけの回と区別が付かない (Refs #920)。
    drivers.value = []
    driversError.value = describeListFailure(e, RETRY_RELOAD)
  }
}

async function loadVehicles() {
  try {
    vehicles.value = await getVehicles()
  }
  catch (e) {
    // loadDrivers と同じ理由 (Refs #920)。
    vehicles.value = []
    vehiclesError.value = describeListFailure(e, RETRY_RELOAD)
  }
}

// Fetch filter options
// **`Promise.all` のまま並行に取る** (直列にすると初回表示が遅くなる)。
// **片方が落ちてももう片方は読める** — catch はそれぞれの中にあるので、
// `.catch(() => {})` 時代と同じ性質。変えたのは**理由を捨てずに持つ**ところだけ。
onMounted(async () => {
  await Promise.all([loadDrivers(), loadVehicles()])
  await fetchData()
})

// Re-fetch on filter change
watch([dateFrom, dateTo, selectedDriverCd, selectedVehicleCd], () => {
  page.value = 1
  fetchData()
})

watch(page, fetchData)

function onRowClick(row: OperationListItem) {
  router.push(`/operations/${row.unko_no}`)
}

function formatDistance(val: number | null): string {
  if (val == null) return '-'
  return `${val.toFixed(1)} km`
}

function formatScore(val: number | null): string {
  if (val == null) return '-'
  return val.toFixed(1)
}

function scoreColor(val: number | null): string {
  if (val == null) return ''
  if (val >= 80) return 'text-green-600'
  if (val >= 60) return 'text-yellow-600'
  return 'text-red-600'
}

const totalPages = computed(() => Math.ceil(total.value / perPage))

// 車両検索
const vehicleSearch = ref('')
const vehicleDropdown = ref(false)
const filteredVehicles = computed(() => {
  const q = vehicleSearch.value.toLowerCase()
  if (!q) return vehicles.value
  return vehicles.value.filter(v => v.vehicle_name.toLowerCase().includes(q) || v.vehicle_cd.includes(q))
})
function selectVehicle(v: Vehicle) {
  selectedVehicleCd.value = v.vehicle_cd
  vehicleSearch.value = v.vehicle_name
  vehicleDropdown.value = false
}
function clearVehicle() {
  selectedVehicleCd.value = ''
  vehicleSearch.value = ''
}

// ドロップダウンを閉じる（input の blur で遅延して閉じる）
function closeVehicleDropdown() {
  setTimeout(() => { vehicleDropdown.value = false }, 200)
}

const unsplitCount = computed(() => operations.value.filter(op => !op.has_kudgivt).length)

async function splitAll() {
  splitLoading.value = true
  splitResult.value = '準備中...'
  let gotDone = false
  try {
    await splitCsvAllStream((evt: any) => {
      if (evt.event === 'progress') {
        splitResult.value = `分割中 (${evt.current}/${evt.total}) ${evt.filename || ''}`
      } else if (evt.event === 'done') {
        gotDone = true
        splitResult.value = `完了: ${evt.success}/${evt.total} 成功${evt.failed > 0 ? `, ${evt.failed} 失敗` : ''}`
        fetchData()
      } else if (evt.event === 'error') {
        gotDone = true
        splitResult.value = evt.message || '失敗'
      }
    }, '「IVT一括分割」を押してください')
    // done も error も来ずにストリームが閉じた = 何が起きたか分からない。
    // 「処理中...」は**永久に動いているように読める**ので出さない。`scraper.vue` の
    // 同じ状況 (`splitCsvAllStream` の同じ関数) と同じく loud に出す (Refs #917)。
    if (!gotDone) splitResult.value = '応答が空でした (alc から done イベントが来ていません)'
  } catch (e: any) {
    splitResult.value = e.message || '失敗'
  } finally {
    splitLoading.value = false
    if (gotDone) setTimeout(() => { splitResult.value = '' }, 10000)
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-3">
      <h2 class="text-xl font-bold">運行一覧</h2>
      <UButton
        v-if="unsplitCount > 0"
        :label="`IVT一括分割 (${unsplitCount}件未分割)`"
        icon="i-lucide-scissors"
        size="xs"
        color="warning"
        variant="outline"
        :loading="splitLoading"
        @click="splitAll"
      />
      <span v-if="splitResult" class="text-xs text-gray-500">{{ splitResult }}</span>
    </div>

    <!-- ★ 「読めなかった」と「0 人 / 0 台」を別の文にする (Refs #920)。失敗した回に
         だけ出す (理由だけ出すと**本当に 0 件の回**まで異常に見える)。
         **乗務員と車両で別の文**にしてある — 1 本にまとめると、落ちていない側の
         選択肢まで信用できないと読める。
         ★ **やり直し方はここに書かない** (#1008 PR-3)。次の一手は `title` の側
         (`describeListFailure`) が **status ごとに撃ち分ける**ので、注記にも固定文を
         置くと 403 で「ログインし直しても変わりません」と食い違う (dev で実測)。
         **どの経路でも次の一手はちょうど 1 つ**であることは `describeListFailure` が
         保証している。 -->
    <UAlert
      v-if="driversError"
      :title="`乗務員一覧を取得できませんでした (${driversError})`"
      description="0 人なのか読めなかっただけなのかは、この画面では判りません"
      color="error"
      icon="i-lucide-circle-x"
      variant="subtle"
    />
    <UAlert
      v-if="vehiclesError"
      :title="`車両一覧を取得できませんでした (${vehiclesError})`"
      description="0 台なのか読めなかっただけなのかは、この画面では判りません"
      color="error"
      icon="i-lucide-circle-x"
      variant="subtle"
    />

    <!-- ★ 表の取得失敗を出す (Refs #1008)。直す前は `console.error` だけで、画面には
         **表の「データがありません」しか出ていなかった** — 「取れなかった」と
         「本当に 0 件」が区別できない。**失敗した回にだけ出す**のは上 2 本と同じ理由。

         ★★ `description` は**事実だけ**を書き、**次の一手を持たない**。
         次の一手は `title` の側 (`describeCaughtError` → `nextStepForStatus`) が
         **status ごとに撃ち分けている**ので、ここにも書くと**食い違う**。
         dev で 403 を撃って実測: title は「ログインし直しても変わりません。管理者に
         許可の追加を依頼してください」なのに、初稿の description は「ページを
         再読み込みして確かめてください」と、**title が効かないと言った手を勧めていた**
         (PR-2 が `margin` / `allowance` で見つけた「指示が 2 つ並んで食い違う」と同型。
         **ヘルパ 1 本を読んでいる限り出ず、合成後を描画して初めて出た**)。 -->
    <UAlert
      v-if="fetchError"
      :title="`運行一覧を取得できませんでした (${fetchError})`"
      description="下の表の「データがありません」は 0 件を意味しません"
      color="error"
      icon="i-lucide-circle-x"
      variant="subtle"
    />

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="text-xs text-gray-500 block mb-1">開始日</label>
        <input v-model="dateFrom" type="date" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">終了日</label>
        <input v-model="dateTo" type="date" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">ドライバー</label>
        <DriverSearchSelect v-model="selectedDriverCd" :drivers="drivers" value-key="driver_cd" />
      </div>
      <div class="relative">
        <label class="text-xs text-gray-500 block mb-1">車両</label>
        <input
          v-model="vehicleSearch"
          type="text"
          placeholder="すべて"
          class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700 w-52"
          @focus="vehicleDropdown = true"
          @input="vehicleDropdown = true"
          @blur="closeVehicleDropdown"
        >
        <button v-if="selectedVehicleCd" class="absolute right-2 top-7 text-gray-400 hover:text-gray-600" @click="clearVehicle">
          <UIcon name="i-lucide-x" class="size-3.5" />
        </button>
        <div v-if="vehicleDropdown" class="absolute z-10 mt-1 w-60 max-h-48 overflow-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg">
          <button
            v-for="v in filteredVehicles"
            :key="v.id"
            class="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-gray-800"
            @mousedown.prevent="selectVehicle(v)"
          >
            {{ v.vehicle_name }}
          </button>
          <div v-if="filteredVehicles.length === 0" class="px-3 py-2 text-xs text-gray-400">該当なし</div>
        </div>
      </div>
    </div>

    <!-- Table -->
    <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th v-for="col in columns" :key="col.key" class="text-left px-4 py-3 font-medium text-gray-500">
              {{ col.label }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td :colspan="columns.length" class="px-4 py-8 text-center text-gray-400">
              <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
              読み込み中...
            </td>
          </tr>
          <tr v-else-if="operations.length === 0">
            <td :colspan="columns.length" class="px-4 py-8 text-center text-gray-400">
              データがありません
            </td>
          </tr>
          <tr
            v-for="op in operations"
            v-else
            :key="op.id"
            class="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
            @click="onRowClick(op)"
          >
            <td class="px-4 py-3">{{ op.operation_date || '-' }}</td>
            <td class="px-4 py-3">{{ op.reading_date }}</td>
            <td class="px-4 py-3 font-mono">{{ op.unko_no }}</td>
            <td class="px-4 py-3">{{ op.driver_name || '-' }}</td>
            <td class="px-4 py-3">{{ op.vehicle_name || '-' }}</td>
            <td class="px-4 py-3">{{ formatDistance(op.total_distance) }}</td>
            <td class="px-4 py-3 text-center">
              <span v-if="op.has_kudgivt" class="text-green-600">✓</span>
              <span v-else class="text-red-400">✗</span>
            </td>
            <td class="px-4 py-3" :class="scoreColor(op.safety_score)">{{ formatScore(op.safety_score) }}</td>
            <td class="px-4 py-3" :class="scoreColor(op.economy_score)">{{ formatScore(op.economy_score) }}</td>
            <td class="px-4 py-3" :class="scoreColor(op.total_score)">{{ formatScore(op.total_score) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="flex items-center justify-between">
      <span class="text-sm text-gray-500">{{ total }} 件中 {{ (page - 1) * perPage + 1 }}〜{{ Math.min(page * perPage, total) }} 件</span>
      <div class="flex gap-1">
        <UButton :disabled="page <= 1" variant="outline" size="sm" icon="i-lucide-chevron-left" @click="page--" />
        <UButton :disabled="page >= totalPages" variant="outline" size="sm" icon="i-lucide-chevron-right" @click="page++" />
      </div>
    </div>
  </div>
</template>
