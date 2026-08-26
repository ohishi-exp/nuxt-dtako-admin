<script setup lang="ts">
/**
 * 給与DB取得 (Refs #369 PR-B1)。
 *
 * - 会社×年度リストは D1 (kyuyo_companies) から即表示。「リスト更新 (差分)」は
 *   rust の高速一覧 (ミリ秒) と D1 の突き合わせ、「フル更新」は会社名+権限
 *   チェック込みの遅い方 (〜10 秒、初回シード用)
 * - 明細は会社 (複数) × 月範囲を選んで明示的に一括引き直し (サーバー側の直列制限に
 *   合わせ 1 件ずつ、進捗表示)。`POST /api/kyuyo/sync` で給与大臣 (OHKEN) を実際に
 *   読み直してサーバーの給与アーカイブを上書きする — `payroll` は read-through
 *   キャッシュなので、sync 無しでは遡り修正が反映されない (Refs #467)
 * - 画面には件数と warnings 数のみ表示 (金額・氏名は出さない)
 *
 * ## 一覧の正はサーバー、ブラウザには明細を残さない (Refs #467 PR-A3)
 *
 * 以前は取得した明細を sessionStorage (`kyuyo-payroll:{会社}:{月}`) に置き、その
 * キーを数えて「取得済み」一覧を出していた。**氏名と金額がブラウザに平文で残る**ので
 * 廃止し、一覧は `GET /api/kyuyo/synced-months` (サーバー側の給与アーカイブ) から引く。
 * 別ユーザーのログイン時に purge する仕掛け (`shouldPurgeSession`) も、消すべき
 * データがブラウザに無くなったので不要になった。
 */
import { defaultPayrollMonth } from '~/utils/ichiban-health'
import {
  buildFetchPlan,
  expandMonthRange,
  fmtPayrollSync,
  summarizeSyncedMonths,
  type SyncedMonthRow,
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
/** サーバー側の給与アーカイブ一覧 (`/api/kyuyo/synced-months`)。 */
const synced = ref<SyncedMonthRow[]>([])
const syncedLoading = ref(false)

/** この画面で今回引き直した結果 (会社×月ごと)。**一覧に無い情報はここにだけ出す** —
 * DB 名と warnings は `synced-months` が返さないので、その場で分かる形で残す。 */
interface SyncRunRow {
  company: string
  month: string
  database: string
  payrollRows: number
  employees: number
  warnings: string[]
}
const syncResults = ref<SyncRunRow[]>([])

/** サーバー側の給与アーカイブ一覧を読む。**失敗しても静かに空のまま** —
 * 一覧が出ないだけで、引き直し自体は妨げない。
 * 認証は cookie 任せ (Refs #375) — server route が cookie から Bearer を組む。 */
async function loadSynced() {
  syncedLoading.value = true
  try {
    const res = await fetch('/api/kyuyo/synced-months')
    if (!res.ok) return
    const body = await res.json().catch(() => null) as { entries?: unknown } | null
    synced.value = summarizeSyncedMonths(body?.entries)
  }
  catch {
    // 一覧が出ないだけ — エラー表示はしない
  }
  finally {
    syncedLoading.value = false
  }
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
    // 認証は cookie (`logi_auth_token`) 任せ — 同一オリジンなので自動で載る
    // (Refs #375。server route が cookie から Bearer を組んで upstream へ渡す)。
    const res = await fetch(endpoint, { method: 'POST' })
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
      const updated = (body?.updated as string[] | undefined) ?? []
      const ignored = (body?.ignored as string[] | undefined) ?? []
      const missing = (body?.missing as string[] | undefined) ?? []
      const notes = [
        ignored.length ? `対象外DB: ${ignored.join(',')}` : '',
        missing.length ? `upstream に無い会社: ${missing.join(',')}` : '',
      ].filter(Boolean).join(' / ')
      refreshResult.value = (updated.length === 0 ? '差分なし' : `年度更新: ${updated.join(',')}`)
        + (notes ? ` (${notes})` : '')
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
  syncResults.value = []
  try {
    for (const [index, item] of plan.entries()) {
      progress.value = `${index + 1}/${plan.length} — ${item.company} ${item.month} を給与大臣から引き直し中…`
      try {
        // ★ `sync` だけで完結する — 明細は取り込まない (Refs #467 PR-A3)。
        // 応答が返す行数・人数・warnings で「何が入ったか」は分かるので、
        // 氏名と金額をブラウザへ持ってくる必要が無い。
        // 認証は cookie 任せ (Refs #375、`refreshList` と同じ) — POST proxy も
        // cookie から Bearer を組むので、ページ側は何も載せない
        const res = await fetch(
          `/api/kyuyo/sync?company=${item.company}&month=${item.month}`,
          { method: 'POST' },
        )
        const body = await res.json().catch(() => null) as Record<string, unknown> | null
        if (!res.ok) {
          const message = (body as { statusMessage?: string, error?: string } | null)?.statusMessage
            ?? (body as { error?: string } | null)?.error ?? `HTTP ${res.status}`
          fetchErrors.value.push(`${item.company} ${item.month}: 引き直しに失敗 (${message})`)
          continue
        }
        const warnings = Array.isArray(body?.warnings)
          ? (body.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
          : []
        syncResults.value.push({
          company: item.company,
          month: item.month,
          database: typeof body?.database === 'string' ? body.database : '-',
          payrollRows: typeof body?.payroll_rows === 'number' ? body.payroll_rows : 0,
          employees: typeof body?.employees === 'number' ? body.employees : 0,
          warnings,
        })
      }
      catch (e: unknown) {
        fetchErrors.value.push(`${item.company} ${item.month}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    progress.value = ''
    // サーバー側の同期状態が進んだので一覧を取り直す
    await loadSynced()
  }
  finally {
    fetching.value = false
  }
}

onMounted(() => {
  loadCompanies()
  loadSynced()
})
</script>

<template>
  <div class="p-6 max-w-4xl">
    <h1 class="text-xl font-bold mb-1">
      給与DB取得
    </h1>
    <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
      給与大臣 (OHKEN) を実際に読み直し、<b>サーバー側の給与アーカイブを上書き</b>します
      (1 社×1 ヶ月あたり 10〜20 秒。給与大臣 PC が古く DB を都度開くためで、異常ではありません)。
      <b>明細はこのブラウザに持ってきません</b> — 画面に出るのは件数だけで、金額・氏名は出しません。
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
      <UButton icon="i-lucide-refresh-cw" :loading="fetching" @click="fetchRange">
        一括で引き直す
      </UButton>
      <span v-if="progress" class="text-xs text-gray-500 dark:text-gray-400 pb-2">{{ progress }}</span>
    </div>
    <ul v-if="fetchErrors.length" class="text-sm text-red-600 dark:text-red-400 mb-4 list-disc pl-5">
      <li v-for="message in fetchErrors" :key="message">{{ message }}</li>
    </ul>

    <!-- 今回の引き直し結果 (この実行限り)。DB 名と warnings は一覧に出ない情報なので、
         その場で分かるここにだけ出す (Refs #467 PR-A3) -->
    <template v-if="syncResults.length">
      <h2 class="font-semibold mb-2">今回の引き直し</h2>
      <div class="overflow-x-auto mb-6">
        <table class="w-full text-sm border-collapse">
          <thead>
            <tr class="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
              <th class="py-2 pr-3 font-medium">会社</th>
              <th class="py-2 pr-3 font-medium">月</th>
              <th class="py-2 pr-3 font-medium">DB</th>
              <th class="py-2 pr-3 font-medium text-right">明細</th>
              <th class="py-2 pr-3 font-medium text-right">社員</th>
              <th class="py-2 font-medium">warnings</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in syncResults" :key="`run:${row.company}:${row.month}`" class="border-b border-gray-100 dark:border-gray-800">
              <td class="py-2 pr-3">{{ row.company }}</td>
              <td class="py-2 pr-3">{{ row.month }}</td>
              <td class="py-2 pr-3 text-gray-500 dark:text-gray-400">{{ row.database }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ row.payrollRows }}</td>
              <td class="py-2 pr-3 text-right tabular-nums">{{ row.employees }}</td>
              <td class="py-2 text-gray-500 dark:text-gray-400">
                <span v-if="!row.warnings.length">-</span>
                <ul v-else class="list-disc pl-4">
                  <li v-for="w in row.warnings" :key="w">{{ w }}</li>
                </ul>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- サーバー側の給与アーカイブ一覧 (/api/kyuyo/synced-months) -->
    <div class="flex items-center gap-2 mb-2">
      <h2 class="font-semibold">サーバーに同期済み</h2>
      <UButton size="xs" variant="ghost" :loading="syncedLoading" @click="loadSynced">
        再読み込み
      </UButton>
    </div>
    <p class="text-xs text-gray-500 dark:text-gray-400 mb-2">
      <!-- ★ 旧「取得済み (このタブ限り)」表の置き換え (Refs #467 PR-A3)。
           何が変わったかを書いておかないと「前は見えていたのに」になる。 -->
      以前ここは<b>ブラウザ内 (sessionStorage) の取得済み一覧</b>でしたが、氏名と金額を
      ブラウザに残さないため廃止し、<b>サーバー側の給与アーカイブ</b>の一覧に変えました。
      これに伴い <b>DB 名・warnings 数・ブラウザの取得時刻の列は無くなりました</b> —
      DB 名と warnings は上の「今回の引き直し」に出ます。
      <b>行を消す操作もありません</b> (サーバーの給与アーカイブを削除する API が上流に無いため)。
      引き直せば同じ行が上書きされます。
    </p>
    <p v-if="synced.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
      同期済みの会社×月はありません (または一覧を読めませんでした)。
    </p>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
            <th class="py-2 pr-3 font-medium">会社</th>
            <th class="py-2 pr-3 font-medium">月 (勤務月)</th>
            <th class="py-2 pr-3 font-medium text-right">人数</th>
            <th class="py-2 pr-3 font-medium">サーバー同期</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in synced" :key="`${row.company}:${row.month}`" class="border-b border-gray-100 dark:border-gray-800">
            <td class="py-2 pr-3">{{ row.company }}</td>
            <td class="py-2 pr-3">{{ row.month }}</td>
            <td class="py-2 pr-3 text-right tabular-nums">{{ row.rowCount }}</td>
            <td class="py-2 pr-3 text-gray-500 dark:text-gray-400">{{ fmtPayrollSync({ source: 'cache', syncedAt: row.syncedAt }) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
