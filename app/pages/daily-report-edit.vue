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
 * 作業 (F-DES1013、Refs #170) / 乗務員 (F-DES1011、Refs #171) 編集も本ページの
 * モーダルとして実装している (経費モーダルと同型)。
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

/** F-DES1013 作業行の表示ビュー (worker の theearth-report-client WorkRow と同型)。
 * 日時は "YY/MM/DD HH:mm" の短縮表示。編集には edit-start が返すフル形式を使う。 */
interface WorkRow {
  ctrlIndex: number
  eventCd: string
  eventName: string
  startDateTime: string
  endDateTime: string
  eventMin: string
  driverType: string
  startPlaceCd: string
  startPlaceName: string
  startCityCd: string
  startCityName: string
  endPlaceCd: string
  endPlaceName: string
  endCityCd: string
  endCityName: string
}

interface WorkEventOption {
  value: string
  label: string
}

/** 編集モード行の現在値 (worker の WorkEditFormRow と同型)。日時は
 * "YYYY/MM/DD HH:mm:ss" のフル形式 (theearth の編集入力欄そのまま)。 */
interface WorkEditFormRow {
  ctrlIndex: number
  eventCd: string
  eventOptions: WorkEventOption[]
  destination: boolean
  startDateTime: string
  endDateTime: string
  driverType: string
  startPlaceCd: string
  startPlaceName: string
  startCityCd: string
  startCityName: string
  endPlaceCd: string
  endPlaceName: string
  endCityCd: string
  endCityName: string
}

/** F-DES1011 運行データ修正フォーム (worker の ReviseForm と同型)。 */
interface ReviseForm {
  opeNo: string
  startOpe: string
  driver1: string
  vehicle: string
  branch: string
  formFilled: boolean
}

/** 事業所/車輌/乗務員マスタ (worker の DvrMasters と同型、VenusBridge 由来)。 */
interface ReportMasterItem {
  code: string
  link: string | null
  name: string
}
interface ReportMasters {
  branches: { code: string, name: string }[]
  vehicles: ReportMasterItem[]
  drivers: ReportMasterItem[]
}

const { session, authHeaders, restoreSession, showLoginPanel, expireSession } = useDailyReportSession()

function onLogin() {
  loadList()
}

watch(session, (s) => {
  if (!s) {
    rows.value = []
    sortOk.value = null
    reportMasters.value = null
    closeExpenseModal()
    closeWorkModal()
    closeReviseModal()
  }
})

// --- 事業所/車輌/乗務員マスタ (VenusBridge、乗務員CD → 名称の解決に使う) ---

const reportMasters = ref<ReportMasters | null>(null)

/** マスタを 1 セッション 1 回だけ取得する。補助情報 (名称表示) なので取得失敗
 * しても編集操作自体は止めない (名称が出ないだけ)。 */
async function ensureReportMasters() {
  if (reportMasters.value || !session.value) return
  try {
    reportMasters.value = await $fetch<ReportMasters>('/daily-report-api/masters', { headers: authHeaders() })
  }
  catch (e) {
    console.warn('乗務員マスタの取得に失敗しました (名称表示のみ影響):', dailyReportErrorMessage(e))
  }
}

/** 乗務員CD → 名称 (マスタ未取得・未登録コードは "")。マスタの code は数値由来の
 * 文字列なので数値比較で "0001" 等のゼロ埋め差を吸収する。 */
function driverNameByCd(cd: string): string {
  const m = reportMasters.value
  const trimmed = cd.trim()
  if (!m || trimmed === '') return ''
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return ''
  return m.drivers.find(d => Number(d.code) === n)?.name ?? ''
}

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

/** 検索条件を sessionStorage に保持する (リロードで毎回消えるのは面倒、という
 * ユーザー要望)。タブを閉じれば消える (localStorage にはしない)。 */
const SEARCH_STORAGE_KEY = 'daily-report-edit:search'

function restoreSearchForm() {
  try {
    const raw = sessionStorage.getItem(SEARCH_STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as Partial<{ from: string, to: string, vehicleCd: string, driverFilter: string }>
    if (typeof saved.from === 'string' && saved.from) periodForm.from = saved.from
    if (typeof saved.to === 'string' && saved.to) periodForm.to = saved.to
    if (typeof saved.vehicleCd === 'string') vehicleCd.value = saved.vehicleCd
    if (typeof saved.driverFilter === 'string') driverFilter.value = saved.driverFilter
  }
  catch {
    // 壊れた保存値は無視して既定値で開く
  }
}

const rows = ref<DailyReportRow[]>([])
const sortOk = ref<boolean | null>(null)
const listLoading = ref(false)
const listError = ref<string | null>(null)

/** 乗務員絞込 (CD または名前の部分一致、クライアント側フィルタ)。theearth 側の
 * 表示条件指定 (F-GOS0030) に乗務員 range フィールドがあるかは実機未確認のため、
 * 車輌CD のようなサーバー側絞込ではなく取得済み行のフィルタで実現する。 */
const driverFilter = ref('')

const filteredRows = computed(() => {
  const q = driverFilter.value.trim()
  if (!q) return rows.value
  return rows.value.filter(r => (r.driverCd1 ?? '').includes(q) || (r.driverName1 ?? '').includes(q))
})

watch([() => periodForm.from, () => periodForm.to, vehicleCd, driverFilter], () => {
  try {
    sessionStorage.setItem(SEARCH_STORAGE_KEY, JSON.stringify({
      from: periodForm.from,
      to: periodForm.to,
      vehicleCd: vehicleCd.value,
      driverFilter: driverFilter.value,
    }))
  }
  catch {
    // ストレージが使えない環境では保持しないだけ
  }
})

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
    const res = await $fetch<{ rows: DailyReportRow[], sortOk: boolean | null }>('/daily-report-api/list', {
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

// 手動指定の編集制御解除 — 一覧の取得自体が失敗している状態 (theearth が 500 を
// 返し続ける等) でも、運行No/出庫日時を直接指定してロック解放を試せる復旧経路。
const manualUnlockOpeNo = ref('')
const manualUnlockStartOpe = ref('')
const manualUnlocking = ref(false)

async function unlockManual() {
  const s = session.value
  if (!s) return
  const opeNo = manualUnlockOpeNo.value.trim()
  const startOpe = manualUnlockStartOpe.value.trim()
  unlockError.value = null
  unlockMessage.value = null
  if (!/^\d{22}$/.test(opeNo)) {
    unlockError.value = '運行Noは22桁の数値で指定してください'
    return
  }
  manualUnlocking.value = true
  try {
    await $fetch('/daily-report-api/unlock', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo, startOpe },
    })
    unlockMessage.value = `編集制御を解除しました (${opeNo})`
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      return
    }
    unlockError.value = dailyReportErrorMessage(e)
  }
  finally {
    manualUnlocking.value = false
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
// システム連携 (btnLinkSys): 再集計成功で有効化される
const linkSysEnabled = ref(false)
const linking = ref(false)
const linkResult = ref<string | null>(null)
// この運行の csvdata.zip ダウンロード (モーダル内、単一運行のみ)
const opeZipLoading = ref(false)

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
  resetNewFuelRow()
  linkSysEnabled.value = false
  linkResult.value = null
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
  linkSysEnabled.value = false
  linkResult.value = null
}

// 新規給油行 (テーブル最下段の入力行、theearth の最下段テンプレート行と同じ操作感)。
// 給油 0 件の運行でも追加できる。
const newFuelRow = reactive({ supplyCategory: '', supplyStation: '', supplyType: '', dateTime: '', quantity: '' })
const addingFuelRow = ref(false)

function resetNewFuelRow() {
  newFuelRow.supplyCategory = ''
  newFuelRow.supplyStation = ''
  newFuelRow.supplyType = ''
  newFuelRow.dateTime = ''
  newFuelRow.quantity = ''
}

const newFuelCategoryName = computed(() => expenseMasters.value.supplyCategory[newFuelRow.supplyCategory.trim()] ?? '')
const newFuelStationName = computed(() => expenseMasters.value.supplyStation[newFuelRow.supplyStation.trim()] ?? '')
const newFuelTypeName = computed(() => typeMasterFor(newFuelRow.supplyCategory)[newFuelRow.supplyType.trim()] ?? '')

async function addNewFuelRow() {
  const s = session.value
  const target = selectedRow.value
  if (!s || !target) return
  addingFuelRow.value = true
  expenseError.value = null
  try {
    const res = await $fetch<{ fuelRows: FuelRow[], masters: ExpenseMasters }>('/daily-report-api/expense/add', {
      method: 'POST',
      headers: authHeaders(),
      body: {
        opeNo: target.operationNo,
        startOpe: target.startDateTime,
        supplyCategory: newFuelRow.supplyCategory.trim(),
        supplyStation: newFuelRow.supplyStation.trim(),
        supplyType: newFuelRow.supplyType.trim(),
        dateTime: newFuelRow.dateTime.trim(),
        quantity: newFuelRow.quantity.trim(),
      },
    })
    fuelRows.value = res.fuelRows
    if (res.masters && Object.keys(res.masters.supplyCategory).length > 0) expenseMasters.value = res.masters
    syncFuelEditForm()
    resetNewFuelRow()
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
    addingFuelRow.value = false
  }
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
    linkSysEnabled.value = res.linkSysEnabled
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

/** システム連動開始 (btnLinkSys)。theearth 側にデータを連動させる本番アクションのため
 * 実行前に確認する。worker が btnScore→btnLinkSys の連鎖 postback を行う。 */
async function startSystemLink() {
  const s = session.value
  const target = selectedRow.value
  if (!s || !target) return
  if (!window.confirm('システム連動開始 (theearth へのデータ連動) を実行します。よろしいですか?')) return
  linking.value = true
  expenseError.value = null
  linkResult.value = null
  try {
    const res = await $fetch<{ linked: boolean, message: string }>('/daily-report-api/expense/link-sys', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo: target.operationNo, startOpe: target.startDateTime },
    })
    linkResult.value = res.linked
      ? 'システム連動を開始しました'
      : `システム連動を実行しました (応答: ${res.message || '確認要'})`
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
    linking.value = false
  }
}

/** この運行 **1 件だけ** の編集後 csvdata.zip をダウンロードする。F-NOS3010 の
 * 「運行データ選択」モードは OpeNo/StartOpe 指定で単一運行の zip を返せる
 * (cdp-pair 実機確認、Refs #203。以前の「読取日 1 日分 (from=to)」は暫定実装)。 */
async function downloadOperationZip() {
  const s = session.value
  const target = selectedRow.value
  if (!s || !target) return
  opeZipLoading.value = true
  expenseError.value = null
  try {
    const params = new URLSearchParams({ opeNo: target.operationNo, startOpe: target.startDateTime })
    const res = await fetch(`/daily-report-api/zip?${params.toString()}`, { headers: authHeaders() })
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string } | null
      const message = data?.error ?? `csvdata.zip の取得に失敗しました (HTTP ${res.status})`
      if (res.status === 401) {
        expireSession(message)
        expenseModalOpen.value = false
        return
      }
      throw new Error(message)
    }
    await downloadBlobResponse(res, `csvdata-${target.operationNo}.zip`)
  }
  catch (e) {
    expenseError.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    opeZipLoading.value = false
  }
}

// --- 作業入力 (F-DES1013 lstWork) 編集モーダル (Refs #170) ---
// 実 theearth の UX (表示行 → 鉛筆で編集モード → 修正 → 保存) をそのまま再現する:
// 「編集」で /work/edit-start (btnEditButton postback、フル形式の現在値が返る) →
// 修正して /work/save (btnUpdateButton postback)。

const workModalOpen = ref(false)
const workSelectedRow = ref<DailyReportRow | null>(null)
const workRows = ref<WorkRow[]>([])
const workEventOptions = ref<WorkEventOption[]>([])
const workLoading = ref(false)
const workError = ref<string | null>(null)
const workRecalculating = ref(false)
const workRecalculateResult = ref<string | null>(null)
// システム連携 (btnLinkSys): 作業時間再集計成功で有効化される。expense モーダルの
// linkSysEnabled と対の per-modal 状態 (同時に開くモーダルは 1 つだが、各モーダルで
// 独立した再集計 → 連携のライフサイクルを持たせる)
const workLinkSysEnabled = ref(false)
const workLinking = ref(false)
const workLinkResult = ref<string | null>(null)
// この運行の csvdata.zip ダウンロード (作業モーダル内、単一運行のみ)
const workOpeZipLoading = ref(false)
// 編集モード中の行 (edit-start の応答をそのまま編集する)。null = 編集中でない
const workEditing = ref<WorkEditFormRow | null>(null)
const workEditStarting = ref<number | null>(null)
const workSaving = ref(false)

/** 作業種別ごとの行スタイル (theearth-np 実ページの明細行色分けを再現、2026-07-11
 * 実機確認)。積み/降しは行の背景色、休憩/休息は文字色で区別される。 */
function workRowClass(eventCd: string): string {
  switch (eventCd) {
    case '202': return 'bg-cyan-50 dark:bg-cyan-900/70' // 積み
    case '203': return 'bg-yellow-50 dark:bg-yellow-900/70' // 降し
    case '301': return 'text-blue-600 dark:text-blue-400' // 休憩
    case '302': return 'text-red-600 dark:text-red-400' // 休息
    default: return ''
  }
}

/** USelect (reka-ui) は空文字 value の item を許可しないため、空 value の option
 * (見出し行等) は除外する。選択肢が取れなかった場合はテキスト入力にフォールバック。 */
const workEventSelectItems = computed(() => {
  const options = workEditing.value && workEditing.value.eventOptions.length > 0
    ? workEditing.value.eventOptions
    : workEventOptions.value
  return options
    .filter(o => o.value !== '')
    .map(o => ({ label: `${o.value}: ${o.label}`, value: o.value }))
})

async function openWorkModal(row: DailyReportRow) {
  const s = session.value
  if (!s) return
  workSelectedRow.value = row
  workModalOpen.value = true
  workRows.value = []
  workEventOptions.value = []
  workError.value = null
  workRecalculateResult.value = null
  workLinkSysEnabled.value = false
  workLinkResult.value = null
  workEditing.value = null
  workLoading.value = true
  try {
    const res = await $fetch<{ opeNo: string, startOpe: string, workRows: WorkRow[], eventOptions: WorkEventOption[] }>('/daily-report-api/work', {
      headers: authHeaders(),
      query: { opeNo: row.operationNo, startOpe: row.startDateTime },
    })
    workRows.value = res.workRows
    workEventOptions.value = res.eventOptions
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      workModalOpen.value = false
      return
    }
    workError.value = dailyReportErrorMessage(e)
  }
  finally {
    workLoading.value = false
  }
}

function closeWorkModal() {
  workModalOpen.value = false
  workSelectedRow.value = null
  workRows.value = []
  workEventOptions.value = []
  workError.value = null
  workRecalculateResult.value = null
  workLinkSysEnabled.value = false
  workLinkResult.value = null
  workEditing.value = null
}

/** 行の「編集」— theearth の鉛筆ボタン相当。編集モードの現在値 (フル形式の日時) が返る。 */
async function startWorkEdit(row: WorkRow) {
  const s = session.value
  const target = workSelectedRow.value
  if (!s || !target) return
  if (workEditing.value || workEditStarting.value !== null) return // 編集中は他行クリックを無視
  workEditStarting.value = row.ctrlIndex
  workError.value = null
  try {
    const res = await $fetch<{ row: WorkEditFormRow }>('/daily-report-api/work/edit-start', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo: target.operationNo, startOpe: target.startDateTime, ctrlIndex: row.ctrlIndex },
    })
    workEditing.value = { ...res.row }
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      workModalOpen.value = false
      return
    }
    workError.value = dailyReportErrorMessage(e)
  }
  finally {
    workEditStarting.value = null
  }
}

function cancelWorkEdit() {
  // 編集モードの viewstate は使い捨て (worker 側 storage は次の edit-start で上書きされる)
  workEditing.value = null
}

async function saveWorkEdit() {
  const s = session.value
  const target = workSelectedRow.value
  const editing = workEditing.value
  if (!s || !target || !editing) return
  workSaving.value = true
  workError.value = null
  try {
    const res = await $fetch<{ workRows: WorkRow[], eventOptions: WorkEventOption[] }>('/daily-report-api/work/save', {
      method: 'POST',
      headers: authHeaders(),
      body: {
        opeNo: target.operationNo,
        startOpe: target.startDateTime,
        ctrlIndex: editing.ctrlIndex,
        eventCd: editing.eventCd,
        destination: editing.destination,
        startDateTime: editing.startDateTime,
        endDateTime: editing.endDateTime,
        startPlaceCd: editing.startPlaceCd,
        startPlaceName: editing.startPlaceName,
        startCityCd: editing.startCityCd,
        startCityName: editing.startCityName,
        endPlaceCd: editing.endPlaceCd,
        endPlaceName: editing.endPlaceName,
        endCityCd: editing.endCityCd,
        endCityName: editing.endCityName,
      },
    })
    workRows.value = res.workRows
    if (res.eventOptions.length > 0) workEventOptions.value = res.eventOptions
    workEditing.value = null
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      workModalOpen.value = false
      return
    }
    workError.value = dailyReportErrorMessage(e)
  }
  finally {
    workSaving.value = false
  }
}

/** 作業時間再集計 (F-DES1013 btnScore)。DriverState1〜5Min が更新される。 */
async function recalculateWorkTime() {
  const s = session.value
  const target = workSelectedRow.value
  if (!s || !target) return
  workRecalculating.value = true
  workError.value = null
  workRecalculateResult.value = null
  workLinkResult.value = null
  try {
    const res = await $fetch<{ linkSysEnabled: boolean }>('/daily-report-api/work/recalculate', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo: target.operationNo, startOpe: target.startDateTime },
    })
    workLinkSysEnabled.value = res.linkSysEnabled
    workRecalculateResult.value = res.linkSysEnabled
      ? '作業時間再集計が完了しました (システム連動開始が有効になりました)'
      : '作業時間再集計が完了しました'
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      workModalOpen.value = false
      return
    }
    workError.value = dailyReportErrorMessage(e)
  }
  finally {
    workRecalculating.value = false
  }
}

/** システム連動開始 (btnLinkSys) を作業モーダルから実行する。expense モーダルの
 * `startSystemLink` と同じく `/daily-report-api/expense/link-sys` を叩く
 * (theearth の連動アクションは per-operation で、どの form から postback しても
 * 同じ運行に対して 1 回の連動が走る。DO 側は btnScore→btnLinkSys の連鎖を
 * F-DES1012 で行う実装で、UI クリック元に依らず結果は同じ)。 */
async function startWorkLink() {
  const s = session.value
  const target = workSelectedRow.value
  if (!s || !target) return
  if (!window.confirm('システム連動開始 (theearth へのデータ連動) を実行します。よろしいですか?')) return
  workLinking.value = true
  workError.value = null
  workLinkResult.value = null
  try {
    const res = await $fetch<{ linked: boolean, message: string }>('/daily-report-api/expense/link-sys', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo: target.operationNo, startOpe: target.startDateTime },
    })
    workLinkResult.value = res.linked
      ? 'システム連動を開始しました'
      : `システム連動を実行しました (応答: ${res.message || '確認要'})`
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      workModalOpen.value = false
      return
    }
    workError.value = dailyReportErrorMessage(e)
  }
  finally {
    workLinking.value = false
  }
}

/** この運行の csvdata.zip ダウンロード (作業モーダル版)。expense モーダルの
 * `downloadOperationZip` と同じ endpoint (`/daily-report-api/zip`) を叩く。 */
async function downloadWorkOperationZip() {
  const s = session.value
  const target = workSelectedRow.value
  if (!s || !target) return
  workOpeZipLoading.value = true
  workError.value = null
  try {
    const params = new URLSearchParams({ opeNo: target.operationNo, startOpe: target.startDateTime })
    const res = await fetch(`/daily-report-api/zip?${params.toString()}`, { headers: authHeaders() })
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string } | null
      const message = data?.error ?? `csvdata.zip の取得に失敗しました (HTTP ${res.status})`
      if (res.status === 401) {
        expireSession(message)
        workModalOpen.value = false
        return
      }
      throw new Error(message)
    }
    await downloadBlobResponse(res, `csvdata-${target.operationNo}.zip`)
  }
  catch (e) {
    workError.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    workOpeZipLoading.value = false
  }
}

// --- 乗務員変更 (F-DES1011 運行データ修正) モーダル (Refs #171) ---

const reviseModalOpen = ref(false)
const reviseSelectedRow = ref<DailyReportRow | null>(null)
const reviseForm = ref<ReviseForm | null>(null)
const reviseLoading = ref(false)
const reviseError = ref<string | null>(null)
const reviseSaving = ref(false)
const reviseResult = ref<string | null>(null)
const reviseDriverInput = ref('')
// 作業時間再集計 (F-DES1013 btnScore) — 乗務員変更後にそのまま再集計できるよう
// このモーダルにも置く (作業モーダルの recalculateWorkTime と同じ endpoint)
const reviseRecalculating = ref(false)
const reviseRecalculateResult = ref<string | null>(null)
// システム連携 (btnLinkSys): 乗務員変更モーダルからも再集計 → 連携できるように
// per-modal 状態を持たせる (expense / work モーダルと対)
const reviseLinkSysEnabled = ref(false)
const reviseLinking = ref(false)
const reviseLinkResult = ref<string | null>(null)
// この運行の csvdata.zip ダウンロード (乗務員モーダル内、単一運行のみ)
const reviseOpeZipLoading = ref(false)
const DRIVER_CD_RE = /^\d{1,8}$/

/** 入力中の乗務員CD / 現在の乗務員CD の名称 (マスタ live 解決)。 */
const reviseDriverInputName = computed(() => driverNameByCd(reviseDriverInput.value))
const reviseCurrentDriverName = computed(() => (reviseForm.value ? driverNameByCd(reviseForm.value.driver1) : ''))

async function openReviseModal(row: DailyReportRow) {
  const s = session.value
  if (!s) return
  reviseSelectedRow.value = row
  reviseModalOpen.value = true
  reviseForm.value = null
  reviseError.value = null
  reviseResult.value = null
  reviseRecalculateResult.value = null
  reviseLinkSysEnabled.value = false
  reviseLinkResult.value = null
  reviseDriverInput.value = ''
  reviseLoading.value = true
  void ensureReportMasters() // 名称解決用 (失敗しても編集は続行できる)
  try {
    const res = await $fetch<ReviseForm>('/daily-report-api/revise', {
      headers: authHeaders(),
      query: { opeNo: row.operationNo, startOpe: row.startDateTime },
    })
    reviseForm.value = res
    reviseDriverInput.value = res.driver1
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      reviseModalOpen.value = false
      return
    }
    reviseError.value = dailyReportErrorMessage(e)
  }
  finally {
    reviseLoading.value = false
  }
}

function closeReviseModal() {
  reviseModalOpen.value = false
  reviseSelectedRow.value = null
  reviseForm.value = null
  reviseError.value = null
  reviseResult.value = null
  reviseRecalculateResult.value = null
  reviseLinkSysEnabled.value = false
  reviseLinkResult.value = null
}

/** 作業時間再集計 (F-DES1013 btnScore) を乗務員変更モーダルから実行する。
 * 乗務員変更は再集計不要 (DriverCD1 は直接反映) だが、同じ運行の作業時間を
 * 続けて再集計したい運用があるため並べて置く。フォーム未取得 (500 等) でも
 * 再集計自体は実行できる (対象は opeNo/startOpe で特定するため)。 */
async function recalculateWorkFromRevise() {
  const s = session.value
  const target = reviseSelectedRow.value
  if (!s || !target) return
  reviseRecalculating.value = true
  reviseError.value = null
  reviseRecalculateResult.value = null
  reviseLinkResult.value = null
  try {
    const res = await $fetch<{ linkSysEnabled: boolean }>('/daily-report-api/work/recalculate', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo: target.operationNo, startOpe: target.startDateTime },
    })
    reviseLinkSysEnabled.value = res.linkSysEnabled
    reviseRecalculateResult.value = res.linkSysEnabled
      ? '作業時間再集計が完了しました (システム連動開始が有効になりました)'
      : '作業時間再集計が完了しました'
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      reviseModalOpen.value = false
      return
    }
    reviseError.value = dailyReportErrorMessage(e)
  }
  finally {
    reviseRecalculating.value = false
  }
}

/** システム連動開始 (btnLinkSys) を乗務員変更モーダルから実行する。
 * `/daily-report-api/expense/link-sys` を再利用 (連動は per-operation で form 非依存、
 * startWorkLink と同じ理由)。 */
async function startReviseLink() {
  const s = session.value
  const target = reviseSelectedRow.value
  if (!s || !target) return
  if (!window.confirm('システム連動開始 (theearth へのデータ連動) を実行します。よろしいですか?')) return
  reviseLinking.value = true
  reviseError.value = null
  reviseLinkResult.value = null
  try {
    const res = await $fetch<{ linked: boolean, message: string }>('/daily-report-api/expense/link-sys', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo: target.operationNo, startOpe: target.startDateTime },
    })
    reviseLinkResult.value = res.linked
      ? 'システム連動を開始しました'
      : `システム連動を実行しました (応答: ${res.message || '確認要'})`
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      reviseModalOpen.value = false
      return
    }
    reviseError.value = dailyReportErrorMessage(e)
  }
  finally {
    reviseLinking.value = false
  }
}

/** この運行の csvdata.zip ダウンロード (乗務員モーダル版)。expense モーダルの
 * `downloadOperationZip` と同じ endpoint (`/daily-report-api/zip`) を叩く。 */
async function downloadReviseOperationZip() {
  const s = session.value
  const target = reviseSelectedRow.value
  if (!s || !target) return
  reviseOpeZipLoading.value = true
  reviseError.value = null
  try {
    const params = new URLSearchParams({ opeNo: target.operationNo, startOpe: target.startDateTime })
    const res = await fetch(`/daily-report-api/zip?${params.toString()}`, { headers: authHeaders() })
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string } | null
      const message = data?.error ?? `csvdata.zip の取得に失敗しました (HTTP ${res.status})`
      if (res.status === 401) {
        expireSession(message)
        reviseModalOpen.value = false
        return
      }
      throw new Error(message)
    }
    await downloadBlobResponse(res, `csvdata-${target.operationNo}.zip`)
  }
  catch (e) {
    reviseError.value = e instanceof Error ? e.message : String(e)
  }
  finally {
    reviseOpeZipLoading.value = false
  }
}

/** 乗務員CD の登録 (F-DES1011 btnReg)。運行データの本体を書き換える操作のため
 * 実行前に確認する。フォーム初期値が空の場合は worker 側が登録を拒否する
 * (既存データを空で上書きしない、loud fail)。 */
async function saveReviseDriver() {
  const s = session.value
  const target = reviseSelectedRow.value
  if (!s || !target) return
  const driver1 = reviseDriverInput.value.trim()
  if (!DRIVER_CD_RE.test(driver1)) {
    reviseError.value = '乗務員CDは8桁以内の数値で指定してください'
    return
  }
  const driverName = driverNameByCd(driver1)
  if (!window.confirm(`乗務員CD を「${driver1}」${driverName ? ` (${driverName})` : ''} に変更して登録します。よろしいですか?`)) return
  reviseSaving.value = true
  reviseError.value = null
  reviseResult.value = null
  try {
    const res = await $fetch<{ driver1After: string | null }>('/daily-report-api/revise/save', {
      method: 'POST',
      headers: authHeaders(),
      body: { opeNo: target.operationNo, startOpe: target.startDateTime, driver1 },
    })
    reviseResult.value = res.driver1After
      ? `乗務員CD を「${res.driver1After}」に登録しました`
      : '登録 postback を送信しました (応答から値を読み直せなかったため、一覧の再検索で反映を確認してください)'
    await loadList()
  }
  catch (e) {
    if (dailyReportErrorStatus(e) === 401) {
      expireSession(dailyReportErrorMessage(e))
      reviseModalOpen.value = false
      return
    }
    reviseError.value = dailyReportErrorMessage(e)
  }
  finally {
    reviseSaving.value = false
  }
}

onMounted(() => {
  restoreSearchForm()
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
            <UFormField label="乗務員 (CD/名前で絞込、任意)">
              <UInput v-model="driverFilter" icon="i-lucide-user" placeholder="例: 1405 / 松尾" class="w-44" />
            </UFormField>
            <UButton icon="i-lucide-search" label="日報を検索" :loading="listLoading" @click="loadList" />
            <UButton icon="i-lucide-file-archive" label="編集後 csvdata.zip をダウンロード" variant="outline" :loading="zipLoading" @click="downloadZip" />
          </div>
          <p class="mt-2 text-xs text-gray-400">
            編集制御解除 (ロック解放) は一覧の各行 (赤字表示、ロック中) に表示されるボタンから行ごとに行います。
          </p>
          <!-- 一覧が取得できない状態からの復旧用: 運行No/出庫日時の直接指定でロック解除 -->
          <div class="mt-2 flex flex-wrap items-end gap-2">
            <UFormField label="運行No (手動ロック解除)">
              <UInput v-model="manualUnlockOpeNo" placeholder="22桁の運行No" class="w-56" size="sm" />
            </UFormField>
            <UFormField label="出庫日時">
              <UInput v-model="manualUnlockStartOpe" placeholder="2026/07/03 10:38:50" class="w-48" size="sm" />
            </UFormField>
            <UButton
              size="sm"
              variant="outline"
              color="warning"
              icon="i-lucide-lock-open"
              label="編集制御解除 (手動指定)"
              :loading="manualUnlocking"
              @click="unlockManual"
            />
          </div>
          <p v-if="vehicleCd.trim()" class="mt-2 text-xs text-gray-400">
            車輌CD 絞込は theearth 側のアカウント共通設定 (表示条件指定) を検索中だけ一時的に書き換えます。
            検索完了後は自動で元の設定に戻ります。
          </p>

          <div v-if="sortOk === false" class="mt-3 text-sm text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 rounded-lg p-3">
            表示条件指定 (F-GOS0030) の並び順が「読取日 降順」になっていません。早期打ち切りを無効化して
            全ページ走査しましたが、theearth 側の表示条件指定を「読取日 降順」に直すことを推奨します。
          </div>
          <div v-if="sortOk === null && rows.length > 0" class="mt-3 text-xs text-gray-400">
            並び順設定 (F-GOS0030) の事前確認に失敗したためスキップしました (取得結果の並びで自動検証しています)。
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
            <span class="font-semibold">
              運行データ入力一覧 ({{ filteredRows.length }} 件<template v-if="filteredRows.length !== rows.length"> / 全 {{ rows.length }} 件</template>)
            </span>
          </template>
          <div v-if="listLoading" class="text-center py-8 text-gray-400">
            読み込み中…
          </div>
          <div v-else-if="filteredRows.length === 0" class="text-center py-8 text-gray-400">
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
                  v-for="row in filteredRows"
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
                    <UButton size="xs" variant="outline" icon="i-lucide-clipboard-list" label="作業を編集" @click="openWorkModal(row)" />
                    <UButton size="xs" variant="outline" icon="i-lucide-fuel" label="経費 (給油) を編集" @click="openExpenseModal(row)" />
                    <UButton size="xs" variant="outline" icon="i-lucide-user" label="乗務員を編集" @click="openReviseModal(row)" />
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
      <UModal v-model:open="expenseModalOpen" :ui="{ content: 'max-w-4xl' }">
        <template #content>
          <div class="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <h3 class="text-lg font-bold">
              経費入力 (給油) — {{ selectedRow?.operationNo }}
            </h3>

            <div v-if="expenseLoading" class="text-center py-8 text-gray-400">
              読み込み中…
            </div>
            <div v-else class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                    <th class="py-2 pr-2">分類CD</th>
                    <th class="py-2 pr-2">分類名</th>
                    <th class="py-2 pr-2">区分CD</th>
                    <th class="py-2 pr-2">区分名</th>
                    <th class="py-2 pr-2">種別CD</th>
                    <th class="py-2 pr-2">種別名</th>
                    <th class="py-2 pr-2">日時</th>
                    <th class="py-2 pr-2">数量</th>
                    <th class="py-2 pr-2" />
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in fuelRows"
                    :key="row.ctrlIndex"
                    class="border-b border-gray-100 dark:border-gray-900"
                  >
                    <td class="py-1 pr-2">
                      <UInput v-model="fuelEditForm[row.ctrlIndex]!.supplyCategory" class="w-16" />
                    </td>
                    <td class="py-1 pr-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                      {{ liveCategoryName(row) || '—' }}
                    </td>
                    <td class="py-1 pr-2">
                      <UInput v-model="fuelEditForm[row.ctrlIndex]!.supplyStation" class="w-16" />
                    </td>
                    <td class="py-1 pr-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                      {{ liveStationName(row) || '—' }}
                    </td>
                    <td class="py-1 pr-2">
                      <UInput v-model="fuelEditForm[row.ctrlIndex]!.supplyType" class="w-16" />
                    </td>
                    <td class="py-1 pr-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                      {{ liveTypeName(row) || '—' }}
                    </td>
                    <td class="py-1 pr-2">
                      <UInput v-model="fuelEditForm[row.ctrlIndex]!.dateTime" class="w-40" />
                    </td>
                    <td class="py-1 pr-2">
                      <UInput v-model="fuelEditForm[row.ctrlIndex]!.quantity" class="w-20" />
                    </td>
                    <td class="py-1 pr-2 text-right whitespace-nowrap">
                      <UButton
                        size="xs"
                        label="保存"
                        :loading="savingCtrlIndex === row.ctrlIndex"
                        @click="saveFuelRow(row.ctrlIndex)"
                      />
                    </td>
                  </tr>
                  <!-- 新規行 (theearth の最下段テンプレート行と同じ。給油 0 件でも追加できる) -->
                  <tr class="border-t border-gray-200 dark:border-gray-800">
                    <td class="py-1 pr-2">
                      <UInput v-model="newFuelRow.supplyCategory" placeholder="分類" class="w-16" />
                    </td>
                    <td class="py-1 pr-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                      {{ newFuelCategoryName || '—' }}
                    </td>
                    <td class="py-1 pr-2">
                      <UInput v-model="newFuelRow.supplyStation" placeholder="区分" class="w-16" />
                    </td>
                    <td class="py-1 pr-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                      {{ newFuelStationName || '—' }}
                    </td>
                    <td class="py-1 pr-2">
                      <UInput v-model="newFuelRow.supplyType" placeholder="種別" class="w-16" />
                    </td>
                    <td class="py-1 pr-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                      {{ newFuelTypeName || '—' }}
                    </td>
                    <td class="py-1 pr-2">
                      <UInput v-model="newFuelRow.dateTime" placeholder="26/07/07 10:29" class="w-40" />
                    </td>
                    <td class="py-1 pr-2">
                      <UInput v-model="newFuelRow.quantity" placeholder="100.0" class="w-20" />
                    </td>
                    <td class="py-1 pr-2 text-right whitespace-nowrap">
                      <UButton
                        size="xs"
                        label="保存"
                        :loading="addingFuelRow"
                        @click="addNewFuelRow"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-if="expenseError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
              {{ expenseError }}
            </div>
            <div v-if="recalculateResult" class="text-sm text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300 rounded-lg p-3">
              {{ recalculateResult }}
            </div>
            <div v-if="linkResult" class="text-sm text-blue-700 bg-blue-50 dark:bg-blue-950 dark:text-blue-300 rounded-lg p-3">
              {{ linkResult }}
            </div>

            <div class="flex justify-between items-center pt-2 border-t border-gray-200 dark:border-gray-800">
              <div class="flex gap-2">
                <UButton
                  icon="i-lucide-calculator"
                  label="評価点再集計"
                  variant="outline"
                  :loading="recalculating"
                  @click="recalculateExpense"
                />
                <UButton
                  icon="i-lucide-link"
                  label="システム連携"
                  color="error"
                  variant="outline"
                  :disabled="!linkSysEnabled"
                  :loading="linking"
                  title="評価点再集計の成功後に有効化されます (theearth へデータ連動)"
                  @click="startSystemLink"
                />
                <UButton
                  icon="i-lucide-file-archive"
                  label="この運行の csvdata.zip"
                  variant="outline"
                  :loading="opeZipLoading"
                  title="この運行 1 件だけの編集後 csvdata.zip をダウンロード"
                  @click="downloadOperationZip"
                />
              </div>
              <UButton label="閉じる" variant="ghost" @click="closeExpenseModal" />
            </div>
          </div>
        </template>
      </UModal>

      <!-- F-DES1013 作業行編集モーダル (Refs #170) -->
      <UModal v-model:open="workModalOpen" fullscreen>
        <template #content>
          <div class="p-6 space-y-4 h-full overflow-y-auto">
            <h3 class="text-lg font-bold">
              作業入力 — {{ workSelectedRow?.operationNo }}
            </h3>

            <div v-if="workLoading" class="text-center py-8 text-gray-400">
              読み込み中…
            </div>
            <div v-else-if="workRows.length === 0" class="text-center py-8 text-gray-400">
              作業データがありません
            </div>
            <template v-else>
              <!-- 作業行一覧 (inline 編集、theearth のグリッドと同じ操作感) -->
              <div>
                <table class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-800">
                      <th class="py-2 pr-2">作業</th>
                      <th class="py-2 pr-2">行先</th>
                      <th class="py-2 pr-2">開始日時</th>
                      <th class="py-2 pr-2">終了日時</th>
                      <th class="py-2 pr-2">作業時間</th>
                      <th class="py-2 pr-2">開始場所CD</th>
                      <th class="py-2 pr-2">開始場所名</th>
                      <th class="py-2 pr-2">開始市町村CD</th>
                      <th class="py-2 pr-2">開始市町村名</th>
                      <th class="py-2 pr-2">終了場所CD</th>
                      <th class="py-2 pr-2">終了場所名</th>
                      <th class="py-2 pr-2">終了市町村CD</th>
                      <th class="py-2 pr-2">終了市町村名</th>
                      <th class="py-2 pr-2" />
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="row in workRows" :key="row.ctrlIndex">
                      <!-- 編集モード行 (edit-start 済み、日時はフル形式 "YYYY/MM/DD HH:mm:ss") -->
                      <tr
                        v-if="workEditing && workEditing.ctrlIndex === row.ctrlIndex"
                        class="border-b border-gray-100 dark:border-gray-900 bg-primary-50 dark:bg-primary-950"
                      >
                        <td class="py-1 pr-2">
                          <USelect
                            v-if="workEventSelectItems.length > 0"
                            v-model="workEditing.eventCd"
                            :items="workEventSelectItems"
                            class="w-32"
                          />
                          <UInput v-else v-model="workEditing.eventCd" class="w-20" />
                        </td>
                        <td class="py-1 pr-2">
                          <UCheckbox v-model="workEditing.destination" />
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.startDateTime" class="w-44" />
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.endDateTime" class="w-44" />
                        </td>
                        <td class="py-1 pr-2 whitespace-nowrap">
                          {{ row.eventMin }}
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.startPlaceCd" class="w-24" />
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.startPlaceName" class="w-36" />
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.startCityCd" class="w-24" />
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.startCityName" class="w-36" />
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.endPlaceCd" class="w-24" />
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.endPlaceName" class="w-36" />
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.endCityCd" class="w-24" />
                        </td>
                        <td class="py-1 pr-2">
                          <UInput v-model="workEditing.endCityName" class="w-36" />
                        </td>
                        <td class="py-1 pr-2 text-right whitespace-nowrap space-x-1">
                          <UButton size="xs" label="保存" :loading="workSaving" @click="saveWorkEdit" />
                          <UButton size="xs" variant="ghost" label="取消" @click="cancelWorkEdit" />
                        </td>
                      </tr>
                      <!-- 表示行 (行クリックで編集開始 = theearth の鉛筆ボタン相当) -->
                      <tr
                        v-else
                        class="border-b border-gray-100 dark:border-gray-900"
                        :class="[
                          workRowClass(row.eventCd),
                          workEditing ? 'opacity-60' : workEditStarting === row.ctrlIndex ? 'opacity-50 animate-pulse' : 'cursor-pointer hover:brightness-95 dark:hover:brightness-125',
                        ]"
                        @click="startWorkEdit(row)"
                      >
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.eventCd }} {{ row.eventName }}
                        </td>
                        <td class="py-2 pr-2" />
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.startDateTime }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.endDateTime }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.eventMin }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.startPlaceCd || '-' }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.startPlaceName || '-' }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.startCityCd || '-' }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.startCityName || '-' }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.endPlaceCd || '-' }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.endPlaceName || '-' }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.endCityCd || '-' }}
                        </td>
                        <td class="py-2 pr-2 whitespace-nowrap">
                          {{ row.endCityName || '-' }}
                        </td>
                        <td class="py-2 pr-2" />
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
              <p class="text-xs text-gray-400">
                行をクリックすると編集できます (theearth の鉛筆ボタンと同じ)。
              </p>
            </template>

            <div v-if="workError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
              {{ workError }}
            </div>
            <div v-if="workRecalculateResult" class="text-sm text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300 rounded-lg p-3">
              {{ workRecalculateResult }}
            </div>
            <div v-if="workLinkResult" class="text-sm text-blue-700 bg-blue-50 dark:bg-blue-950 dark:text-blue-300 rounded-lg p-3">
              {{ workLinkResult }}
            </div>

            <div class="flex justify-between items-center pt-2 border-t border-gray-200 dark:border-gray-800">
              <div class="flex gap-2">
                <UButton
                  icon="i-lucide-calculator"
                  label="作業時間再集計"
                  variant="outline"
                  :loading="workRecalculating"
                  title="作業1〜5時間 (DriverState1〜5Min) を再計算します"
                  @click="recalculateWorkTime"
                />
                <UButton
                  icon="i-lucide-link"
                  label="システム連携"
                  color="error"
                  variant="outline"
                  :disabled="!workLinkSysEnabled"
                  :loading="workLinking"
                  title="作業時間再集計の成功後に有効化されます (theearth へデータ連動)"
                  @click="startWorkLink"
                />
                <UButton
                  icon="i-lucide-file-archive"
                  label="この運行の csvdata.zip"
                  variant="outline"
                  :loading="workOpeZipLoading"
                  title="この運行 1 件だけの編集後 csvdata.zip をダウンロード"
                  @click="downloadWorkOperationZip"
                />
              </div>
              <UButton label="閉じる" variant="ghost" @click="closeWorkModal" />
            </div>
          </div>
        </template>
      </UModal>

      <!-- F-DES1011 乗務員変更モーダル (Refs #171) -->
      <UModal v-model:open="reviseModalOpen" :ui="{ content: 'max-w-lg' }">
        <template #content>
          <div class="p-6 space-y-4">
            <h3 class="text-lg font-bold">
              乗務員変更 — {{ reviseSelectedRow?.operationNo }}
            </h3>

            <div v-if="reviseLoading" class="text-center py-8 text-gray-400">
              読み込み中…
            </div>
            <template v-else-if="reviseForm">
              <div class="text-sm text-gray-500 dark:text-gray-400 space-y-1">
                <p>
                  現在の乗務員CD: {{ reviseForm.driver1 || '—' }}
                  <template v-if="reviseCurrentDriverName"> {{ reviseCurrentDriverName }}</template>
                  (一覧: {{ reviseSelectedRow?.driverName1 ?? '-' }})
                </p>
                <p>車両CD: {{ reviseForm.vehicle || '—' }} / 事業所CD: {{ reviseForm.branch || '—' }}</p>
              </div>

              <div v-if="!reviseForm.formFilled" class="text-sm text-amber-700 bg-amber-50 dark:bg-amber-950 dark:text-amber-300 rounded-lg p-3">
                フォームの初期値が theearth から取得できませんでした (JS PageLoad 依存の可能性)。
                既存の運行データを空で上書きする恐れがあるため、登録は実行できません (実機確認待ち)。
              </div>

              <UFormField label="乗務員CD (変更後)">
                <UInput v-model="reviseDriverInput" placeholder="例: 1405" class="w-40" />
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                  {{ reviseDriverInputName || '—' }}
                </p>
              </UFormField>
            </template>

            <div v-if="reviseError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
              {{ reviseError }}
              <p v-if="!reviseForm" class="mt-1 text-xs">
                theearth 側に編集ロックが残っている可能性があります。一覧を再検索し、赤字表示の行の「編集制御解除」で解放してから開き直してください。
              </p>
            </div>
            <div v-if="reviseResult" class="text-sm text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300 rounded-lg p-3">
              {{ reviseResult }}
            </div>
            <div v-if="reviseRecalculateResult" class="text-sm text-green-700 bg-green-50 dark:bg-green-950 dark:text-green-300 rounded-lg p-3">
              {{ reviseRecalculateResult }}
            </div>
            <div v-if="reviseLinkResult" class="text-sm text-blue-700 bg-blue-50 dark:bg-blue-950 dark:text-blue-300 rounded-lg p-3">
              {{ reviseLinkResult }}
            </div>

            <div class="flex justify-between items-center pt-2 border-t border-gray-200 dark:border-gray-800">
              <div class="flex gap-2">
                <UButton
                  icon="i-lucide-user-check"
                  label="登録"
                  :disabled="!reviseForm || !reviseForm.formFilled"
                  :loading="reviseSaving"
                  @click="saveReviseDriver"
                />
                <UButton
                  icon="i-lucide-calculator"
                  label="作業時間再集計"
                  variant="outline"
                  :loading="reviseRecalculating"
                  title="作業1〜5時間 (DriverState1〜5Min) を再計算します (F-DES1013 btnScore)"
                  @click="recalculateWorkFromRevise"
                />
                <UButton
                  icon="i-lucide-link"
                  label="システム連携"
                  color="error"
                  variant="outline"
                  :disabled="!reviseLinkSysEnabled"
                  :loading="reviseLinking"
                  title="作業時間再集計の成功後に有効化されます (theearth へデータ連動)"
                  @click="startReviseLink"
                />
                <UButton
                  icon="i-lucide-file-archive"
                  label="この運行の csvdata.zip"
                  variant="outline"
                  :loading="reviseOpeZipLoading"
                  title="この運行 1 件だけの編集後 csvdata.zip をダウンロード"
                  @click="downloadReviseOperationZip"
                />
              </div>
              <UButton label="閉じる" variant="ghost" @click="closeReviseModal" />
            </div>
          </div>
        </template>
      </UModal>
    </template>
  </div>
</template>
