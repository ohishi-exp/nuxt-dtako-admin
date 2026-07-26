// タイムカード日別 JSON → サマリの golden テスト (Refs #424 PR-B)
//
// 入力は**実機の応答をそのまま切り出した fixture**
// (`tests/fixtures/restraint-wage/timecard-daily-2026-06.json`、2026-06 の 4 名分)。
// 本物の summarizeTimecardMonth に通し、golden/timecard-summaries.json と全件突合する。
// 期待値は手計算しない — 意図したロジック変更のときは (この worker ディレクトリで)
//   UPDATE_GOLDEN=1 npx vitest run test/timecard-summary-golden.test.ts
// で golden を再生成し、diff を PR でレビューする (restraint-wage-golden.test.ts と同作法)。
//
// fixture に含めた 4 名は実データから意図して選んである:
//   1029 冨田　竜   … 乗務員。日曜出勤 3 日・日跨ぎ 12 日・中抜け 4 日
//   1621 西山　珠里 … 事務/パート層。中抜けなし・休日出勤なしの素直な形
//   1663 松山　裕己 … 中抜け 1 日 (昼をまたがない = 中抜けと 12:00-13:00 の両方を引く)
//   1670 松永　寿乃 … 中抜け 1 日 (昼をまたぐ = 二重控除してはいけない)
import { describe, expect, it } from 'vitest'
import { summarizeTimecardMonth, type TimecardDailyRow } from '../src/timecard-summary'
import daily from '../../../tests/fixtures/restraint-wage/timecard-daily-2026-06.json'
import golden from '../../../tests/fixtures/restraint-wage/golden/timecard-summaries.json'

/** fixture の所定労働時間 (全社既定 8 時間)。work_schedules から解決した値の代わり。 */
const DAILY_WORK_MINUTES = 480

/** 承認済み休日出勤。1029 が出勤した日曜 (6/14・6/21・6/28) のうち **6/14 だけ**を
 * 承認し、残り 2 日が自主出勤へ落ちることを golden で固定する。 */
const APPROVED = new Set(['1029|2026-06-14'])

const UPDATE_GOLDEN = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN,
)

describe('timecard-summary golden (実機 fixture 2026-06)', () => {
  const rows = (daily as { rows: unknown[] }).rows as unknown as TimecardDailyRow[]
  const result = summarizeTimecardMonth(rows, {
    yearMonth: '2026-06',
    dailyWorkMinutesFor: () => DAILY_WORK_MINUTES,
    approvedHolidayWork: APPROVED,
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

  it('fixture は 4 名・実データ由来の形を保っている', () => {
    expect(result.summaries.map(s => s.driverCd)).toEqual(['1029', '1621', '1663', '1670'])
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

  it('未承認の日曜出勤は自主出勤になり、賃金計算から外れる', () => {
    const tomita = result.summaries.find(s => s.driverCd === '1029')!
    const voluntary = tomita.days.filter(d => d.holidayKind === 'legal' && d.isRestDay)
    expect(voluntary.length).toBeGreaterThan(0)
    for (const d of voluntary) {
      expect(d.workingMinutes).toBe(0)
      expect(d.overtimeMinutes).toBe(0)
      expect(d.voluntaryMinutes).toBeGreaterThan(0)
    }
    expect(tomita.voluntaryMinutes).toBe(voluntary.reduce((s, d) => s + d.voluntaryMinutes, 0))
  })

  it('承認済みの日曜出勤は勤務日として時間が出る', () => {
    const tomita = result.summaries.find(s => s.driverCd === '1029')!
    const approved = tomita.days.find(d => d.day === 14)!
    expect(approved.isRestDay).toBe(false)
    expect(approved.workingMinutes).toBeGreaterThan(0)
    expect(approved.voluntaryMinutes).toBe(0)
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

  it('自主出勤の日も打刻を残す (賃金計算からは外すが表には出す)', () => {
    const tomita = result.summaries.find(s => s.driverCd === '1029')!
    const voluntary = tomita.days.filter(d => d.isRestDay && d.voluntaryMinutes > 0)
    expect(voluntary.length).toBeGreaterThan(0)
    for (const d of voluntary) expect(d.sessions.length).toBeGreaterThan(0)
  })

  it('法定外休日の承認が無いので warning は出ない', () => {
    expect(result.warnings).toEqual([])
  })
})
