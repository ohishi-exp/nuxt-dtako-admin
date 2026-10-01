<script setup lang="ts">
/**
 * 訴訟準備の出力タブの「月ごとの時間 (wage report)」— 冊ごとに、暦月の 法定時間内 / 法外残業 /
 * うち月60h超 / 法定外休日 / 法定休日 / 深夜 (内数) / 総労働時間 と、値の在る月の合計を出す
 * (Refs #1133 c1133-36)。画面の表と印刷の紙面が**同じ部品**を使う (紙面は `compact` で余白・文字を詰める)。
 * 行の組み立ては `buildLitigationHoursBooks` (`app/utils/litigation-output.ts`)。値は給与比較タブと
 * 同じ保存済みの wage report で、ここでは計算しない。
 */
import { LITIGATION_HOURS_COLUMNS, type LitigationHoursBook } from '~/utils/litigation-output'

withDefaults(defineProps<{
  books: readonly LitigationHoursBook[]
  /** 乗務員CD → 氏名 (ページが持つ乗務員マスタで引く) */
  driverLabel: (driverCd: string) => string
  /** 表を出せない状態 (保存済みの結果を読み込み中・読めなかった)。在るときは冊の表の代わりにこれを出す */
  notice?: string
  compact?: boolean
}>(), { notice: '', compact: false })
</script>

<template>
  <div :class="compact ? '' : 'space-y-2'" :data-testid="compact ? 'litigation-print-hours' : 'litigation-hours'">
    <h2 :class="compact ? 'font-bold mt-2' : 'text-sm font-medium'">月ごとの時間 (wage report)</h2>
    <p :class="compact ? 'litigation-print-meta' : 'text-xs text-gray-600 dark:text-gray-400'" data-hours="description">
      給与比較と同じ wage report の値です (暦月、時間:分)。保存した版の表示とは連動しません。
      Excel の中の式の結果とは一致しないことが在ります (Excel は入力の作り方が別で、統一は作業中です)。
    </p>
    <div v-if="notice" :class="compact ? 'litigation-print-meta' : 'text-sm text-gray-500'" data-hours="notice">{{ notice }}</div>
    <template v-else>
      <div v-if="books.some(b => b.needsFetch)" :class="compact ? 'litigation-print-meta' : 'text-sm text-amber-700 dark:text-amber-400'" data-hours="needs-fetch">
        エラータブ (または給与比較) で拘束の材料を取ると出ます
      </div>
      <div
        v-for="book in books"
        :key="`${book.driverCd}|${book.label}`"
        class="litigation-hours-book"
        :class="compact ? '' : 'bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-1 overflow-x-auto'"
        :data-hours-book="`${book.driverCd}|${book.label}`"
      >
        <div :class="compact ? 'font-bold' : 'text-sm font-medium'" data-hours="heading">{{ driverLabel(book.driverCd) }} ({{ book.driverCd }}) {{ book.label }}</div>
        <div v-if="book.checkedAtText" :class="compact ? '' : 'text-xs text-gray-500'" data-hours="checked-at">最終取得 {{ book.checkedAtText }}</div>
        <table :class="compact ? 'litigation-print-table litigation-hours-table' : 'text-sm tabular-nums'">
          <thead>
            <tr :class="compact ? '' : 'border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50'">
              <th :class="compact ? '' : 'text-left px-3 py-1 font-medium'">対象月</th>
              <th v-for="col in LITIGATION_HOURS_COLUMNS" :key="col" :class="compact ? '' : 'text-right px-3 py-1 font-medium'">{{ col }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in book.rows" :key="row.month" :class="compact ? '' : 'border-b border-gray-100 dark:border-gray-800'" data-hours="month">
              <td :class="compact ? '' : 'px-3 py-1 whitespace-nowrap'">{{ row.month }}</td>
              <td v-if="row.note !== null" :colspan="LITIGATION_HOURS_COLUMNS.length" :class="compact ? '' : 'px-3 py-1 text-gray-500'" data-hours="month-note">{{ row.note }}</td>
              <template v-else>
                <td v-for="(cell, i) in row.cells" :key="i" class="litigation-hours-num" :class="compact ? '' : 'text-right px-3 py-1'">{{ cell }}</td>
              </template>
            </tr>
            <tr v-if="book.total" class="font-bold" data-hours="total">
              <td :class="compact ? '' : 'px-3 py-1 whitespace-nowrap'">{{ book.total.month }}</td>
              <td v-for="(cell, i) in book.total.cells" :key="i" class="litigation-hours-num" :class="compact ? '' : 'text-right px-3 py-1'">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
