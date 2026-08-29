<script setup lang="ts">
import { getDailyHours, getDrivers, getWorkTimes } from '~/utils/api'
import type { DailyWorkHours, Driver, WorkTimeItem } from '~/types'
import { describeApiError, describeCaughtError } from '~/utils/api-error'

// Tab
const activeTab = ref('segments')

// Filters
const selectedDriverId = ref('')
const now = new Date()
const selectedMonth = ref(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
const page = ref(1)
const perPage = 50

// Data
const items = ref<DailyWorkHours[]>([])
const total = ref(0)
const drivers = ref<Driver[]>([])
// 乗務員一覧が**取得できなかった**理由 (Refs #920)。**空配列だけでは「0 人」と
// 区別が付かない**ので、「読めなかった」ことを状態として持つ。
const driversError = ref<string | null>(null)
// 表そのものが**取得できなかった**理由 (Refs #1008)。`driversError` と同じ理由で
// **別に持つ** — 落ちたときの表は `items.length === 0` の枝に入って
// **「データがありません」**と出るので、**空配列だけでは「本当に 0 件」と
// 区別が付かない**。乗務員一覧とは落ちる口が違うので 1 本にまとめない。
const fetchError = ref<string | null>(null)
const workTimeItems = ref<WorkTimeItem[]>([])
const wtTotal = ref(0)
const loading = ref(false)

function buildFilter() {
  let date_from: string | undefined
  let date_to: string | undefined
  if (selectedMonth.value) {
    const [y = 0, m = 0] = selectedMonth.value.split('-').map(Number)
    date_from = `${y}-${String(m).padStart(2, '0')}-01`
    const lastDay = new Date(y, m, 0).getDate()
    date_to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  }
  return {
    driver_id: selectedDriverId.value || undefined,
    date_from,
    date_to,
    page: page.value,
    per_page: perPage,
  }
}

async function fetchData() {
  loading.value = true
  // **取り直しごとに消す** — 絞り込みやページ送りで走り直して成功した回に、
  // 前回の失敗が残っていると「いま落ちている」と読める。
  fetchError.value = null
  try {
    const filter = buildFilter()
    const [hoursRes, wtRes] = await Promise.all([
      getDailyHours(filter),
      getWorkTimes(filter),
    ])
    items.value = hoursRes.items
    total.value = hoursRes.total
    workTimeItems.value = wtRes.items
    wtTotal.value = wtRes.total
  } catch (e) {
    console.error('Failed to fetch daily hours:', e)
    // ★ **console だけだと画面には何も出ない** (Refs #1008)。`loading` が終わって
    //   表が「データがありません」になるだけなので、**「取得に失敗した」と
    //   「本当に 0 件」が人には区別できない**。理由と次の一手を状態に持つ。
    fetchError.value = describeListFailure(e)
  } finally {
    loading.value = false
  }
}

/** 一覧を取り直す口が `onMounted` にしかない画面の「やり直し方」 (Refs #1008)。 */
const RETRY_RELOAD = 'ページを再読み込みしてください'

/**
 * 一覧の取得失敗を 1 行にする (Refs #920 / #1008)。
 *
 * ## `describeCaughtError` に通す — 足しているのは**「次に何をすればいいか」**
 *
 * この経路 (`app/utils/api.ts` の `request()` → `@ippoan/auth-client` の
 * `createAuthFetch`) の例外は **ofetch の `FetchError` ではなく素の `Error`** なので、
 * **理由の文字列は `describeApiError` を当てても 1 文字も変わらない**
 * (`app/pages/restraint-report.vue` の同名関数の doc が正)。**変わるのは末尾**で、
 * `describeCaughtError` が `` `(3 桁): ` `` の形から status を読んで
 * 「再ログイン」「管理者に依頼」「復旧を待つ」を撃ち分ける。
 *
 * ## `retry` にボタンを渡していない理由
 *
 * **この画面に、取り直しを起こせるボタンが 1 つも無い。** 乗務員一覧の口は
 * `onMounted` の 1 回だけ。一覧 (`fetchData`) は絞り込みの `watch` とページ送りでも
 * 走るが、**絞り込みはボタンではなく**、ページ送りは `totalPages > 1` のときしか
 * 描かれない — **失敗した回は `total` が 0 のままなので出ていない**。
 * **無いボタンを案内しない** (`tests/components/next-step-retry-labels.test.ts` の
 * 規約) ので、ボタンを名指ししない `RETRY_RELOAD` を渡す。
 *
 * ## ★ 次の一手は**どの経路でもちょうど 1 つ**。0 にも 2 つにもしない (#1008 PR-3)
 *
 * | 入ってくる例外 | `describeCaughtError` | ここで足すもの |
 * | --- | --- | --- |
 * | `API エラー (503): …` | 「復旧してから」+ `RETRY_RELOAD` | なし |
 * | `API エラー (403): …` | 「管理者に許可の追加を依頼してください」 | なし |
 * | status を読めない `Error` | **次の一手なし** (3 番目の枝) | `RETRY_RELOAD` |
 * | `Error` ですらない | — | `RETRY_RELOAD` |
 *
 * **0 にしない**のは #1008 そのものだから。**2 つにしない**のは、`UAlert` の
 * `description` 側にも固定の指示を置いていた初稿が、403 で
 * 「ログインし直しても変わりません」と「ページを再読み込みして確かめてください」を
 * **並べて食い違わせていた**から (dev で実測。PR-2 が `margin` / `allowance` で
 * 見つけたのと同型で、**合成後を描画するまで出ない**)。
 * ⇒ **次の一手を持つのは `title` の側だけ。`description` は事実だけを書く。**
 */
function describeListFailure(e: unknown): string {
  if (!(e instanceof Error)) return `理由を読めませんでした — ${RETRY_RELOAD}`
  const detail = describeCaughtError(e, RETRY_RELOAD)
  // ★ **`describeCaughtError` は status が読めなかった回に次の一手を付けない** —
  //   status ごとに違うので「1 つ選ぶと嘘になる」から (`api-error.ts` の 3 番目の枝)。
  //   注記側の固定文を落とした (#1008 PR-3) 以上、**ここが最後の砦**なので、
  //   付かなかった回だけ status に依らない `RETRY_RELOAD` を補う。
  //   **判定は「3 番目の枝が返す値そのもの」との一致**で行う — 文言を grep すると
  //   `nextStepForStatus` を書き換えた日に空撃ちになる。
  return detail === describeApiError(e) ? `${detail} — ${RETRY_RELOAD}` : detail
}

onMounted(async () => {
  try {
    drivers.value = await getDrivers()
  }
  catch (e) {
    // 一覧は空に戻すが、**空にした理由を必ず持つ** — 空配列だけだと選択肢が出ないのを
    // 「乗務員が 0 人」と読まれ、読めなかっただけの回と区別が付かない (Refs #920)。
    drivers.value = []
    driversError.value = describeListFailure(e)
  }
  await fetchData()
})

watch([selectedDriverId, selectedMonth], () => {
  page.value = 1
  fetchData()
})

watch(page, fetchData)

function formatMinutes(val: number | null): string {
  if (val == null) return '-'
  const h = Math.floor(val / 60)
  const m = val % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

const currentTotal = computed(() => activeTab.value === 'segments' ? wtTotal.value : total.value)
const totalPages = computed(() => Math.ceil(currentTotal.value / perPage))

// ドライバー名を引くためのマップ
const driverMap = computed(() => {
  const map = new Map<string, string>()
  for (const d of drivers.value) {
    map.set(d.id, d.driver_name)
  }
  return map
})

function formatTime(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tokyo' })
}

function isNextDay(isoString: string, workDate: string): boolean {
  const d = new Date(isoString)
  const jstDate = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
  return jstDate !== workDate
}

function onTabChange() {
  page.value = 1
  fetchData()
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-xl font-bold">日別労働時間</h2>

    <!-- ★ 「読めなかった」と「0 人」を別の文にする (Refs #920)。失敗した回にだけ出す
         (理由だけ出すと**本当に 0 人の回**まで異常に見える)。
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

    <!-- ★ 表の取得失敗を出す (Refs #1008)。直す前は `console.error` だけで、画面には
         **表の「データがありません」しか出ていなかった** — 「取れなかった」と
         「本当に 0 件」が区別できない。**失敗した回にだけ出す**のは上と同じ理由。

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
      :title="`日別労働時間を取得できませんでした (${fetchError})`"
      description="下の表の「データがありません」は 0 件を意味しません"
      color="error"
      icon="i-lucide-circle-x"
      variant="subtle"
    />

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="text-xs text-gray-500 block mb-1">ドライバー</label>
        <DriverSearchSelect v-model="selectedDriverId" :drivers="drivers" />
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">月</label>
        <input v-model="selectedMonth" type="month" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 border-b border-gray-200 dark:border-gray-700">
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'segments' ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-700'"
        @click="activeTab = 'segments'; onTabChange()"
      >
        始業・終業
      </button>
      <button
        class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
        :class="activeTab === 'daily' ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-700'"
        @click="activeTab = 'daily'; onTabChange()"
      >
        日別集計
      </button>
    </div>

    <!-- 始業・終業 Table -->
    <div v-if="activeTab === 'segments'" class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th class="text-left px-4 py-3 font-medium text-gray-500">日付</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">ドライバー</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">運行番号</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">始業</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">終業</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">拘束時間</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">労働時間</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">
              <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
              読み込み中...
            </td>
          </tr>
          <tr v-else-if="workTimeItems.length === 0">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">
              データがありません
            </td>
          </tr>
          <tr
            v-for="wt in workTimeItems"
            v-else
            :key="wt.id"
            class="border-t border-gray-100 dark:border-gray-800"
          >
            <td class="px-4 py-3">{{ wt.work_date }}</td>
            <td class="px-4 py-3">{{ driverMap.get(wt.driver_id) || '-' }}</td>
            <td class="px-4 py-3">{{ wt.unko_no }}</td>
            <td class="px-4 py-3">{{ formatTime(wt.start_at) }}</td>
            <td class="px-4 py-3">
              <span v-if="isNextDay(wt.end_at, wt.work_date)" class="text-orange-500 text-xs mr-0.5">翌</span>{{ formatTime(wt.end_at) }}
            </td>
            <td class="px-4 py-3">{{ formatMinutes(wt.work_minutes) }}</td>
            <td class="px-4 py-3">{{ formatMinutes(wt.labor_minutes) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 日別集計 Table -->
    <div v-if="activeTab === 'daily'" class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th class="text-left px-4 py-3 font-medium text-gray-500">日付</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">ドライバー</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">拘束時間</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">運転時間</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">休憩時間</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">走行距離</th>
            <th class="text-left px-4 py-3 font-medium text-gray-500">運行数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="loading">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">
              <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
              読み込み中...
            </td>
          </tr>
          <tr v-else-if="items.length === 0">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">
              データがありません
            </td>
          </tr>
          <tr
            v-for="item in items"
            v-else
            :key="item.id"
            class="border-t border-gray-100 dark:border-gray-800"
          >
            <td class="px-4 py-3">{{ item.work_date }}</td>
            <td class="px-4 py-3">{{ driverMap.get(item.driver_id) || '-' }}</td>
            <td class="px-4 py-3">{{ formatMinutes(item.total_work_minutes) }}</td>
            <td class="px-4 py-3">{{ formatMinutes(item.total_drive_minutes) }}</td>
            <td class="px-4 py-3">{{ formatMinutes(item.total_rest_minutes) }}</td>
            <td class="px-4 py-3">{{ item.total_distance?.toFixed(1) ?? '-' }} km</td>
            <td class="px-4 py-3">{{ item.operation_count }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="flex items-center justify-between">
      <span class="text-sm text-gray-500">{{ currentTotal }} 件中 {{ (page - 1) * perPage + 1 }}〜{{ Math.min(page * perPage, currentTotal) }} 件</span>
      <div class="flex gap-1">
        <UButton :disabled="page <= 1" variant="outline" size="sm" icon="i-lucide-chevron-left" @click="page--" />
        <UButton :disabled="page >= totalPages" variant="outline" size="sm" icon="i-lucide-chevron-right" @click="page++" />
      </div>
    </div>
  </div>
</template>
