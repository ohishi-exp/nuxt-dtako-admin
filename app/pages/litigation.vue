<script setup lang="ts">
/**
 * 訴訟用の準備ページ (Refs #1133 c1133-1)。
 *
 * 「何月から何月まで・どの乗務員の勤務を記録するか」を選び、案件として保存して
 * 開き直せる土台。案件を「開く」と詳細にタブが出る。「出力」タブ (#c1133-2) は
 * 案件の乗務員 × 期間ぶんの Y時間 Excel を作って 1 つの ZIP にまとめる。
 * エラー検知・変更記録のタブは後続 PR (#c1133-5 / -6) が足す。
 *
 * 認証は restraint-wage.vue の viewer 経路 (Refs #272) と同型: このページの
 * relay route は theearth に触らない (D1 のみ) ので、theearth ログインは不要。
 * 会社IDを指定して auth-worker JWT (viewer 経路) で閲覧する。
 */
import JSZip from 'jszip'
import type { Driver } from '~/types'
import { getDrivers, currentAccessToken } from '~/utils/api'
import { describeCaughtError, describeResponseFailure } from '~/utils/api-error'
import { downloadBlob } from '~/utils/download-blob'
import {
  buildLitigationOutputChunks,
  countLitigationResults,
  litigationResultFromFailure,
  litigationResultFromHeaders,
  litigationZipFilename,
  LITIGATION_TEMPLATE_KEY,
  type LitigationOutputChunk,
  type LitigationOutputResult,
  type LitigationOutputStatus,
} from '~/utils/litigation-output'
import { b64urlUtf8 } from '~/composables/useTheearthSession'
import {
  addDriverCd,
  buildLitigationCaseSavePayload,
  emptyLitigationCaseForm,
  litigationCaseMonthCount,
  litigationCaseToForm,
  removeDriverCd,
  validateLitigationCaseForm,
  type LitigationCaseFormError,
  type LitigationCaseFormInput,
  type LitigationCaseRecord,
} from '~/utils/litigation-case-form'

// 閲覧する会社ID (restraint-wage.vue の viewer 経路 (Refs #272) に倣う)。
// このページの relay route は theearth に触らないので theearth ログインは不要。
const VIEWER_COMP_STORAGE_KEY = 'litigation-viewer-comp'
const viewerComp = ref('')
const viewerCompInput = ref('')

function startViewer() {
  const comp = viewerCompInput.value.trim()
  if (!comp) return
  viewerComp.value = comp
  if (import.meta.client) localStorage.setItem(VIEWER_COMP_STORAGE_KEY, comp)
}

/** restraint-wage.vue の authHeaders と同じ組み立て。 */
function authHeaders(): Record<string, string> {
  const token = currentAccessToken()
  return {
    'X-Theearth-Comp-Id': viewerComp.value,
    'X-Theearth-User-B64': b64urlUtf8('viewer'),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

const pageError = ref('')
const cases = ref<LitigationCaseRecord[]>([])
const casesLoaded = ref(false)
const casesLoading = ref(false)

async function loadCases() {
  if (!viewerComp.value) return
  casesLoading.value = true
  try {
    const res = await $fetch<{ cases: LitigationCaseRecord[] }>('/restraint-api/litigation-cases', {
      headers: authHeaders(),
    })
    cases.value = res.cases
    casesLoaded.value = true
    pageError.value = ''
  }
  catch (e) {
    pageError.value = describeCaughtError(e, '「再読み込み」を押してやり直してください')
  }
  finally {
    casesLoading.value = false
  }
}

// --- 乗務員一覧 (DriverSearchSelect 用。y-time-export.vue と同じ取り方) ---
// alc に運行が1件でもある乗務員しか出ない (nuxt-dtako-admin-map skill の
// Y時間 節「3つの壁」) ので、一覧に居ない乗務員CDも手入力で追加できるようにする。
const drivers = ref<Driver[]>([])
const selectedDriverId = ref('')

onMounted(async () => {
  viewerComp.value = localStorage.getItem(VIEWER_COMP_STORAGE_KEY) || ''
  viewerCompInput.value = viewerComp.value
  if (viewerComp.value) loadCases()
  try {
    drivers.value = await getDrivers()
  }
  catch (e) {
    pageError.value = describeCaughtError(e, '画面を再読み込みしてください')
  }
})

// --- 新規作成/編集フォーム ---
const showForm = ref(false)
const editingCaseId = ref<string | null>(null)
const form = ref<LitigationCaseFormInput>(emptyLitigationCaseForm())
const formErrors = ref<LitigationCaseFormError[]>([])
const driverCdInput = ref('')
const driverAddError = ref('')
const saving = ref(false)

function fieldError(field: LitigationCaseFormError['field']): string {
  return formErrors.value.find(e => e.field === field)?.message ?? ''
}

function startNewCase() {
  editingCaseId.value = null
  form.value = emptyLitigationCaseForm()
  formErrors.value = []
  driverCdInput.value = ''
  driverAddError.value = ''
  selectedDriverId.value = ''
  showForm.value = true
}

function startEditCase(entry: LitigationCaseRecord) {
  editingCaseId.value = entry.caseId
  form.value = litigationCaseToForm(entry)
  formErrors.value = []
  driverCdInput.value = ''
  driverAddError.value = ''
  selectedDriverId.value = ''
  showForm.value = true
}

function cancelForm() {
  showForm.value = false
}

/** 一覧に居る乗務員を選んで追加する。 */
function addSelectedDriver() {
  if (!selectedDriverId.value) return
  const driver = drivers.value.find(d => d.id === selectedDriverId.value)
  if (!driver) return
  const { driverCds, error } = addDriverCd(form.value.driverCds, driver.driver_cd)
  form.value.driverCds = driverCds
  driverAddError.value = error ?? ''
  selectedDriverId.value = ''
}

/** 一覧に居ない乗務員CDを手入力で追加する。 */
function addTypedDriver() {
  const { driverCds, error } = addDriverCd(form.value.driverCds, driverCdInput.value)
  form.value.driverCds = driverCds
  driverAddError.value = error ?? ''
  if (!error) driverCdInput.value = ''
}

function removeDriver(cd: string) {
  form.value.driverCds = removeDriverCd(form.value.driverCds, cd)
}

/** 乗務員CDに対応する氏名 (一覧に居れば)。手入力分は CD のまま表示する。 */
function driverLabel(cd: string): string {
  return drivers.value.find(d => d.driver_cd === cd)?.driver_name ?? cd
}

async function saveCase() {
  formErrors.value = validateLitigationCaseForm(form.value)
  if (formErrors.value.length > 0) return
  saving.value = true
  pageError.value = ''
  try {
    const payload = buildLitigationCaseSavePayload(form.value, editingCaseId.value ?? undefined)
    await $fetch('/restraint-api/litigation-cases', {
      method: 'PUT',
      headers: authHeaders(),
      body: payload,
    })
    showForm.value = false
    await loadCases()
  }
  catch (e) {
    pageError.value = describeCaughtError(e, '「保存」を押してやり直してください')
  }
  finally {
    saving.value = false
  }
}

const deleting = ref<string | null>(null)

async function deleteCase(entry: LitigationCaseRecord) {
  if (!confirm(`案件「${entry.name}」を削除しますか？この操作は取り消せません。`)) return
  deleting.value = entry.caseId
  pageError.value = ''
  try {
    await $fetch('/restraint-api/litigation-cases', {
      method: 'DELETE',
      headers: authHeaders(),
      query: { case_id: entry.caseId },
    })
    await loadCases()
  }
  catch (e) {
    pageError.value = describeCaughtError(e, '「削除」を押してやり直してください')
  }
  finally {
    deleting.value = null
  }
}

// --- 案件の詳細 (開いた案件のタブ) ---
// restraint-wage.vue の自前 TABS / activeTab と同じ流儀 (UTabs は使わない)。
const TABS = [
  { key: 'output', label: '出力' },
] as const
type TabKey = typeof TABS[number]['key']
const activeTab = ref<TabKey>('output')

const openCaseId = ref<string | null>(null)
const openCase = computed(() => cases.value.find(c => c.caseId === openCaseId.value) ?? null)

function openCaseDetail(entry: LitigationCaseRecord) {
  openCaseId.value = entry.caseId
  activeTab.value = 'output'
}

function closeCaseDetail() {
  openCaseId.value = null
}

// --- 出力タブ: Y時間 Excel を区切りごとに作って ZIP にまとめる ---
// 1 冊 = 乗務員 1 名 × 最大 12 か月 (litigation-output.ts の doc 参照)。
const outputChunks = computed<LitigationOutputChunk[]>(() =>
  openCase.value ? buildLitigationOutputChunks(openCase.value) : [])

/**
 * 区切りごとの結果。**後続のエラータブ (#c1133-5) がこの状態を読む** ので、
 * ページの状態として持つ (保存はしない)。添字は `outputChunks` と揃える。
 */
const outputResults = ref<(LitigationOutputResult | null)[]>([])
const outputRunning = ref(false)
const outputCurrent = ref(-1)
const outputFinished = ref(false)
const outputZipMessage = ref('')
const outputZipError = ref('')

// 別の案件を開いた・案件を編集して期間/乗務員が変わったら、前の結果は捨てる
watch(() => [openCase.value?.caseId, openCase.value?.updatedAt], () => {
  if (outputRunning.value) return
  outputResults.value = []
  outputCurrent.value = -1
  outputFinished.value = false
  outputZipMessage.value = ''
  outputZipError.value = ''
})

const outputDoneCount = computed(() => outputResults.value.filter(r => r !== null).length)
const outputCounts = computed(() =>
  countLitigationResults(outputResults.value.filter((r): r is LitigationOutputResult => r !== null)))

const OUTPUT_RETRY = '「ZIP を作る」を押してやり直してください'

/** 区切り 1 つぶんを作る。失敗は結果に畳んで返す (途中の失敗で全体を止めない)。 */
async function runOutputChunk(chunk: LitigationOutputChunk): Promise<{ result: LitigationOutputResult, bytes?: ArrayBuffer }> {
  try {
    const token = currentAccessToken()
    const res = await fetch('/api/y-time-export', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        driver_cd: chunk.driverCd,
        from: chunk.from,
        to: chunk.to,
        template_key: LITIGATION_TEMPLATE_KEY,
        period_rewrite: true,
      }),
    })
    if (!res.ok) {
      // 404 の出どころ (上流 = 乗務員CD 未登録 / R2 = テンプレ不在) は本文の data で分かる
      const body = await res.clone().json().catch(() => null)
      const reason = await describeResponseFailure(res, OUTPUT_RETRY)
      return { result: litigationResultFromFailure(chunk, res.status, body, reason) }
    }
    const result = litigationResultFromHeaders(chunk, res.headers)
    // 運行 0 件の冊は ZIP に入れない (空の Excel を「働いていない」と読ませない)
    const bytes = result.status === 'ok' ? await res.arrayBuffer() : undefined
    return { result, bytes }
  }
  catch (e) {
    return { result: litigationResultFromFailure(chunk, null, null, describeCaughtError(e, OUTPUT_RETRY)) }
  }
}

async function buildOutputZip() {
  const target = openCase.value
  const chunks = outputChunks.value
  if (!target || chunks.length === 0 || outputRunning.value) return
  outputRunning.value = true
  outputFinished.value = false
  outputZipMessage.value = ''
  outputZipError.value = ''
  outputResults.value = chunks.map(() => null)
  const files: { filename: string, bytes: ArrayBuffer }[] = []
  try {
    // 上流 (alc) は乗務員 1 名・期間 1 本しか受けないので、区切りごとに 1 回ずつ直列に呼ぶ
    for (const [i, chunk] of chunks.entries()) {
      outputCurrent.value = i
      const { result, bytes } = await runOutputChunk(chunk)
      outputResults.value[i] = result
      if (bytes) files.push({ filename: chunk.filename, bytes })
    }
    outputCurrent.value = -1
    if (files.length === 0) {
      outputZipError.value = 'ZIP に入れる Excel が 1 冊もできませんでした (下の表の理由を見てください)'
      return
    }
    const zip = new JSZip()
    for (const f of files) zip.file(f.filename, f.bytes)
    const blob = await zip.generateAsync({ type: 'blob' })
    const zipName = litigationZipFilename(target.name, new Date())
    downloadBlob(blob, zipName)
    outputZipMessage.value = `${zipName} を保存しました (${files.length} / ${chunks.length} 冊)`
  }
  catch (e) {
    outputZipError.value = `ZIP を組めませんでした: ${describeCaughtError(e, OUTPUT_RETRY)}`
  }
  finally {
    outputRunning.value = false
    outputCurrent.value = -1
    outputFinished.value = true
  }
}

/** 状態の短い名前。**0 件・未登録・失敗を同じ見た目にしない** (map skill「PR の基準」(7)) */
const OUTPUT_STATUS_LABEL: Record<LitigationOutputStatus, string> = {
  ok: '作成',
  empty: '運行 0 件',
  not_found: 'alc に未登録',
  error: '失敗',
}
const OUTPUT_STATUS_CLASS: Record<LitigationOutputStatus, string> = {
  ok: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  empty: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  not_found: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  error: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-bold">訴訟準備</h2>
      <UButton
        v-if="viewerComp"
        icon="i-lucide-refresh-cw"
        label="再読み込み"
        variant="ghost"
        size="sm"
        :loading="casesLoading"
        @click="loadCases"
      />
    </div>

    <UAlert v-if="pageError" color="error" :title="pageError" class="mb-4" />

    <!-- 閲覧する会社ID の指定 (Refs #272 と同型: theearth ログイン不要) -->
    <UCard v-if="!viewerComp" class="max-w-md mb-4">
      <template #header>
        <span class="font-medium">閲覧する会社IDを指定</span>
      </template>
      <div class="flex items-center gap-2">
        <UInput v-model="viewerCompInput" placeholder="会社ID (例: 1000)" class="w-40" @keyup.enter="startViewer" />
        <UButton label="開始" :disabled="!viewerCompInput.trim()" @click="startViewer" />
      </div>
    </UCard>

    <template v-else>
      <div class="flex items-center justify-between mb-4">
        <span class="text-sm text-gray-500">会社ID: {{ viewerComp }}</span>
        <UButton icon="i-lucide-plus" label="新規作成" size="sm" @click="startNewCase" />
      </div>

      <!-- 新規作成/編集フォーム -->
      <div v-if="showForm" class="mb-4 p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg space-y-4">
        <h3 class="text-sm font-medium">{{ editingCaseId ? '案件を編集' : '新規案件' }}</h3>

        <div>
          <label class="block text-xs text-gray-500 mb-1">案件名</label>
          <UInput v-model="form.name" placeholder="例: 未払残業代請求事件" class="w-full max-w-md" />
          <p v-if="fieldError('name')" class="text-xs text-red-600 mt-1">{{ fieldError('name') }}</p>
        </div>

        <div class="flex items-end gap-3 flex-wrap">
          <div>
            <label class="block text-xs text-gray-500 mb-1">開始月</label>
            <input v-model="form.fromMonth" type="month" class="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
            <p v-if="fieldError('fromMonth')" class="text-xs text-red-600 mt-1">{{ fieldError('fromMonth') }}</p>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">終了月</label>
            <input v-model="form.toMonth" type="month" class="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm">
            <p v-if="fieldError('toMonth')" class="text-xs text-red-600 mt-1">{{ fieldError('toMonth') }}</p>
          </div>
          <p v-if="form.fromMonth && form.toMonth" class="text-xs text-gray-500 pb-2">
            {{ litigationCaseMonthCount(form.fromMonth, form.toMonth) }}か月分
          </p>
          <p v-if="fieldError('range')" class="text-xs text-red-600 pb-2">{{ fieldError('range') }}</p>
        </div>

        <div>
          <label class="block text-xs text-gray-500 mb-1">乗務員</label>
          <div class="flex items-center gap-2 flex-wrap">
            <DriverSearchSelect v-model="selectedDriverId" :drivers="drivers" placeholder="一覧から選ぶ" />
            <UButton size="xs" label="追加" :disabled="!selectedDriverId" @click="addSelectedDriver" />
            <span class="text-xs text-gray-400">または</span>
            <UInput v-model="driverCdInput" size="sm" placeholder="乗務員CDを直接入力" class="w-40" @keyup.enter="addTypedDriver" />
            <UButton size="xs" label="追加" variant="soft" :disabled="!driverCdInput.trim()" @click="addTypedDriver" />
          </div>
          <p v-if="driverAddError" class="text-xs text-red-600 mt-1">{{ driverAddError }}</p>
          <p v-if="fieldError('driverCds')" class="text-xs text-red-600 mt-1">{{ fieldError('driverCds') }}</p>
          <div v-if="form.driverCds.length > 0" class="flex flex-wrap gap-1.5 mt-2">
            <span
              v-for="cd in form.driverCds"
              :key="cd"
              class="inline-flex items-center gap-1 text-xs bg-gray-100 dark:bg-gray-800 rounded-full pl-2.5 pr-1 py-1"
            >
              {{ driverLabel(cd) }} ({{ cd }})
              <button class="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" @click="removeDriver(cd)">
                <UIcon name="i-lucide-x" class="size-3" />
              </button>
            </span>
          </div>
        </div>

        <div>
          <label class="block text-xs text-gray-500 mb-1">メモ (任意)</label>
          <textarea
            v-model="form.memo"
            rows="2"
            class="w-full max-w-md rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          />
        </div>

        <div class="flex gap-2">
          <UButton label="保存" :loading="saving" @click="saveCase" />
          <UButton label="キャンセル" variant="ghost" @click="cancelForm" />
        </div>
      </div>

      <!-- 案件一覧 -->
      <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
              <th class="text-left px-4 py-3 font-medium">名前</th>
              <th class="text-left px-4 py-3 font-medium">期間</th>
              <th class="text-left px-4 py-3 font-medium">乗務員数</th>
              <th class="text-left px-4 py-3 font-medium">更新日時</th>
              <th class="text-left px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody v-if="casesLoading && !casesLoaded">
            <tr>
              <td colspan="5" class="px-4 py-8 text-center text-gray-500">
                <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin mr-2" />
                読み込み中...
              </td>
            </tr>
          </tbody>
          <tbody v-else-if="cases.length === 0">
            <tr>
              <td colspan="5" class="px-4 py-8 text-center text-gray-500">案件がありません</td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr
              v-for="entry in cases"
              :key="entry.caseId"
              class="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/30"
            >
              <td class="px-4 py-3 font-medium">{{ entry.name }}</td>
              <td class="px-4 py-3 text-gray-500">{{ entry.fromMonth }} 〜 {{ entry.toMonth }}</td>
              <td class="px-4 py-3 text-gray-500">{{ entry.driverCds.length }}名</td>
              <td class="px-4 py-3 text-gray-500">{{ fmtDateTime(entry.updatedAt) }}</td>
              <td class="px-4 py-3 text-right whitespace-nowrap">
                <UButton
                  icon="i-lucide-folder-open" label="開く" size="xs"
                  :variant="openCaseId === entry.caseId ? 'solid' : 'soft'"
                  @click="openCaseDetail(entry)"
                />
                <UButton icon="i-lucide-pencil" label="編集" variant="ghost" size="xs" @click="startEditCase(entry)" />
                <UButton
                  icon="i-lucide-trash-2" label="削除" variant="ghost" color="error" size="xs"
                  :loading="deleting === entry.caseId" @click="deleteCase(entry)"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 開いた案件の詳細 (タブ) -->
      <div v-if="openCase" class="mt-6 space-y-4">
        <div class="flex items-center justify-between">
          <h3 class="text-lg font-bold">
            {{ openCase.name }}
            <span class="text-sm font-normal text-gray-500 ml-2">
              {{ openCase.fromMonth }} 〜 {{ openCase.toMonth }} / {{ openCase.driverCds.length }}名
            </span>
          </h3>
          <UButton icon="i-lucide-x" label="閉じる" variant="ghost" size="sm" @click="closeCaseDetail" />
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <UButton
            v-for="tab in TABS"
            :key="tab.key"
            size="sm"
            :variant="activeTab === tab.key ? 'solid' : 'soft'"
            :label="tab.label"
            @click="activeTab = tab.key"
          />
        </div>

        <!-- 出力: Y時間 Excel を区切りごとに作って ZIP 1 つにまとめる -->
        <div v-if="activeTab === 'output'" data-testid="litigation-output" class="space-y-3">
          <p class="text-sm text-gray-600 dark:text-gray-400">
            案件の乗務員 × 期間ぶんの Y時間 Excel (京都ソフト案件のテンプレ) を作り、1 つの ZIP で保存します。
            1 冊 = 乗務員 1 名 × 最大 12 か月 (開始月から 12 か月ごとに区切ります)。
            1 冊あたり 5〜15 秒かかります。運行 0 件・alc に未登録・失敗の冊は ZIP に入れず、下の表に残します。
          </p>

          <div class="flex items-center gap-3 flex-wrap">
            <UButton
              icon="i-lucide-file-archive"
              label="ZIP を作る"
              :loading="outputRunning"
              :disabled="outputRunning || outputChunks.length === 0"
              @click="buildOutputZip"
            />
            <span v-if="outputRunning || outputFinished" class="text-sm text-gray-600 dark:text-gray-400" data-testid="litigation-output-progress">
              {{ outputDoneCount }} / {{ outputChunks.length }} 冊
              <template v-if="outputFinished">
                (作成 {{ outputCounts.ok }} / 運行 0 件 {{ outputCounts.empty }} / alc に未登録 {{ outputCounts.not_found }} / 失敗 {{ outputCounts.error }})
              </template>
            </span>
            <span v-if="outputChunks.length === 0" class="text-sm text-gray-500">区切りがありません (期間か乗務員が空です)</span>
          </div>

          <UAlert v-if="outputZipMessage" color="success" :title="outputZipMessage" />
          <UAlert v-if="outputZipError" color="error" :title="outputZipError" />

          <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-x-auto">
            <table class="w-full text-sm" data-testid="litigation-output-table">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                  <th class="text-left px-4 py-2 font-medium">乗務員</th>
                  <th class="text-left px-4 py-2 font-medium">期間</th>
                  <th class="text-left px-4 py-2 font-medium">ファイル名</th>
                  <th class="text-left px-4 py-2 font-medium">状態</th>
                  <th class="text-left px-4 py-2 font-medium">結果</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(chunk, i) in outputChunks"
                  :key="chunk.filename"
                  class="border-b border-gray-100 dark:border-gray-800 align-top"
                >
                  <td class="px-4 py-2 whitespace-nowrap">{{ driverLabel(chunk.driverCd) }} ({{ chunk.driverCd }})</td>
                  <td class="px-4 py-2 whitespace-nowrap">{{ chunk.label }}</td>
                  <td class="px-4 py-2 font-mono text-xs text-gray-500">{{ chunk.filename }}</td>
                  <td class="px-4 py-2 whitespace-nowrap">
                    <span v-if="outputResults[i]" class="text-xs rounded px-2 py-0.5" :class="OUTPUT_STATUS_CLASS[outputResults[i]!.status]">
                      {{ OUTPUT_STATUS_LABEL[outputResults[i]!.status] }}
                    </span>
                    <span v-else-if="outputRunning && outputCurrent === i" class="text-xs text-gray-500">
                      <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin mr-1" />作成中
                    </span>
                    <span v-else class="text-xs text-gray-400">未実行</span>
                  </td>
                  <td class="px-4 py-2">
                    <template v-if="outputResults[i]">
                      <div>{{ outputResults[i]!.message }}</div>
                      <div v-if="outputResults[i]!.missingCount > 0" class="text-xs text-amber-700 dark:text-amber-400 mt-1">
                        テンプレに行が無く書けなかった日 {{ outputResults[i]!.missingCount }} 日
                        ({{ outputResults[i]!.missingDates.join(', ') }}<template v-if="outputResults[i]!.missingCount > outputResults[i]!.missingDates.length"> ほか</template>)
                      </div>
                      <div v-if="outputResults[i]!.warningsCount > 0" class="text-xs text-amber-700 dark:text-amber-400 mt-1">
                        警告 {{ outputResults[i]!.warningsCount }} 件: {{ outputResults[i]!.warnings.join(' / ') }}<template v-if="outputResults[i]!.warningsCount > outputResults[i]!.warnings.length"> ほか</template>
                      </div>
                    </template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
