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
 *
 * 編集制御解除は行単位 (対象運行 1 件だけ) でしか効かない (cdp-pair 実機確認、
 * Refs #183)。ロック中の行にだけ表示するボタンから呼ぶ。
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
  supplyCategory: string
  supplyCategoryName: string
  supplyStation: string
  supplyStationName: string
  supplyType: string
  supplyTypeName: string
  dateTime: string
  quantity: string
}

/** 給油マスタ (コード→名称)。worker (theearth-report-client の ExpenseMasters) が
 * F-DES1012 の ClientInit マスタ文字列から抽出して返す。CD 入力の live 名称解決に使う。 */
interface ExpenseMasters {
  supplyCategory: Record<string, string>
  supplyStation: Record<string, string>
  fuelType: Record<string, string>
  additive: Record<string, string>
  consumable: Record<string, string>
}

function emptyExpenseMasters(): ExpenseMasters {
  return { supplyCategory: {}, supplyStation: {}, fuelType: {}, additive: {}, consumable: {} }
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

/** 車輌CD (8桁以内の数値、theearth 表示条件指定 txtSVehicle/txtEVehicle の形式)。
 * 空なら車輌絞込なしで検索する。 */
const vehicleCd = ref('')
const VEHICLE_CD_RE = /^\d{1,8}$/

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
  const trimmedVehicleCd = vehicleCd.value.trim()
  if (trimmedVehicleCd && !VEHICLE_CD_RE.test(trimmedVehicleCd)) {
    listError.value = '車輌CDは8桁以内の数値で指定してください'
    return
  }
  listLoading.value = true
  listError.value = null
  try {
    const query: Record<string, string> = {
      from: toReportDateTime(periodForm.from),
      to: toReportDateTime(periodForm.to),
    }
    if (trimmedVehicleCd) {
      query.vehicleFrom = trimmedVehicleCd
      query.vehicleTo = trimmedVehicleCd
    }
    const res = await $fetch<{ rows: DailyReportRow[], sortOk: boolean }>('/daily-report-api/list', {
      headers: authHeaders(),
      query,
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

// --- 編集制御解除 (F-DES1010 の行選択 + btnInitialize、対象運行 1 件のみ解除) ---
// 「編集制御解除」は全ロック一括解放ではない (cdp-pair 実機確認、Refs #183) ため、
// ロック中の行にだけ表示するボタンから対象運行 1 件を指定して呼ぶ。

const unlockingOperationNo = ref<string | null>(null)
const unlockError = ref<string | null>(null)
const unlockMessage = ref<string | null>(null)

async function unlockRow(row: DailyReportRow) {
  const s = session.value
  if (!s) return
  unlockingOperationNo.value = row.operationNo
  unlockError.value = null
  unlockMessage.value = null
  try {
    await $fetch('/daily-report-api/unlock', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo: row.operationNo, startOpe: row.startDateTime },
    })
    unlockMessage.value = `編集制御を解除しました (${row.operationNo})`
    await loadList()
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      return
    }
    unlockError.value = dailyReportErrorMessage(e)
  }
  finally {
    unlockingOperationNo.value = null
  }
}

// --- 経費入力 (F-DES1012 給油行) 編集モーダル ---

const expenseModalOpen = ref(false)
const selectedRow = ref<DailyReportRow | null>(null)
const fuelRows = ref<FuelRow[]>([])
const expenseMasters = ref<ExpenseMasters>(emptyExpenseMasters())
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

// --- CD → 名称の live 解決 (theearth FuelChange と同じマスタ引き) ---

const hasExpenseMasters = computed(() => Object.keys(expenseMasters.value.supplyCategory).length > 0)

/** 種別 (SupplyType) の参照マスタは分類コードで分岐する (theearth `FuelChange` と同一):
 * 分類 1/4 → 燃料種別、2/5 → 添加剤、3 → 消耗品。それ以外は該当マスタ無し。 */
function typeMasterFor(categoryCode: string): Record<string, string> {
  switch (Number(categoryCode)) {
    case 1:
    case 4:
      return expenseMasters.value.fuelType
    case 2:
    case 5:
      return expenseMasters.value.additive
    case 3:
      return expenseMasters.value.consumable
    default:
      return {}
  }
}

/** 入力中の CD から名称を解決する。マスタ未取得時は取得時の初期名称にフォールバック
 * (名称を空にしない)。マスタ取得済みで未登録コードなら空 (theearth と同じ挙動)。 */
function liveCategoryName(row: FuelRow): string {
  if (!hasExpenseMasters.value) return row.supplyCategoryName
  return expenseMasters.value.supplyCategory[fuelEditForm[row.ctrlIndex]?.supplyCategory ?? ''] ?? ''
}
function liveStationName(row: FuelRow): string {
  if (!hasExpenseMasters.value) return row.supplyStationName
  return expenseMasters.value.supplyStation[fuelEditForm[row.ctrlIndex]?.supplyStation ?? ''] ?? ''
}
function liveTypeName(row: FuelRow): string {
  if (!hasExpenseMasters.value) return row.supplyTypeName
  const form = fuelEditForm[row.ctrlIndex]
  if (!form) return ''
  return typeMasterFor(form.supplyCategory)[form.supplyType] ?? ''
}

async function openExpenseModal(row: DailyReportRow) {
  const s = session.value
  if (!s) return
  selectedRow.value = row
  expenseModalOpen.value = true
  fuelRows.value = []
  expenseMasters.value = emptyExpenseMasters()
  expenseError.value = null
  recalculateResult.value = null
  expenseLoading.value = true
  try {
    const res = await $fetch<{ opeNo: string, startOpe: string, fuelRows: FuelRow[], masters: ExpenseMasters }>('/daily-report-api/expense', {
      headers: authHeaders(),
      query: { opeNo: row.operationNo, startOpe: row.startDateTime },
    })
    fuelRows.value = res.fuelRows
    expenseMasters.value = res.masters ?? emptyExpenseMasters()
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

    <div v-if="!session" class="px-6 py-12 text-center text-gray-400">
      右上の「ログイン」から theearth (web地球号) にログインしてください。
    </div>

    <template v-else>
      <div class="px-6 py-6 space-y-6">
        <!-- 期間フィルタ -->
        <UCard>
          <div class="flex flex-wrap items-end gap-3">
            <UFormField label="読取日 (退社日時) 下限">
              <UInput v-model="periodForm.from" type="datetime-local" class="w-56" />
            </UFormField>
            <UFormField label="読取日 (退社日時) 上限">
              <UInput v-model="periodForm.to" type="datetime-local" class="w-56" />
            </UFormField>
            <UFormField label="車輌CD (絞込、任意)">
              <UInput v-model="vehicleCd" icon="i-lucide-truck" placeholder="例: 6572" class="w-32" />
            </UFormField>
            <UButton icon="i-lucide-search" label="日報を検索" :loading="listLoading" @click="loadList" />
            <UButton icon="i-lucide-file-archive" label="編集後 csvdata.zip をダウンロード" variant="outline" :loading="zipLoading" @click="downloadZip" />
          </div>
          <p class="mt-2 text-xs text-gray-400">
            編集制御解除 (ロック解放) は一覧の各行 (赤字表示、ロック中) に表示されるボタンから行ごとに行います。
          </p>
          <p v-if="vehicleCd.trim()" class="mt-2 text-xs text-gray-400">
            車輌CD 絞込は theearth 側のアカウント共通設定 (表示条件指定) を検索中だけ一時的に書き換えます。
            検索完了後は自動で元の設定に戻ります。
          </p>

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
                  <td class="py-2 pr-4 text-right space-x-2 whitespace-nowrap">
                    <UButton size="xs" variant="outline" icon="i-lucide-fuel" label="経費 (給油) を編集" @click="openExpenseModal(row)" />
                    <UButton
                      v-if="row.exclusionFlag"
                      size="xs"
                      variant="outline"
                      color="warning"
                      icon="i-lucide-lock-open"
                      label="編集制御解除"
                      :loading="unlockingOperationNo === row.operationNo"
                      @click="unlockRow(row)"
                    />
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
                    <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                      {{ liveCategoryName(row) || '—' }}
                    </p>
                  </UFormField>
                  <UFormField label="区分 (CD)">
                    <UInput v-model="fuelEditForm[row.ctrlIndex]!.supplyStation" class="w-full" />
                    <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                      {{ liveStationName(row) || '—' }}
                    </p>
                  </UFormField>
                  <UFormField label="種別 (CD)">
                    <UInput v-model="fuelEditForm[row.ctrlIndex]!.supplyType" class="w-full" />
                    <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                      {{ liveTypeName(row) || '—' }}
                    </p>
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
