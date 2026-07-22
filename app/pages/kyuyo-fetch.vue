<script setup lang="ts">
/**
 * 給与DB取得 (Refs #369 PR-B1)。
 *
 * - 会社×年度リストは D1 (kyuyo_companies) から即表示。「リスト更新 (差分)」は
 *   rust の高速一覧 (ミリ秒) と D1 の突き合わせ、「フル更新」は会社名+権限
 *   チェック込みの遅い方 (〜10 秒、初回シード用)
 * - 明細は会社 (複数) × 月範囲を選んで明示的に一括取得 (サーバー側の直列制限に
 *   合わせ 1 件ずつ、進捗表示)。結果は sessionStorage — タブを閉じれば消え、
 *   別ユーザーのログインを検知したら purge する
 * - 画面には件数と warnings 数のみ表示 (金額・氏名は出さない)
 */
import { decodeJwtPayloadFromToken } from '@ippoan/auth-client'
import { currentAccessToken } from '~/utils/api'
import { defaultPayrollMonth } from '~/utils/ichiban-health'
import {
  buildFetchPlan,
  expandMonthRange,
  parsePayrollStorageKey,
  payrollStorageKey,
  shouldPurgeSession,
  summarizeStored,
  toStoredPayroll,
  SESSION_OWNER_KEY,
  type StoredPayroll,
  type StoredSummary,
} from '~/utils/kyuyo-fetch'

interface CompanyRow {
  company: string
  name: string
  years: number[]
  updated_at: string
}

const pageError = ref('')
const companies = ref<CompanyRow[]>([])
const selectedCompanies = ref<Set<string>>(new Set())
const listLoading = ref(false)
const refreshResult = ref('')

const monthFrom = ref(defaultPayrollMonth(new Date()))
const monthTo = ref(defaultPayrollMonth(new Date()))

const fetching = ref(false)
const progress = ref('')
const fetchErrors = ref<string[]>([])
const stored = ref<StoredSummary[]>([])

function authHeader(): Record<string, string> {
  const token = currentAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 別ユーザーのログインを検知したら取得済みデータを全部消す。 */
function purgeIfOwnerChanged() {
  const token = currentAccessToken()
  const payload = token ? decodeJwtPayloadFromToken(token) as { sub?: string } | null : null
  const sub = payload?.sub ?? null
  const owner = sessionStorage.getItem(SESSION_OWNER_KEY)
  if (shouldPurgeSession(owner, sub)) clearAllStored()
  if (sub) sessionStorage.setItem(SESSION_OWNER_KEY, sub)
}

function loadStoredSummaries() {
  const entries: { key: string, value: StoredPayroll }[] = []
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index)
    if (!key || !parsePayrollStorageKey(key)) continue
    try {
      entries.push({ key, value: JSON.parse(sessionStorage.getItem(key) ?? '') as StoredPayroll })
    }
    catch {
      sessionStorage.removeItem(key)
    }
  }
  stored.value = summarizeStored(entries)
}

function removeStored(company: string, month: string) {
  sessionStorage.removeItem(payrollStorageKey(company, month))
  loadStoredSummaries()
}

function clearAllStored() {
  const keys: string[] = []
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index)
    if (key && parsePayrollStorageKey(key)) keys.push(key)
  }
  keys.forEach(key => sessionStorage.removeItem(key))
  loadStoredSummaries()
}

async function loadCompanies() {
  pageError.value = ''
  try {
    const res = await fetch('/api/kyuyo-master/companies')
    if (!res.ok) {
      pageError.value = `会社リストを読めません (HTTP ${res.status})`
      return
    }
    const body = await res.json() as { companies: CompanyRow[] }
    companies.value = body.companies
    if (selectedCompanies.value.size === 0) {
      selectedCompanies.value = new Set(body.companies.map(row => row.company))
    }
  }
  catch (e: unknown) {
    pageError.value = `会社リストを読めません: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function refreshList(full: boolean) {
  listLoading.value = true
  refreshResult.value = ''
  pageError.value = ''
  try {
    const endpoint = full ? '/api/kyuyo-master/refresh-full' : '/api/kyuyo-master/refresh'
    const res = await fetch(endpoint, { method: 'POST', headers: authHeader() })
    const body = await res.json().catch(() => null) as Record<string, unknown> | null
    if (!res.ok) {
      pageError.value = `リスト更新に失敗 (HTTP ${res.status}): ${String((body as { statusMessage?: unknown } | null)?.statusMessage ?? '')}`
      return
    }
    if (full) {
      const warnings = (body?.warnings as string[] | undefined) ?? []
      refreshResult.value = `フル更新完了${warnings.length ? ` / warnings: ${warnings.join(' / ')}` : ''}`
    }
    else {
      const added = (body?.added as string[] | undefined) ?? []
      const updated = (body?.updated as string[] | undefined) ?? []
      const missing = (body?.missing as string[] | undefined) ?? []
      refreshResult.value = added.length + updated.length === 0
        ? `差分なし${missing.length ? ` (upstream に無い会社: ${missing.join(',')})` : ''}`
        : `追加 ${added.join(',') || 'なし'} / 年度更新 ${updated.join(',') || 'なし'}`
    }
    companies.value = (body?.companies as CompanyRow[] | undefined) ?? companies.value
  }
  finally {
    listLoading.value = false
  }
}

function toggleCompany(company: string) {
  const next = new Set(selectedCompanies.value)
  if (next.has(company)) next.delete(company)
  else next.add(company)
  selectedCompanies.value = next
}

async function fetchRange() {
  if (fetching.value) return
  fetchErrors.value = []
  pageError.value = ''
  const range = expandMonthRange(monthFrom.value, monthTo.value)
  if ('error' in range) {
    pageError.value = range.error
    return
  }
  const targets = [...selectedCompanies.value].sort()
  if (targets.length === 0) {
    pageError.value = '会社を選択してください'
    return
  }
  const plan = buildFetchPlan(targets, range.months)
  fetching.value = true
  try {
    for (const [index, item] of plan.entries()) {
      progress.value = `${index + 1}/${plan.length} — ${item.company} ${item.month} を取得中…`
      try {
        const res = await fetch(
          `/api/kyuyo/payroll?company=${item.company}&month=${item.month}`,
          { headers: authHeader() },
        )
        const body = await res.json().catch(() => null)
        if (!res.ok) {
          const message = (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`
          fetchErrors.value.push(`${item.company} ${item.month}: ${message}`)
          continue
        }
        const storedEntry = toStoredPayroll(body, new Date().toISOString())
        if (!storedEntry) {
          fetchErrors.value.push(`${item.company} ${item.month}: 応答形式が想定外`)
          continue
        }
        try {
          sessionStorage.setItem(payrollStorageKey(item.company, item.month), JSON.stringify(storedEntry))
        }
        catch {
          fetchErrors.value.push(`${item.company} ${item.month}: 保存失敗 (セッション保存の容量上限。取得済みを削除してください)`)
          break
        }
        loadStoredSummaries()
      }
      catch (e: unknown) {
        fetchErrors.value.push(`${item.company} ${item.month}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    progress.value = ''
  }
  finally {
    fetching.value = false
  }
}

onMounted(() => {
  purgeIfOwnerChanged()
  loadStoredSummaries()
  loadCompanies()
})
</script>

<template>
  <div class="p-6 max-w-4xl">
    <h1 class="text-xl font-bold mb-1">
      給与DB取得
    </h1>
    <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
      給与大臣 DB から明細を取得してこのタブ内に保持します (タブを閉じると消えます)。
      画面には件数のみ表示し、金額・氏名は出しません。
    </p>

    <p v-if="pageError" class="text-sm text-red-600 dark:text-red-400 mb-3">
      {{ pageError }}
    </p>

    <!-- 会社リスト (D1) -->
    <div class="mb-5">
      <div class="flex items-center gap-2 mb-2">
        <h2 class="font-semibold">会社</h2>
        <UButton size="xs" variant="soft" :loading="listLoading" @click="refreshList(false)">
          リスト更新 (差分)
        </UButton>
        <UButton size="xs" variant="ghost" :loading="listLoading" @click="refreshList(true)">
          フル更新 (会社名・権限、遅い)
        </UButton>
        <span v-if="refreshResult" class="text-xs text-gray-500 dark:text-gray-400">{{ refreshResult }}</span>
      </div>
      <p v-if="companies.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
        リストが空です — 初回は「フル更新」で取得してください。
      </p>
      <div class="flex flex-wrap gap-3">
        <label
          v-for="row in companies"
          :key="row.company"
          class="flex items-center gap-2 text-sm border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 cursor-pointer"
        >
          <input
            type="checkbox"
            :checked="selectedCompanies.has(row.company)"
            @change="toggleCompany(row.company)"
          >
          <span>{{ row.company }}<template v-if="row.name">　{{ row.name }}</template></span>
          <span v-if="row.years.length" class="text-xs text-gray-400">
            {{ row.years[0] }}〜{{ row.years[row.years.length - 1] }}
          </span>
        </label>
      </div>
    </div>

    <!-- 月範囲 + 一括取得 -->
    <div class="flex items-end gap-3 mb-3">
      <div>
        <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1">開始月</label>
        <UInput v-model="monthFrom" type="month" :disabled="fetching" />
      </div>
      <div>
        <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1">終了月</label>
        <UInput v-model="monthTo" type="month" :disabled="fetching" />
      </div>
      <UButton icon="i-lucide-download" :loading="fetching" @click="fetchRange">
        一括取得
      </UButton>
      <span v-if="progress" class="text-xs text-gray-500 dark:text-gray-400 pb-2">{{ progress }}</span>
    </div>
    <ul v-if="fetchErrors.length" class="text-sm text-red-600 dark:text-red-400 mb-4 list-disc pl-5">
      <li v-for="message in fetchErrors" :key="message">{{ message }}</li>
    </ul>

    <!-- 取得済み一覧 (セッション) -->
    <div class="flex items-center gap-2 mb-2">
      <h2 class="font-semibold">取得済み (このタブ限り)</h2>
      <UButton v-if="stored.length" size="xs" variant="ghost" color="error" @click="clearAllStored">
        全削除
      </UButton>
    </div>
    <p v-if="stored.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
      まだ取得していません。
    </p>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
            <th class="py-2 pr-3 font-medium">会社</th>
            <th class="py-2 pr-3 font-medium">月</th>
            <th class="py-2 pr-3 font-medium">DB</th>
            <th class="py-2 pr-3 font-medium text-right">人数</th>
            <th class="py-2 pr-3 font-medium text-right">warnings</th>
            <th class="py-2 pr-3 font-medium">取得時刻</th>
            <th class="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in stored" :key="`${row.company}:${row.month}`" class="border-b border-gray-100 dark:border-gray-800">
            <td class="py-2 pr-3">{{ row.company }}</td>
            <td class="py-2 pr-3">{{ row.month }}</td>
            <td class="py-2 pr-3 text-gray-500 dark:text-gray-400">{{ row.database }}</td>
            <td class="py-2 pr-3 text-right tabular-nums">{{ row.rowCount }}</td>
            <td class="py-2 pr-3 text-right tabular-nums">{{ row.warningCount }}</td>
            <td class="py-2 pr-3 text-gray-500 dark:text-gray-400">{{ new Date(row.fetchedAt).toLocaleString('ja-JP') }}</td>
            <td class="py-2 text-right">
              <UButton size="xs" variant="ghost" color="error" @click="removeStored(row.company, row.month)">
                削除
              </UButton>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
