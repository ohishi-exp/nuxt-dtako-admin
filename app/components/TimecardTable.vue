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
import type { OvertimeHoursComparison } from '~/utils/salary-compare'
import type { TimecardTableRow, WorkKindCounts } from '~/utils/timecard-view'

/** 拘束 (打刻) 側と給与明細側、日数 1 項目分。給与側が引けなければ null (Refs #441)。 */
interface DayCountPair { sys: number, csv: number | null }

const props = defineProps<{
  driverCd: string
  driverName: string
  /** "YYYY-MM" */
  month: string
  rows: TimecardTableRow[]
  /** 勤務区分ごとの日数。 */
  counts: WorkKindCounts
  /** 残業の「拘束時間 vs 給与換算時間」比較 (Refs #441)。null なら非表示。 */
  overtimeCompare?: OvertimeHoursComparison | null
  /** 出勤・休日出勤・公休の日数比較 (拘束 vs 給与明細、Refs #441)。休日出勤は
   * 給与明細の様式に列が無いため csv は常に null。null なら非表示。 */
  attendanceCompare?: {
    work: DayCountPair
    holidayWork: DayCountPair
    publicHoliday: DayCountPair
  } | null
  /** 月の拘束と深夜 (Refs #472 PR-D)。日別の 8 列は増やさずここに出す。null なら非表示。 */
  restraint?: {
    restraintMinutes: number
    nightMinutes: number
    overtimeNightMinutes: number
    /** 法定時間外 (8h 超)。法定休日の実働は含まない。 */
    overtimeMinutes: number
    /** 法定休日 (日曜) の実働。 */
    legalHolidayMinutes: number
  } | null
  /**
   * 内訳列 (拘束 / 休憩 / 時間外 / 時間外深夜 / 深夜) を出すか (2026-07-28 指示)。
   *
   * **1 人だけ表示している時だけ true。** 3 人横並び (印刷・一覧) では紙幅に入らず、
   * 8 列に揃えてある社内 PDF の形も崩れる。
   */
  detailed?: boolean
}>()

/** 分の符号付き表示 ("+2h13m" / "-2h13m")。0 は符号無し。 */
function fmtSignedMinutes(minutes: number): string {
  if (minutes === 0) return fmtMinutes(0)
  const sign = minutes > 0 ? '+' : '-'
  return `${sign}${fmtMinutes(Math.abs(minutes))}`
}

/** "拘束 5日 / 給与 5日" (csv が無ければ "拘束 5日" のみ)。 */
function fmtDayPair(pair: DayCountPair): string {
  return pair.csv == null ? `拘束${pair.sys}日` : `拘束${pair.sys}日/給与${pair.csv}日`
}

/** 出勤・休日出勤・公休の日数比較を 1 行にまとめる (Refs #441)。全部 0 の月は出さない。 */
const attendanceSummary = computed(() => {
  const a = props.attendanceCompare
  if (!a) return ''
  return [
    ['出勤', a.work],
    ['休日出勤', a.holidayWork],
    ['公休', a.publicHoliday],
  ]
    .filter(([, pair]) => (pair as DayCountPair).sys > 0 || ((pair as DayCountPair).csv ?? 0) > 0)
    .map(([label, pair]) => `${label} ${fmtDayPair(pair as DayCountPair)}`)
    .join(' ・ ')
})

/**
 * 月の拘束と深夜の 1 行 (Refs #472 PR-D)。
 *
 * **日別の 8 列は増やさない** — 表の形は社内 PDF に合わせてあり、総務がその形で
 * 見慣れているため。人ごとのヘッダに足す。
 *
 * 深夜は「所定内・法定内残業に重なる深夜」と「時間外に重なる深夜」の**排他**な 2 本
 * (上流 #118)。合計を出して内訳を括弧に入れる — 時間外深夜だけ別枠で見たい場面が
 * あるが、合計が無いと深夜手当の当たりが付けられない。
 */
const restraintSummary = computed(() => {
  const r = props.restraint
  if (!r) return ''
  const night = r.nightMinutes + r.overtimeNightMinutes
  if (r.restraintMinutes <= 0 && night <= 0 && r.overtimeMinutes <= 0 && r.legalHolidayMinutes <= 0) return ''
  const parts = [`拘束: ${fmtMinutes(r.restraintMinutes)}`]
  // 0 の項目は出さない — 「深夜 0h00m (うち時間外深夜 0h00m)」は読む値が無い
  if (r.overtimeMinutes > 0) parts.push(`時間外: ${fmtMinutes(r.overtimeMinutes)}`)
  // 法定休日は時間外に入らない (休日割増 1.35 に一本化) ので別に出す
  if (r.legalHolidayMinutes > 0) parts.push(`法定休日: ${fmtMinutes(r.legalHolidayMinutes)}`)
  if (night > 0) {
    parts.push(`深夜: ${fmtMinutes(night)}`
      + (r.overtimeNightMinutes > 0 ? ` (うち時間外深夜 ${fmtMinutes(r.overtimeNightMinutes)})` : ''))
  }
  return parts.join(' ・ ')
})

/** 有休・欠勤・自主出勤の日数 (0 の区分は出さない)。打刻エラーだけは別枠で赤く出すので
 * ここには入れない。出勤・休日出勤・公休は上の attendanceSummary (拘束/給与比較) が
 * 担当するのでここでは重複させない (Refs #441)。 */
const kindSummary = computed(() => {
  const c = props.counts
  return [
    ['自主出勤', c.voluntary],
    ['有休', c.paidLeave],
    ['欠勤', c.absence],
  ].filter(([, n]) => (n as number) > 0).map(([label, n]) => `${label} ${n}日`).join(' / ')
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
    <!-- 出勤・休日出勤・公休の日数 (拘束/打刻 vs 給与明細、Refs #441) -->
    <div v-if="attendanceSummary" class="py-0.5 text-gray-500">{{ attendanceSummary }}</div>
    <div v-if="kindSummary" class="py-0.5 text-gray-500">{{ kindSummary }}</div>
    <!-- 打刻エラーは総務が CakePHP 側で直す必要があるので、区分サマリに埋めずに立てる -->
    <div v-if="counts.punchError > 0" class="py-0.5 font-semibold text-red-600 dark:text-red-400">
      打刻エラー {{ counts.punchError }} 日 ({{ fmtMinutes(counts.punchErrorMinutes) }})
    </div>
    <!-- 残業の「拘束時間 vs 給与換算時間」比較 (Refs #441)。給与側は基礎単価(実績) が
         無い (給与比較タブで CSV 未取り込み等) と "-" になる -->
    <div
      v-if="overtimeCompare && (overtimeCompare.sysMinutes > 0 || (overtimeCompare.paidMinutes ?? 0) > 0)"
      class="py-0.5 text-gray-500"
      title="給与 = 給与明細の勤怠欄にある残業時間そのもの (KINDATA)。給与比較タブで明細を取り込んでいない月は「-」"
    >
      残業: 実働 {{ fmtMinutes(overtimeCompare.sysMinutes) }}
      / 給与 {{ overtimeCompare.paidMinutes != null ? fmtMinutes(overtimeCompare.paidMinutes) : '-' }}
      <span
        v-if="overtimeCompare.diffMinutes != null"
        :class="overtimeCompare.diffMinutes > 0 ? 'text-amber-600 dark:text-amber-400' : ''"
      >
        (差 {{ fmtSignedMinutes(overtimeCompare.diffMinutes) }})
      </span>
    </div>
    <!-- 月の拘束と深夜 (Refs #472 PR-D)。日別の列は増やさずここに出す -->
    <div v-if="restraintSummary" class="py-0.5 text-gray-500">{{ restraintSummary }}</div>

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
          <template v-if="detailed">
            <th class="border-b border-gray-200 py-0.5 text-right font-normal dark:border-gray-700" title="法定時間外 (8h 超)。法定休日の実働は含まない">時間外</th>
            <th class="border-b border-gray-200 py-0.5 text-right font-normal dark:border-gray-700" title="時間外に重なる深夜 (残業列の内数)">時間外<br>深夜</th>
            <th class="border-b border-gray-200 py-0.5 text-right font-normal dark:border-gray-700" title="その日に深夜帯 (22:00-05:00) で働いた時間">深夜</th>
          </template>
          <th class="border-b border-gray-200 py-0.5 text-left font-normal dark:border-gray-700">備考</th>
          <!-- その日の実働 (拘束 − 休憩)。打刻の無い日にも乗る (Refs #472) -->
          <template v-if="detailed">
            <th class="border-b border-gray-200 py-0.5 text-right font-normal dark:border-gray-700" title="終業 − 始業 (休憩を含む)">拘束</th>
            <th class="border-b border-gray-200 py-0.5 text-right font-normal dark:border-gray-700" title="拘束 − 実働">休憩</th>
          </template>
          <th class="border-b border-gray-200 py-0.5 text-right font-normal dark:border-gray-700">実働</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.day"
          :class="[
            r.isSunday ? 'bg-gray-100 dark:bg-gray-800/60' : '',
            r.isVoluntary ? 'text-amber-600 dark:text-amber-400' : '',
            r.isPunchError ? 'font-semibold text-red-600 dark:text-red-400' : '',
            r.isAfterPunchError ? 'text-red-500/80 dark:text-red-400/70' : '',
          ]"
        >
          <td class="py-0.5 text-right">{{ r.day }}</td>
          <td class="text-center" :class="r.isSunday ? 'text-red-600 dark:text-red-400' : ''">{{ r.dowLabel }}</td>
          <td class="text-center">{{ r.in1 ?? '' }}</td>
          <td class="text-center">{{ r.out1 ?? '' }}</td>
          <td class="text-center">{{ r.in2 ?? '' }}</td>
          <td class="text-center">{{ r.out2 ?? '' }}</td>
          <!-- 法定休日は残業ではないので括弧つきで出す (2026-07-28 決定)。備考には書かない -->
          <td class="text-right" :title="r.legalHolidayMinutes > 0 ? '法定休日 (日曜) の実働。時間外ではなく休日割増 1.35 倍' : undefined">
            {{ r.legalHolidayMinutes > 0 ? `(${fmtMinutes(r.legalHolidayMinutes)})` : (r.overtimeMinutes > 0 ? fmtMinutes(r.overtimeMinutes) : '') }}
          </td>
          <template v-if="detailed">
            <td class="text-right text-gray-500">{{ r.overtimeMinutes - r.overtimeNightMinutes > 0 ? fmtMinutes(r.overtimeMinutes - r.overtimeNightMinutes) : '' }}</td>
            <td class="text-right text-gray-500">{{ r.overtimeNightMinutes > 0 ? fmtMinutes(r.overtimeNightMinutes) : '' }}</td>
            <td class="text-right text-gray-500">{{ r.nightMinutes > 0 ? fmtMinutes(r.nightMinutes) : '' }}</td>
          </template>
          <td class="pl-1 text-left whitespace-nowrap">{{ r.note }}</td>
          <template v-if="detailed">
            <td class="pl-1 text-right text-gray-500">{{ r.restraintMinutes > 0 ? fmtMinutes(r.restraintMinutes) : '' }}</td>
            <td class="text-right text-gray-500">{{ r.breakMinutes > 0 ? fmtMinutes(r.breakMinutes) : '' }}</td>
          </template>
          <td class="pl-1 text-right text-gray-500">{{ r.workingMinutes > 0 ? fmtMinutes(r.workingMinutes) : '' }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 自主出勤は賃金計算に入らないので、合計を別枠で必ず見せる (Refs #424 の法的注記) -->
    <div v-if="counts.voluntaryMinutes > 0" class="mt-1 text-amber-600 dark:text-amber-400">
      自主出勤 合計 {{ fmtMinutes(counts.voluntaryMinutes) }} (賃金計算には入っていません)
    </div>
    <!-- 打刻エラーは「直せば数字が変わる」ので、何をすればよいかまで書く (Refs #433) -->
    <div class="mt-1 text-gray-500">
      打刻は<b>押された日の行</b>に出しています。日をまたぐ勤務 (夜勤・長距離) は
      出勤がその日、退社が翌日の行になります。
    </div>
    <div v-if="counts.punchError > 0" class="mt-1 text-red-600 dark:text-red-400">
      赤い日は<b>退勤の押し忘れ</b>です (次に押された退勤と組まれています)。時間は賃金計算に入れていません。
      タイムカード側で打刻を直してから勤怠を再取り込みしてください。
    </div>
  </div>
</template>
