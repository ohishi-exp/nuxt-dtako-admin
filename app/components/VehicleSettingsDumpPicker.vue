<script setup lang="ts">
/**
 * 1 つの dump (R2 の VehicleSettings JSON) を選ぶためのピッカー。
 *
 * フロー:
 *   1. vehicle_cd を入力 (datalist で R2 にある車輛 cd を autocomplete サジェスト)
 *   2. `GET /api/vehicle-settings/history?vehicle_cd=...` を取得して dump 一覧を表示
 *   3. dump (uploaded_at + dump_dir) を選択 → `GET /api/vehicle-settings/object?key=...` で JSON 取得
 *      - dump が 1 件しかない場合は自動選択 (ワンクリック節約 + 同一車輛 diff の手間軽減)
 *   4. 完了したら `selected` イベントを発火
 *
 * 使う側 (`/vehicle-settings/diff.vue`) は 左右 2 つこのコンポーネントを並べて
 * 、両方の selected が揃ったら diff を表示する。
 * available-vehicle-cds prop で親から datalist を受け取る
 * (両 picker で共通のサマリ fetch を 1 回だけ走らせるため)。
 */

import { computed, ref, watch } from 'vue'
import type { VehicleSettings } from '~/utils/vehicle-settings-cfg'
import { currentAccessToken } from '~/utils/api'
import { describeResponseFailure } from '~/utils/api-error'

/**
 * この picker の「やり直し方」。**句点を付けない** (`describeResponseFailure` が文に組む)。
 *
 * ★ **ボタンの表記は `history.vue` と違う** (Refs #1005)。同じ 2 本の route を叩き、
 * `/vehicle-settings/history` と見た目もほぼ同じだが、**こちらのボタンは「履歴取得」**
 * (`<span v-else>履歴取得</span>` — 「を」が無い)。**画面に無い語で案内すると探させる**
 * ので、文字列を共有せずこちらの表記で書く。
 */

/** 履歴一覧の取得。`vehicle_cd` は自由入力 (datalist はあくまでサジェスト) なので
 * **400 (`vehicle_cd は英数 / _ / - のみ`) が実際に来る**。 */
const RETRY_HISTORY = 'もう一度「履歴取得」を押してください'

/** dump 実体の取得。**行クリック (または 1 件のときの自動選択) で走るのでボタンは無い。**
 * この口だけ **404 (`object not found: <key>`) が来る** — 一覧を出した後に R2 から
 * 消えた形なので、**行を押し直す前に一覧を取り直す**のが正しい動線。
 * 404 だけは `describeResponseFailure` に通さない (下の `describeMissingDump` を見ること)。 */
const RETRY_DETAIL = '「履歴取得」で一覧を取り直し、行をクリックし直してください'

/**
 * ★ **暫定** — 404 をここで撃ち分ける (Refs #1005 #1021)。**恒久策は
 * `app/utils/api-error.ts` の `nextStepForStatus` に 404 の枝を足すこと (#1021)。**
 * いま足さないのは `api-error.ts` が別タスクの持ち物で、`coverage_100.toml` に
 * 登録された分岐数を兄弟タスクが測っている最中のため。**#1021 の着手は #1009 の
 * マージ後** (分岐数の注記が新しい実測値に置き換わってから) で、**そのとき
 * この関数と呼び出し側の `res.status === 404` は消える。**
 *
 * **`/vehicle-settings/history` の同名関数と中身が重複しているが、そのままにしてある** —
 * 共通化の置き場は `api-error.ts` で、今回そこを触れないため。恒久策を入れるときに
 * **両方まとめて消える**のが正しい畳み方。
 *
 * **`describeResponseFailure` に 404 を通すと嘘になる。** 404 は「その他 4xx」に落ちて
 * 前置きが「**送った内容をサーバが受け付けませんでした。上の理由のとおりに直してから**」に
 * なるが、**行をクリックしただけの人は何も送っていない**し、直せるものも無い。
 *
 * **本文は読まない。** `object.get.ts` の 404 は `object not found: <key>` の 1 種類しか
 * 無く、key を指す `dump dir` は選択中バナーに出ている。**本文から理由を組む処理は
 * `api-error.ts` の持ち物**なので、ここに写さない。
 */
function describeMissingDump(): string {
  return 'dump JSON の取得に失敗しました: 404 この dump は R2 にもう存在しません — '
    + `一覧を出した後に消えた可能性があります。${RETRY_DETAIL}`
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

const props = defineProps<{
  label: string
  initialVehicleCd?: string
  /** R2 に dump がある vehicle_cd の一覧。datalist のサジェストに使う */
  availableVehicleCds?: string[]
}>()

const emit = defineEmits<{
  (e: 'selected', payload: { key: string; settings: VehicleSettings } | null): void
}>()

const vehicleCd = ref(props.initialVehicleCd ?? '')
const items = ref<HistoryItem[]>([])
const itemsLoading = ref(false)
const itemsError = ref('')

const selectedKey = ref<string | null>(null)
const loadingDetail = ref(false)
const detailError = ref('')

// 選択中の item を items から逆引き (バナーに表示する整形済み日時用)
const selectedItem = computed<HistoryItem | null>(() => {
  if (!selectedKey.value) return null
  return items.value.find((i) => i.key === selectedKey.value) ?? null
})

// datalist の id は同ページで 2 つ使うので一意にしておく
const datalistId = computed(
  () => `vehicle-cd-options-${props.label.replace(/[^a-zA-Z0-9]/g, '-')}`,
)

async function loadHistory() {
  const cd = vehicleCd.value.trim()
  items.value = []
  selectedKey.value = null
  detailError.value = ''
  emit('selected', null)
  if (!cd) return
  itemsLoading.value = true
  itemsError.value = ''
  try {
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — この読み口が
    // `requireAuth` を通すようになった (Refs #988)。`postNet780Archive` と同じ扱い。
    const token = currentAccessToken()
    const res = await fetch(`/api/vehicle-settings/history?vehicle_cd=${encodeURIComponent(cd)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      // **reason phrase に落とさない** (Refs #1005 / #996 / #890)。`res.statusText` は
      // **本番 (workerd) では空**なので、画面に出ていたのは `HTTP 401: ` だけだった
      // (dev の node は埋めるので**再現しない**)。理由は本文
      // (`{ error: true, statusCode, statusMessage, message }`) に無傷で残っている。
      // この口は 401 (`requireAuth`) / 400 (`vehicle_cd` の形) / 503 (binding 未設定)。
      throw new Error(`履歴の取得に失敗しました: ${await describeResponseFailure(res, RETRY_HISTORY)}`)
    }
    items.value = (await res.json()) as HistoryItem[]
    // dump が 1 件しかなければ自動選択 (UX: 余分なクリックを省く)
    if (items.value.length === 1) {
      await selectDump(items.value[0]!)
    }
  } catch (e) {
    itemsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    itemsLoading.value = false
  }
}

async function selectDump(item: HistoryItem) {
  selectedKey.value = item.key
  detailError.value = ''
  loadingDetail.value = true
  emit('selected', null)
  try {
    // Refs #988 — 読み口が `requireAuth` を通すので Bearer も明示する。
    const token = currentAccessToken()
    const res = await fetch(`/api/vehicle-settings/object?key=${encodeURIComponent(item.key)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (res.status === 404) throw new Error(describeMissingDump())
    if (!res.ok) {
      // Refs #1005 — 叩く先が別 route (`object.get.ts`) なので **404 が増える**
      // (`object not found: <key>`)。404 だけは上で撃ち分けてある。
      // **やり直し方も上とは別**で、押し直すべきは行ではなく一覧の取り直し。
      throw new Error(`dump JSON の取得に失敗しました: ${await describeResponseFailure(res, RETRY_DETAIL)}`)
    }
    const settings = (await res.json()) as VehicleSettings
    emit('selected', { key: item.key, settings })
  } catch (e) {
    detailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingDetail.value = false
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ja-JP', { hour12: false })
}

// initialVehicleCd が后から入るケース (反対側の値をコピーしたとき等) に対応
watch(
  () => props.initialVehicleCd,
  (v) => {
    if (v && v !== vehicleCd.value) {
      vehicleCd.value = v
      loadHistory()
    }
  },
)

// datalist から選ぶと input の change イベントが発火するので、そのタイミングで
// 自動的に履歴をロードする。手動入力は Enter またはボタンでトリガー。
function onInputChange() {
  const cd = vehicleCd.value.trim()
  if (cd && props.availableVehicleCds?.includes(cd)) {
    loadHistory()
  }
}
</script>

<template>
  <!-- 選択状態が分かるように、card の border を色付け (選択中 = emerald、未選択 = gray) -->
  <div
    class="p-4 rounded-lg shadow space-y-3 border-2 transition-colors"
    :class="selectedKey
      ? 'bg-white dark:bg-gray-900 border-emerald-400 dark:border-emerald-600'
      : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800'"
  >
    <div class="flex justify-between items-baseline">
      <h3 class="font-semibold">{{ label }}</h3>
      <!-- ステータスバッジ (常時表示): 選択中 = 緑, 未選択 = 灰 -->
      <span
        v-if="selectedKey"
        class="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200"
      >
        ✓ 選択中
      </span>
      <span
        v-else
        class="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
      >
        未選択
      </span>
    </div>

    <!-- 選択中の dump 情報を分かりやすくバナー表示 -->
    <div
      v-if="selectedItem"
      class="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-700 p-2 rounded text-xs"
    >
      <div class="font-semibold text-emerald-900 dark:text-emerald-200">
        ✓ {{ vehicleCd }} / {{ formatDate(selectedItem.uploaded_at) }}
      </div>
      <div class="font-mono text-emerald-700 dark:text-emerald-400 text-[10px] break-all">
        {{ selectedItem.dump_dir }}
      </div>
    </div>

    <form class="flex gap-2 items-center" @submit.prevent="loadHistory">
      <label class="text-sm font-medium">車輛 cd</label>
      <input
        v-model="vehicleCd"
        type="text"
        :placeholder="availableVehicleCds && availableVehicleCds.length > 0 ? '例: 4437 (クリックで一覧)' : '例: 4437'"
        :list="datalistId"
        class="border rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 flex-1 font-mono"
        @change="onInputChange"
      >
      <datalist :id="datalistId">
        <option
          v-for="cd in availableVehicleCds ?? []"
          :key="cd"
          :value="cd"
        />
      </datalist>
      <button
        type="submit"
        class="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm disabled:opacity-50"
        :disabled="itemsLoading || !vehicleCd.trim()"
      >
        <span v-if="itemsLoading">読込中</span>
        <span v-else>履歴取得</span>
      </button>
    </form>

    <div v-if="itemsError" class="bg-red-50 border border-red-200 text-red-800 p-2 rounded text-xs">
      {{ itemsError }}
    </div>

    <div
      v-if="items.length > 1 && !selectedKey"
      class="text-xs text-amber-700 dark:text-amber-400 font-semibold"
    >
      ↓ 行をクリックして dump を選択してください ({{ items.length }} 件)
    </div>
    <div v-if="items.length > 0" class="max-h-72 overflow-auto border rounded">
      <table class="w-full text-xs">
        <thead class="bg-gray-50 dark:bg-gray-800 sticky top-0">
          <tr class="text-left text-gray-500 dark:text-gray-400">
            <th class="px-2 py-1 w-5" />
            <th class="px-2 py-1">アップロード</th>
            <th class="px-2 py-1">Main App</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="item in items"
            :key="item.key"
            class="border-t border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40"
            :class="selectedKey === item.key
              ? 'bg-emerald-100 dark:bg-emerald-900/40 font-semibold'
              : ''"
            @click="selectDump(item)"
          >
            <td class="px-2 py-1 text-center">
              <span
                v-if="selectedKey === item.key"
                class="text-emerald-600 dark:text-emerald-400"
              >✓</span>
              <span v-else class="text-gray-300 dark:text-gray-600">○</span>
            </td>
            <td class="px-2 py-1 font-mono whitespace-nowrap">
              {{ formatDate(item.uploaded_at) }}
            </td>
            <td class="px-2 py-1 font-mono">{{ item.firm_main_app ?? '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div
      v-else-if="vehicleCd.trim() && !itemsLoading && !itemsError"
      class="text-xs text-gray-500 dark:text-gray-400"
    >
      この車輛 cd の dump はありません。
    </div>

    <div v-if="loadingDetail" class="text-xs text-gray-500">JSON 読込中...</div>
    <div v-if="detailError" class="bg-red-50 border border-red-200 text-red-800 p-2 rounded text-xs">
      {{ detailError }}
    </div>
  </div>
</template>
