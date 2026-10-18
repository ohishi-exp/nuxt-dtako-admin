<script setup lang="ts">
/**
 * インタンク燃料の手入力 (CakePHP の /fuel-intank/add-manual の置き換え、Refs yhonda-ohishi/nginx#814)。
 * データは rust-fuel-worker の `/api/fuel/*` (alc-proxy 経由)。本文の組み立て・入力の検査・エラーの文は
 * `app/utils/fuel-manual.ts` が持ち、ここは並べるだけ。
 *
 * ★ カードの選択欄は 1 つだけ置く。Reka UI の SelectMenu は閉じていても全選択肢を描画して持つので、
 * 行ごとに置くと `/fuel/cards` と同じく固まる (Refs yhonda-ohishi/nginx#814)。
 */
import { getFuelManualCandidates, getFuelCards, getFuelStarts, getFuelIntank, createFuelIntank } from '~/utils/api'
import {
  START_CARD, manualCardItems, buildManualBody, describeManualError, manualRows, lastInsertedText, rowCardLabel,
} from '~/utils/fuel-manual'
import { toDatetimeLocal } from '~/utils/fuel-cards'
import { formatShortDatetime, formatQuantity } from '~/utils/fuel-intank'
import { describeCaughtError, describeListFailure } from '~/utils/api-error'
import type { FuelCard, FuelIntankRow, FuelManualCandidatesResponse, FuelStart } from '~/types'

const candidates = ref<number[]>([])
const lastInserted = ref<FuelManualCandidatesResponse['last_inserted']>(null)
const cards = ref<FuelCard[]>([])
const starts = ref<FuelStart[]>([])
const masterError = ref<string | null>(null)

const rows = ref<FuelIntankRow[]>([])
const loadingRows = ref(false)
const listError = ref<string | null>(null)

const slipNum = ref('')
const datetimeLocal = ref('')
const card = ref<string | undefined>(undefined)
/**
 * ★ 型は UInput に合わせて string だが、`type="number"` の UInput は実行時に**数値**を入れる (空は `''`)。
 * `buildManualBody` は両方を受ける (文字列前提で `.trim()` すると数量を入れた送信が黙って落ちた — dev で実測)
 */
const quantity = ref('')

const submitting = ref(false)
const submitMessage = ref<string | null>(null)
const submitError = ref<string | null>(null)

const cardItems = computed(() => manualCardItems(cards.value))
const candidateItems = computed(() => candidates.value.map(n => ({ label: String(n), value: String(n) })))
const isStart = computed(() => card.value === START_CARD)
const lastText = computed(() => lastInsertedText(lastInserted.value))
const manualList = computed(() => manualRows(rows.value))

/** 候補の選択欄。選んだら伝票番号の欄へ入れる (欄は手で打ち直せる。候補に無い番号なら選択欄は空に見える) */
const candidateChoice = computed({
  get: () => candidates.value.includes(Number(slipNum.value)) && slipNum.value.trim() !== '' ? slipNum.value.trim() : undefined,
  set: (v: string | undefined) => { if (v) slipNum.value = v },
})

async function loadCandidates() {
  const res = await getFuelManualCandidates()
  candidates.value = res.candidates
  lastInserted.value = res.last_inserted
  // 伝票番号と日時は空のときだけ埋める (CakePHP は最新の行の日時を既定にしていた)
  if (slipNum.value === '' && res.candidates.length > 0) slipNum.value = String(res.candidates[0])
  if (datetimeLocal.value === '' && res.last_inserted) datetimeLocal.value = toDatetimeLocal(res.last_inserted.datetime)
}

async function loadMasters() {
  masterError.value = null
  try {
    const [, cardsRes, startsRes] = await Promise.all([loadCandidates(), getFuelCards(), getFuelStarts()])
    cards.value = cardsRes.cards
    starts.value = startsRes.rows
  }
  catch (e) {
    masterError.value = describeListFailure(e, '再読み込みしてください')
  }
}

async function loadRows() {
  loadingRows.value = true
  listError.value = null
  try {
    rows.value = (await getFuelIntank()).rows
  }
  catch (e) {
    rows.value = []
    listError.value = describeListFailure(e, '再読み込みしてください')
  }
  finally {
    loadingRows.value = false
  }
}

async function submit() {
  submitMessage.value = null
  submitError.value = null
  const built = buildManualBody(
    { slipNum: slipNum.value, datetimeLocal: datetimeLocal.value, card: card.value, quantity: quantity.value },
    starts.value,
  )
  if (!built.ok) {
    submitError.value = built.error
    return
  }
  submitting.value = true
  try {
    await createFuelIntank(built.body)
    // 上流は追加 (201) と手入力の行の上書き (200) で本文の形が同じで、`request()` は status を返さない
    submitMessage.value = `保存しました (${formatShortDatetime(built.body.datetime)} / 伝票番号 ${built.body.slip_num})`
    slipNum.value = ''
    await Promise.all([loadCandidates(), loadRows()])
  }
  catch (e) {
    submitError.value = (e instanceof Error ? describeManualError(e.message) : null)
      ?? describeCaughtError(e, 'もう一度「保存」を押してください')
  }
  finally {
    submitting.value = false
  }
}

onMounted(() => {
  loadMasters()
  loadRows()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-xl font-bold mr-auto">インタンク燃料 手入力</h2>
      <UButton to="/fuel/intank" icon="i-lucide-arrow-left" variant="outline" label="給油の一覧" />
    </div>

    <details class="text-sm text-gray-600 dark:text-gray-400">
      <summary class="cursor-pointer">説明</summary>
      <ul class="list-disc ml-5 mt-1 space-y-0.5">
        <li>伝票番号の候補は、空いている番号と最新の行の次の番号です。候補に無い番号は欄に直接入れてください</li>
        <li>日経精算の伝票は「start 行 (カード無し)」を選びます。数量は要りません。前回集計した分の時間を入れてください</li>
        <li>通常の伝票はカードと数量 (L、小数 2 桁まで) が必須です。start の伝票番号は、いちばん大きい start の番号を自動で付けます</li>
        <li>同じ日時・カードの手入力の行は上書きします。CSV から取り込んだ行は手入力で上書きできません</li>
        <li>手入力の行も、あとで CSV に同じ行があれば CSV の値で上書きされます</li>
      </ul>
    </details>

    <UAlert v-if="masterError" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="伝票番号の候補・カード・start の一覧を読めませんでした" :description="masterError" />

    <p class="text-sm">
      <span class="font-medium">最新の行:</span>
      {{ lastText ?? '(行がありません)' }}
    </p>

    <!-- novalidate: 数量の step (0.01) を外れるとブラウザが黙って送信を止めるので、検査は buildManualBody の文に寄せる -->
    <form class="flex flex-wrap items-end gap-3" novalidate @submit.prevent="submit">
      <!-- 候補と番号は別の欄にする (1 つの UFormField に 2 つ入れると id が重なり、ラベルが両方を指す) -->
      <UFormField label="伝票番号の候補">
        <USelect v-model="candidateChoice" :items="candidateItems" placeholder="候補" class="w-28" />
      </UFormField>
      <UFormField label="伝票番号">
        <UInput v-model="slipNum" inputmode="numeric" class="w-24" />
      </UFormField>
      <UFormField label="日時">
        <UInput v-model="datetimeLocal" type="datetime-local" />
      </UFormField>
      <UFormField label="カード">
        <USelectMenu v-model="card" :items="cardItems" value-key="value" :search-input="{ placeholder: 'カード番号・車番で検索' }" placeholder="カードを選択" class="w-64" />
      </UFormField>
      <UFormField label="数量 (L)">
        <UInput v-model="quantity" type="number" step="0.01" min="0" :disabled="isStart" :placeholder="isStart ? '(start 行は不要)' : ''" class="w-32" />
      </UFormField>
      <UButton type="submit" label="保存" icon="i-lucide-save" :loading="submitting" />
    </form>

    <UAlert v-if="submitMessage" color="success" variant="subtle" icon="i-lucide-check-circle" :title="submitMessage" />
    <UAlert v-if="submitError" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="保存できませんでした" :description="submitError" />

    <div>
      <h3 class="font-medium mb-1">手入力の行</h3>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-1">最新 100 行のうち、手入力 (manual) の行だけを出しています。それより古い手入力の行はここに出ません。</p>
      <UAlert v-if="listError" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="給油の一覧を読めませんでした" :description="listError" class="my-2" />
      <div v-if="loadingRows" class="flex items-center gap-2 text-sm my-2">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />読み込み中...
      </div>
      <div v-else class="overflow-x-auto">
        <table class="fuel-table">
          <thead>
            <tr>
              <th>日時</th><th>伝票番号</th><th>start の番号</th><th>カード</th><th>数量</th><th>type</th><th>detail</th><th>dtako_row_id</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in manualList" :key="`${r.datetime};${r.fuel_card_id}`">
              <td>{{ formatShortDatetime(r.datetime) }}</td>
              <td class="text-right">{{ r.slip_num }}</td>
              <td class="text-right">{{ r.slip_num_parent }}</td>
              <td class="text-right">{{ rowCardLabel(r.fuel_card_id) }}</td>
              <td class="text-right">{{ r.qt == null ? '' : formatQuantity(r.qt) }}</td>
              <td>{{ r.type }}</td>
              <td>{{ r.detail }}</td>
              <td>{{ r.dtako_row_id ?? '' }}</td>
            </tr>
            <tr v-if="manualList.length === 0 && !listError">
              <td colspan="8" class="text-center text-gray-500">最新 100 行に手入力の行はありません</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
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
