<script setup lang="ts">
/**
 * 月次集計テーブル (theearth プレビュー形式 + 時間給の法定区分列、Refs #244)。
 * 単月表示と一括印刷 (月毎 1 テーブル) の両方で使う。
 * `expandWage` で時間給内訳列の表示/非表示を切り替える (印刷にもそのまま効く)。
 */
import type { WageReportRow } from '~/utils/restraint-wage-view'

defineProps<{
  rows: WageReportRow[]
  expandWage: boolean
}>()
</script>

<template>
  <div class="overflow-x-auto print:overflow-visible">
    <table class="w-full text-xs monthly-table">
      <thead>
        <tr class="text-left text-gray-500 border-b-2 border-gray-300 dark:border-gray-600">
          <th class="px-1.5 py-1.5">乗務員</th>
          <th class="px-1.5 py-1.5 text-right">稼働<br>日数</th>
          <th class="px-1.5 py-1.5 text-right">運転</th>
          <th class="px-1.5 py-1.5 text-right">荷役</th>
          <th class="px-1.5 py-1.5 text-right">休憩</th>
          <th class="px-1.5 py-1.5 text-right">拘束<br>合計</th>
          <th class="px-1.5 py-1.5 text-right">年度累計<br>(前月まで)</th>
          <th class="px-1.5 py-1.5 text-right">当月<br>超過</th>
          <th class="px-1.5 py-1.5 text-right">15h超<br>日数</th>
          <th class="px-1.5 py-1.5 text-right">平均運転<br>9h超</th>
          <th class="px-1.5 py-1.5 text-right">実働</th>
          <th class="px-1.5 py-1.5 text-right">時間外</th>
          <th class="px-1.5 py-1.5 text-right">深夜</th>
          <th class="px-1.5 py-1.5 text-right">時間外<br>深夜</th>
          <th class="px-1.5 py-1.5 text-right wage-col">単価</th>
          <template v-if="expandWage">
            <th v-for="c in WAGE_COLUMNS" :key="c.key" class="px-1.5 py-1.5 text-right wage-col">{{ c.label }}</th>
          </template>
          <th class="px-1.5 py-1.5 text-right wage-col">時間給<br>合計</th>
          <th class="px-1.5 py-1.5 text-right wage-col">換算<br>時給</th>
          <th class="px-1.5 py-1.5 text-right wage-col">最低賃金<br>差</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.summary.driverCd" class="border-b border-gray-100 dark:border-gray-800">
          <td class="px-1.5 py-1 whitespace-nowrap">{{ row.summary.driverCd }} {{ row.summary.driverName }}</td>
          <td class="px-1.5 py-1 text-right">{{ row.summary.workDays }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.summary.drivingMinutes) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.summary.loadingMinutes) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.summary.breakMinutes) }}</td>
          <td class="px-1.5 py-1 text-right font-medium">{{ fmtMinutes(row.summary.restraintMinutes) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.summary.fiscalCumulativeMinutes) }}</td>
          <td class="px-1.5 py-1 text-right" :class="(row.summary.excessRestraintMinutes ?? 0) > 0 ? 'text-red-600 font-bold' : ''">
            {{ fmtMinutes(row.summary.excessRestraintMinutes) }}
          </td>
          <td class="px-1.5 py-1 text-right">{{ row.summary.over15hDays }}</td>
          <td class="px-1.5 py-1 text-right">{{ row.summary.avgDriving9hOverCount }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.summary.workingMinutes) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.summary.overtimeMinutes) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.summary.nightMinutes) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.summary.overtimeNightMinutes) }}</td>
          <td class="px-1.5 py-1 text-right wage-col">{{ fmtYen(row.wage.hourlyRate) }}</td>
          <template v-if="expandWage">
            <td v-for="c in WAGE_COLUMNS" :key="c.key" class="px-1.5 py-1 text-right wage-col">
              {{ row.wage.amounts ? fmtYen(row.wage.amounts[c.key]) : '-' }}
            </td>
          </template>
          <td class="px-1.5 py-1 text-right font-medium wage-col">{{ fmtYen(row.wage.totalAmount) }}</td>
          <td class="px-1.5 py-1 text-right wage-col">{{ fmtYen(row.wage.hourlyEquivalent) }}</td>
          <td class="px-1.5 py-1 text-right wage-col" :class="(row.wage.minWageDiff ?? 0) < 0 ? 'text-red-600 font-bold' : ''">
            {{ row.wage.minWageDiff == null ? '-' : (row.wage.minWageDiff >= 0 ? '+' : '') + fmtYen(row.wage.minWageDiff) }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
