<script setup lang="ts">
import type { CrewGroup, EventCategory, SelectedRowsSummary, SelectedRowsLocationRange } from '~/utils/event-data-table'
import {
  colIndex,
  getDisplayColumns,
  eventRowClass,
  columnAlignClass,
  selectedRowsTimeRange,
  summarizeSelectedRows,
  selectedRowsLocationRange,
  filterRowsByCategory,
  countRowsByCategory,
  rowIndicesInTimeRanges,
  EVENT_CATEGORY_ORDER,
  EVENT_CATEGORY_LABELS,
} from '~/utils/event-data-table'
import { rowLegLookup, legCellClass, legLabel, legTitle, UNKNOWN_LEG_ROW } from '~/utils/event-row-legs'

const props = defineProps<{
  group: CrewGroup
  headers: string[]
  /** **便の列の元になる「運行 1 本の CSV 全行」** (Refs #868)。粗利の按分
   * (`extractOperationIdle`) が便を数えるのと**同じ配列**を渡すこと。
   *
   * `group.rows` ではなく全行なのは、**KUDGIVT.csv が 1 運行分の全乗務員 (運転手 = 1 /
   * 副運転手 = 2) の行を持つ**ため — 乗務員タブで絞った配列から数え直すと、絞られた側に
   * 積みがある運行で**画面の便番号がお金の便番号とずれる**。
   *
   * 省略時は `group.rows` から数える (乗務員が 1 人の運行では同じ結果になる)。 */
  allRows?: string[][]
  /** 一番星の伝票から提案された区間 (Refs proposeFromSlips)。値が変わるたびに
   * filteredRows 内で対応する行をチェック状態にする。手動選択とは独立した
   * 「外部からの選択指示」チャネルとして扱う (null は「指示なし」で無視する)。
   *
   * **`legs` があればそちらをレグごとに選ぶ。** `fromTs`〜`toTs` は全レグの union
   * なので、レグの間に挟まった無関係な別レグまで選択に入ってしまう
   * (`rowIndicesInTimeRanges` の実運用回帰を参照)。 */
  proposedRange?: { fromTs: number, toTs: number, legs?: { fromTs: number, toTs: number }[] } | null
}>()

const emit = defineEmits<{
  'update:selectedRange': [range: { fromTs: number, toTs: number } | null]
  'update:selectedSummary': [summary: SelectedRowsSummary | null]
  'update:selectedLocation': [location: SelectedRowsLocationRange | null]
}>()

/** イベント/走行/アイドリング/速度超過 の4タブ (排他選択)。 */
const activeCategory = ref<EventCategory>('event')

const eventNameIdx = computed(() => colIndex(props.headers, 'イベント名'))

const filteredRows = computed(() =>
  filterRowsByCategory(props.group.rows, eventNameIdx.value, activeCategory.value),
)

const categoryCounts = computed(() => {
  const counts = {} as Record<EventCategory, number>
  for (const cat of EVENT_CATEGORY_ORDER) {
    counts[cat] = countRowsByCategory(props.group.rows, eventNameIdx.value, cat)
  }
  return counts
})

const displayColumns = computed(() => getDisplayColumns(props.headers))

/** 行オブジェクトそのものを key にした便の引き当て表 (index はタブで絞るとずれるので使わない)。 */
const legLookup = computed(() => rowLegLookup(props.headers, props.allRows ?? props.group.rows))

/** 表示行 → 便。表に無い行 (引き当て表に載っていない) は**空欄にせず**「判定不能」を出す。 */
function legOf(row: string[]) {
  return legLookup.value.get(row) ?? UNKNOWN_LEG_ROW
}

/** 選択行 index (filteredRows 基準)。地図パネル (速度カラー) に渡す時刻レンジの元。 */
const selectedRows = ref<Set<number>>(new Set())

function clearSelection() {
  if (selectedRows.value.size > 0) selectedRows.value = new Set()
}

// filteredRows の並びが変わる (乗務員切替・タブ切替) と選択index が
// 別の行を指してしまうため、その都度クリアする。
watch(() => props.group, clearSelection)
watch(activeCategory, clearSelection)

// 一番星の伝票から区間が提案されたら、対応する filteredRows のチェックボックスに
// 反映する (以前は提案区間がページ側の ref だけを更新し、テーブルのチェックボックス
// が一切連動しない実運用回帰があった)。積み/降し/運転は既定の 'event' カテゴリに
// 含まれるため、通常はカテゴリ切替不要でそのまま一致する。
watch(() => props.proposedRange, (range) => {
  if (!range) return
  const idx = rowIndicesInTimeRanges(props.headers, filteredRows.value, range.legs ?? [range])
  selectedRows.value = new Set(idx)
})

function toggleRow(ri: number) {
  const next = new Set(selectedRows.value)
  if (next.has(ri)) next.delete(ri)
  else next.add(ri)
  selectedRows.value = next
}

watch(selectedRows, (rows) => {
  const range = selectedRowsTimeRange(props.headers, filteredRows.value, rows)
  emit('update:selectedRange', range)
  emit('update:selectedSummary', rows.size > 0 ? summarizeSelectedRows(props.headers, filteredRows.value, rows) : null)
  emit('update:selectedLocation', selectedRowsLocationRange(props.headers, filteredRows.value, rows))
})
</script>

<template>
  <div class="px-4 py-3 flex flex-wrap gap-4 items-center text-xs text-gray-500 border-b border-gray-100 dark:border-gray-800">
    <span>{{ group.officeName }}</span>
    <span>{{ group.vehicleName }}</span>
    <span>{{ group.driverCd }} {{ group.driverName }}</span>
    <div class="ml-auto flex items-center gap-2">
      <button
        v-for="cat in EVENT_CATEGORY_ORDER"
        :key="cat"
        class="px-2 py-1 rounded text-xs transition-colors"
        :class="activeCategory === cat
          ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
          : 'text-gray-400 hover:text-gray-600'"
        @click="activeCategory = cat"
      >
        {{ EVENT_CATEGORY_LABELS[cat] }} ({{ categoryCounts[cat] }})
      </button>
    </div>
  </div>

  <p v-if="selectedRows.size > 0" class="px-4 pt-2 text-xs text-gray-500">
    {{ selectedRows.size }}行選択中
    <button class="ml-2 text-blue-600 dark:text-blue-400 hover:underline" @click="clearSelection">
      選択解除
    </button>
  </p>

  <table v-if="displayColumns.length" class="w-full text-xs">
    <thead class="bg-gray-50 dark:bg-gray-800">
      <tr>
        <th class="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap w-8" />
        <th class="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">#</th>
        <th class="text-left px-3 py-2 font-medium text-gray-500 whitespace-nowrap">便</th>
        <th
          v-for="col in displayColumns"
          :key="col.header"
          class="px-3 py-2 font-medium text-gray-500 whitespace-nowrap"
          :class="columnAlignClass(col.header)"
        >
          {{ col.header }}<span v-if="col.header === '区間距離'" class="text-[10px] text-gray-400 ml-0.5">(km)</span>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="(row, ri) in filteredRows"
        :key="ri"
        class="border-t border-gray-100 dark:border-gray-800 cursor-pointer"
        :class="[eventRowClass(headers, row), selectedRows.has(ri) ? 'bg-blue-50 dark:bg-blue-950/40' : '']"
        @click="toggleRow(ri)"
      >
        <td class="px-3 py-1.5" @click.stop="toggleRow(ri)">
          <input type="checkbox" :checked="selectedRows.has(ri)" class="cursor-pointer" @click.stop="toggleRow(ri)">
        </td>
        <td class="px-3 py-1.5 text-gray-400">{{ ri + 1 }}</td>
        <!-- 便の列。**色はこのセルだけに載せる** (行の背景は 積み/降し/休息 で使用済み)。
             色が読めない環境でも分かるよう、語 (`便2` / `便2 回送` / `便2 帰庫`) でも分ける。 -->
        <td class="px-3 py-1.5 whitespace-nowrap">
          <span class="px-1.5 py-0.5 rounded" :class="legCellClass(legOf(row))" :title="legTitle(legOf(row))">
            {{ legLabel(legOf(row)) }}
          </span>
        </td>
        <td
          v-for="col in displayColumns"
          :key="col.header"
          class="px-3 py-1.5 whitespace-nowrap"
          :class="columnAlignClass(col.header)"
        >
          <EventTableCell
            :headers="headers"
            :row="row"
            :header="col.header"
            :value="row[col.index] ?? ''"
          />
        </td>
      </tr>
      <tr v-if="filteredRows.length === 0">
        <td :colspan="displayColumns.length + 3" class="px-3 py-8 text-center text-gray-400">
          データがありません
        </td>
      </tr>
    </tbody>
  </table>
</template>
