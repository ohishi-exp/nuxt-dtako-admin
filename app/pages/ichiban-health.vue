<script setup lang="ts">
/**
 * 一番星ヘルスチェック (Refs #369)。
 *
 * rust-ichibanboshi の既存 API (CAPE#01) と給与読み取り API (OHKEN、#82) を
 * 一括疎通確認する。給与系はブラウザの JWT が proxy 経由で upstream に渡り、
 * introspect + allowlist の認可ゲートまで含めて検証される — つまりこのページが
 * 通れば「トンネル・CF Access・introspect・DB 接続」の全区間が生きている。
 *
 * 給与明細の内容 (金額・氏名) は画面に出さない — 件数と warnings 数のみ。
 */
import { buildHealthChecks, classifyResult, defaultPayrollMonth, type CheckLevel, type HealthCheck } from '~/utils/ichiban-health'
import { currentAccessToken } from '~/utils/api'

interface CheckRow {
  check: HealthCheck
  state: 'pending' | 'running' | 'done'
  level?: CheckLevel
  detail?: string
  ms?: number
}

const payrollMonth = ref(defaultPayrollMonth(new Date()))
const rows = ref<CheckRow[]>(buildHealthChecks(payrollMonth.value).map(check => ({ check, state: 'pending' })))
const running = ref(false)
const lastRunAt = ref('')

watch(payrollMonth, (month) => {
  rows.value = buildHealthChecks(month).map(check => ({ check, state: 'pending' }))
})

async function runOne(row: CheckRow): Promise<void> {
  row.state = 'running'
  const started = performance.now()
  try {
    const token = row.check.needsAuth ? currentAccessToken() : null
    if (row.check.needsAuth && !token) {
      row.level = 'ng'
      row.detail = 'JWT がありません (再ログインしてください)'
      return
    }
    const res = await fetch(row.check.url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    let body: unknown = null
    try {
      body = await res.json()
    }
    catch {
      // 非 JSON 応答 (health 等) は body なしで判定
    }
    const outcome = classifyResult(row.check.id, res.status, body)
    row.level = outcome.level
    row.detail = outcome.detail
  }
  catch (e: unknown) {
    row.level = 'ng'
    row.detail = `接続失敗: ${e instanceof Error ? e.message : String(e)}`
  }
  finally {
    row.ms = Math.round(performance.now() - started)
    row.state = 'done'
  }
}

async function runAll() {
  if (running.value) return
  running.value = true
  rows.value = buildHealthChecks(payrollMonth.value).map(check => ({ check, state: 'pending' }))
  try {
    await Promise.all(rows.value.map(row => runOne(row)))
    lastRunAt.value = new Date().toLocaleString('ja-JP')
  }
  finally {
    running.value = false
  }
}

const summary = computed(() => {
  const done = rows.value.filter(r => r.state === 'done')
  return {
    ok: done.filter(r => r.level === 'ok').length,
    warn: done.filter(r => r.level === 'warn').length,
    ng: done.filter(r => r.level === 'ng').length,
    total: rows.value.length,
  }
})

function levelBadge(level: CheckLevel | undefined): { label: string, class: string } {
  if (level === 'ok') return { label: 'OK', class: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' }
  if (level === 'warn') return { label: 'WARN', class: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' }
  return { label: 'NG', class: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' }
}
</script>

<template>
  <div class="p-6 max-w-4xl">
    <h1 class="text-xl font-bold mb-1">
      一番星ヘルスチェック
    </h1>
    <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
      rust-ichibanboshi の既存 API (CAPE#01) と給与読み取り API (OHKEN) を一括疎通確認します。
      給与系はログイン中のアカウントで認可まで検証されます (金額・氏名は表示しません)。
    </p>

    <div class="flex items-end gap-3 mb-4">
      <div>
        <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1">給与明細の対象月</label>
        <UInput v-model="payrollMonth" type="month" :disabled="running" />
      </div>
      <UButton icon="i-lucide-heart-pulse" :loading="running" @click="runAll">
        一括実行
      </UButton>
      <span v-if="lastRunAt" class="text-xs text-gray-500 dark:text-gray-400 pb-2">
        最終実行: {{ lastRunAt }} — OK {{ summary.ok }} / WARN {{ summary.warn }} / NG {{ summary.ng }}
      </span>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full text-sm border-collapse">
        <thead>
          <tr class="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
            <th class="py-2 pr-3 font-medium">チェック</th>
            <th class="py-2 pr-3 font-medium">対象</th>
            <th class="py-2 pr-3 font-medium">結果</th>
            <th class="py-2 pr-3 font-medium">詳細</th>
            <th class="py-2 font-medium text-right">時間</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.check.id" class="border-b border-gray-100 dark:border-gray-800">
            <td class="py-2 pr-3">{{ row.check.label }}</td>
            <td class="py-2 pr-3 text-gray-500 dark:text-gray-400">{{ row.check.target }}</td>
            <td class="py-2 pr-3">
              <span v-if="row.state === 'pending'" class="text-gray-400">—</span>
              <span v-else-if="row.state === 'running'" class="text-gray-400">実行中…</span>
              <span
                v-else
                class="inline-block px-2 py-0.5 rounded text-xs font-semibold"
                :class="levelBadge(row.level).class"
              >{{ levelBadge(row.level).label }}</span>
            </td>
            <td class="py-2 pr-3">{{ row.detail ?? '' }}</td>
            <td class="py-2 text-right tabular-nums text-gray-500 dark:text-gray-400">
              <template v-if="row.ms != null">{{ row.ms }}ms</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
