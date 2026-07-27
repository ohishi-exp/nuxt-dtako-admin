// タイムカード日別 JSON → サマリの golden テスト (Refs #424 PR-B)
//
// 入力は**実機の応答をそのまま切り出した fixture**
// (`tests/fixtures/restraint-wage/timecard-daily-2026-06.json`、2026-06 の 4 名分)。
// 本物の summarizeTimecardMonth に通し、golden/timecard-summaries.json と全件突合する。
// 期待値は手計算しない — 意図したロジック変更のときは (この worker ディレクトリで)
//   UPDATE_GOLDEN=1 npx vitest run test/timecard-summary-golden.test.ts
// で golden を再生成し、diff を PR でレビューする (restraint-wage-golden.test.ts と同作法)。
//
// fixture に含めた 6 名は実データから意図して選んである:
//   1029 冨田　竜   … 乗務員 (非事務職)。日曜出勤 3 日・日跨ぎ 12 日・中抜け 4 日
//   1065 佐藤　泰弘 … 一般管理事務・非夜勤。**日跨ぎ 2 日 = 打刻エラー** (Refs #433)
//   1621 西山　珠里 … 非事務職。中抜けなし・休日出勤なしの素直な形
//   1663 松山　裕己 … 一般管理事務。中抜け 1 日 (昼をまたがない = 両方引く)
//   1670 松永　寿乃 … 一般管理事務。中抜け 1 日 (昼をまたぐ = 二重控除してはいけない)
//   1706 山根　幸数 … 一般管理事務・**夜勤者**。日跨ぎ 15 日だがエラーにせず、日曜の
//                     未承認出勤 2 日も自主出勤にせず通常計上する (Refs #433)
import { describe, expect, it } from 'vitest'
import { isClericalJob, summarizeTimecardMonth, type TimecardDailyRow } from '../src/timecard-summary'
import daily from '../../../tests/fixtures/restraint-wage/timecard-daily-2026-06.json'
import golden from '../../../tests/fixtures/restraint-wage/golden/timecard-summaries.json'

/** fixture の所定労働時間 (全社既定 8 時間)。work_schedules から解決した値の代わり。 */
const DAILY_WORK_MINUTES = 480

/** 承認済み休日出勤。1029 が出勤した日曜 (6/14・6/21・6/28) のうち **6/14 だけ**を
 * 承認し、承認あり / 未承認 (非事務職なので 1.35 で計上) の分岐を固定する。 */
const APPROVED = new Set(['1029|2026-06-14'])

/** 本番 D1 の `employee_attrs.job_name` 実測値。`isClericalJob` に通して事務職判定にする。 */
const JOB_NAMES: Record<string, string> = {
  1029: '乗務員',
  1065: '一般管理事務',
  1621: '乗務員',
  1663: '一般管理事務',
  1670: '一般管理事務',
  1706: '一般管理事務',
}

/** 夜勤者マスタ (`buildNightShiftIndex` の出力に相当)。1706 山根だけ。 */
const NIGHT_SHIFT = new Set(['1706'])

const UPDATE_GOLDEN = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN,
)

describe('timecard-summary golden (実機 fixture 2026-06)', () => {
  const rows = (daily as { rows: unknown[] }).rows as unknown as TimecardDailyRow[]
  const result = summarizeTimecardMonth(rows, {
    yearMonth: '2026-06',
    dailyWorkMinutesFor: () => DAILY_WORK_MINUTES,
    approvedHolidayWork: APPROVED,
    isClerical: driverCd => isClericalJob(JOB_NAMES[driverCd] ?? null),
    isNightShift: driverCd => NIGHT_SHIFT.has(driverCd),
  })

  if (UPDATE_GOLDEN) {
    it('golden を再生成した (UPDATE_GOLDEN)', async () => {
      const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as {
        writeFileSync: (path: string, data: string) => void
      }
      fs.writeFileSync(
        '../../tests/fixtures/restraint-wage/golden/timecard-summaries.json',
        `${JSON.stringify(result, null, 2)}\n`,
      )
      expect(result.summaries.length).toBeGreaterThan(0)
    })
    return
  }

  it('golden と全件一致する', () => {
    expect(result).toEqual(golden)
  })

  it('fixture は 6 名・実データ由来の形を保っている', () => {
    expect(result.summaries.map(s => s.driverCd)).toEqual(['1029', '1065', '1621', '1663', '1670', '1706'])
    expect(result.summaries.every(s => s.source === 'timecard')).toBe(true)
  })

  it('日別の恒等式が全日で成り立つ (実働 = 法定内 + 時間外 + 時間外深夜)', () => {
    // classifyMonth が statutory = 実働 − 時間外 − 時間外深夜 で出すので、
    // ここが負になる日があると法定内が 0 に潰れて賃金が過少になる
    for (const s of result.summaries) {
      for (const d of s.days) {
        const statutory = (d.workingMinutes ?? 0) - (d.overtimeMinutes ?? 0) - (d.overtimeNightMinutes ?? 0)
        expect(statutory).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('深夜 (通常) と時間外深夜は排他で、合計が実働を超えない', () => {
    for (const s of result.summaries) {
      for (const d of s.days) {
        const night = (d.nightMinutes ?? 0) + (d.overtimeNightMinutes ?? 0)
        expect(night).toBeLessThanOrEqual(d.workingMinutes ?? 0)
      }
    }
  })

  it('実働は拘束を超えない (休憩の引き忘れ・二重控除の検知)', () => {
    for (const s of result.summaries) {
      for (const d of s.days) {
        expect(d.workingMinutes ?? 0).toBeLessThanOrEqual(d.restraintMinutes ?? 0)
      }
    }
  })

  it('非事務職 (乗務員) の未承認の日曜出勤は自主出勤にせず 1.35 で計上する (Refs #433)', () => {
    const tomita = result.summaries.find(s => s.driverCd === '1029')!
    // 打刻のある日曜だけを見る (6/7 は公休で打刻が無い)
    const sundays = tomita.days.filter(d => d.holidayKind === 'legal' && d.sessions.length > 0)
    expect(sundays.map(d => d.day)).toEqual([14, 21, 28])
    for (const d of sundays) {
      expect(d.isRestDay).toBe(false)
      expect(d.voluntaryMinutes).toBe(0)
      expect(d.workingMinutes).toBeGreaterThan(0)
    }
    // 承認が無い 6/21・6/28 も含めて自主出勤へは落ちない
    expect(tomita.voluntaryMinutes).toBe(0)
  })

  it('夜勤者の未承認の日曜出勤は自主出勤にせず通常計上する (実データ: 山根 6/14・6/28、Refs #433)', () => {
    // 夜勤ローテーションでは日曜も通常の勤務日。割増も付けない (holidayKind = weekday)
    const yamane = result.summaries.find(s => s.driverCd === '1706')!
    const sundays = yamane.days.filter(d => d.day === 14 || d.day === 28)
    expect(sundays.length).toBe(2)
    for (const d of sundays) {
      expect(d.isRestDay).toBe(false)
      expect(d.voluntaryMinutes).toBe(0)
      expect(d.holidayKind).toBe('weekday')
      expect(d.workingMinutes).toBeGreaterThan(0)
    }
    expect(yamane.voluntaryMinutes).toBe(0)
  })

  it('この fixture に自主出勤は 1 件も出ない (休日打刻を持つのが 1029 非事務職 と 1706 夜勤者だけのため)', () => {
    // 自主出勤 = 事務職**かつ非夜勤**の未承認休日打刻。実データ 6 名にその組み合わせが
    // 居ないので golden では 0 になる — 隔離そのものの検証は timecard-summary.test.ts 側
    expect(result.summaries.every(s => s.voluntaryMinutes === 0)).toBe(true)
  })

  it('承認済みの日曜出勤は勤務日として時間が出る', () => {
    const tomita = result.summaries.find(s => s.driverCd === '1029')!
    const approved = tomita.days.find(d => d.day === 14)!
    expect(approved.isRestDay).toBe(false)
    expect(approved.workingMinutes).toBeGreaterThan(0)
    expect(approved.voluntaryMinutes).toBe(0)
  })

  it('事務職の日跨ぎは打刻エラーになり、賃金計算から外れる (実データ: 佐藤 6/8・6/25)', () => {
    const sato = result.summaries.find(s => s.driverCd === '1065')!
    expect(sato.punchErrorDays).toBe(2)
    const errors = sato.days.filter(d => d.punchErrorMinutes > 0)
    expect(errors.map(d => d.day)).toEqual([8, 25])
    for (const d of errors) {
      expect(d.isRestDay).toBe(true)
      expect(d.workingMinutes).toBe(0)
      expect(d.overtimeMinutes).toBe(0)
      // 打刻は残す (総務が CakePHP 側で直すための手掛かり)
      expect(d.sessions.length).toBeGreaterThan(0)
    }
    // 35.6h + 36.6h の架空拘束が残業合計へ入っていない
    expect(sato.punchErrorMinutes).toBe(2138 + 2194)
  })

  it('夜勤者の日跨ぎは 15 日すべてエラーにしない (実データ: 山根)', () => {
    const yamane = result.summaries.find(s => s.driverCd === '1706')!
    expect(yamane.punchErrorDays).toBe(0)
    // 15 日すべて日跨ぎ (19:43 → 翌 00:02)。日曜の 2 日も自主出勤にせず計上するので
    // 15 日すべてが勤務日 (Refs #433)
    expect(yamane.days.length).toBe(15)
    expect(yamane.days.every(d => d.sessions.some(s => s.end !== null && s.start.slice(0, 10) !== s.end.slice(0, 10)))).toBe(true)
    expect(yamane.workDays).toBe(15)
  })

  it('非事務職 (乗務員) の日跨ぎは 1 件もエラーにならない', () => {
    const tomita = result.summaries.find(s => s.driverCd === '1029')!
    expect(tomita.punchErrorDays).toBe(0)
    const crossing = tomita.days.filter(d => d.sessions.some(s => s.end !== null && s.start.slice(0, 10) !== s.end.slice(0, 10)))
    expect(crossing.length).toBe(12)
  })

  it('打刻の無い休暇日も行として出て、時間 0 で区分だけ載る (Refs #433)', () => {
    const sato = result.summaries.find(s => s.driverCd === '1065')!
    // 実データ: 6/7・6/9・6/14・6/21・6/28 が公休
    const kyuka = sato.days.filter(d => d.leaves.includes('公休'))
    expect(kyuka.map(d => d.day)).toEqual([7, 9, 14, 21, 28])
    for (const d of kyuka) {
      expect(d.isRestDay).toBe(true)
      expect(d.workingMinutes).toBe(0)
      expect(d.sessions).toEqual([])
    }
    expect(sato.leaveCounts.publicHoliday).toBe(5)
  })

  it('打刻エラーの翌日が公休で消えている (画面で 9 日が空欄になる理由)', () => {
    const sato = result.summaries.find(s => s.driverCd === '1065')!
    // 6/8 の終業が 6/9 18:52 と組まれた結果、6/9 に打刻の行が無い
    const d9 = sato.days.find(d => d.day === 9)!
    expect(d9.sessions).toEqual([])
    expect(sato.days.find(d => d.day === 8)!.punchErrorMinutes).toBeGreaterThan(0)
  })

  it('中抜けのある日は sessions が 2 本以上で、休憩が中抜け分だけ増える', () => {
    const split = result.summaries.flatMap(s => s.days).filter(d => d.sessions.length > 1)
    expect(split.length).toBeGreaterThan(0)
    for (const d of split) {
      expect((d.restraintMinutes ?? 0) - (d.workingMinutes ?? 0)).toBeGreaterThan(0)
    }
  })

  it('勤務日の sessions は実データの打刻がそのまま入る (タイムカード表の素材)', () => {
    const matsunaga = result.summaries.find(s => s.driverCd === '1670')!
    // 松永 2026-06-11: 07:44:15 → 11:41:10 / 13:14:38 → 16:49:11 (中抜けが昼をまたぐ日)
    const d11 = matsunaga.days.find(d => d.day === 11)!
    expect(d11.sessions).toEqual([
      { start: '2026-06-11 07:44:15', end: '2026-06-11 11:41:10' },
      { start: '2026-06-11 13:14:38', end: '2026-06-11 16:49:11' },
    ])
  })

  it('実働は拘束を超えない — 打刻エラーの日も 0 対 0 で成立する', () => {
    // 上の「実働は拘束を超えない」と重なるが、隔離した日が負の差を作らないことの明示
    for (const s of result.summaries) {
      for (const d of s.days.filter(x => x.punchErrorMinutes > 0)) {
        expect(d.restraintMinutes).toBe(0)
        expect(d.workingMinutes).toBe(0)
      }
    }
  })

  it('法定外休日の承認が無いので warning は出ない', () => {
    expect(result.warnings).toEqual([])
  })
})
