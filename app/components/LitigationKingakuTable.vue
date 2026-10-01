<script setup lang="ts">
/**
 * 訴訟準備の出力タブの「Y金額 (時間の行)」— 冊ごとに、賃金月度の 法内残業 / 法外残業 /
 * 月60h超 / 休日労働 / 深夜労働 / 総労働時間 と冊の合計を出す (Refs #1133 c1133-31)。
 * 画面の表と印刷の紙面が**同じ部品**を使う (紙面は `compact` で余白・文字を詰める)。
 * 行の組み立ては `buildLitigationKingakuBooks` (`app/utils/litigation-output.ts`)、
 * 計算は `app/utils/y-kingaku.ts` (サーバが応答ヘッダで返す)。
 */
import { LITIGATION_KINGAKU_COLUMNS, type LitigationKingakuBook } from '~/utils/litigation-output'

withDefaults(defineProps<{
  books: readonly LitigationKingakuBook[]
  /** 乗務員CD → 氏名 (ページが持つ乗務員マスタで引く) */
  driverLabel: (driverCd: string) => string
  compact?: boolean
}>(), { compact: false })
</script>

<template>
  <div :class="compact ? '' : 'space-y-2'" :data-testid="compact ? 'litigation-print-kingaku' : 'litigation-kingaku'">
    <h2 :class="compact ? 'font-bold mt-2' : 'text-sm font-medium'">Y金額 (時間の行)</h2>
    <p :class="compact ? 'litigation-print-meta' : 'text-xs text-gray-600 dark:text-gray-400'" data-kingaku="description">
      Excel の Y金額 シートの時間の行と同じ計算です (賃金月度ごとの合計、時間:分)。金額の行は出しません (賃金単価・既払額は Excel で手入力)。
      1 冊は独立した Excel なので、週の累計は冊の初日から数え直します。
    </p>
    <div
      v-for="book in books"
      :key="`${book.driverCd}|${book.label}`"
      class="litigation-kingaku-book"
      :class="compact ? '' : 'bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-3 space-y-1 overflow-x-auto'"
      :data-kingaku-book="`${book.driverCd}|${book.label}`"
    >
      <div :class="compact ? 'font-bold' : 'text-sm font-medium'" data-kingaku="heading">{{ driverLabel(book.driverCd) }} ({{ book.driverCd }}) {{ book.label }}</div>
      <div v-if="book.note" :class="compact ? '' : 'text-sm text-amber-700 dark:text-amber-400'" data-kingaku="note">{{ book.note }}</div>
      <template v-else>
        <table :class="compact ? 'litigation-print-table litigation-kingaku-table' : 'text-sm tabular-nums'">
          <thead>
            <tr :class="compact ? '' : 'border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50'">
              <th :class="compact ? '' : 'text-left px-3 py-1 font-medium'">対象期間</th>
              <th v-for="col in LITIGATION_KINGAKU_COLUMNS" :key="col" :class="compact ? '' : 'text-right px-3 py-1 font-medium'">{{ col }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in book.rows" :key="row.period" :class="compact ? '' : 'border-b border-gray-100 dark:border-gray-800'" data-kingaku="month">
              <td :class="compact ? '' : 'px-3 py-1 whitespace-nowrap'">{{ row.period }}<template v-if="row.partial"> ※</template></td>
              <td v-for="(cell, i) in row.cells" :key="i" class="litigation-kingaku-num" :class="compact ? '' : 'text-right px-3 py-1'">{{ cell }}</td>
            </tr>
            <tr v-if="book.total" class="font-bold" data-kingaku="total">
              <td :class="compact ? '' : 'px-3 py-1'">{{ book.total.period }}</td>
              <td v-for="(cell, i) in book.total.cells" :key="i" class="litigation-kingaku-num" :class="compact ? '' : 'text-right px-3 py-1'">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="book.rows.some(r => r.partial)" :class="compact ? '' : 'text-xs text-gray-600 dark:text-gray-400'" data-kingaku="partial-note">
          ※ 冊の期間からはみ出す月度です。はみ出した日はこの冊の Excel に無いので、合計に入っていません。
        </div>
      </template>
    </div>
  </div>
</template>
