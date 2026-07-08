<script setup lang="ts">
/**
 * 日報編集 (Refs #169)。
 *
 * 管理者 (auth-worker ログイン必須) が theearth-np.com のアカウントでログインして、
 * 運行データ入力一覧 (F-DES1010) を期間指定で一覧表示し、運行を選んで経費
 * (F-DES1012、給油行) を編集 → 評価点再集計 → 編集後の csvdata.zip をダウンロードするページ。
 *
 * credential pass-through 設計は /dvr-viewer と同じ (DvrSessionHeader.vue 参照)。
 * theearth ログインセッションは DVR viewer とは共有しない (useDailyReportSession /
 * workers/dtako-scraper-relay/src/report-session.ts で別セッション)。
 *
 * 作業 (Refs #170) / 乗務員 (Refs #171) 編集は本ページの共通基盤 (一覧・zip DL・
 * 編集制御解除) を前提にした差分機能として後続 issue で追加する想定。
 */
interface DailyReportRow {
  operationNo: string
  startDateTime: string
  exclusionFlag: boolean
  operationDate: string | null
  branchCd: string | null
  branchName: string | null
  vehicleCd: string | null
  vehicleName: string | null
  driverCd1: string | null
  driverName1: string | null
  workStartDateTime: string | null
  workEndDateTime: string
  operationStartDateTime: string | null
  operationEndDateTime: string | null
  totalRunningDist: string | null
  salesFlag: string | null
  expenseFlag: string | null
}

interface FuelRow {
  ctrlIndex: number
  operationNo: string
  subNo: string
  supplyCategory: string
  supplyStation: string
  supplyType: string
  dateTime: string
  quantity: string
}

const { session, authHeaders, restoreSession, showLoginPanel, expireSession } = useDailyReportSession()

function onLogin() {
  loadList()
}

watch(session, (s) => {
  if (!s) {
    rows.value = []
    sortOk.value = null
    closeExpenseModal()
  }
})

// --- 期間フィルタ + 一覧 (F-NRS1010) ---

/** datetime-local (YYYY-MM-DDTHH:mm) の既定値。既定は直近7日間。 */
function defaultDateTimeLocal(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const periodForm = reactive({
  from: defaultDateTimeLocal(7),
  to: defaultDateTimeLocal(0),
})

const rows = ref<DailyReportRow[]>([])
const sortOk = ref<boolean | null>(null)
const listLoading = ref(false)
const listError = ref<string | null>(null)

/** datetime-local (YYYY-MM-DDTHH:mm) → theearth 形式 (YYYY/MM/DD HH:mm、
 * harvestDailyReport の HarvestRange)。dvr-viewer.vue の変換パターンと同じ。 */
function toReportDateTime(value: string): string {
  return value.replaceAll('-', '/').replace('T', ' ')
}

async function loadList() {
  const s = session.value
  if (!s) return
  listLoading.value = true
  listError.value = null
  try {
    const res = await $fetch<{ rows: DailyReportRow[], sortOk: boolean }>('/daily-report-api/list', {
      headers: authHeaders(),
      query: { from: toReportDateTime(periodForm.from), to: toReportDateTime(periodForm.to) },
    })
    rows.value = res.rows
    sortOk.value = res.sortOk
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      return
    }
    listError.value = dailyReportErrorMessage(e)
  }
  finally {
    listLoading.value = false
  }
}

// --- 編集後 csvdata.zip ダウンロード (F-NOS3010) ---

const zipLoading = ref(false)
const zipError = ref<string | null>(null)

async function downloadZip() {
  const s = session.value
  if (!s) return
  zipLoading.value = true
  zipError.value = null
  try {
    const params = new URLSearchParams({
      from: periodForm.from.slice(0, 10),
      to: periodForm.to.slice(0, 10),
    })
    const res = await fetch(`/daily-report-api/zip?${params.toString()}`, { headers: authHeaders() })
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string } | null
      const message = data?.error ?? `csvdata.zip の取得に失敗しました (HTTP ${res.status})`
      if (res.status === 401) {
        expireSession(message)
        return
      }
      throw new Error(message)
    }
    await downloadBlobResponse(res, `csvdata-${s.compId}.zip`)
  }
  catch (e) {
    zipError.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    zipLoading.value = false
  }
}

// --- 編集制御解除 (F-DES1010 btnInitialize) ---

const unlockLoading = ref(false)
const unlockError = ref<string | null>(null)
const unlockMessage = ref<string | null>(null)

async function unlockAll() {
  const s = session.value
  if (!s) return
  unlockLoading.value = true
  unlockError.value = null
  unlockMessage.value = null
  try {
    await $fetch('/daily-report-api/unlock-all', { method: 'POST', headers: authHeaders() })
    unlockMessage.value = '編集制御を解除しました'
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      return
    }
    unlockError.value = dailyReportErrorMessage(e)
  }
  finally {
    unlockLoading.value = false
  }
}

// --- 経費入力 (F-DES1012 給油行) 編集モーダル ---

const expenseModalOpen = ref(false)
const selectedRow = ref<DailyReportRow | null>(null)
const fuelRows = ref<FuelRow[]>([])
const expenseLoading = ref(false)
const expenseError = ref<string | null>(null)
const savingCtrlIndex = ref<number | null>(null)
const recalculating = ref(false)
const recalculateResult = ref<string | null>(null)

const fuelEditForm = reactive<Record<number, { supplyCategory: string, supplyStation: string, supplyType: string, dateTime: string, quantity: string }>>({})

function syncFuelEditForm() {
  for (const key of Object.keys(fuelEditForm)) delete fuelEditForm[Number(key)]
  for (const row of fuelRows.value) {
    fuelEditForm[row.ctrlIndex] = {
      supplyCategory: row.supplyCategory,
      supplyStation: row.supplyStation,
      supplyType: row.supplyType,
      dateTime: row.dateTime,
      quantity: row.quantity,
    }
  }
}

async function openExpenseModal(row: DailyReportRow) {
  const s = session.value
  if (!s) return
  selectedRow.value = row
  expenseModalOpen.value = true
  fuelRows.value = []
  expenseError.value = null
  recalculateResult.value = null
  expenseLoading.value = true
  try {
    const res = await $fetch<{ opeNo: string, startOpe: string, fuelRows: FuelRow[] }>('/daily-report-api/expense', {
      headers: authHeaders(),
      query: { opeNo: row.operationNo, startOpe: row.startDateTime },
    })
    fuelRows.value = res.fuelRows
    syncFuelEditForm()
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      expenseModalOpen.value = false
      return
    }
    expenseError.value = dailyReportErrorMessage(e)
  }
  finally {
    expenseLoading.value = false
  }
}

function closeExpenseModal() {
  expenseModalOpen.value = false
  selectedRow.value = null
  fuelRows.value = []
  expenseError.value = null
  recalculateResult.value = null
}

async function saveFuelRow(ctrlIndex: number) {
  const s = session.value
  const target = selectedRow.value
  const edited = fuelEditForm[ctrlIndex]
  if (!s || !target || !edited) return
  savingCtrlIndex.value = ctrlIndex
  expenseError.value = null
  try {
    const res = await $fetch<{ fuelRows: FuelRow[] }>('/daily-report-api/expense/save', {
      method: 'POST',
      headers: authHeaders(),
      body: {
        opeNo: target.operationNo,
        startOpe: target.startDateTime,
        ctrlIndex,
        ...edited,
      },
    })
    fuelRows.value = res.fuelRows
    syncFuelEditForm()
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      expenseModalOpen.value = false
      return
    }
    expenseError.value = dailyReportErrorMessage(e)
  }
  finally {
    savingCtrlIndex.value = null
  }
}

async function recalculateExpense() {
  const s = session.value
  const target = selectedRow.value
  if (!s || !target) return
  recalculating.value = true
  expenseError.value = null
  recalculateResult.value = null
  try {
    const res = await $fetch<{ linkSysEnabled: boolean }>('/daily-report-api/expense/recalculate', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo: target.operationNo, startOpe: target.startDateTime },
    })
    recalculateResult.value = res.linkSysEnabled
      ? '評価点再集計が完了しました (システム連動開始が有効になりました)'
      : '評価点再集計が完了しました'
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      expenseModalOpen.value = false
      return
    }
    expenseError.value = dailyReportErrorMessage(e)
  }
  finally {
    recalculating.value = false
  }
}

onMounted(() => {
  restoreSession()
  if (session.value) loadList()
  else showLoginPanel.value = true
})
</script>

<template>
  <div>
    <DailyReportSessionHeader title="日報編集" @login="onLogin" />

    <div v-if="!session" class="max-w-7xl mx-auto px-6 py-12 text-center text-gray-400">
      右上の「ログイン」から theearth (web地球号) にログインしてください。
    </div>

    <template v-else>
      <div class="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <!-- 期間フィルタ -->
        <UCard>
          <div class="flex flex-wrap items-end gap-3">
            <UFormField label="読取日 (退社日時) 下限">
              <UInput v-model="periodForm.from" type="datetime-local" class="w-56" />
            </UFormField>
            <UFormField label="読取日 (退社日時) 上限">
              <UInput v-model="periodForm.to" type="datetime-local" class="w-56" />
            </UFormField>
            <UButton icon="i-lucide-search" label="日報を検索" :loading="listLoading" @click="loadList" />
            <UButton icon="i-lucide-file-archive" label="編集後 csvdata.zip をダウンロード" variant="outline" :loading="zipLoading" @click="downloadZip" />
            <UButton icon="i-lucide-lock-open" label="編集制御解除" variant="outline" color="warning" :loading="unlockLoading" @click="unlockAll" />
          </div>

          <div v-if="sortOk === false" class="mt-3 text-sm text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 rounded-lg p-3">
            表示条件指定 (F-GOS0030) の並び順が「読取日 降順」になっていません。早期打ち切りを無効化して
            全ページ走査しましたが、theearth 側の表示条件指定を「読取日 降順」に直すことを推奨します。
          </div>
          <div v-if="listError" class="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
            {{ listError }}
          </div>
          <div v-if="zipError" class="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
            {{ zipError }}
          </div>
          <div v-if="unlockError" class="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
            {{ unlockError }}
          </div>
          <div v-if="unlockMessage" class="mt-3 text-sm text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300 rounded-lg p-3">
            {{ unlockMessage }}
          </div>
        </UCard>

        <!-- 運転日報一覧 -->
        <UCard>
          <template #header>
            <span class="font-semibold">運行データ入力一覧 ({{ rows.length }} 件)</span>
          </template>
          <div v-if="listLoading" class="text-center py-8 text-gray-400">
            読み込み中…
          </div>
          <div v-else-if="rows.length === 0" class="text-center py-8 text-gray-400">
            該当する運行がありません
          </div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                  <th class="py-2 pr-4">運行日</th>
                  <th class="py-2 pr-4">事業所CD</th>
                  <th class="py-2 pr-4">事業所名</th>
                  <th class="py-2 pr-4">車輌CD</th>
                  <th class="py-2 pr-4">車輌名</th>
                  <th class="py-2 pr-4">乗務員CD1</th>
                  <th class="py-2 pr-4">乗務員名1</th>
                  <th class="py-2 pr-4">出社日時</th>
                  <th class="py-2 pr-4">退社日時</th>
                  <th class="py-2 pr-4">出庫日時</th>
                  <th class="py-2 pr-4">帰庫日時</th>
                  <th class="py-2 pr-4">総走行距離</th>
                  <th class="py-2 pr-4">売上</th>
                  <th class="py-2 pr-4">経費</th>
                  <th class="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in rows"
                  :key="row.operationNo"
                  class="border-b border-gray-100 dark:border-gray-900"
                  :class="{ 'text-red-600 dark:text-red-400': row.exclusionFlag }"
                >
                  <td class="py-2 pr-4">
                    {{ row.operationDate ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.branchCd ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.branchName ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.vehicleCd ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.vehicleName ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.driverCd1 ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.driverName1 ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.workStartDateTime ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.workEndDateTime }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.operationStartDateTime ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.operationEndDateTime ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.totalRunningDist ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.salesFlag ?? '-' }}
                  </td>
                  <td class="py-2 pr-4">
                    {{ row.expenseFlag ?? '-' }}
                  </td>
                  <td class="py-2 pr-4 text-right">
                    <UButton size="xs" variant="outline" icon="i-lucide-fuel" label="経費 (給油) を編集" @click="openExpenseModal(row)" />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </UCard>
      </div>

      <!-- F-DES1012 給油行編集モーダル -->
      <UModal v-model:open="expenseModalOpen">
        <template #content>
          <div class="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <h3 class="text-lg font-bold">
              経費入力 (給油) — {{ selectedRow?.operationNo }}
            </h3>

            <div v-if="expenseLoading" class="text-center py-8 text-gray-400">
              読み込み中…
            </div>
            <div v-else-if="fuelRows.length === 0" class="text-center py-8 text-gray-400">
              給油データがありません
            </div>
            <div v-else class="space-y-4">
              <div
                v-for="row in fuelRows"
                :key="row.ctrlIndex"
                class="border border-gray-200 dark:border-gray-800 rounded-lg p-3 space-y-2"
              >
                <div class="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  <UFormField label="分類 (CD)">
                    <UInput v-model="fuelEditForm[row.ctrlIndex]!.supplyCategory" class="w-full" />
                  </UFormField>
                  <UFormField label="区分 (CD)">
                    <UInput v-model="fuelEditForm[row.ctrlIndex]!.supplyStation" class="w-full" />
                  </UFormField>
                  <UFormField label="種別 (CD)">
                    <UInput v-model="fuelEditForm[row.ctrlIndex]!.supplyType" class="w-full" />
                  </UFormField>
                  <UFormField label="日時">
                    <UInput v-model="fuelEditForm[row.ctrlIndex]!.dateTime" class="w-full" />
                  </UFormField>
                  <UFormField label="数量">
                    <UInput v-model="fuelEditForm[row.ctrlIndex]!.quantity" class="w-full" />
                  </UFormField>
                </div>
                <div class="flex justify-end">
                  <UButton
                    size="xs"
                    label="この行を保存"
                    :loading="savingCtrlIndex === row.ctrlIndex"
                    @click="saveFuelRow(row.ctrlIndex)"
                  />
                </div>
              </div>
            </div>

            <div v-if="expenseError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
              {{ expenseError }}
            </div>
            <div v-if="recalculateResult" class="text-sm text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300 rounded-lg p-3">
              {{ recalculateResult }}
            </div>

            <div class="flex justify-between items-center pt-2 border-t border-gray-200 dark:border-gray-800">
              <UButton
                icon="i-lucide-calculator"
                label="評価点再集計"
                variant="outline"
                :loading="recalculating"
                @click="recalculateExpense"
              />
              <UButton label="閉じる" variant="ghost" @click="closeExpenseModal" />
            </div>
          </div>
        </template>
      </UModal>
    </template>
  </div>
</template>
