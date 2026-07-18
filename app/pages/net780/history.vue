<script setup lang="ts">
/**
 * NET780 検索カタログ (D1 `dtako_uploads`、Refs #299) の検索・一覧ページ。
 *
 * 過去に `/net780` からダウンロード (→ R2 archive + D1 upsert) された運行を
 * 車輌名の部分一致 / 乗務員CD の完全一致で検索する。行クリックで `/net780`
 * に `?operationNo=` 付きで遷移し、R2 アーカイブから直接表示する。
 *
 * 車輌CD (vehicle_cd) は theearth の検索結果に含まれないため、ここでは
 * vehicle_name で検索する (vehicle-settings 側は vehicle_cd で検索できる —
 * 対象データの性質が異なるため検索キーを統一していない)。
 */

interface Net780HistoryRow {
  operation_no: string
  vehicle_name: string | null
  driver_cd1: string | null
  driver_name1: string | null
  start_datetime: string | null
  r2_key: string
  uploaded_at: string
}

const { session: net780Session, authHeaders: net780AuthHeaders, restoreSession: restoreNet780Session, expireSession: expireNet780Session } = useNet780Session()

const searchVehicleName = ref('')
const searchDriverCd1 = ref('')
const searching = ref(false)
const searchError = ref('')
const rows = ref<Net780HistoryRow[]>([])
const searched = ref(false)

onMounted(() => {
  restoreNet780Session()
})

watch(net780Session, (s) => {
  if (!s) {
    rows.value = []
    searched.value = false
  }
})

async function runHistorySearch() {
  if (searching.value || !net780Session.value) return
  searchError.value = ''
  searching.value = true
  try {
    const res = await $fetch<{ rows: Net780HistoryRow[] }>('/net780-api/history', {
      headers: net780AuthHeaders(),
      query: {
        vehicleName: searchVehicleName.value.trim() || undefined,
        driverCd1: searchDriverCd1.value.trim() || undefined,
      },
    })
    rows.value = res.rows
    searched.value = true
  }
  catch (e) {
    if (net780ErrorStatus(e) === 401) {
      expireNet780Session(net780ErrorMessage(e))
      return
    }
    searchError.value = net780ErrorMessage(e)
  }
  finally {
    searching.value = false
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { hour12: false })
}
</script>

<template>
  <div>
    <TheearthSessionHeader title="NET780 検索履歴" api-prefix="/net780-api" wide />

    <div class="max-w-4xl mx-auto p-6 space-y-6">
      <div class="flex justify-end">
        <NuxtLink to="/net780" class="text-sm text-blue-600 dark:text-blue-400 hover:underline">
          ← 検索・一括ダウンロードに戻る
        </NuxtLink>
      </div>

      <UCard>
        <template #header>
          <span class="font-semibold">過去にダウンロード済みの運行を検索</span>
        </template>
        <div class="flex flex-wrap items-end gap-4">
          <UFormField label="車輌名 (部分一致)">
            <UInput v-model="searchVehicleName" placeholder="例: いすゞ" />
          </UFormField>
          <UFormField label="乗務員CD (完全一致)">
            <UInput v-model="searchDriverCd1" placeholder="例: 12345" />
          </UFormField>
          <UButton
            :label="searching ? '検索中...' : '検索'"
            :loading="searching"
            :disabled="!net780Session"
            @click="runHistorySearch"
          />
        </div>
        <p v-if="!net780Session" class="text-sm text-gray-500 mt-3">
          検索するには上部で theearth にログインしてください。
        </p>
        <p v-if="searchError" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3 mt-3">
          {{ searchError }}
        </p>
      </UCard>

      <UCard v-if="searched">
        <template #header>
          <span class="font-semibold">検索結果 ({{ rows.length }} 件、最大200件)</span>
        </template>
        <div v-if="rows.length === 0" class="text-sm text-gray-500">
          該当する運行はありません。条件を変えて検索するか、
          <NuxtLink to="/net780" class="text-blue-600 dark:text-blue-400 hover:underline">
            検索・一括ダウンロード
          </NuxtLink>
          からダウンロードしてください。
        </div>
        <div v-else class="overflow-x-auto max-h-96 overflow-y-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
                <th class="px-2 py-2">運行日時</th>
                <th class="px-2 py-2">車輌名</th>
                <th class="px-2 py-2">乗務員CD</th>
                <th class="px-2 py-2">乗務員名</th>
                <th class="px-2 py-2">ダウンロード日時</th>
                <th class="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in rows"
                :key="row.operation_no"
                class="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40"
              >
                <td class="px-2 py-2 font-mono text-xs whitespace-nowrap">{{ row.start_datetime ?? '-' }}</td>
                <td class="px-2 py-2">{{ row.vehicle_name ?? '-' }}</td>
                <td class="px-2 py-2 font-mono text-xs">{{ row.driver_cd1 ?? '-' }}</td>
                <td class="px-2 py-2">{{ row.driver_name1 ?? '-' }}</td>
                <td class="px-2 py-2 font-mono text-xs whitespace-nowrap">{{ formatDate(row.uploaded_at) }}</td>
                <td class="px-2 py-2 text-right">
                  <NuxtLink
                    :to="`/net780?operationNo=${encodeURIComponent(row.operation_no)}`"
                    class="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    表示 →
                  </NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UCard>
    </div>
  </div>
</template>
