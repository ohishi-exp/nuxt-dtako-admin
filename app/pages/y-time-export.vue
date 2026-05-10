<script setup lang="ts">
import { useAuth } from '@ippoan/auth-client'
import { getDrivers } from '~/utils/api'
import type { Driver } from '~/types'

const drivers = ref<Driver[]>([])
const selectedDriverCd = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const templateKey = ref('templates/kyoto-soft/base.xlsx')
const loading = ref(false)
const error = ref('')
const lastWarnings = ref<string[]>([])

const { token, orgId } = useAuth()

onMounted(async () => {
  try {
    drivers.value = await getDrivers()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'ドライバー一覧の取得に失敗しました'
  }
})

async function downloadXlsx() {
  if (!selectedDriverCd.value || !dateFrom.value || !dateTo.value) {
    error.value = 'ドライバー / 期間 を入力してください'
    return
  }

  loading.value = true
  error.value = ''
  lastWarnings.value = []

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (token.value) headers['authorization'] = `Bearer ${token.value}`
    if (orgId.value) headers['x-tenant-id'] = orgId.value

    const res = await fetch('/api/y-time-export', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        driver_cd: selectedDriverCd.value,
        from: dateFrom.value,
        to: dateTo.value,
        template_key: templateKey.value,
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`xlsx 生成失敗 (${res.status}): ${text || res.statusText}`)
    }

    const warnings = res.headers.get('x-y-time-warnings')
    if (warnings) {
      lastWarnings.value = decodeURIComponent(warnings).split(' / ')
    }
    const missing = res.headers.get('x-y-time-missing-dates')
    if (missing) {
      lastWarnings.value.push(`テンプレに日付が無い: ${missing}`)
    }

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const cd = res.headers.get('content-disposition') ?? ''
    const m = cd.match(/filename="([^"]+)"/)
    a.download = m ? m[1]! : `y_time_${selectedDriverCd.value}_${dateFrom.value}_${dateTo.value}.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'ダウンロードに失敗しました'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-2xl font-bold">Y時間 エクスポート</h2>

    <p class="text-sm text-gray-600 dark:text-gray-400">
      京都ソフト案件 等の証拠書類用 Excel テンプレ (Y時間 シート) に、KUDGIVT
      由来の日別 始業/終業/休憩 を自動追記してダウンロードします。テンプレは
      Cloudflare R2 (<code>dtako-uploads</code>) に配置されたものを参照します。
    </p>

    <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-1">ドライバー</label>
          <select
            v-model="selectedDriverCd"
            class="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800"
          >
            <option value="">— 選択 —</option>
            <option v-for="d in drivers" :key="d.id" :value="d.driver_cd">
              {{ d.driver_cd }} : {{ d.driver_name }}
            </option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">テンプレ Key (R2)</label>
          <input
            v-model="templateKey"
            type="text"
            class="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800 font-mono text-sm"
            placeholder="templates/kyoto-soft/base.xlsx"
          >
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-1">開始日</label>
          <input
            v-model="dateFrom"
            type="date"
            class="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800"
          >
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">終了日</label>
          <input
            v-model="dateTo"
            type="date"
            class="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800"
          >
        </div>
      </div>
      <div class="flex justify-end">
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          :disabled="loading || !selectedDriverCd || !dateFrom || !dateTo"
          @click="downloadXlsx"
        >
          <span v-if="loading">生成中...</span>
          <span v-else>ダウンロード</span>
        </button>
      </div>
    </div>

    <div v-if="error" class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
      {{ error }}
    </div>

    <div v-if="lastWarnings.length > 0" class="bg-yellow-50 border border-yellow-200 text-yellow-900 p-3 rounded text-sm space-y-1">
      <div class="font-semibold">⚠ 警告:</div>
      <ul class="list-disc list-inside">
        <li v-for="(w, i) in lastWarnings" :key="i">{{ w }}</li>
      </ul>
    </div>
  </div>
</template>
