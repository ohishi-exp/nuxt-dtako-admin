<script setup lang="ts">
/**
 * 期間サマリー印刷の 1 ヶ月分の一覧 (Refs #443)。
 *
 * 既存のタイムカード表 (`TimecardTable.vue`) が「1 人 1 枚 × 日別」なのに対し、
 * こちらは「1 ヶ月 1 枚 × 1 人 1 行」。総務が期間の日数を突き合わせるための形で、
 * 日別の打刻は出さない。
 *
 * 残業(給与) と 残業(計算) は**並べるだけで差の判定はしない** — 事務員は実残業を
 * つけていない運用なので、差が出るのが前提 (Refs #424)。
 */
import { fmtMinutes, fmtYen } from '~/utils/restraint-wage-view'
import type { TimecardSummaryRow } from '~/utils/timecard-view'

defineProps<{
  rows: TimecardSummaryRow[]
}>()

/** 行クリック = その人の日別表を見たい (数字の根拠を確かめる導線)。 */
const emit = defineEmits<{ select: [driverCd: string] }>()

/** 日数の表示。0 は空欄 (0 が並ぶと非ゼロが目に入らない)。半休の 0.5 は 1 桁残す。 */
function fmtDays(n: number): string {
  if (!n) return ''
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
</script>

<template>
  <div class="overflow-x-auto print:overflow-visible">
    <table class="w-full text-xs monthly-table">
      <thead>
        <tr class="text-left text-gray-500 border-b-2 border-gray-300 dark:border-gray-600">
          <th class="px-1.5 py-1.5">乗務員</th>
          <th class="px-1.5 py-1.5 text-right" title="出勤した日数。残業の有無で分けず、打刻エラーの日も含む (押し忘れただけで出勤はしている)。時間の列からは打刻エラーの日は外れている">出勤</th>
          <th class="px-1.5 py-1.5 text-right" title="休日出勤の承認簿に載っている日">休日<br>出勤</th>
          <th class="px-1.5 py-1.5 text-right" title="休日に打刻があるが未承認の日。時間は記録するが賃金計算には入れていない">自主<br>出勤</th>
          <th class="px-1.5 py-1.5 text-right" title="公休 / 泊休 / 積置泊休 / 指休">公休</th>
          <th class="px-1.5 py-1.5 text-right" title="有休 = 1.0、前休 / 後休 = 0.5">有休</th>
          <th class="px-1.5 py-1.5 text-right">欠勤</th>
          <th class="px-1.5 py-1.5 text-right">特休</th>
          <th class="px-1.5 py-1.5 text-right">遅刻</th>
          <th class="px-1.5 py-1.5 text-right">早退</th>
          <th class="px-1.5 py-1.5 text-right" title="打刻が翌日にまたがっていた日数 (終業の押し忘れ)。この日の時間は賃金計算から外れている">打刻<br>エラー</th>
          <th class="px-1.5 py-1.5 text-right">実働</th>
          <th class="px-1.5 py-1.5 text-right" title="打刻から計算した残業 (実働 − 所定労働時間)">残業<br>(計算)</th>
          <th class="px-1.5 py-1.5 text-right" title="給与明細の残業手当。その月の明細を取り込んでいなければ空欄">残業<br>(給与)</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.driverCd"
          class="border-b border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 print:cursor-auto print:hover:bg-transparent"
          :title="`${row.driverName} の日別表を開く`"
          @click="emit('select', row.driverCd)"
        >
          <td class="px-1.5 py-1 whitespace-nowrap">{{ row.driverCd }} {{ row.driverName }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtDays(row.attendanceDays) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtDays(row.counts.holidayWork) }}</td>
          <td class="px-1.5 py-1 text-right text-amber-600 dark:text-amber-400">{{ fmtDays(row.counts.voluntary) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtDays(row.leaves.publicHoliday) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtDays(row.leaves.paidLeave) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtDays(row.leaves.absence) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtDays(row.leaves.specialLeave) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtDays(row.leaves.late) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtDays(row.leaves.earlyLeave) }}</td>
          <td class="px-1.5 py-1 text-right text-red-600 dark:text-red-400">{{ fmtDays(row.counts.punchError) }}</td>
          <td class="px-1.5 py-1 text-right font-medium">{{ fmtMinutes(row.workingMinutes) }}</td>
          <td class="px-1.5 py-1 text-right">{{ row.overtimeMinutes > 0 ? fmtMinutes(row.overtimeMinutes) : '' }}</td>
          <td class="px-1.5 py-1 text-right">{{ row.salaryOvertime == null ? '' : fmtYen(row.salaryOvertime) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
