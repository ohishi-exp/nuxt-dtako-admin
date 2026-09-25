<script setup lang="ts">
/**
 * 訴訟用の準備ページ (Refs #1133 c1133-1)。
 *
 * 「何月から何月まで・どの乗務員の勤務を記録するか」を選び、案件として保存して
 * 開き直せる土台。Y時間 Excel 出力・エラー検知・変更記録のタブは後続 PR
 * (#c1133-2 / -5 / -6) が足す — ここは案件の保存・一覧・編集・削除だけを持つ。
 *
 * 認証は restraint-wage.vue の viewer 経路 (Refs #272) と同型: このページの
 * relay route は theearth に触らない (D1 のみ) ので、theearth ログインは不要。
 * 会社IDを指定して auth-worker JWT (viewer 経路) で閲覧する。
 */
import type { Driver } from '~/types'
import { getDrivers, currentAccessToken } from '~/utils/api'
import { describeCaughtError } from '~/utils/api-error'
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
    </template>
  </div>
</template>
