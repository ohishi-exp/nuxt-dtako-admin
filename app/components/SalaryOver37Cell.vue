<script setup lang="ts">
/**
 * 給与比較の「残業代 (37条)」セルの中身。基礎単価 (と分母の根拠) / 残業時間 / 理論値 / 支給 / 差の 5 段、
 * 出せないときはその理由。基礎単価が最低賃金を下回る月は赤太字のエラー。画面の表と印刷の紙面が同じ部品を使う (紙面は `compact`)。
 * 値は `salaryRowCells` が運んだもの — ここは並べるだけ。
 */
import { diffSignClass, fmtSalaryDiff, type LitigationSalaryOver37 } from '~/utils/litigation-salary'
import { fmtMinutes, fmtRatePerHour, fmtYen } from '~/utils/restraint-wage-view'

withDefaults(defineProps<{
  over37: LitigationSalaryOver37 | null
  /** `over37` が null のときの理由 */
  noneReason: string
  compact?: boolean
}>(), { compact: false })
</script>

<template>
  <div class="tabular-nums" :class="compact ? 'leading-tight' : ''">
    <template v-if="over37">
      <div class="flex justify-between" :class="[compact ? 'gap-1' : 'gap-3', over37.belowMinWage ? 'font-bold text-red-600 dark:text-red-400' : '']" data-salary-line="rate"><span :class="compact || over37.belowMinWage ? '' : 'text-xs text-gray-500'">基礎単価</span><span>{{ fmtRatePerHour(over37.rate) }} 円/h</span></div>
      <div v-if="over37.belowMinWage" class="text-right font-bold text-red-600 dark:text-red-400" :class="compact ? '' : 'text-xs'" data-salary-line="below-minwage">37条の基礎単価が最低賃金 {{ fmtRatePerHour(over37.minWageRate) }} 円/h を下回る</div>
      <div class="text-right" :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'" data-salary-line="rate-basis">= {{ over37.rateBasis }}</div>
      <div v-if="over37.scheduledNote" class="text-right" :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'" data-salary-line="scheduled-note">{{ over37.scheduledNote }}</div>
      <div class="flex justify-between" :class="compact ? 'gap-1' : 'gap-3'" data-salary-line="minutes"><span :class="compact ? '' : 'text-xs text-gray-500'">残業時間</span><span>{{ fmtMinutes(over37.minutes) }}</span></div>
      <div class="flex justify-between" :class="compact ? 'gap-1' : 'gap-3'" data-salary-line="theory"><span :class="compact ? '' : 'text-xs text-gray-500'">理論値</span><span>{{ fmtYen(over37.theory) }}</span></div>
      <div class="flex justify-between" :class="compact ? 'gap-1' : 'gap-3'" data-salary-line="paid"><span :class="compact ? '' : 'text-xs text-gray-500'">支給</span><span>{{ fmtYen(over37.paid) }}</span></div>
      <div class="flex justify-between" :class="[compact ? 'gap-1' : 'gap-3', diffSignClass(over37.diff), over37.shortfall ? 'font-bold' : '']" data-salary-line="diff37"><span :class="compact ? '' : 'text-xs text-gray-500'">差</span><span>{{ fmtSalaryDiff(over37.diff) }}</span></div>
    </template>
    <div v-else class="text-right" :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'" data-salary-line="none">- {{ noneReason }}</div>
  </div>
</template>
