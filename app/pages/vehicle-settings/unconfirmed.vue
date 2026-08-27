<script setup lang="ts">
/**
 * 未確認車輛一覧 — backend の全車輛マスタ ∖ R2 に dump がある車輛。
 *
 * このリストに出ている車輛は「一度も dump がアップロードされていない」もの。
 * クリックで履歴ページに飛ぶ (選択状態で dump 一覧 = ゼロ件になる)。
 */

import { computed, ref, onMounted } from 'vue'
import { currentAccessToken } from '~/utils/api'
import { describeResponseFailure } from '~/utils/api-error'

/** この画面の「やり直し方」。**句点を付けない** (`describeResponseFailure` が文に組む)。
 * **ボタンの表記そのまま** (`再取得`) を書く — 画面に無い語で案内すると探させる。 */
const RETRY_LOAD = '「再取得」を押してください'

interface UnconfirmedVehicle {
  vehicle_cd: string
  vehicle_name: string
}

const items = ref<UnconfirmedVehicle[]>([])
const loading = ref(false)
const error = ref('')

const filter = ref('')
const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter(
    (v) =>
      v.vehicle_cd.toLowerCase().includes(q) || v.vehicle_name.toLowerCase().includes(q),
  )
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — この読み口が
    // `requireAuth` を通すようになった (Refs #988)。`postNet780Archive` と同じ扱い。
    const token = currentAccessToken()
    const res = await fetch('/api/vehicle-settings/unconfirmed', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      // **サーバの本文をそのまま貼らない** (Refs #996)。`/vehicle-settings` の抽出と
      // 同じ形だった — `HTTP 503: {"error":true,…}` のように JSON を画面に出し、
      // **次に何をすればいいかが 1 文字も無い**。この口は 503 (R2 binding 無し /
      // `INTERNAL_SHARED_SECRET` 未設定) と、upstream の status をそのまま中継する
      // 4xx/5xx を投げる。
      //
      // ★ **401 の出どころは 2 つある** — 上流 (auth-worker `/alc-proxy` が
      // fail-closed) と、自前の `requireAuth` (Refs #988 の続き)。`statusMessage` が
      // 別物になるが、**人がすべきこと (再ログイン) は同じ**なので同じ文が出る。
      // 両方を `tests/components/vehicle-settings-error-text.test.ts` で固定してある。
      throw new Error(`未確認車輛の取得に失敗しました: ${await describeResponseFailure(res, RETRY_LOAD)}`)
    }
    items.value = (await res.json()) as UnconfirmedVehicle[]
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold">未確認車輛</h2>
      <div class="flex gap-3 text-sm">
        <NuxtLink
          to="/vehicle-settings"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          抽出へ
        </NuxtLink>
        <NuxtLink
          to="/vehicle-settings/history"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          履歴へ
        </NuxtLink>
        <NuxtLink
          to="/vehicle-settings/diff"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          差分比較へ
        </NuxtLink>
      </div>
    </div>

    <p class="text-sm text-gray-600 dark:text-gray-400">
      車輛マスタ (backend <code>/api/dtako/vehicles</code>) のうち、R2 に dump が
      一件もアップロードされていない車輛を一覧します。
      <button
        type="button"
        class="text-blue-600 dark:text-blue-400 hover:underline"
        :disabled="loading"
        @click="load"
      >
        再取得
      </button>
    </p>

    <div v-if="loading" class="text-sm text-gray-500 dark:text-gray-400">
      読込中...
    </div>
    <div v-if="error" class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
      {{ error }}
    </div>

    <div
      v-if="!loading && !error && items.length === 0"
      class="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-700 text-emerald-900 dark:text-emerald-200 p-4 rounded text-sm"
    >
      ✓ 未確認車輛はありません。全車輛の設定 dump が R2 に存在します。
    </div>

    <div v-if="items.length > 0" class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
      <div class="flex justify-between items-baseline">
        <h3 class="font-semibold">未確認車輛一覧</h3>
        <span class="text-xs text-gray-500 dark:text-gray-400">
          {{ filtered.length }} / {{ items.length }} 車輛
        </span>
      </div>
      <input
        v-model="filter"
        type="text"
        placeholder="vehicle_cd / 車輛名 で絞り込み"
        class="w-full border rounded px-3 py-2 text-sm bg-white dark:bg-gray-800"
      >
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-gray-500 dark:text-gray-400 border-b">
          <tr>
            <th class="py-2 pr-3">vehicle_cd</th>
            <th class="py-2 pr-3">車輛名</th>
            <th class="py-2 pr-3 text-right" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="v in filtered"
            :key="v.vehicle_cd"
            class="border-b border-gray-100 dark:border-gray-800 last:border-0"
          >
            <td class="py-2 pr-3 font-mono">{{ v.vehicle_cd }}</td>
            <td class="py-2 pr-3">{{ v.vehicle_name || '-' }}</td>
            <td class="py-2 pr-3 text-right">
              <NuxtLink
                :to="`/vehicle-settings/history?vehicle_cd=${encodeURIComponent(v.vehicle_cd)}`"
                class="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                履歴ページへ →
              </NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
