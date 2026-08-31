<script setup lang="ts">
/**
 * 車輛設定 履歴ビューア — R2 に保存済みの dump を vehicle_cd で絞り込んで一覧 + 個別表示。
 *
 * - 引数なし `GET /api/vehicle-settings/history` → 全車輛 cd の集計 (件数 / 最新)
 * - vehicle_cd 入力後 `?vehicle_cd=XXXX` → 該当車輛の dump 一覧
 * - 一覧 行クリック → `?key=...` で JSON 取得 → `<VehicleSettingsDisplay>` で表示
 *
 * URL の `?vehicle_cd=...` を onMount で拾うようにして、
 * `/vehicle-settings/unconfirmed` など他ページからディープリンクで飛べるようにしてある。
 */

import { computed, ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import VehicleSettingsDisplay from '~/components/VehicleSettingsDisplay.vue'
import type { VehicleSettings } from '~/utils/vehicle-settings-cfg'
import { currentAccessToken } from '~/utils/api'
import { describeResponseFailure } from '~/utils/api-error'

/**
 * この画面の「やり直し方」。**句点を付けない** (`describeResponseFailure` が文に組む)。
 *
 * ★ **3 つとも別物にしてある** (Refs #1005)。3 つのうち 2 つは同じ route
 * (`/api/vehicle-settings/history`) を叩くが、**画面の「次の一手」は違う** —
 * 上の集計はボタンが無く、下の履歴はボタンがある。**まとめない。**
 */

/** 下部「登録済み車輛一覧」の集計。**この画面に再取得ボタンは 1 つも無い**
 * (`loadSummary` は `onMounted` からしか呼ばれない) ので、**無いボタンの名前で
 * 案内しない** — ページの再読み込みで案内する。
 * 来るのは 401 (`requireAuth`) と 503 (`INTERNAL_SHARED_SECRET` / `DTAKO_R2` binding
 * 未設定) — **引数無しの集計なので 400 は来ない**。 */
const RETRY_SUMMARY = 'ページを再読み込みしてください'

/** 履歴の取得。**ボタンの表記そのまま** (`<span v-else>履歴を取得</span>`)。
 * `vehicle_cd` は自由入力なので **400 (`vehicle_cd は英数 / _ / - のみ`) が実際に来る**
 * — 「上の理由のとおりに直してから」の続きが、そのまま入力を直して押し直す動線になる。 */
const RETRY_HISTORY = 'もう一度「履歴を取得」を押してください'

/** dump 実体の取得。**行クリックで開くのでボタンは無い。**
 * この口だけ **404 (`object not found: <key>`) が来る** — 一覧を出した後に R2 から
 * 消えた形なので、**行を押し直す前に一覧を取り直す**のが正しい動線。
 * **404 の前置きは `nextStepForStatus` が持つ** (Refs #1021) ので、ここは
 * 「やり直し方」だけを渡す。#1005 の暫定 (`describeMissingDump` + `res.status === 404`)
 * は恒久策と引き換えに消してある — **呼び出し側へ戻さないこと**。
 * key は一覧から来るので 400 (key の形) は事実上来ない。 */
const RETRY_DETAIL = '「履歴を取得」で一覧を取り直し、行をクリックし直してください'

interface VehicleSummary {
  vehicle_cd: string
  count: number
  latest_uploaded_at: string
}
interface HistoryItem {
  key: string
  vehicle_cd: string
  dump_dir: string
  uploaded_at: string
  size: number
  machine_id: string | null
  firm_main_app: string | null
}

const route = useRoute()

const summary = ref<VehicleSummary[]>([])
const summaryLoading = ref(false)
const summaryError = ref('')

const vehicleCd = ref('')
const items = ref<HistoryItem[]>([])
const itemsLoading = ref(false)
const itemsError = ref('')

const selectedKey = ref<string | null>(null)
const detail = ref<VehicleSettings | null>(null)
const detailLoading = ref(false)
const detailError = ref('')

const summaryFilter = ref('')
const filteredSummary = computed(() => {
  const q = summaryFilter.value.trim().toLowerCase()
  if (!q) return summary.value
  return summary.value.filter((s) => s.vehicle_cd.toLowerCase().includes(q))
})

/**
 * この画面の 3 つの読み口に共通の GET (Refs #1068)。**画面に出る 1 文をここで組む** —
 * 形は 3 か所とも `${prefix}: ${describeResponseFailure(res, retry)}` で同じで、
 * 違うのは `prefix` と**やり直し方** (`RETRY_*`) だけ。**実際に来る status の顔ぶれは
 * 口ごとに違う**ので、それは上の `RETRY_*` の注記が持つ。
 *
 * - 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
 *   経路でも通るよう `Authorization: Bearer` も明示する — 読み口が `requireAuth` を
 *   通すようになった (Refs #988)。`postNet780Archive` と同じ扱い。
 * - **reason phrase に落とさない** (Refs #1005 / #996 / #890)。`res.statusText` は
 *   **本番 (workerd) では空**なので、画面に出ていたのは `HTTP 503: ` だけだった
 *   (dev の node は埋めるので**再現しない**)。理由は本文
 *   (`{ error: true, statusCode, statusMessage, message }`) に無傷で残っている。
 */
async function getJson<T>(url: string, prefix: string, retry: string): Promise<T> {
  const token = currentAccessToken()
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error(`${prefix}: ${await describeResponseFailure(res, retry)}`)
  return (await res.json()) as T
}

async function loadSummary() {
  summaryLoading.value = true
  summaryError.value = ''
  try {
    summary.value = await getJson<VehicleSummary[]>(
      '/api/vehicle-settings/history', '登録済み車輛一覧の取得に失敗しました', RETRY_SUMMARY)
  } catch (e) {
    summaryError.value = e instanceof Error ? e.message : String(e)
  } finally {
    summaryLoading.value = false
  }
}

async function loadHistory(cd: string) {
  vehicleCd.value = cd
  items.value = []
  selectedKey.value = null
  detail.value = null
  if (!cd) return
  itemsLoading.value = true
  itemsError.value = ''
  try {
    items.value = await getJson<HistoryItem[]>(
      `/api/vehicle-settings/history?vehicle_cd=${encodeURIComponent(cd)}`, '履歴の取得に失敗しました', RETRY_HISTORY)
  } catch (e) {
    itemsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    itemsLoading.value = false
  }
}

async function loadDetail(key: string) {
  selectedKey.value = key
  detail.value = null
  detailLoading.value = true
  detailError.value = ''
  try {
    detail.value = await getJson<VehicleSettings>(
      `/api/vehicle-settings/object?key=${encodeURIComponent(key)}`, 'dump JSON の取得に失敗しました', RETRY_DETAIL)
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    detailLoading.value = false
  }
}

function submitVehicleCd(e: Event) {
  e.preventDefault()
  loadHistory(vehicleCd.value.trim())
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { hour12: false })
}

onMounted(() => {
  loadSummary()
  // ?vehicle_cd= クエリで初期値セット + 自動ロード (未確認ページからのディープリンク)
  const q = route.query.vehicle_cd
  const initialCd = typeof q === 'string' ? q : Array.isArray(q) ? (q[0] ?? '') : ''
  if (initialCd) loadHistory(initialCd)
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex justify-between items-center">
      <h2 class="text-2xl font-bold">車輛設定 履歴</h2>
      <div class="flex gap-3 text-sm">
        <NuxtLink
          to="/vehicle-settings"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          ← 抽出に戻る
        </NuxtLink>
        <NuxtLink
          :to="vehicleCd ? `/vehicle-settings/diff?left=${encodeURIComponent(vehicleCd)}&right=${encodeURIComponent(vehicleCd)}` : '/vehicle-settings/diff'"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          差分比較 →
        </NuxtLink>
        <NuxtLink
          to="/vehicle-settings/unconfirmed"
          class="text-blue-600 dark:text-blue-400 hover:underline"
        >
          未確認車輛 →
        </NuxtLink>
      </div>
    </div>

    <p class="text-sm text-gray-600 dark:text-gray-400">
      過去にアップロードされた車輛設定 dump (R2 <code>vehicle-settings/</code>) を
      vehicle_cd ごとに参照します。
    </p>

    <!-- 検索 -->
    <form
      class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow flex gap-2 items-center"
      @submit="submitVehicleCd"
    >
      <label for="vehicle-cd" class="text-sm font-medium">車輛 cd</label>
      <input
        id="vehicle-cd"
        v-model="vehicleCd"
        type="text"
        placeholder="例: 4437"
        class="border rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 flex-1 max-w-xs font-mono"
      >
      <button
        type="submit"
        class="px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm disabled:opacity-50"
        :disabled="itemsLoading || !vehicleCd.trim()"
      >
        <span v-if="itemsLoading">読込中...</span>
        <span v-else>履歴を取得</span>
      </button>
    </form>

    <div v-if="itemsError" class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
      {{ itemsError }}
    </div>

    <!-- 該当車輛の dump 一覧 -->
    <div v-if="items.length > 0" class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow">
      <h3 class="font-semibold mb-2">
        {{ vehicleCd }} の dump ({{ items.length }} 件)
      </h3>
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-gray-500 dark:text-gray-400 border-b">
          <tr>
            <th class="py-2 pr-3">アップロード日時</th>
            <th class="py-2 pr-3">dump dir</th>
            <th class="py-2 pr-3">MachineID</th>
            <th class="py-2 pr-3">Main App</th>
            <th class="py-2 pr-3 text-right">size</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.key"
            class="border-b border-gray-100 dark:border-gray-800 last:border-0 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40"
            :class="selectedKey === item.key ? 'bg-blue-50 dark:bg-blue-950/40' : ''"
            @click="loadDetail(item.key)"
          >
            <td class="py-2 pr-3 font-mono text-xs whitespace-nowrap">
              {{ formatDate(item.uploaded_at) }}
            </td>
            <td class="py-2 pr-3 font-mono text-xs">{{ item.dump_dir }}</td>
            <td class="py-2 pr-3 font-mono text-xs">{{ item.machine_id ?? '-' }}</td>
            <td class="py-2 pr-3 font-mono text-xs">{{ item.firm_main_app ?? '-' }}</td>
            <td class="py-2 pr-3 font-mono text-xs text-right">{{ item.size }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-else-if="vehicleCd && !itemsLoading && !itemsError"
      class="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-300 dark:border-yellow-700 text-yellow-900 dark:text-yellow-200 p-3 rounded text-sm"
    >
      この車輛 cd の dump はまだ R2 にありません。
    </div>

    <!-- 個別 dump 詳細 -->
    <div v-if="detailLoading" class="text-sm text-gray-500 dark:text-gray-400">
      dump JSON を読み込み中...
    </div>
    <div v-if="detailError" class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
      {{ detailError }}
    </div>
    <VehicleSettingsDisplay v-if="detail" :data="detail" />

    <!-- 全車輛集計 (画面下部、参考情報) -->
    <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
      <div class="flex justify-between items-baseline">
        <h3 class="font-semibold">登録済み車輛一覧</h3>
        <span class="text-xs text-gray-500 dark:text-gray-400">
          {{ filteredSummary.length }} / {{ summary.length }} 車輛
        </span>
      </div>
      <input
        v-model="summaryFilter"
        type="text"
        placeholder="vehicle_cd で絞り込み"
        class="w-full border rounded px-3 py-2 text-sm bg-white dark:bg-gray-800 font-mono"
      >
      <div v-if="summaryLoading" class="text-sm text-gray-500 dark:text-gray-400">
        集計を読み込み中...
      </div>
      <div
        v-else-if="summaryError"
        class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm"
      >
        {{ summaryError }}
      </div>
      <div
        v-else-if="filteredSummary.length === 0"
        class="text-sm text-gray-500 dark:text-gray-400"
      >
        R2 にまだ dump がありません。
      </div>
      <table v-else class="w-full text-sm">
        <thead class="text-left text-xs text-gray-500 dark:text-gray-400 border-b">
          <tr>
            <th class="py-2 pr-3">vehicle_cd</th>
            <th class="py-2 pr-3 text-right">件数</th>
            <th class="py-2 pr-3">最新アップロード</th>
            <th class="py-2 pr-3" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in filteredSummary"
            :key="s.vehicle_cd"
            class="border-b border-gray-100 dark:border-gray-800 last:border-0"
          >
            <td class="py-2 pr-3 font-mono">{{ s.vehicle_cd }}</td>
            <td class="py-2 pr-3 font-mono text-right">{{ s.count }}</td>
            <td class="py-2 pr-3 font-mono text-xs">{{ formatDate(s.latest_uploaded_at) }}</td>
            <td class="py-2 pr-3 text-right">
              <button
                class="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                @click="loadHistory(s.vehicle_cd)"
              >
                履歴を開く →
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
