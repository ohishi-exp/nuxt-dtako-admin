import { describe, expect, it } from 'vitest'
import {
  ALL_BRANCHES,
  ALL_JOBS,
  buildHolidayWorkIndex,
  buildHolidayWorkResponse,
  buildHolidayWorkWriteStatements,
  buildWorkScheduleResponse,
  buildWorkScheduleWriteStatements,
  isHolidayWorkApproved,
  normalizeHolidayWorkPutBody,
  normalizeWorkSchedulePutBody,
  resolveWorkScheduleAt,
  WorkScheduleError,
  type HolidayWorkD1Row,
  type WorkScheduleD1Row,
  type WorkScheduleRow,
} from '../src/work-schedule'

const COMP = '27324455'
const NOW = '2026-07-26T00:00:00.000Z'

/** 所定 1 行を組み立てるヘルパ (テストの意図を読みやすくする)。 */
function sched(
  effectiveFrom: string,
  dailyWorkMinutes: number,
  branchCode: number | null = null,
  jobName: string | null = null,
): WorkScheduleRow {
  return { effectiveFrom, branchCode, jobName, dailyWorkMinutes }
}

describe('normalizeWorkSchedulePutBody', () => {
  it('全フィールド省略時は空配列', () => {
    expect(normalizeWorkSchedulePutBody({})).toEqual({ schedules: [], deleteSchedules: [] })
  })

  it('スコープ未指定は null (= 全社既定)', () => {
    const body = normalizeWorkSchedulePutBody({
      schedules: [{ effectiveFrom: '2026-04-01', dailyWorkMinutes: 480 }],
    })
    expect(body.schedules).toEqual([
      { effectiveFrom: '2026-04-01', branchCode: null, jobName: null, dailyWorkMinutes: 480 },
    ])
  })

  it('スコープを指定できる (職種は NFKC + trim)', () => {
    const body = normalizeWorkSchedulePutBody({
      schedules: [
        { effectiveFrom: '2026-04-01', branchCode: 10, jobName: '　事務　', dailyWorkMinutes: 450 },
      ],
    })
    expect(body.schedules[0]).toEqual({
      effectiveFrom: '2026-04-01',
      branchCode: 10,
      jobName: '事務',
      dailyWorkMinutes: 450,
    })
  })

  it('branchCode の 0・負数・非整数・非数値は全拠点 (null) へ倒す', () => {
    const raw = (branchCode: unknown) =>
      normalizeWorkSchedulePutBody({
        schedules: [{ effectiveFrom: '2026-04-01', branchCode, dailyWorkMinutes: 480 }],
      }).schedules[0]!.branchCode
    expect(raw(0)).toBeNull()
    expect(raw(-5)).toBeNull()
    expect(raw(1.5)).toBeNull()
    expect(raw('10')).toBeNull()
    expect(raw(undefined)).toBeNull()
  })

  it('jobName の空文字・非文字列は全職種 (null) へ倒す', () => {
    const raw = (jobName: unknown) =>
      normalizeWorkSchedulePutBody({
        schedules: [{ effectiveFrom: '2026-04-01', jobName, dailyWorkMinutes: 480 }],
      }).schedules[0]!.jobName
    expect(raw('   ')).toBeNull()
    expect(raw(42)).toBeNull()
  })

  it('deleteSchedules も同じ規則で正規化される', () => {
    const body = normalizeWorkSchedulePutBody({
      deleteSchedules: [{ effectiveFrom: '2026-04-01', branchCode: 10, jobName: '事務' }],
    })
    expect(body.deleteSchedules).toEqual([
      { effectiveFrom: '2026-04-01', branchCode: 10, jobName: '事務' },
    ])
  })

  it('body がオブジェクトでなければ 400 相当', () => {
    expect(() => normalizeWorkSchedulePutBody(null)).toThrow(WorkScheduleError)
    expect(() => normalizeWorkSchedulePutBody([])).toThrow(WorkScheduleError)
    expect(() => normalizeWorkSchedulePutBody('x')).toThrow(WorkScheduleError)
  })

  it('schedules が配列でなければ 400 相当', () => {
    expect(() => normalizeWorkSchedulePutBody({ schedules: {} })).toThrow(/schedules は配列/)
  })

  it('要素がオブジェクトでなければ 400 相当', () => {
    expect(() => normalizeWorkSchedulePutBody({ schedules: [1] })).toThrow(
      /schedules\[0\] がオブジェクトではありません/,
    )
    expect(() => normalizeWorkSchedulePutBody({ deleteSchedules: [null] })).toThrow(
      /deleteSchedules\[0\] がオブジェクトではありません/,
    )
  })

  it('effectiveFrom は YYYY-MM-DD 必須', () => {
    expect(() =>
      normalizeWorkSchedulePutBody({ schedules: [{ effectiveFrom: '2026-4-1', dailyWorkMinutes: 480 }] }),
    ).toThrow(/effectiveFrom は YYYY-MM-DD/)
    expect(() =>
      normalizeWorkSchedulePutBody({ schedules: [{ dailyWorkMinutes: 480 }] }),
    ).toThrow(/effectiveFrom は YYYY-MM-DD/)
  })

  it('dailyWorkMinutes は 1〜1440 の整数', () => {
    const bad = (dailyWorkMinutes: unknown) =>
      normalizeWorkSchedulePutBody({ schedules: [{ effectiveFrom: '2026-04-01', dailyWorkMinutes }] })
    expect(() => bad(0)).toThrow(/1〜1440 の整数/)
    expect(() => bad(-1)).toThrow(/1〜1440 の整数/)
    expect(() => bad(1441)).toThrow(/1〜1440 の整数/)
    expect(() => bad(480.5)).toThrow(/1〜1440 の整数/)
    expect(() => bad('480')).toThrow(/1〜1440 の整数/)
    // 境界は通る
    expect(bad).toBeTruthy()
    expect(
      normalizeWorkSchedulePutBody({ schedules: [{ effectiveFrom: '2026-04-01', dailyWorkMinutes: 1440 }] })
        .schedules[0]!.dailyWorkMinutes,
    ).toBe(1440)
  })
})

describe('normalizeHolidayWorkPutBody', () => {
  it('全フィールド省略時は空配列', () => {
    expect(normalizeHolidayWorkPutBody({})).toEqual({ approvals: [], deleteApprovals: [] })
  })

  it('乗務員CD は前ゼロを除去する', () => {
    const body = normalizeHolidayWorkPutBody({
      approvals: [{ driverCd: '0018', workDate: '2026-06-07', reason: '　棚卸　' }],
    })
    expect(body.approvals).toEqual([{ driverCd: '18', workDate: '2026-06-07', reason: '棚卸' }])
  })

  it('reason は省略・空文字・非文字列なら null', () => {
    const reasonOf = (reason: unknown) =>
      normalizeHolidayWorkPutBody({ approvals: [{ driverCd: '18', workDate: '2026-06-07', reason }] })
        .approvals[0]!.reason
    expect(reasonOf(undefined)).toBeNull()
    expect(reasonOf('  ')).toBeNull()
    expect(reasonOf(5)).toBeNull()
  })

  it('deleteApprovals も同じ規則で正規化される', () => {
    expect(
      normalizeHolidayWorkPutBody({ deleteApprovals: [{ driverCd: '0018', workDate: '2026-06-07' }] })
        .deleteApprovals,
    ).toEqual([{ driverCd: '18', workDate: '2026-06-07' }])
  })

  it('body・要素がオブジェクトでなければ 400 相当', () => {
    expect(() => normalizeHolidayWorkPutBody(null)).toThrow(WorkScheduleError)
    expect(() => normalizeHolidayWorkPutBody({ approvals: [1] })).toThrow(
      /approvals\[0\] がオブジェクトではありません/,
    )
    expect(() => normalizeHolidayWorkPutBody({ deleteApprovals: [null] })).toThrow(
      /deleteApprovals\[0\] がオブジェクトではありません/,
    )
  })

  it('approvals が配列でなければ 400 相当', () => {
    expect(() => normalizeHolidayWorkPutBody({ approvals: 'x' })).toThrow(/approvals は配列/)
  })

  it('driverCd は数字 (最大8桁)', () => {
    const bad = (driverCd: unknown) =>
      normalizeHolidayWorkPutBody({ approvals: [{ driverCd, workDate: '2026-06-07' }] })
    expect(() => bad('abc')).toThrow(/driverCd は数字/)
    expect(() => bad('123456789')).toThrow(/driverCd は数字/)
    expect(() => bad(18)).toThrow(/driverCd は数字/)
  })

  it('workDate は YYYY-MM-DD 必須', () => {
    expect(() =>
      normalizeHolidayWorkPutBody({ approvals: [{ driverCd: '18', workDate: '2026/06/07' }] }),
    ).toThrow(/workDate は YYYY-MM-DD/)
  })
})

describe('buildWorkScheduleWriteStatements', () => {
  it('スコープ未指定は番兵値 (-1 / 空文字) で書く', () => {
    const st = buildWorkScheduleWriteStatements(
      { schedules: [sched('2026-04-01', 480)], deleteSchedules: [] },
      NOW,
      COMP,
    )
    expect(st).toHaveLength(1)
    expect(st[0]!.sql).toMatch(/ON CONFLICT\(comp_id, effective_from, branch_code, job_name\)/)
    expect(st[0]!.params).toEqual([COMP, '2026-04-01', ALL_BRANCHES, ALL_JOBS, 480, NOW])
  })

  it('スコープ指定はそのまま書く', () => {
    const st = buildWorkScheduleWriteStatements(
      { schedules: [sched('2026-04-01', 450, 10, '事務')], deleteSchedules: [] },
      NOW,
      COMP,
    )
    expect(st[0]!.params).toEqual([COMP, '2026-04-01', 10, '事務', 450, NOW])
  })

  it('削除も番兵値へ変換する', () => {
    const st = buildWorkScheduleWriteStatements(
      { schedules: [], deleteSchedules: [{ effectiveFrom: '2026-04-01', branchCode: null, jobName: null }] },
      NOW,
      COMP,
    )
    expect(st[0]!.sql).toMatch(/^DELETE FROM work_schedules/)
    expect(st[0]!.params).toEqual([COMP, '2026-04-01', ALL_BRANCHES, ALL_JOBS])
  })

  it('削除でスコープ指定ありも書ける', () => {
    const st = buildWorkScheduleWriteStatements(
      { schedules: [], deleteSchedules: [{ effectiveFrom: '2026-04-01', branchCode: 10, jobName: '事務' }] },
      NOW,
      COMP,
    )
    expect(st[0]!.params).toEqual([COMP, '2026-04-01', 10, '事務'])
  })

  it('空 body は 0 文', () => {
    expect(buildWorkScheduleWriteStatements({ schedules: [], deleteSchedules: [] }, NOW, COMP)).toEqual([])
  })
})

describe('buildHolidayWorkWriteStatements', () => {
  it('upsert と削除を組み立てる', () => {
    const st = buildHolidayWorkWriteStatements(
      {
        approvals: [{ driverCd: '18', workDate: '2026-06-07', reason: '棚卸' }],
        deleteApprovals: [{ driverCd: '29', workDate: '2026-06-14' }],
      },
      NOW,
      COMP,
    )
    expect(st).toHaveLength(2)
    expect(st[0]!.params).toEqual([COMP, '18', '2026-06-07', '棚卸', NOW])
    expect(st[1]!.sql).toMatch(/^DELETE FROM holiday_work_approvals/)
    expect(st[1]!.params).toEqual([COMP, '29', '2026-06-14'])
  })

  it('空 body は 0 文', () => {
    expect(buildHolidayWorkWriteStatements({ approvals: [], deleteApprovals: [] }, NOW, COMP)).toEqual([])
  })
})

describe('buildWorkScheduleResponse', () => {
  const row = (
    effective_from: string,
    daily_work_minutes: number,
    branch_code = ALL_BRANCHES,
    job_name = ALL_JOBS,
  ): WorkScheduleD1Row => ({ effective_from, branch_code, job_name, daily_work_minutes })

  it('番兵値を null へ戻す', () => {
    expect(buildWorkScheduleResponse([row('2026-04-01', 480)])).toEqual([
      { effectiveFrom: '2026-04-01', branchCode: null, jobName: null, dailyWorkMinutes: 480 },
    ])
  })

  it('スコープ付きはそのまま', () => {
    expect(buildWorkScheduleResponse([row('2026-04-01', 450, 10, '事務')])).toEqual([
      { effectiveFrom: '2026-04-01', branchCode: 10, jobName: '事務', dailyWorkMinutes: 450 },
    ])
  })

  it('適用開始日の降順 → 具体的なスコープ順に並べる', () => {
    const out = buildWorkScheduleResponse([
      row('2026-04-01', 480),
      row('2026-10-01', 470),
      row('2026-04-01', 450, 10),
      row('2026-04-01', 460, ALL_BRANCHES, '事務'),
      row('2026-04-01', 440, 10, '事務'),
    ])
    expect(out.map(r => [r.effectiveFrom, r.branchCode, r.jobName])).toEqual([
      ['2026-10-01', null, null],
      ['2026-04-01', 10, '事務'],
      ['2026-04-01', 10, null],
      ['2026-04-01', null, '事務'],
      ['2026-04-01', null, null],
    ])
  })

  it('同一日・同一具体度は拠点コード昇順 (決定的な順序)', () => {
    const out = buildWorkScheduleResponse([row('2026-04-01', 1, 20), row('2026-04-01', 2, 10)])
    expect(out.map(r => r.branchCode)).toEqual([10, 20])
  })

  it('同一日・全社スコープ同士は 0 として扱う (順序不変)', () => {
    const out = buildWorkScheduleResponse([
      row('2026-04-01', 1, ALL_BRANCHES, '事務'),
      row('2026-04-01', 2, ALL_BRANCHES, '運転'),
    ])
    expect(out.map(r => r.jobName)).toEqual(['事務', '運転'])
  })
})

describe('buildHolidayWorkResponse', () => {
  const row = (driver_cd: string, work_date: string, reason: string | null = null): HolidayWorkD1Row => ({
    driver_cd,
    work_date,
    reason,
  })

  it('乗務員CD → 日付 の昇順', () => {
    const out = buildHolidayWorkResponse([
      row('1029', '2026-06-14'),
      row('18', '2026-06-21'),
      row('18', '2026-06-07', '棚卸'),
    ])
    expect(out).toEqual([
      { driverCd: '18', workDate: '2026-06-07', reason: '棚卸' },
      { driverCd: '18', workDate: '2026-06-21', reason: null },
      { driverCd: '1029', workDate: '2026-06-14', reason: null },
    ])
  })

  it('乗務員CD は数値として比べる (文字列順ではない)', () => {
    const out = buildHolidayWorkResponse([row('100', '2026-06-01'), row('99', '2026-06-01')])
    expect(out.map(e => e.driverCd)).toEqual(['99', '100'])
  })

  it('既に日付順に並んでいる同一乗務員の行はそのまま', () => {
    const out = buildHolidayWorkResponse([row('18', '2026-06-07'), row('18', '2026-06-21')])
    expect(out.map(e => e.workDate)).toEqual(['2026-06-07', '2026-06-21'])
  })

  it('同一キーが来ても落ちない (全域性)', () => {
    // D1 の PK 上は起こらないが、pure 関数として同値を比較できること
    const out = buildHolidayWorkResponse([row('18', '2026-06-07'), row('18', '2026-06-07')])
    expect(out).toHaveLength(2)
  })
})

describe('resolveWorkScheduleAt', () => {
  it('対象月の末日時点で効いている行を採る', () => {
    const rows = [sched('2026-04-01', 480), sched('2026-07-01', 450)]
    expect(resolveWorkScheduleAt(rows, '2026-06', null, null)?.dailyWorkMinutes).toBe(480)
    expect(resolveWorkScheduleAt(rows, '2026-07', null, null)?.dailyWorkMinutes).toBe(450)
  })

  it('月末より後の適用開始日は無視する', () => {
    expect(resolveWorkScheduleAt([sched('2026-07-01', 450)], '2026-06', null, null)).toBeNull()
  })

  it('月末ちょうどの適用開始日は効く (2月の末日を跨ぐ)', () => {
    expect(resolveWorkScheduleAt([sched('2026-02-28', 450)], '2026-02', null, null)?.dailyWorkMinutes).toBe(450)
  })

  it('該当が無ければ null', () => {
    expect(resolveWorkScheduleAt([], '2026-06', null, null)).toBeNull()
  })

  it('yearMonth が不正なら null (fail-soft)', () => {
    expect(resolveWorkScheduleAt([sched('2026-04-01', 480)], '2026-6', null, null)).toBeNull()
    expect(resolveWorkScheduleAt([sched('2026-04-01', 480)], '2026-13', null, null)).toBeNull()
  })

  it('拠点別の設定は全社既定より優先する (具体度が先、日付は後)', () => {
    const rows = [
      sched('2026-04-01', 450, 10), // 拠点別 (古い)
      sched('2026-06-01', 480), // 全社既定 (新しい)
    ]
    expect(resolveWorkScheduleAt(rows, '2026-06', 10, null)?.dailyWorkMinutes).toBe(450)
    // 対象拠点が違えば全社既定に落ちる
    expect(resolveWorkScheduleAt(rows, '2026-06', 20, null)?.dailyWorkMinutes).toBe(480)
  })

  it('拠点+職種 > 拠点 > 職種 > 全社既定 の順で具体的な行が勝つ', () => {
    const rows = [
      sched('2026-04-01', 480),
      sched('2026-04-01', 470, null, '事務'),
      sched('2026-04-01', 460, 10),
      sched('2026-04-01', 450, 10, '事務'),
    ]
    expect(resolveWorkScheduleAt(rows, '2026-06', 10, '事務')?.dailyWorkMinutes).toBe(450)
    expect(resolveWorkScheduleAt(rows, '2026-06', 10, '運転')?.dailyWorkMinutes).toBe(460)
    expect(resolveWorkScheduleAt(rows, '2026-06', 20, '事務')?.dailyWorkMinutes).toBe(470)
    expect(resolveWorkScheduleAt(rows, '2026-06', 20, '運転')?.dailyWorkMinutes).toBe(480)
  })

  it('同じ具体度なら適用開始日が新しい行が勝つ (順序に依存しない)', () => {
    const older = sched('2026-04-01', 480)
    const newer = sched('2026-06-01', 450)
    expect(resolveWorkScheduleAt([older, newer], '2026-06', null, null)?.dailyWorkMinutes).toBe(450)
    expect(resolveWorkScheduleAt([newer, older], '2026-06', null, null)?.dailyWorkMinutes).toBe(450)
  })

  it('職種だけ指定の行は職種が一致した時だけ効く', () => {
    const rows = [sched('2026-04-01', 470, null, '事務')]
    expect(resolveWorkScheduleAt(rows, '2026-06', null, '事務')?.dailyWorkMinutes).toBe(470)
    expect(resolveWorkScheduleAt(rows, '2026-06', null, null)).toBeNull()
  })
})

describe('buildHolidayWorkIndex / isHolidayWorkApproved', () => {
  it('承認済みの日だけ true', () => {
    const index = buildHolidayWorkIndex([
      { driverCd: '18', workDate: '2026-06-07', reason: null },
      { driverCd: '29', workDate: '2026-06-14', reason: '立会' },
    ])
    expect(isHolidayWorkApproved(index, '18', '2026-06-07')).toBe(true)
    expect(isHolidayWorkApproved(index, '18', '2026-06-14')).toBe(false)
    expect(isHolidayWorkApproved(index, '99', '2026-06-07')).toBe(false)
  })

  it('空の承認簿ならすべて false (= 休日出勤は自主出勤へ倒れる)', () => {
    expect(isHolidayWorkApproved(buildHolidayWorkIndex([]), '18', '2026-06-07')).toBe(false)
  })
})
