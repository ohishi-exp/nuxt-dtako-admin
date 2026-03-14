<script setup lang="ts">
import { getCalendar, triggerScrapeStream } from '~/utils/api'
import type { ScrapeResult } from '~/types'
import type { ScrapeProgressEvent } from '~/utils/api'

const compIdOptions = [
  { label: '全企業', value: '' },
  { label: '27324455 (大石運輸倉庫)', value: '27324455' },
  { label: '75700192 (北海大運)', value: '75700192' },
]

const selectedCompId = ref('')
const skipUpload = ref(false)

// Calendar state
const now = new Date()
const calYear = ref(now.getFullYear())
const calMonth = ref(now.getMonth() + 1)
const calLoading = ref(false)
const fetchedDates = ref<Map<string, number>>(new Map())
const selectedDates = ref<Set<string>>(new Set())

const weekDays = ['日', '月', '火', '水', '木', '金', '土']

interface CalendarCell {
  date: string // YYYY-MM-DD
  day: number
  inMonth: boolean
  count: number // 0 = no data
}

const calendarCells = computed<CalendarCell[]>(() => {
  const y = calYear.value
  const m = calMonth.value
  const firstDay = new Date(y, m - 1, 1)
  const startDow = firstDay.getDay() // 0=Sun
  const daysInMonth = new Date(y, m, 0).getDate()

  const cells: CalendarCell[] = []

  // Padding before
  for (let i = 0; i < startDow; i++) {
    const d = new Date(y, m - 1, -startDow + i + 1)
    cells.push({
      date: fmt(d),
      day: d.getDate(),
      inMonth: false,
      count: 0,
    })
  }

  // Days in month
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(y, m - 1, day)
    const dateStr = fmt(d)
    cells.push({
      date: dateStr,
      day,
      inMonth: true,
      count: fetchedDates.value.get(dateStr) || 0,
    })
  }

  // Padding after (fill to complete week)
  while (cells.length % 7 !== 0) {
    const d = new Date(y, m - 1, daysInMonth + (cells.length - startDow - daysInMonth + 1))
    cells.push({
      date: fmt(d),
      day: d.getDate(),
      inMonth: false,
      count: 0,
    })
  }

  return cells
})

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const calLabel = computed(() => `${calYear.value}年${calMonth.value}月`)

function prevMonth() {
  if (calMonth.value === 1) {
    calYear.value--
    calMonth.value = 12
  }
  else {
    calMonth.value--
  }
  loadCalendar()
}

function nextMonth() {
  if (calMonth.value === 12) {
    calYear.value++
    calMonth.value = 1
  }
  else {
    calMonth.value++
  }
  loadCalendar()
}

async function loadCalendar() {
  calLoading.value = true
  selectedDates.value.clear()
  try {
    const res = await getCalendar(calYear.value, calMonth.value)
    const map = new Map<string, number>()
    for (const d of res.dates) {
      map.set(d.date, d.count)
    }
    fetchedDates.value = map
  }
  catch {
    fetchedDates.value = new Map()
  }
  finally {
    calLoading.value = false
  }
}

function toggleDate(cell: CalendarCell) {
  if (!cell.inMonth) return
  const s = selectedDates.value
  if (s.has(cell.date)) {
    s.delete(cell.date)
  }
  else {
    s.add(cell.date)
  }
  // trigger reactivity
  selectedDates.value = new Set(s)
}

function selectAllMissing() {
  const y = calYear.value
  const m = calMonth.value
  const daysInMonth = new Date(y, m, 0).getDate()
  const s = new Set<string>()
  for (let day = 1; day <= daysInMonth; day++) {
    const d = fmt(new Date(y, m - 1, day))
    if (!fetchedDates.value.has(d)) {
      s.add(d)
    }
  }
  selectedDates.value = s
}

function clearSelection() {
  selectedDates.value = new Set()
}

// Scraping (useState でページ遷移しても保持)
const isRunning = useState('scraper-running', () => false)

const stepLabels: Record<string, string> = {
  login: 'ログイン中...',
  download: 'ダウンロード中...',
  upload: 'アップロード中...',
}

interface DayTask {
  date: string
  status: 'pending' | 'running' | 'success' | 'error'
  step?: string
  results: ScrapeResult[]
  error?: string
}

const tasks = useState<DayTask[]>('scraper-tasks', () => [])

async function handleScrape() {
  const dates = [...selectedDates.value].sort()
  if (dates.length === 0) return

  tasks.value = dates.map(date => ({
    date,
    status: 'pending',
    results: [],
  }))
  isRunning.value = true

  for (const task of tasks.value) {
    task.status = 'running'
    task.step = undefined
    try {
      await triggerScrapeStream(
        {
          comp_id: selectedCompId.value || undefined,
          start_date: task.date,
          end_date: task.date,
          skip_upload: skipUpload.value,
        },
        (evt: ScrapeProgressEvent) => {
          if (evt.event === 'progress') {
            task.step = evt.step
          }
          else if (evt.event === 'result') {
            task.results.push({
              comp_id: evt.comp_id || '',
              status: evt.status || 'error',
              message: evt.message || '',
            })
          }
          else if (evt.event === 'done') {
            task.status = task.results.some(r => r.status === 'error') ? 'error' : 'success'
            task.step = undefined
          }
        },
      )
      // ストリーム終了後、まだ pending なら完了にする
      if (task.status === 'running') {
        task.status = task.results.some(r => r.status === 'error') ? 'error' : 'success'
      }
    }
    catch (e) {
      task.error = e instanceof Error ? e.message : 'エラー'
      task.status = 'error'
    }
  }

  isRunning.value = false
  // Reload calendar to reflect new data
  await loadCalendar()
}

const completedCount = computed(() => tasks.value.filter(t => t.status === 'success' || t.status === 'error').length)
const successCount = computed(() => tasks.value.filter(t => t.status === 'success').length)
const errorCount = computed(() => tasks.value.filter(t => t.status === 'error').length)

onMounted(loadCalendar)
</script>

<template>
  <div class="max-w-3xl">
    <h1 class="text-2xl font-bold mb-6">
      デジタコ スクレイプ
    </h1>

    <!-- Settings -->
    <UCard class="mb-4">
      <div class="flex flex-wrap gap-4 items-end">
        <div>
          <label class="block text-sm font-medium mb-1">企業</label>
          <USelect v-model="selectedCompId" :items="compIdOptions" />
        </div>
        <label class="flex items-center gap-2">
          <input v-model="skipUpload" type="checkbox" class="rounded">
          <span class="text-sm">アップロードをスキップ</span>
        </label>
      </div>
    </UCard>

    <!-- Calendar -->
    <UCard>
      <!-- Header -->
      <div class="flex items-center justify-between mb-4">
        <UButton icon="i-lucide-chevron-left" variant="ghost" size="sm" @click="prevMonth" />
        <span class="text-lg font-bold">{{ calLabel }}</span>
        <UButton icon="i-lucide-chevron-right" variant="ghost" size="sm" @click="nextMonth" />
      </div>

      <p class="text-xs text-gray-500 mb-2">読み取り日ベース</p>

      <!-- Legend -->
      <div class="flex gap-4 mb-3 text-xs text-gray-500">
        <span class="flex items-center gap-1">
          <span class="w-3 h-3 rounded bg-green-200 dark:bg-green-800 inline-block" /> 取得済み
        </span>
        <span class="flex items-center gap-1">
          <span class="w-3 h-3 rounded bg-gray-100 dark:bg-gray-800 inline-block" /> 未取得
        </span>
        <span class="flex items-center gap-1">
          <span class="w-3 h-3 rounded ring-2 ring-blue-500 inline-block" /> 選択中
        </span>
      </div>

      <!-- Week day headers -->
      <div class="grid grid-cols-7 text-center text-xs font-medium text-gray-500 mb-1">
        <div v-for="w in weekDays" :key="w" :class="w === '日' ? 'text-red-400' : w === '土' ? 'text-blue-400' : ''">
          {{ w }}
        </div>
      </div>

      <!-- Calendar grid -->
      <div v-if="calLoading" class="py-12 text-center text-gray-400">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
        読み込み中...
      </div>
      <div v-else class="grid grid-cols-7 gap-1">
        <button
          v-for="cell in calendarCells"
          :key="cell.date"
          :disabled="!cell.inMonth"
          class="aspect-square rounded-lg text-sm flex flex-col items-center justify-center transition-all relative"
          :class="[
            !cell.inMonth ? 'text-gray-300 dark:text-gray-700 cursor-default' : 'cursor-pointer hover:ring-2 hover:ring-blue-300',
            cell.inMonth && cell.count > 0 ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300' : '',
            cell.inMonth && cell.count === 0 ? 'bg-gray-50 dark:bg-gray-800/50' : '',
            selectedDates.has(cell.date) ? 'ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-gray-900' : '',
          ]"
          @click="toggleDate(cell)"
        >
          <span class="font-medium">{{ cell.day }}</span>
          <span v-if="cell.inMonth && cell.count > 0" class="text-[10px] leading-none text-green-600 dark:text-green-400">
            {{ cell.count }}件
          </span>
        </button>
      </div>

      <!-- Actions -->
      <div class="flex flex-wrap gap-2 mt-4">
        <UButton
          label="未取得を全選択"
          icon="i-lucide-check-square"
          variant="outline"
          size="sm"
          @click="selectAllMissing"
        />
        <UButton
          label="選択解除"
          icon="i-lucide-x"
          variant="outline"
          size="sm"
          :disabled="selectedDates.size === 0"
          @click="clearSelection"
        />
        <div class="flex-1" />
        <UButton
          :label="`選択した ${selectedDates.size} 日をスクレイプ`"
          icon="i-lucide-play"
          :loading="isRunning"
          :disabled="isRunning || selectedDates.size === 0"
          @click="handleScrape"
        />
      </div>
    </UCard>

    <!-- Task progress -->
    <div v-if="tasks.length" class="mt-4 space-y-3">
      <div class="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
        <span>{{ completedCount }} / {{ tasks.length }} 完了</span>
        <span v-if="successCount" class="text-green-600">{{ successCount }} 成功</span>
        <span v-if="errorCount" class="text-red-600">{{ errorCount }} エラー</span>
      </div>

      <div class="space-y-2">
        <div
          v-for="task in tasks"
          :key="task.date"
          class="border rounded-lg p-3 text-sm"
          :class="{
            'border-gray-200 dark:border-gray-800': task.status === 'pending',
            'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950': task.status === 'running',
            'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950': task.status === 'success',
            'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950': task.status === 'error',
          }"
        >
          <div class="flex items-center gap-2">
            <UIcon
              v-if="task.status === 'pending'"
              name="i-lucide-circle"
              class="size-4 text-gray-400"
            />
            <UIcon
              v-else-if="task.status === 'running'"
              name="i-lucide-loader-circle"
              class="size-4 text-blue-500 animate-spin"
            />
            <UIcon
              v-else-if="task.status === 'success'"
              name="i-lucide-check-circle"
              class="size-4 text-green-500"
            />
            <UIcon
              v-else
              name="i-lucide-alert-circle"
              class="size-4 text-red-500"
            />
            <span class="font-medium">{{ task.date }}</span>
            <span v-if="task.status === 'running'" class="text-blue-600 dark:text-blue-400">
              {{ task.step ? stepLabels[task.step] || task.step : '実行中...' }}
            </span>
          </div>

          <div v-if="task.results.length" class="mt-2 pl-6 space-y-1">
            <div
              v-for="r in task.results"
              :key="r.comp_id"
              class="text-xs"
              :class="r.status === 'success' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'"
            >
              [{{ r.comp_id }}] {{ r.message }}
            </div>
          </div>
          <div v-if="task.error" class="mt-1 pl-6 text-xs text-red-600">
            {{ task.error }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
