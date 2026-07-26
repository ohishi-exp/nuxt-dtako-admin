<script setup lang="ts">
/**
 * 1 人分のタイムカード表 (Refs #424 PR-E)。
 *
 * 列も並びも**社内 CakePHP が出している既存 PDF に合わせてある**
 * (`TimeCardController::createPdf`) — 総務がその形で見慣れているため、
 * 日/曜/出勤1/退社1/出勤2/退社2/残業/備考 の 8 列固定・1〜月末の全日・日曜は網掛け。
 *
 * 印刷では 3 人が横に並ぶ (親の grid が担当)。ここは 1 人分だけを描く。
 */
import { fmtMinutes } from '~/utils/restraint-wage-view'
import type { TimecardTableRow, WorkKindCounts } from '~/utils/timecard-view'

const props = defineProps<{
  driverCd: string
  driverName: string
  /** "YYYY-MM" */
  month: string
  rows: TimecardTableRow[]
  /** 勤務区分ごとの日数。 */
  counts: WorkKindCounts
}>()

/** 0 の区分は出さない (毎行 "休日出勤 0" が並ぶと通常日の把握が鈍る)。 */
const kindSummary = computed(() => {
  const c = props.counts
  return [
    ['通常', c.normal],
    ['残業', c.overtime],
    ['休日出勤', c.holidayWork],
    ['自主出勤', c.voluntary],
  ].filter(([, n]) => (n as number) > 0).map(([label, n]) => `${label} ${n}`).join(' / ')
})
</script>

<template>
  <div class="timecard-sheet break-inside-avoid text-xs">
    <div class="flex items-baseline justify-between border-b border-gray-300 pb-1 dark:border-gray-600">
      <div class="font-semibold">
        {{ driverName }}
        <span class="ml-1 font-normal text-gray-500">{{ driverCd }}</span>
      </div>
      <div class="text-gray-500">{{ month.replace('-', '年') }}月</div>
    </div>
    <div v-if="kindSummary" class="py-0.5 text-gray-500">{{ kindSummary }}</div>

    <table class="w-full border-collapse tabular-nums">
      <thead>
        <tr class="text-gray-500">
          <th class="w-6 border-b border-gray-200 py-0.5 text-right font-normal dark:border-gray-700">日</th>
          <th class="w-5 border-b border-gray-200 py-0.5 text-center font-normal dark:border-gray-700">曜</th>
          <th class="border-b border-gray-200 py-0.5 text-center font-normal dark:border-gray-700">出勤1</th>
          <th class="border-b border-gray-200 py-0.5 text-center font-normal dark:border-gray-700">退社1</th>
          <th class="border-b border-gray-200 py-0.5 text-center font-normal dark:border-gray-700">出勤2</th>
          <th class="border-b border-gray-200 py-0.5 text-center font-normal dark:border-gray-700">退社2</th>
          <th class="border-b border-gray-200 py-0.5 text-right font-normal dark:border-gray-700">残業</th>
          <th class="border-b border-gray-200 py-0.5 text-left font-normal dark:border-gray-700">備考</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.day"
          :class="[
            r.isSunday ? 'bg-gray-100 dark:bg-gray-800/60' : '',
            r.isVoluntary ? 'text-amber-600 dark:text-amber-400' : '',
          ]"
        >
          <td class="py-0.5 text-right">{{ r.day }}</td>
          <td class="text-center" :class="r.isSunday ? 'text-red-600 dark:text-red-400' : ''">{{ r.dowLabel }}</td>
          <td class="text-center">{{ r.in1 ?? '' }}</td>
          <td class="text-center">{{ r.out1 ?? '' }}</td>
          <td class="text-center">{{ r.in2 ?? '' }}</td>
          <td class="text-center">{{ r.out2 ?? '' }}</td>
          <td class="text-right">{{ r.overtimeMinutes > 0 ? fmtMinutes(r.overtimeMinutes) : '' }}</td>
          <td class="pl-1 text-left whitespace-nowrap">{{ r.note }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 自主出勤は賃金計算に入らないので、合計を別枠で必ず見せる (Refs #424 の法的注記) -->
    <div v-if="counts.voluntaryMinutes > 0" class="mt-1 text-amber-600 dark:text-amber-400">
      自主出勤 合計 {{ fmtMinutes(counts.voluntaryMinutes) }} (賃金計算には入っていません)
    </div>
  </div>
</template>
