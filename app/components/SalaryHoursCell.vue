<script setup lang="ts">
/**
 * 給与比較の「計算で使った労働時間」セル。デジタコの時間 (wage report の欄) / 明細の日数 / 37条の分母を縦に積む。
 * 訴訟準備の画面の表と印刷の紙面が**同じ部品**を使う (紙面は `compact` で行を横に流して高さを詰める)。
 * compact は幅 (`w-44`) を締める — 行を横に流しただけだと列の max-content が全部 1 行ぶんになり、ほかの列を押し潰して紙面の行が高くなる。
 * 値と文言は `salaryRowCells` (`app/utils/litigation-salary.ts`) が運んだもの — ここは並べるだけ。
 */
import type { LitigationSalaryHours } from '~/utils/litigation-salary'

withDefaults(defineProps<{
  hours: LitigationSalaryHours
  compact?: boolean
}>(), { compact: false })
</script>

<template>
  <div class="tabular-nums" :class="compact ? 'leading-tight w-44' : ''">
    <div :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'" data-salary-line="hours-digitaco-head">デジタコ</div>
    <div :class="compact ? 'flex flex-wrap gap-x-2' : ''">
      <div
        v-for="l in hours.digitaco"
        :key="l.key"
        class="flex justify-between"
        :class="compact ? 'gap-1' : 'gap-3'"
        :data-salary-line="`hours-${l.key}`"
      ><span :class="compact ? '' : 'text-xs text-gray-500'">{{ l.label }}</span><span>{{ l.value }}</span></div>
    </div>
    <div :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'" data-salary-line="hours-csv-head">明細</div>
    <div :class="compact ? 'flex flex-wrap gap-x-2' : ''">
      <div v-if="hours.csvNoDays" :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'" data-salary-line="hours-csv-no-days">明細に日数なし</div>
      <div
        v-for="l in hours.csv"
        :key="l.key"
        class="flex justify-between"
        :class="compact ? 'gap-1' : 'gap-3'"
        :data-salary-line="`hours-${l.key}`"
      ><span :class="compact ? '' : 'text-xs text-gray-500'">{{ l.label }}</span><span>{{ l.value }}</span></div>
    </div>
    <div v-if="hours.denominator" :class="compact ? 'text-gray-600' : 'text-xs text-gray-500'" data-salary-line="hours-denominator">37条の分母: {{ hours.denominator }}</div>
  </div>
</template>
