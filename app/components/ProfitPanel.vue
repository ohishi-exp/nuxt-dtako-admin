<script setup lang="ts">
/**
 * `/operations/[unko_no]` の「イベント」タブ: 選択区間に対応する一番星の伝票候補を
 * 検索し、確認 (チェックボックス) した伝票の売上合計とデジタコ実績 (距離・時間) を
 * 並列表示する収支パネル (Refs #330 PR4)。EventSelectionSummaryPanel (デジタコ実績、
 * 画面左下) / EventSpeedMapPanel (速度カラーMap、画面右下) と並ぶ第3のフローティング
 * パネル (画面下中央)。
 *
 * 突合ロジック (スコアリング・効率指標計算) は `app/utils/ichiban.ts` の pure 関数に
 * 集約し、このコンポーネントは fetch のトリガーと選択状態の保持に専念する。
 */
import type { SelectedRowsSummary, SelectedRowsLocationRange } from '~/utils/event-data-table'
import {
  fetchVehicleDailySlips,
  vehicleDailyDateRange,
  scoreVehicleDailySlips,
  calcProfitEfficiency,
  type ScoredVehicleDailySlip,
} from '~/utils/ichiban'
import { segmentId as buildSegmentId, profitYm, buildProfitSnapshot, type ProfitSnapshot, type ProfitPanelLegGroup } from '~/utils/profit-r2'

const props = defineProps<{
  vehicleCode: string | null
  unkoNo: string
  range: { fromTs: number, toTs: number } | null
  location: SelectedRowsLocationRange | null
  summary: SelectedRowsSummary
  /** 日付をまたぐ複数レグが提案された場合の日付ごとの区間・実績 (Refs #356 派生
   * 要望: 「日付が違う部分を分けて別々に登録したい」)。2件未満 (同日往復のみ/単一
   * レグ/手動選択) なら従来通りの単一保存フローのままにする。 */
  legGroups?: ProfitPanelLegGroup[]
}>()

defineEmits<{ close: [] }>()

type FetchStatus = 'idle' | 'loading' | 'ready' | 'error' | 'no-vehicle'
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

type BucketSaveStatus = 'idle' | 'saving' | 'saved' | 'error'

const status = ref<FetchStatus>('idle')
const errorMessage = ref<string | null>(null)
const scoredSlips = ref<ScoredVehicleDailySlip[]>([])
const confirmedRowIds = ref<Set<string>>(new Set())
const saveStatus = ref<SaveStatus>('idle')
/** 日付ごとの分割保存 (下記) の保存状態、日付をキーにする。 */
const bucketSaveStatus = ref<Record<string, BucketSaveStatus>>({})
/** 検索窓 (前後1〜2日) に混ざる無関係な伝票候補をこのパネル表示中だけ隠す
 * (「見た目の整理」目的、範囲が変われば load() でリセットされる、保存はしない)。 */
const hiddenRowIds = ref<Set<string>>(new Set())
const visibleSlips = computed(() => scoredSlips.value.filter(s => !hiddenRowIds.value.has(s.slip.rowId)))

/** 日付が2件以上 (日付をまたぐ複数レグ) の場合だけ日付ごとの分割保存UIに切り替える。
 * 同日往復のみ (1件) や手動選択 (undefined) では従来の単一保存フローのままにする。 */
const hasLegGroups = computed(() => (props.legGroups?.length ?? 0) > 1)

function hideSlip(rowId: string) {
  const next = new Set(hiddenRowIds.value)
  next.add(rowId)
  hiddenRowIds.value = next
  // 非表示にした伝票が確定金額に紛れ込まないよう、確認済みだった場合は外す。
  if (confirmedRowIds.value.has(rowId)) toggleConfirmed(rowId)
}

function unhideAllSlips() {
  hiddenRowIds.value = new Set()
}

/** 指定した区間の保存済みスナップショットがあれば confirmedSlips の rowId 一覧を
 * 返す。無ければ (404 等) null。 */
async function fetchSnapshotConfirmedRowIds(range: { fromTs: number, toTs: number }): Promise<string[] | null> {
  try {
    const snapshot = await $fetch<ProfitSnapshot>('/api/profit/snapshot', {
      query: {
        ym: profitYm(range.fromTs),
        vehicle: props.vehicleCode!,
        unkoNo: props.unkoNo,
        segmentId: buildSegmentId(range.fromTs, range.toTs),
      },
    })
    return snapshot.confirmedSlips.map(s => s.rowId)
  }
  catch {
    return null
  }
}

/** 保存済みスナップショットがあれば確認状態を復元し、無ければ suggested ベースの
 * 自動チェックにフォールバックする。`legGroups` がある場合は日付ごとに個別の
 * セグメントとして保存されているため、日付ごとに別々に復元を試みる — ある日付が
 * 未保存でも他の日付の復元結果には影響させない。load() からしか呼ばれず、その
 * 時点で vehicleCode/range は非null が保証されている。 */
async function restoreConfirmedRowIds(scored: ScoredVehicleDailySlip[]): Promise<Set<string>> {
  if (!hasLegGroups.value) {
    const rowIds = await fetchSnapshotConfirmedRowIds(props.range!)
    if (rowIds) return new Set(rowIds)
    return new Set(scored.filter(s => s.suggested).map(s => s.slip.rowId))
  }

  const groupByDate = new Map(props.legGroups!.map(g => [g.date, g]))
  const slipsByDate = new Map<string, ScoredVehicleDailySlip[]>()
  for (const s of scored) {
    const list = slipsByDate.get(s.slip.saleDate) ?? []
    list.push(s)
    slipsByDate.set(s.slip.saleDate, list)
  }

  const merged = new Set<string>()
  for (const [date, slips] of slipsByDate) {
    const group = groupByDate.get(date)
    const rowIds = group ? await fetchSnapshotConfirmedRowIds(group.range) : null
    if (rowIds) rowIds.forEach(id => merged.add(id))
    else slips.filter(s => s.suggested).forEach(s => merged.add(s.slip.rowId))
  }
  return merged
}

async function load() {
  if (!props.vehicleCode || !props.range) {
    status.value = 'no-vehicle'
    scoredSlips.value = []
    confirmedRowIds.value = new Set()
    return
  }
  status.value = 'loading'
  errorMessage.value = null
  saveStatus.value = 'idle'
  bucketSaveStatus.value = {}
  hiddenRowIds.value = new Set()
  try {
    const { from, to } = vehicleDailyDateRange(props.range.fromTs, props.range.toTs)
    const slips = await fetchVehicleDailySlips(props.vehicleCode, from, to)
    const scored = scoreVehicleDailySlips(
      props.location?.originCity ?? '',
      props.location?.destCity ?? '',
      slips,
    )
    scoredSlips.value = scored
    confirmedRowIds.value = await restoreConfirmedRowIds(scored)
    status.value = 'ready'
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
  }
}

watch([() => props.vehicleCode, () => props.range], load, { immediate: true })

function toggleConfirmed(rowId: string) {
  const next = new Set(confirmedRowIds.value)
  if (next.has(rowId)) next.delete(rowId)
  else next.add(rowId)
  confirmedRowIds.value = next
  saveStatus.value = 'idle'
  bucketSaveStatus.value = {}
}

function amountOf(slips: ScoredVehicleDailySlip[]): number {
  return slips.filter(s => confirmedRowIds.value.has(s.slip.rowId)).reduce((sum, s) => sum + s.slip.amount, 0)
}

const confirmedAmount = computed(() => amountOf(scoredSlips.value))

const efficiency = computed(() => calcProfitEfficiency(
  confirmedAmount.value,
  props.summary.distanceKm,
  props.summary.durationMin,
  props.summary.byCategory.drive,
))

/** 現在の確認状態を検証スナップショットとして R2 に保存する (Refs #330 PR3)。
 * `legGroups` が無い (単一レグ/手動選択) 場合のみ使う。 */
/** 保存ボタンは status==='ready' の時しか描画されず、その時点で load() により
 * vehicleCode/range は非null が保証されている (template の v-else-if 参照)。 */
async function saveSnapshot() {
  saveStatus.value = 'saving'
  try {
    const snapshot = buildProfitSnapshot({
      vehicleCode: props.vehicleCode!,
      unkoNo: props.unkoNo,
      range: props.range!,
      location: props.location,
      summary: props.summary,
      scoredSlips: scoredSlips.value,
      confirmedRowIds: confirmedRowIds.value,
      confirmedAmount: confirmedAmount.value,
      efficiency: efficiency.value,
      savedAt: '', // server 側で実行時刻に上書きする
    })
    await $fetch('/api/profit/snapshot', { method: 'POST', body: snapshot })
    saveStatus.value = 'saved'
  }
  catch {
    saveStatus.value = 'error'
  }
}

// --- 日付ごとの分割保存 (Refs #356 派生要望: 「日付が違う部分を分けて別々に登録したい」) ---

interface SlipDateBucket {
  date: string
  legGroup: ProfitPanelLegGroup
  slips: ScoredVehicleDailySlip[]
}

/** legGroups の日付ごとに対応する伝票候補 (非表示除く) をまとめる。伝票が1件も
 * 無い日付は表示しても意味が無いので除く。テンプレート側で `hasLegGroups` の間
 * しか参照しないため、ここでは `props.legGroups` が2件以上であることを前提にする。 */
const dateBuckets = computed<SlipDateBucket[]>(() => props.legGroups!
  .map(legGroup => ({
    date: legGroup.date,
    legGroup,
    slips: visibleSlips.value.filter(s => s.slip.saleDate === legGroup.date),
  }))
  .filter(bucket => bucket.slips.length > 0))

/** どの legGroup の日付にも一致しない伝票候補 (実データの不整合等)。対応する区間の
 * 実績が無いため日付ごとの保存はできず、非表示にするか手動確認する対象として
 * 別枠に表示する。dateBuckets と同様、`hasLegGroups` の間しか参照しない前提。 */
const unmatchedSlips = computed(() => {
  const dates = new Set(props.legGroups!.map(g => g.date))
  return visibleSlips.value.filter(s => !dates.has(s.slip.saleDate))
})

function bucketAmount(bucket: SlipDateBucket): number {
  return amountOf(bucket.slips)
}

function bucketEfficiency(bucket: SlipDateBucket) {
  const { summary } = bucket.legGroup
  return calcProfitEfficiency(bucketAmount(bucket), summary.distanceKm, summary.durationMin, summary.byCategory.drive)
}

/** その日付の確認済み伝票だけを、対応するレグ自身の区間・実績でスナップショット
 * 保存する (単一レグ保存の segmentId が全体区間なのに対し、こちらは
 * `bucket.legGroup.range` = その日付のレグだけの区間になる)。 */
async function saveBucket(bucket: SlipDateBucket) {
  bucketSaveStatus.value = { ...bucketSaveStatus.value, [bucket.date]: 'saving' }
  try {
    const confirmedIdsForBucket = new Set(
      bucket.slips.filter(s => confirmedRowIds.value.has(s.slip.rowId)).map(s => s.slip.rowId),
    )
    const amount = bucketAmount(bucket)
    const { summary } = bucket.legGroup
    const snapshot = buildProfitSnapshot({
      vehicleCode: props.vehicleCode!,
      unkoNo: props.unkoNo,
      range: bucket.legGroup.range,
      location: props.location,
      summary,
      scoredSlips: bucket.slips,
      confirmedRowIds: confirmedIdsForBucket,
      confirmedAmount: amount,
      efficiency: calcProfitEfficiency(amount, summary.distanceKm, summary.durationMin, summary.byCategory.drive),
      savedAt: '',
    })
    await $fetch('/api/profit/snapshot', { method: 'POST', body: snapshot })
    bucketSaveStatus.value = { ...bucketSaveStatus.value, [bucket.date]: 'saved' }
  }
  catch {
    bucketSaveStatus.value = { ...bucketSaveStatus.value, [bucket.date]: 'error' }
  }
}

function formatYen(v: number | null): string {
  return v === null ? '-' : Math.round(v).toLocaleString('ja-JP')
}

/** 品名N/数量/単価をまとめて1列に表示するための整形。同一日でも複数明細で単価が
 * 異なりうることを一目で確認できるようにする (Refs #330 実データ検証)。 */
function formatItem(slip: ScoredVehicleDailySlip['slip']): string {
  if (!slip.itemName) return '-'
  const qty = slip.quantity > 0 ? `${slip.quantity}${slip.unit}` : ''
  const price = slip.unitPrice > 0 ? `@${formatYen(slip.unitPrice)}` : ''
  const detail = [qty, price].filter(Boolean).join(' ')
  return detail ? `${slip.itemName} (${detail})` : slip.itemName
}

const matchBadgeClass: Record<string, string> = {
  exact: 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300',
  partial: 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300',
  none: 'bg-gray-100 dark:bg-gray-800 text-gray-400',
}

const matchBadgeLabel: Record<string, string> = { exact: '完全一致', partial: '部分一致', none: '根拠なし' }
</script>

<template>
  <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[560px] max-w-[calc(100vw-2rem)] rounded-lg shadow-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-hidden">
    <div class="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
      <span class="text-xs font-medium text-gray-600 dark:text-gray-300">収支パネル (一番星 × デジタコ)</span>
      <button class="text-gray-400 hover:text-gray-600" @click="$emit('close')">
        <UIcon name="i-lucide-x" class="size-4" />
      </button>
    </div>

    <div v-if="status === 'no-vehicle'" class="px-4 py-6 text-xs text-gray-400 text-center">
      車輌CD が特定できないため一番星との突合はできません
    </div>
    <div v-else-if="status === 'loading'" class="px-4 py-6 text-xs text-gray-400 flex items-center justify-center gap-2">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />
      一番星の伝票を検索中...
    </div>
    <div v-else-if="status === 'error'" class="px-4 py-6 text-xs text-red-600 dark:text-red-400 text-center">
      {{ errorMessage }}
    </div>

    <!-- 日付をまたぐ複数レグ: 日付ごとにグループ化して個別に確認・保存する (Refs #356派生) -->
    <template v-else-if="status === 'ready' && hasLegGroups">
      <p class="px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30">
        日付をまたぐ複数のレグが見つかりました。日付ごとに確認・保存してください。
      </p>
      <div class="max-h-80 overflow-y-auto overflow-x-auto">
        <p v-if="dateBuckets.length === 0 && unmatchedSlips.length === 0" class="px-4 py-6 text-xs text-gray-400 text-center">
          この車輌・期間の伝票が見つかりませんでした
        </p>
        <div v-for="bucket in dateBuckets" :key="bucket.date" class="border-t border-gray-100 dark:border-gray-800">
          <div class="px-3 py-1.5 bg-gray-50 dark:bg-gray-800 text-[11px] font-medium">
            {{ bucket.date }}
          </div>
          <table class="w-full text-xs min-w-[640px]">
            <tbody>
              <tr
                v-for="s in bucket.slips"
                :key="s.slip.rowId"
                class="border-t border-gray-100 dark:border-gray-800 cursor-pointer"
                :class="confirmedRowIds.has(s.slip.rowId) ? 'bg-blue-50 dark:bg-blue-950/40' : ''"
                @click="toggleConfirmed(s.slip.rowId)"
              >
                <td class="w-8 px-2 py-1.5" @click.stop="toggleConfirmed(s.slip.rowId)">
                  <input type="checkbox" :checked="confirmedRowIds.has(s.slip.rowId)" class="cursor-pointer" @click.stop="toggleConfirmed(s.slip.rowId)">
                </td>
                <td class="px-2 py-1.5">{{ s.slip.customerName || '-' }}</td>
                <td class="px-2 py-1.5">{{ s.slip.originAreaName || s.slip.origin || '?' }} → {{ s.slip.destAreaName || s.slip.dest || '?' }}</td>
                <td class="px-2 py-1.5 whitespace-nowrap">{{ formatItem(s.slip) }}</td>
                <td class="px-2 py-1.5 text-right whitespace-nowrap">{{ formatYen(s.slip.amount) }}</td>
                <td class="px-2 py-1.5 text-center">
                  <span class="px-1.5 py-0.5 rounded text-[10px]" :class="matchBadgeClass[s.score > 0 ? (s.originMatch !== 'none' && s.destMatch !== 'none' ? 'exact' : 'partial') : 'none']">
                    {{ s.suggested ? matchBadgeLabel.exact : (s.score > 0 ? matchBadgeLabel.partial : matchBadgeLabel.none) }}
                  </span>
                </td>
                <td class="w-8 px-2 py-1.5 text-center">
                  <button
                    class="text-gray-400 hover:text-red-500"
                    title="この候補を一覧から隠す"
                    @click.stop="hideSlip(s.slip.rowId)"
                  >
                    <UIcon name="i-lucide-x" class="size-3.5" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="px-3 py-1.5 flex items-center justify-between gap-2 text-[11px]">
            <span class="text-gray-500">
              確定 {{ formatYen(bucketAmount(bucket)) }} 円 ・
              {{ bucket.legGroup.summary.distanceKm.toFixed(1) }} km / {{ (bucket.legGroup.summary.durationMin / 60).toFixed(1) }} h ・
              円/km {{ formatYen(bucketEfficiency(bucket).yenPerKm) }} ・
              円/時間 {{ formatYen(bucketEfficiency(bucket).yenPerHourBound) }}
            </span>
            <span class="flex items-center gap-2 whitespace-nowrap">
              <span v-if="bucketSaveStatus[bucket.date] === 'saved'" class="text-green-600 dark:text-green-400">保存しました</span>
              <span v-else-if="bucketSaveStatus[bucket.date] === 'error'" class="text-red-600 dark:text-red-400">保存に失敗しました</span>
              <button
                class="px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
                :disabled="bucketSaveStatus[bucket.date] === 'saving'"
                @click="saveBucket(bucket)"
              >
                {{ bucketSaveStatus[bucket.date] === 'saving' ? '保存中...' : 'この日付を保存' }}
              </button>
            </span>
          </div>
        </div>

        <div v-if="unmatchedSlips.length > 0" class="border-t border-gray-100 dark:border-gray-800">
          <div class="px-3 py-1.5 bg-gray-50 dark:bg-gray-800 text-[11px] font-medium text-gray-400">
            対応するレグが見つかりません ({{ unmatchedSlips.length }}件、非表示にするか手動で確認してください)
          </div>
          <table class="w-full text-xs min-w-[640px]">
            <tbody>
              <tr v-for="s in unmatchedSlips" :key="s.slip.rowId" class="border-t border-gray-100 dark:border-gray-800">
                <td class="px-2 py-1.5 whitespace-nowrap">{{ s.slip.saleDate }}</td>
                <td class="px-2 py-1.5">{{ s.slip.customerName || '-' }}</td>
                <td class="px-2 py-1.5 text-right whitespace-nowrap">{{ formatYen(s.slip.amount) }}</td>
                <td class="w-8 px-2 py-1.5 text-center">
                  <button
                    class="text-gray-400 hover:text-red-500"
                    title="この候補を一覧から隠す"
                    @click.stop="hideSlip(s.slip.rowId)"
                  >
                    <UIcon name="i-lucide-x" class="size-3.5" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div v-if="hiddenRowIds.size > 0" class="px-3 py-1 border-t border-gray-100 dark:border-gray-800 text-[10px] text-gray-400 text-right">
        非表示 {{ hiddenRowIds.size }}件
        <button class="text-blue-600 dark:text-blue-400 hover:underline ml-1" @click="unhideAllSlips">元に戻す</button>
      </div>
    </template>

    <!-- 単一レグ (同日往復のみ含む) または手動選択: 従来通りまとめて1件保存 -->
    <template v-else-if="status === 'ready'">
      <div class="max-h-64 overflow-y-auto overflow-x-auto">
        <table v-if="visibleSlips.length" class="w-full text-xs min-w-[640px]">
          <thead class="bg-gray-50 dark:bg-gray-800 sticky top-0">
            <tr>
              <th class="w-8" />
              <th class="text-left px-2 py-1.5 font-medium text-gray-500">日付</th>
              <th class="text-left px-2 py-1.5 font-medium text-gray-500">得意先</th>
              <th class="text-left px-2 py-1.5 font-medium text-gray-500">積地→卸地</th>
              <th class="text-left px-2 py-1.5 font-medium text-gray-500">品名 (数量@単価)</th>
              <th class="text-right px-2 py-1.5 font-medium text-gray-500">金額</th>
              <th class="text-center px-2 py-1.5 font-medium text-gray-500">根拠</th>
              <th class="w-8" />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="s in visibleSlips"
              :key="s.slip.rowId"
              class="border-t border-gray-100 dark:border-gray-800 cursor-pointer"
              :class="confirmedRowIds.has(s.slip.rowId) ? 'bg-blue-50 dark:bg-blue-950/40' : ''"
              @click="toggleConfirmed(s.slip.rowId)"
            >
              <td class="px-2 py-1.5" @click.stop="toggleConfirmed(s.slip.rowId)">
                <input type="checkbox" :checked="confirmedRowIds.has(s.slip.rowId)" class="cursor-pointer" @click.stop="toggleConfirmed(s.slip.rowId)">
              </td>
              <td class="px-2 py-1.5 whitespace-nowrap">{{ s.slip.saleDate }}</td>
              <td class="px-2 py-1.5">{{ s.slip.customerName || '-' }}</td>
              <td class="px-2 py-1.5">{{ s.slip.originAreaName || s.slip.origin || '?' }} → {{ s.slip.destAreaName || s.slip.dest || '?' }}</td>
              <td class="px-2 py-1.5 whitespace-nowrap">{{ formatItem(s.slip) }}</td>
              <td class="px-2 py-1.5 text-right whitespace-nowrap">{{ formatYen(s.slip.amount) }}</td>
              <td class="px-2 py-1.5 text-center">
                <span class="px-1.5 py-0.5 rounded text-[10px]" :class="matchBadgeClass[s.score > 0 ? (s.originMatch !== 'none' && s.destMatch !== 'none' ? 'exact' : 'partial') : 'none']">
                  {{ s.suggested ? matchBadgeLabel.exact : (s.score > 0 ? matchBadgeLabel.partial : matchBadgeLabel.none) }}
                </span>
              </td>
              <td class="px-2 py-1.5 text-center">
                <button
                  class="text-gray-400 hover:text-red-500"
                  title="この候補を一覧から隠す"
                  @click.stop="hideSlip(s.slip.rowId)"
                >
                  <UIcon name="i-lucide-x" class="size-3.5" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="scoredSlips.length === 0" class="px-4 py-6 text-xs text-gray-400 text-center">
          この車輌・期間の伝票が見つかりませんでした
        </p>
        <p v-else class="px-4 py-6 text-xs text-gray-400 text-center">
          すべての候補を非表示にしました
        </p>
      </div>
      <div v-if="hiddenRowIds.size > 0" class="px-3 py-1 border-t border-gray-100 dark:border-gray-800 text-[10px] text-gray-400 text-right">
        非表示 {{ hiddenRowIds.size }}件
        <button class="text-blue-600 dark:text-blue-400 hover:underline ml-1" @click="unhideAllSlips">元に戻す</button>
      </div>

      <div class="px-3 py-2 border-t border-gray-100 dark:border-gray-800 grid grid-cols-2 gap-3 text-xs">
        <div>
          <span class="text-gray-500 block">確定売上 (税抜)</span>
          <span class="text-sm font-semibold">{{ formatYen(confirmedAmount) }} 円</span>
        </div>
        <div>
          <span class="text-gray-500 block">距離 / 時間 (拘束)</span>
          <span class="text-sm font-semibold">{{ summary.distanceKm.toFixed(1) }} km / {{ (summary.durationMin / 60).toFixed(1) }} h</span>
        </div>
        <div>
          <span class="text-gray-500 block">円/km</span>
          <span class="text-sm font-semibold">{{ formatYen(efficiency.yenPerKm) }}</span>
        </div>
        <div>
          <span class="text-gray-500 block">円/時間 (拘束 / 運転)</span>
          <span class="text-sm font-semibold">{{ formatYen(efficiency.yenPerHourBound) }} / {{ formatYen(efficiency.yenPerHourDrive) }}</span>
        </div>
      </div>

      <div class="px-3 py-2 border-t border-gray-100 dark:border-gray-800 flex items-center justify-end gap-2">
        <span v-if="saveStatus === 'saved'" class="text-xs text-green-600 dark:text-green-400">保存しました</span>
        <span v-else-if="saveStatus === 'error'" class="text-xs text-red-600 dark:text-red-400">保存に失敗しました</span>
        <button
          class="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
          :disabled="saveStatus === 'saving'"
          @click="saveSnapshot"
        >
          {{ saveStatus === 'saving' ? '保存中...' : '検証結果を保存' }}
        </button>
      </div>
    </template>
  </div>
</template>
