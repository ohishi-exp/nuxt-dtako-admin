<script setup lang="ts">
/**
 * インタンク燃料確認 (CakePHP の /fuel-intank の置き換え、Refs yhonda-ohishi/nginx#814)。
 * データは rust-fuel-worker の `/api/fuel/*` (alc-proxy 経由)。表の文字列と判定は
 * `app/utils/fuel-intank.ts` が組み、ここは並べるだけ。
 */
import {
  getFuelStarts, getFuelIntank, getFuelUnregisteredCards, getFuelCars, getFuelCards,
  createFuelCard, updateFuelIntankDtakoRow, deleteFuelIntank, uploadFuelCsv, downloadFuelUpload, recheckFuelIntank,
} from '~/utils/api'
import {
  startLabel, formatShortDatetime, formatQuantity, dtakoRowOptions, quantityDiff,
  isDiffHighlighted, totalQuantity, uploadResultText, sha256FromKey, describeCsvError,
} from '~/utils/fuel-intank'
import { carOptions } from '~/utils/fuel-cards'
import { canRecheck, describeManualError } from '~/utils/fuel-manual'
import { describeCaughtError, describeListFailure } from '~/utils/api-error'
import type { FuelStart, FuelIntankRow, FuelCar } from '~/types'

/** start を選ばないとき (最新 100 行) の選択肢の値。reka の Select は空文字の値を持てない */
const LATEST = '__latest__'

const starts = ref<FuelStart[]>([])
const selected = ref<string>(LATEST)
const rows = ref<FuelIntankRow[]>([])
const loading = ref(false)
const listError = ref<string | null>(null)

const cars = ref<FuelCar[]>([])
/** fuel_card_id → 車番 (最新 100 行の表は応答に car を持たないので card の一覧から引く) */
const carNameByCard = ref<Record<number, string>>({})
const unregistered = ref<number[]>([])
/**
 * 車両を選んでいる未登録カード (1 行ずつ) とその車両。★ 選択欄を全行に置かない — Reka UI の Select は
 * 閉じていても全選択肢を文書の外に描画して持つので、行数 × 車両数 ぶん重くなる (551 件 × 20 行で
 * 11.6 秒・ヒープ 565MB をスタブで実測。`/fuel/cards` が固まったのと同じ原因、Refs yhonda-ohishi/nginx#814)
 */
const choosingId = ref<number | null>(null)
const carChoice = ref<string | undefined>(undefined)
const registering = ref<number | null>(null)
const registerError = ref<string | null>(null)

const isDragging = ref(false)
const uploading = ref(false)
const uploadMessage = ref<string | null>(null)
const uploadError = ref<string | null>(null)
const uploadedSha = ref<string | null>(null)
const downloadError = ref<string | null>(null)

const editingKey = ref<string | null>(null)
const editValue = ref('')
const saving = ref(false)
const rowError = ref<string | null>(null)
const deleteTarget = ref<FuelIntankRow | null>(null)
const deleting = ref(false)
/** 再照合中の行 (rowKey)。押した行のボタンだけ回す */
const rechecking = ref<string | null>(null)
const recheckMessage = ref<string | null>(null)

const isMatching = computed(() => selected.value !== LATEST)
const selectedStart = computed(() => starts.value.find(s => s.datetime === selected.value) ?? null)
const startItems = computed(() => [
  { label: '(最新 100 行)', value: LATEST },
  ...starts.value.map(s => ({ label: startLabel(s), value: s.datetime })),
])
const carItems = computed(() => carOptions(cars.value))
const total = computed(() => totalQuantity(rows.value))

function rowKey(r: FuelIntankRow): string {
  return `${r.datetime};${r.fuel_card_id}`
}

function carName(r: FuelIntankRow): string {
  return r.car?.name ?? carNameByCard.value[r.fuel_card_id] ?? ''
}

async function loadRows() {
  loading.value = true
  listError.value = null
  try {
    rows.value = (await getFuelIntank(isMatching.value ? selected.value : undefined)).rows
  }
  catch (e) {
    rows.value = []
    listError.value = describeListFailure(e, 'start を選び直してください')
  }
  finally {
    loading.value = false
  }
}

async function loadStarts() {
  starts.value = (await getFuelStarts()).rows
}

async function loadCardsAndCars() {
  const [carsRes, cardsRes, unregRes] = await Promise.all([getFuelCars(), getFuelCards(), getFuelUnregisteredCards()])
  cars.value = carsRes.cars
  carNameByCard.value = Object.fromEntries(cardsRes.cards.filter(c => c.car?.name).map(c => [c.id, c.car!.name!]))
  unregistered.value = unregRes.fuel_card_ids
}

const masterError = ref<string | null>(null)
async function loadMasters() {
  masterError.value = null
  try {
    await Promise.all([loadStarts(), loadCardsAndCars()])
  }
  catch (e) {
    masterError.value = describeListFailure(e, '再読み込みしてください')
  }
}

watch(selected, () => {
  editingKey.value = null
  loadRows()
})

// --- アップロード (upload.vue のドラッグ&ドロップの形) ---

function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragging.value = true
}
function onDragLeave() {
  isDragging.value = false
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  const file = e.dataTransfer?.files[0]
  if (file) handleUpload(file)
}
function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) handleUpload(file)
  input.value = ''
}

async function handleUpload(file: File) {
  uploadMessage.value = null
  uploadError.value = null
  uploadedSha.value = null
  downloadError.value = null
  if (!/\.csv$/i.test(file.name)) {
    uploadError.value = 'CSV ファイル (UTRAN.CSV) を選択してください'
    return
  }
  uploading.value = true
  try {
    const res = await uploadFuelCsv(await file.arrayBuffer())
    uploadMessage.value = uploadResultText(res)
    uploadedSha.value = sha256FromKey(res.key)
    await loadMasters()
    if (res.latest_start && selected.value !== res.latest_start.datetime) {
      selected.value = res.latest_start.datetime // watch が表を読み直す
    }
    else {
      await loadRows()
    }
  }
  catch (e) {
    uploadError.value = (e instanceof Error ? describeCsvError(e.message) : null)
      ?? describeCaughtError(e, 'もう一度アップロードしてください')
  }
  finally {
    uploading.value = false
  }
}

async function downloadUploaded() {
  if (!uploadedSha.value) return
  downloadError.value = null
  try {
    await downloadFuelUpload(uploadedSha.value, '取り込み直後 (1 日以内) にもう一度押してください')
  }
  catch (e) {
    downloadError.value = e instanceof Error ? e.message : String(e)
  }
}

// --- 未登録カードの登録 ---

function startChoose(id: number) {
  choosingId.value = id
  carChoice.value = undefined
  registerError.value = null
}

async function registerCard(id: number) {
  const carId = carChoice.value
  if (!carId) return
  registering.value = id
  registerError.value = null
  try {
    await createFuelCard(id, carId)
    choosingId.value = null
    await loadCardsAndCars()
    await loadRows()
  }
  catch (e) {
    registerError.value = `card ${id}: ${describeCaughtError(e, 'もう一度「登録」を押してください')}`
  }
  finally {
    registering.value = null
  }
}

// --- dtako_row_id の付け替え・削除 ---

function startEdit(r: FuelIntankRow) {
  editingKey.value = rowKey(r)
  editValue.value = r.dtako_row_id ?? ''
  rowError.value = null
}

async function saveEdit(r: FuelIntankRow) {
  saving.value = true
  rowError.value = null
  try {
    await updateFuelIntankDtakoRow(r.datetime, r.fuel_card_id, editValue.value === '' ? null : editValue.value)
    editingKey.value = null
    await loadRows()
  }
  catch (e) {
    rowError.value = describeCaughtError(e, 'もう一度「保存」を押してください')
  }
  finally {
    saving.value = false
  }
}

async function confirmDelete() {
  const r = deleteTarget.value
  if (!r) return
  deleting.value = true
  rowError.value = null
  try {
    await deleteFuelIntank(r.datetime, r.fuel_card_id)
    deleteTarget.value = null
    await loadRows()
  }
  catch (e) {
    deleteTarget.value = null
    rowError.value = describeCaughtError(e, 'もう一度「削除」を押してください')
  }
  finally {
    deleting.value = false
  }
}

// --- 再照合 (dtako_row_id が空の行を照合し直し、manual を外す。CakePHP の recheck) ---

async function recheck(r: FuelIntankRow) {
  rechecking.value = rowKey(r)
  rowError.value = null
  recheckMessage.value = null
  try {
    const res = await recheckFuelIntank(r.datetime, r.fuel_card_id)
    const what = `${formatShortDatetime(r.datetime)} / card ${r.fuel_card_id}`
    const result = res.row.dtako_row_id ? `運行 ${res.row.dtako_row_id} に紐づけました` : '照合できる運行がありませんでした'
    // 上流の recheck は manual を外すので、手入力の行は以後 削除も手入力での上書きもできなくなる (409 not_manual)
    const unmarked = r.manual && !res.row.manual ? ' — 手入力の印を外したので、この行は削除も手入力での上書きもできなくなりました' : ''
    recheckMessage.value = `${what}: ${result}${unmarked}`
    await loadRows()
  }
  catch (e) {
    rowError.value = (e instanceof Error ? describeManualError(e.message) : null)
      ?? describeCaughtError(e, 'もう一度「再照合」を押してください')
  }
  finally {
    rechecking.value = null
  }
}

function printPage() {
  window.print()
}

onMounted(() => {
  loadMasters()
  loadRows()
})
</script>

<template>
  <div class="fuel-intank space-y-4">
    <div class="flex flex-wrap items-center gap-3 fuel-no-print">
      <h2 class="text-xl font-bold mr-auto">インタンク燃料確認</h2>
      <USelect v-model="selected" :items="startItems" class="w-64" />
      <UButton to="/fuel/manual" icon="i-lucide-pencil" variant="outline" label="手入力" />
      <UButton to="/fuel/cards" icon="i-lucide-credit-card" variant="outline" label="カード" />
      <UButton icon="i-lucide-printer" variant="outline" label="印刷" @click="printPage" />
    </div>

    <!-- CSV アップロード -->
    <div
      class="fuel-no-print border-2 border-dashed rounded-xl p-4 text-center transition-colors cursor-pointer"
      :class="isDragging
        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
        : 'border-gray-300 dark:border-gray-700 hover:border-gray-400'"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="($refs.fileInput as HTMLInputElement).click()"
    >
      <p class="text-sm text-gray-600 dark:text-gray-400">
        <UIcon name="i-lucide-upload-cloud" class="size-5 align-middle mr-1" />
        UTRAN.CSV をドラッグ＆ドロップ、またはクリックして選択
      </p>
      <input ref="fileInput" type="file" accept=".csv,.CSV" class="hidden" @change="onFileSelect">
    </div>
    <div v-if="uploading" class="flex items-center gap-2 text-sm fuel-no-print">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />アップロード中...
    </div>
    <UAlert v-if="uploadMessage" class="fuel-no-print" color="success" variant="subtle" icon="i-lucide-check-circle" :title="uploadMessage">
      <template v-if="uploadedSha" #description>
        <UButton size="xs" variant="link" icon="i-lucide-download" label="取り込んだ CSV をダウンロード (1 日以内)" class="px-0" @click="downloadUploaded" />
        <span v-if="downloadError" class="block text-red-600">{{ downloadError }}</span>
      </template>
    </UAlert>
    <UAlert v-if="uploadError" class="fuel-no-print" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="アップロードに失敗しました" :description="uploadError" />
    <UAlert v-if="masterError" class="fuel-no-print" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="start・車両・カードの一覧を読めませんでした" :description="masterError" />

    <!-- 未登録カード -->
    <div v-if="unregistered.length > 0" class="fuel-no-print">
      <h3 class="font-medium mb-1">未登録のカード ({{ unregistered.length }} 件)</h3>
      <table class="fuel-table">
        <thead>
          <tr><th>card_id</th><th>車両</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="id in unregistered" :key="id">
            <td class="text-right">{{ id }}</td>
            <template v-if="choosingId === id">
              <td>
                <USelectMenu v-model="carChoice" :items="carItems" value-key="value" :search-input="{ placeholder: '車番・id で検索' }" placeholder="車両を選択" class="w-64" size="sm" />
              </td>
              <td class="whitespace-nowrap">
                <UButton size="sm" label="登録" :disabled="!carChoice" :loading="registering === id" @click="registerCard(id)" />
                <UButton size="sm" variant="outline" label="取消" class="ml-1" @click="choosingId = null" />
              </td>
            </template>
            <template v-else>
              <td class="text-gray-500">(未登録)</td>
              <td><UButton size="sm" variant="outline" label="車両を選ぶ" @click="startChoose(id)" /></td>
            </template>
          </tr>
        </tbody>
      </table>
      <p v-if="registerError" class="text-sm text-red-600 mt-1">{{ registerError }}</p>
    </div>

    <!-- 給油の表 -->
    <div>
      <template v-if="selectedStart">
        <h3 class="text-lg font-bold">スタートデータNO {{ selectedStart.slip_num }}</h3>
        <p class="text-sm text-gray-600 dark:text-gray-400">計算は、対象運行NOの、給油日当日に入力されたデータのみ集計する。</p>
      </template>
      <p v-else class="text-sm text-gray-600 dark:text-gray-400 fuel-no-print">最新 100 行を新しい順に出しています。start を選ぶと dtako との突き合わせを出します。</p>
      <UAlert v-if="listError" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="給油の一覧を読めませんでした" :description="listError" class="my-2" />
      <UAlert v-if="rowError" color="error" variant="subtle" icon="i-lucide-alert-triangle" :description="rowError" class="my-2 fuel-no-print" />
      <UAlert v-if="recheckMessage" color="success" variant="subtle" icon="i-lucide-check-circle" :description="recheckMessage" class="my-2 fuel-no-print" />
      <div v-if="loading" class="flex items-center gap-2 text-sm my-2">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />読み込み中...
      </div>
      <div v-else class="overflow-x-auto">
        <table class="fuel-table">
          <thead>
            <tr>
              <th>D番号</th><th>card_id</th><th>車番</th><th>日時</th><th>数量</th>
              <template v-if="isMatching">
                <th>D数量</th><th>差異</th><th>乗務員</th><th>dtako_row_id</th><th>車番</th><th>出庫日時</th><th>帰庫日時</th>
              </template>
              <th class="fuel-no-print" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="rowKey(r)">
              <td class="text-right">{{ r.slip_num }}</td>
              <td class="text-right">{{ r.fuel_card_id }}</td>
              <td>{{ carName(r) }}</td>
              <td>{{ formatShortDatetime(r.datetime) }}</td>
              <td class="text-right">{{ r.qt == null ? '' : formatQuantity(r.qt) }}</td>
              <template v-if="isMatching">
                <td class="text-right">{{ r.dtako_fuel_sum == null ? '' : formatQuantity(r.dtako_fuel_sum) }}</td>
                <td class="text-right" :class="{ 'fuel-diff': isDiffHighlighted(r) }">
                  {{ quantityDiff(r) == null ? '集計なし' : formatQuantity(quantityDiff(r)!) }}
                </td>
                <td>{{ r.dtako_row?.driver_name ?? '' }}</td>
                <td>
                  <div v-if="editingKey === rowKey(r)" class="flex items-center gap-1 fuel-no-print">
                    <select v-model="editValue" class="border rounded px-1 py-0.5 text-sm bg-white dark:bg-gray-900">
                      <option value="">(紐づけを外す)</option>
                      <option v-for="(o, i) in dtakoRowOptions(r.dtako_fuel_array, r.dtako_row_id)" :key="i" :value="o.value">{{ o.label }}</option>
                    </select>
                    <UButton size="xs" label="保存" :loading="saving" @click="saveEdit(r)" />
                    <UButton size="xs" variant="outline" label="取消" @click="editingKey = null" />
                  </div>
                  <span v-else>{{ r.dtako_row_id ?? '' }}</span>
                </td>
                <td>{{ r.dtako_row?.car_name ?? '' }}</td>
                <td>{{ formatShortDatetime(r.dtako_row?.departed_at) }}</td>
                <td>{{ formatShortDatetime(r.dtako_row?.returned_at) }}</td>
              </template>
              <td class="fuel-no-print whitespace-nowrap">
                <UButton v-if="isMatching && editingKey !== rowKey(r)" size="xs" variant="outline" label="編集" @click="startEdit(r)" />
                <UButton v-if="canRecheck(r)" size="xs" variant="outline" label="再照合" class="ml-1" :loading="rechecking === rowKey(r)" :disabled="rechecking !== null" @click="recheck(r)" />
                <UButton v-if="r.manual" size="xs" color="error" variant="outline" label="削除" class="ml-1" @click="deleteTarget = r" />
              </td>
            </tr>
            <tr v-if="rows.length === 0 && !listError">
              <td :colspan="isMatching ? 13 : 6" class="text-center text-gray-500">給油の行がありません</td>
            </tr>
            <tr class="font-medium">
              <td colspan="4" class="text-right">合計</td>
              <td class="text-right">{{ formatQuantity(total) }}</td>
              <td :colspan="isMatching ? 8 : 1" />
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <UModal :open="deleteTarget !== null" @update:open="(v: boolean) => { if (!v) deleteTarget = null }">
      <template #content>
        <div class="p-6 space-y-4">
          <h3 class="text-lg font-bold">給油の行の削除</h3>
          <p v-if="deleteTarget" class="text-gray-600 dark:text-gray-400">
            {{ formatShortDatetime(deleteTarget.datetime) }} / card {{ deleteTarget.fuel_card_id }} の行を削除しますか？この操作は取り消せません。
          </p>
          <div class="flex justify-end gap-2">
            <UButton label="キャンセル" variant="outline" @click="deleteTarget = null" />
            <UButton label="削除" color="error" :loading="deleting" @click="confirmDelete" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.fuel-table {
  border-collapse: collapse;
  font-size: 0.875rem;
}
.fuel-table th,
.fuel-table td {
  border: 1px solid var(--ui-border);
  padding: 2px 4px;
  white-space: nowrap;
}
.fuel-diff {
  background-color: #fde68a;
  /* 印刷は既定で背景色を落とすので、差異の強調だけは紙に残す */
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}
</style>

<style>
/* CakePHP の @media print と同じ: 操作を隠し、A4 に収まるよう文字を小さくする。`aside` は scoped では
   効かないので非 scoped。**`@page` は書かない** — 素の `@page` は SPA で他の画面の印刷にも残り、
   粗利・拘束×賃金の `@page { size: A4 landscape }` とぶつかる。名前付き page (`page: …`) は、この画面が
   layouts の flex (サイドバーと横並び) の中にあるので効かない (headless Chrome の printToPDF で実測)。
   代わりに表を詰めて、A4 縦の既定の余白 (印字幅 約 718px) でも 1 行に収まる大きさにする。 */
@media print {
  aside { display: none !important; }
  .fuel-intank .fuel-no-print { display: none !important; }
  /* scoped の `.fuel-table td[data-v-…]` に詳細度で負けるので !important */
  .fuel-intank th,
  .fuel-intank td { font-size: 9px; padding: 1px 2px !important; }
  /* layouts の <main> の p-6 は紙では余白の二重取りになる。この画面を載せた <main> だけ外す
     (`:has` で絞るので、他の画面の印刷には効かない) */
  main:has(> .fuel-intank) { padding: 0 !important; }
}
</style>
