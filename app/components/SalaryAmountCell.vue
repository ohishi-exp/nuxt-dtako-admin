<script setup lang="ts">
/**
 * 給与比較の金額セルの中身 (基本給・残業・総支給)。明細 (基本給は内訳つき) / 計算 / 差を縦に積み、計算の根拠 (基本給 = 単価 × 法定時間内、残業 = 最低賃金ベース × 残業時間) を添える。基本給・残業の差が負 (明細が下回る) は赤太字。
 * 訴訟準備の画面の表と印刷の紙面が**同じ部品**を使う (紙面は `compact` で余白・文字を詰める)。
 * 行の組み立ては `salaryRowCells` (`app/utils/litigation-salary.ts`)。
 */
import { diffSignClass, fmtSalaryDiff, type LitigationSalaryAmountCell } from '~/utils/litigation-salary'
import { fmtYen } from '~/utils/restraint-wage-view'

withDefaults(defineProps<{
  cell: LitigationSalaryAmountCell
  /** 月給 (固定残業) — 残業の差を出さない旨の注記を付ける */
  overtimeFixed?: boolean
  compact?: boolean
}>(), { overtimeFixed: false, compact: false })
</script>

<template>
  <div class="tabular-nums" :class="compact ? 'leading-tight' : ''">
    <div class="flex justify-between" :class="compact ? 'gap-1' : 'gap-3'" data-salary-line="csv"><span :class="compact ? '' : 'text-xs text-gray-500'">明細</span><span>{{ fmtYen(cell.csv) }}</span></div>
    <div v-if="cell.breakdown" class="text-right" :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'" data-salary-line="breakdown">{{ cell.breakdown }}</div>
    <div class="flex justify-between" :class="compact ? 'gap-1' : 'gap-3'" data-salary-line="sys"><span :class="compact ? '' : 'text-xs text-gray-500'">計算</span><span>{{ fmtYen(cell.sys) }}</span></div>
    <div v-if="cell.basis" class="text-right" :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'" data-salary-line="basis">{{ cell.basis }}</div>
    <div class="flex justify-between" :class="[compact ? 'gap-1' : 'gap-3', diffSignClass(cell.diff), cell.key !== 'total' && (cell.diff ?? 0) < 0 ? 'font-bold' : '']" data-salary-line="diff"><span :class="compact ? '' : 'text-xs text-gray-500'">差</span><span>{{ fmtSalaryDiff(cell.diff) }}</span></div>
    <div v-if="cell.key === 'overtime' && overtimeFixed" class="text-right" :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'">月給 (固定残業) — 差は出さない</div>
  </div>
</template>
