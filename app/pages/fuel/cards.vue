<script setup lang="ts">
/**
 * 給油カード (CakePHP の /fuel-cards の置き換え、Refs yhonda-ohishi/nginx#814)。
 * 一覧・追加・車両の変更・終了日時の設定・削除。データは rust-fuel-worker の `/api/fuel/cards`。
 *
 * ★ 車両の選択は「編集」を押した 1 行にだけ出す。Reka UI の Select / SelectMenu は**閉じていても**
 * 全選択肢を文書の外の fragment に描画して持つので、全行に置くと 行数 × 車両数 ぶんのコンポーネントが
 * 常に生きる。本番の 115 行 × 551 件で画面が固まった (スタブで再現: 40 行 × 551 件でノード 50 万・
 * ヒープ 1GB・30 秒超。Refs yhonda-ohishi/nginx#814)。
 */
import { getFuelCards, getFuelCars, createFuelCard, updateFuelCard, deleteFuelCard } from '~/utils/api'
import { carOptions, toDatetimeLocal, cardPatch } from '~/utils/fuel-cards'
import { formatShortDatetime } from '~/utils/fuel-intank'
import { describeCaughtError, describeListFailure } from '~/utils/api-error'
import type { FuelCard, FuelCar } from '~/types'

const cards = ref<FuelCard[]>([])
const cars = ref<FuelCar[]>([])
const loading = ref(false)
const listError = ref<string | null>(null)
const actionError = ref<string | null>(null)

/** 編集中の行 (card id) とその値。編集は 1 行ずつ */
const editingId = ref<number | null>(null)
const draftCar = ref<string | undefined>(undefined)
const draftEnd = ref('')
const savingId = ref<number | null>(null)

const newId = ref<number | undefined>(undefined)
const newCar = ref<string | undefined>(undefined)
const adding = ref(false)

const deleteTarget = ref<FuelCard | null>(null)
const deleting = ref(false)

const carItems = computed(() => carOptions(cars.value))

function startEdit(c: FuelCard) {
  editingId.value = c.id
  draftCar.value = c.car_id ?? undefined
  draftEnd.value = toDatetimeLocal(c.end_datetime)
  actionError.value = null
}

const editingPatch = computed(() => {
  const c = cards.value.find(x => x.id === editingId.value)
  return c ? cardPatch(c, draftCar.value, draftEnd.value) : null
})

async function load() {
  loading.value = true
  listError.value = null
  try {
    const [cardsRes, carsRes] = await Promise.all([getFuelCards(), getFuelCars()])
    cards.value = cardsRes.cards
    cars.value = carsRes.cars
  }
  catch (e) {
    cards.value = []
    listError.value = describeListFailure(e, '再読み込みしてください')
  }
  finally {
    loading.value = false
  }
}

async function save(c: FuelCard) {
  const patch = editingPatch.value
  if (!patch) return
  savingId.value = c.id
  actionError.value = null
  try {
    await updateFuelCard(c.id, patch)
    editingId.value = null
    await load()
  }
  catch (e) {
    actionError.value = `card ${c.id}: ${describeCaughtError(e, 'もう一度「保存」を押してください')}`
  }
  finally {
    savingId.value = null
  }
}

async function add() {
  if (newId.value == null || !newCar.value) return
  adding.value = true
  actionError.value = null
  try {
    await createFuelCard(newId.value, newCar.value)
    newId.value = undefined
    newCar.value = undefined
    await load()
  }
  catch (e) {
    actionError.value = describeCaughtError(e, 'もう一度「追加」を押してください')
  }
  finally {
    adding.value = false
  }
}

async function confirmDelete() {
  const c = deleteTarget.value
  if (!c) return
  deleting.value = true
  actionError.value = null
  try {
    await deleteFuelCard(c.id)
    deleteTarget.value = null
    await load()
  }
  catch (e) {
    deleteTarget.value = null
    actionError.value = `card ${c.id}: ${describeCaughtError(e, 'もう一度「削除」を押してください')}`
  }
  finally {
    deleting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-xl font-bold mr-auto">給油カード</h2>
      <UButton to="/fuel/intank" icon="i-lucide-fuel" variant="outline" label="インタンク燃料確認" />
    </div>

    <UAlert v-if="listError" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="カードの一覧を読めませんでした" :description="listError" />
    <UAlert v-if="actionError" color="error" variant="subtle" icon="i-lucide-alert-triangle" :description="actionError" />

    <div class="flex flex-wrap items-end gap-2">
      <UFormField label="card_id">
        <UInput v-model.number="newId" type="number" class="w-32" />
      </UFormField>
      <UFormField label="車両">
        <USelectMenu v-model="newCar" :items="carItems" value-key="value" :search-input="{ placeholder: '車番・id で検索' }" placeholder="車両を選択" class="w-64" />
      </UFormField>
      <UButton label="追加" icon="i-lucide-plus" :disabled="newId == null || !newCar" :loading="adding" @click="add" />
    </div>

    <div v-if="loading" class="flex items-center gap-2 text-sm">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />読み込み中...
    </div>
    <div v-else class="overflow-x-auto">
      <table class="fuel-table">
        <thead>
          <tr><th>card_id</th><th>車両</th><th>終了日時</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="c in cards" :key="c.id">
            <td class="text-right">{{ c.id }}</td>
            <template v-if="editingId === c.id">
              <td>
                <USelectMenu v-model="draftCar" :items="carItems" value-key="value" :search-input="{ placeholder: '車番・id で検索' }" placeholder="車両を選択" class="w-64" size="sm" />
              </td>
              <td><input v-model="draftEnd" type="datetime-local" class="border rounded px-1 py-0.5 text-sm bg-white dark:bg-gray-900"></td>
              <td class="whitespace-nowrap">
                <UButton size="xs" label="保存" :disabled="editingPatch === null" :loading="savingId === c.id" @click="save(c)" />
                <UButton size="xs" variant="outline" label="取消" class="ml-1" @click="editingId = null" />
              </td>
            </template>
            <template v-else>
              <td>{{ c.car?.name || c.car_id || '' }}</td>
              <td>{{ formatShortDatetime(c.end_datetime) }}</td>
              <td class="whitespace-nowrap">
                <UButton size="xs" variant="outline" label="編集" @click="startEdit(c)" />
                <UButton size="xs" color="error" variant="outline" label="削除" class="ml-1" @click="deleteTarget = c" />
              </td>
            </template>
          </tr>
          <tr v-if="cards.length === 0 && !listError">
            <td colspan="4" class="text-center text-gray-500">カードがありません</td>
          </tr>
        </tbody>
      </table>
      <p class="text-xs text-gray-500 mt-1">「編集」で車両と終了日時を変えられます。終了日時を空にして「保存」すると、終了日時を外します。</p>
    </div>

    <UModal :open="deleteTarget !== null" @update:open="(v: boolean) => { if (!v) deleteTarget = null }">
      <template #content>
        <div class="p-6 space-y-4">
          <h3 class="text-lg font-bold">給油カードの削除</h3>
          <p v-if="deleteTarget" class="text-gray-600 dark:text-gray-400">
            card {{ deleteTarget.id }} ({{ deleteTarget.car?.name || deleteTarget.car_id || '車両なし' }}) を削除しますか？この操作は取り消せません。
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
</style>
