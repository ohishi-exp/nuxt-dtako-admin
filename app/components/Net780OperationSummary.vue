<script setup lang="ts">
/**
 * `/operations/[unko_no]` の NET780 タブ本体。運行No で D1 検索カタログ
 * (Refs #299) を引き、アーカイブ済みなら NET780 生データのサマリを表示する。
 * 詳細な速度チャート・GPS 軌跡は `/net780` 側のビューアに任せ、ここでは
 * 運行詳細画面と同じ場所で「NET780データがあるかどうか・概要」を確認できる
 * ことを優先する (フルビューアの埋め込みは別途検討、Refs #299 の後続候補)。
 */

import { extractSingleOperationZip, parseNet780Zip, buildNet780Summary } from '~/utils/net780'
import type { Net780Summary } from '~/utils/net780'

const props = defineProps<{
  operationNo: string
  operationDate?: string | null
  vehicleCd?: string | null
  driverCd?: string | null
}>()

/** 未アーカイブ時に /net780 へ渡す検索の初期値。運行日 (operation_date) を
 * 使う — この運行のものなので、/net780 自体の検索基準 (読取日) とは別に、
 * ここでは「この運行が行われた日」を渡すのが実用上妥当 (Refs #299)。車輌CD・
 * 乗務員CD も分かっていれば渡し、より絞り込んだ状態で検索フォームを開ける
 * ようにする。 */
const net780SearchLink = computed(() => {
  const params = new URLSearchParams()
  if (props.operationDate) params.set('operationDate', props.operationDate)
  if (props.vehicleCd) params.set('vehicleCd', props.vehicleCd)
  if (props.driverCd) params.set('driverCd', props.driverCd)
  const q = params.toString()
  return `/net780${q ? `?${q}` : ''}`
})

const loading = ref(false)
const notFound = ref(false)
const error = ref<string | null>(null)
const summary = ref<Net780Summary | null>(null)

async function load(operationNo: string) {
  loading.value = true
  notFound.value = false
  error.value = null
  summary.value = null
  try {
    const blob = await $fetch<Blob>('/api/net780/by-operation', {
      query: { operationNo },
      responseType: 'blob',
    })
    const bulkBytes = new Uint8Array(await blob.arrayBuffer())
    const singleBytes = await extractSingleOperationZip(bulkBytes)
    const result = await parseNet780Zip(singleBytes)
    summary.value = buildNet780Summary(result)
  }
  catch (e) {
    const status = (e as { statusCode?: number; response?: { status?: number } })?.statusCode
      ?? (e as { response?: { status?: number } })?.response?.status
    if (status === 404) {
      notFound.value = true
    }
    else {
      error.value = e instanceof Error ? e.message : 'NET780 データの取得に失敗しました'
    }
  }
  finally {
    loading.value = false
  }
}

watch(() => props.operationNo, (v) => { if (v) load(v) }, { immediate: true })
</script>

<template>
  <div class="p-4 space-y-4">
    <div v-if="loading" class="flex items-center gap-2 text-sm text-gray-500">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />
      NET780 データを取得中...
    </div>

    <div v-else-if="notFound" class="text-sm text-gray-500 space-y-2">
      <p>この運行の NET780 生データはまだダウンロード・アーカイブされていません。</p>
      <NuxtLink :to="net780SearchLink" class="text-blue-600 dark:text-blue-400 hover:underline">
        NET780 一括ダウンロードで検索する →
      </NuxtLink>
    </div>

    <p v-else-if="error" class="text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
      {{ error }}
    </p>

    <template v-else-if="summary">
      <dl class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <dt class="text-gray-500">車輌CD</dt>
          <dd class="font-medium">{{ summary.vehicleCode ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">乗務員CD</dt>
          <dd class="font-medium">{{ summary.driverCode ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">走行距離</dt>
          <dd class="font-medium">
            {{ summary.distanceKm !== null ? `${summary.distanceKm.toFixed(2)} km` : '-' }}
          </dd>
        </div>
        <div>
          <dt class="text-gray-500">端末ID</dt>
          <dd class="font-medium">{{ summary.deviceId ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">開始</dt>
          <dd class="font-medium">{{ summary.startAt ?? '-' }}</dd>
        </div>
        <div>
          <dt class="text-gray-500">終了</dt>
          <dd class="font-medium">{{ summary.endAt ?? '-' }}</dd>
        </div>
      </dl>
      <NuxtLink
        :to="`/net780?operationNo=${encodeURIComponent(operationNo)}`"
        class="inline-block text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        速度チャート・GPS軌跡など詳細を NET780 ビューアで見る →
      </NuxtLink>
    </template>
  </div>
</template>
