<script setup lang="ts">
/**
 * 月次集計テーブル (theearth プレビュー形式 + 時間給の法定区分列、Refs #244)。
 * 単月表示と一括印刷 (月毎 1 テーブル) の両方で使う。
 * `expandWage` で時間給内訳列の表示/非表示を切り替える (印刷にもそのまま効く)。
 *
 * **時間区分 (時間外・週40超過・深夜・時間外深夜・法定休日) は `row.wage.minutes`
 * = 最低賃金チェックと同じ `classifyMonth` の結果を出す** (2026-07-28 決定)。
 * サマリの生値 (`summary.overtimeMinutes` 等) は法定休日に働いた分の時間外も
 * 含んでいるため、同じ人・同じ月で 2 タブの時間外が食い違っていた
 * (実測: 1018 / 2026-04 で 78h06m vs 68h54m、差は日曜 4 日分の 9h12m)。
 * 賃金は法定休日労働を休日割増 1.35 に一本化する側が正なので、そちらへ寄せる。
 */
import type { WageReportRow } from '~/utils/restraint-wage-view'

defineProps<{
  rows: WageReportRow[]
  expandWage: boolean
}>()

/**
 * 日数の表示 (Refs #433)。**0 も「-」にする** — 休暇データを持たない
 * デジタコ由来の行 (undefined) と「その月は 0 日だった」を、この列では区別しても
 * 意味がないため。半休で 0.5 が出るので小数は 1 桁まで残す。
 */
function fmtDays(n: number | undefined): string {
  if (!n) return '-'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
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
          <!-- 勤怠 (Refs #433)。打刻から数えた日数なのでタイムカード由来の行にだけ入る。
               デジタコ由来の乗務員は休暇データを持たないので「-」 -->
          <th class="px-1.5 py-1.5 text-right kintai-col" title="打刻から数えた公休日数 (公休 / 泊休 / 積置泊休 / 指休)。デジタコ由来の乗務員は休暇データを持たないため「-」">公休</th>
          <th class="px-1.5 py-1.5 text-right kintai-col" title="打刻から数えた有休日数 (有休 = 1.0、前休 / 後休 = 0.5)">有休</th>
          <th class="px-1.5 py-1.5 text-right kintai-col" title="打刻から数えた欠勤日数">欠勤</th>
          <th class="px-1.5 py-1.5 text-right kintai-col" title="打刻が翌日にまたがっていた日数 (終業の押し忘れ)。この日の時間は賃金計算から外れている">打刻<br>エラー</th>
          <th class="px-1.5 py-1.5 text-right">実働</th>
          <!-- 時間区分は最低賃金チェックと同じ `classifyMonth` の結果を出す (2026-07-28 決定)。
               サマリの生 `overtimeMinutes` は法定休日に働いた分の時間外も混ざっており、
               同じ月の同じ人が 2 タブで違う時間外になっていた -->
          <th class="px-1.5 py-1.5 text-right" title="法定休日を除いた平日・法定外休日の時間外 (最低賃金チェックの「残業代」列と同じ値)">時間外</th>
          <th class="px-1.5 py-1.5 text-right" title="週40時間超過分 (時間外・法定休日として計上済みの分は除く)">週40<br>超過</th>
          <th class="px-1.5 py-1.5 text-right" title="残業ではない通常勤務中の深夜 (0.25 加算分。実働の内数)">深夜</th>
          <th class="px-1.5 py-1.5 text-right" title="時間外かつ深夜">時間外<br>深夜</th>
          <th class="px-1.5 py-1.5 text-right" title="法定休日 (既定 日曜) の実働。労基法上この日に時間外の概念は無く休日割増 1.35 (深夜は 1.6) に一本化されるため、時間外列には出ない。深夜分がある行は下段に併記">法定<br>休日</th>
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
          <td class="px-1.5 py-1 text-right kintai-col">{{ fmtDays(row.summary.leaveCounts?.publicHoliday) }}</td>
          <td class="px-1.5 py-1 text-right kintai-col">{{ fmtDays(row.summary.leaveCounts?.paidLeave) }}</td>
          <td class="px-1.5 py-1 text-right kintai-col">{{ fmtDays(row.summary.leaveCounts?.absence) }}</td>
          <td
            class="px-1.5 py-1 text-right kintai-col"
            :class="(row.summary.punchErrorDays ?? 0) > 0 ? 'text-red-600 font-bold dark:text-red-400' : ''"
          >
            {{ fmtDays(row.summary.punchErrorDays) }}
          </td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.summary.workingMinutes) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.wage.minutes.overtime) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.wage.minutes.weekly40Excess) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.wage.minutes.night) }}</td>
          <td class="px-1.5 py-1 text-right">{{ fmtMinutes(row.wage.minutes.overtimeNight) }}</td>
          <td class="px-1.5 py-1 text-right">
            {{ fmtMinutes(row.wage.minutes.legalHoliday) }}
            <!-- 法定休日の深夜 (1.6 倍) は別単価なので、有る行だけ下段に出す
                 (常設列にすると既定の日勤者では全行 0h00m で紙面を食うだけ) -->
            <div v-if="row.wage.minutes.legalHolidayNight > 0" class="text-[10px] text-gray-500" title="うち深夜 (1.6 倍)">
              夜 {{ fmtMinutes(row.wage.minutes.legalHolidayNight) }}
            </div>
          </td>
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
