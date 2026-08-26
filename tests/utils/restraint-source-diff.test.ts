import { describe, it, expect } from 'vitest'
import {
  buildRestraintSourceDiffRows,
  sortRestraintSourceDiffRows,
  summarizeRestraintSourceDiff,
  restraintSourceDiffKindLabel,
  restraintSourceDiffUnavailableReason,
  fmtRestraintSourceDiffMinutes,
  RESTRAINT_SOURCE_DIFF_KIND_LABEL,
  RESTRAINT_SOURCE_DIFF_KIND_NOTE,
  type ArchiveSummaryEntry,
  type RestraintSourceDiffRow,
} from '~/utils/restraint-source-diff'
import type { RestraintDriverSummary, WageReportRow } from '~/utils/restraint-wage-view'

function summary(over: Partial<RestraintDriverSummary> = {}): RestraintDriverSummary {
  return {
    driverCd: '1000',
    driverName: '山田',
    branchName: '本社',
    workDays: 20,
    restDays: 10,
    restraintMinutes: 10000,
    drivingMinutes: null,
    loadingMinutes: null,
    breakMinutes: null,
    workingMinutes: null,
    overtimeMinutes: null,
    nightMinutes: null,
    overtimeNightMinutes: null,
    maxDailyRestraintMinutes: null,
    fiscalCumulativeMinutes: null,
    restraintLimitMinutes: null,
    excessRestraintMinutes: null,
    over15hDays: 0,
    avgDriving9hOverCount: 0,
    days: [],
    ...over,
  }
}

/** アーカイブ (デジタコ、R2) 側の 1 件。 */
function archive(over: Partial<RestraintDriverSummary> = {}): ArchiveSummaryEntry {
  return { data: summary(over), fetchedAt: null, lastVerifiedAt: null }
}

/** wage-report の 1 行。`wage` は突合に使わないので最小の形で埋める。 */
function report(source: 'theearth' | 'timecard' | undefined, over: Partial<RestraintDriverSummary> = {}): WageReportRow {
  return {
    summary: summary(over),
    fetched_at: null,
    last_verified_at: null,
    source,
    wage: {} as WageReportRow['wage'],
  }
}

function diffRow(over: Partial<RestraintSourceDiffRow> = {}): RestraintSourceDiffRow {
  return {
    driverCd: '1000',
    driverName: '山田',
    branchName: '本社',
    kind: 'both',
    theearthMinutes: 9000,
    timecardMinutes: 10000,
    diffMinutes: 1000,
    ...over,
  }
}

describe('buildRestraintSourceDiffRows', () => {
  it('両方に居る乗務員は差 (打刻 − デジタコ) を出す', () => {
    const rows = buildRestraintSourceDiffRows(
      [archive({ driverCd: '1069', restraintMinutes: 9170 })],
      [report('timecard', { driverCd: '1069', restraintMinutes: 10709 })],
    )
    expect(rows).toEqual([{
      driverCd: '1069',
      driverName: '山田',
      branchName: '本社',
      kind: 'both',
      theearthMinutes: 9170,
      timecardMinutes: 10709,
      // 打刻で測ると拘束が増えるのが設計どおりの向き (kosoku-daily.ts)
      diffMinutes: 1539,
    }])
  })

  it('デジタコにしか居ない乗務員は差を 0 にせず null にする (営業所は打刻が無いのが正常、#613)', () => {
    const rows = buildRestraintSourceDiffRows([archive({ driverCd: '1672', branchName: '釧路' })], [])
    expect(rows).toEqual([expect.objectContaining({
      driverCd: '1672',
      branchName: '釧路',
      kind: 'theearth-only',
      theearthMinutes: 10000,
      timecardMinutes: null,
      diffMinutes: null,
    })])
  })

  it('打刻にしか居ない乗務員も差は null', () => {
    const rows = buildRestraintSourceDiffRows([], [report('timecard', { driverCd: '9001', driverName: '事務' })])
    expect(rows).toEqual([expect.objectContaining({
      driverCd: '9001',
      driverName: '事務',
      kind: 'timecard-only',
      theearthMinutes: null,
      timecardMinutes: 10000,
      diffMinutes: null,
    })])
  })

  it('両方に居ても拘束が null なら差は null (「一致」に化けさせない)', () => {
    const both = buildRestraintSourceDiffRows(
      [archive({ driverCd: '1', restraintMinutes: null })],
      [report('timecard', { driverCd: '1', restraintMinutes: 500 })],
    )
    expect(both[0]).toMatchObject({ kind: 'both', theearthMinutes: null, diffMinutes: null })
    const punchNull = buildRestraintSourceDiffRows(
      [archive({ driverCd: '2', restraintMinutes: 500 })],
      [report('timecard', { driverCd: '2', restraintMinutes: null })],
    )
    expect(punchNull[0]).toMatchObject({ kind: 'both', timecardMinutes: null, diffMinutes: null })
  })

  it('wage-report の source=theearth 行は打刻側に採らない (同じ値どうしを比べて「一致」と出さない)', () => {
    const rows = buildRestraintSourceDiffRows(
      [archive({ driverCd: '1672', restraintMinutes: 20372 })],
      [report('theearth', { driverCd: '1672', restraintMinutes: 20372 })],
    )
    expect(rows).toEqual([expect.objectContaining({ kind: 'theearth-only', timecardMinutes: null, diffMinutes: null })])
  })

  it('source が無い古い応答の行も打刻側に採らない', () => {
    const rows = buildRestraintSourceDiffRows([archive({ driverCd: '1672' })], [report(undefined, { driverCd: '1672' })])
    expect(rows[0]!.kind).toBe('theearth-only')
  })

  it('氏名・事業所は採用された側 (両方あり なら打刻側) を出す', () => {
    const rows = buildRestraintSourceDiffRows(
      [archive({ driverCd: '1', driverName: 'デジタコ名', branchName: 'デジタコ営業所' })],
      [report('timecard', { driverCd: '1', driverName: '打刻名', branchName: '本社' })],
    )
    expect(rows[0]).toMatchObject({ driverName: '打刻名', branchName: '本社' })
  })

  it('両側に散らばっていても乗務員CD で 1 行に畳む', () => {
    const rows = buildRestraintSourceDiffRows(
      [archive({ driverCd: '1' }), archive({ driverCd: '2' })],
      [report('timecard', { driverCd: '2' }), report('timecard', { driverCd: '3' })],
    )
    expect(rows.map(r => [r.driverCd, r.kind])).toEqual([
      ['1', 'theearth-only'],
      ['2', 'both'],
      ['3', 'timecard-only'],
    ])
  })
})

describe('sortRestraintSourceDiffRows', () => {
  it('比べられた行を差の絶対値が大きい順に上へ、比較不能はその下へ CD 順', () => {
    const sorted = sortRestraintSourceDiffRows([
      diffRow({ driverCd: '30', diffMinutes: 100 }),
      diffRow({ driverCd: '20', kind: 'theearth-only', diffMinutes: null }),
      diffRow({ driverCd: '10', diffMinutes: -900 }),
      diffRow({ driverCd: '5', kind: 'timecard-only', diffMinutes: null }),
    ])
    expect(sorted.map(r => r.driverCd)).toEqual(['10', '30', '5', '20'])
  })

  it('差が同値なら乗務員CD の数値昇順で安定させる', () => {
    const sorted = sortRestraintSourceDiffRows([
      diffRow({ driverCd: '100', diffMinutes: 60 }),
      diffRow({ driverCd: '9', diffMinutes: -60 }),
    ])
    expect(sorted.map(r => r.driverCd)).toEqual(['9', '100'])
  })

  it('比較不能どうしも乗務員CD の数値昇順', () => {
    const sorted = sortRestraintSourceDiffRows([
      diffRow({ driverCd: '100', diffMinutes: null }),
      diffRow({ driverCd: '9', diffMinutes: null }),
    ])
    expect(sorted.map(r => r.driverCd)).toEqual(['9', '100'])
  })

  it('入力を破壊しない', () => {
    const input = [diffRow({ driverCd: '2', diffMinutes: 1 }), diffRow({ driverCd: '1', diffMinutes: 5 })]
    sortRestraintSourceDiffRows(input)
    expect(input.map(r => r.driverCd)).toEqual(['2', '1'])
  })
})

describe('summarizeRestraintSourceDiff', () => {
  it('合計は「比べられた行だけ」で、比較不能な行は 1 分も足さない', () => {
    const s = summarizeRestraintSourceDiff([
      diffRow({ driverCd: '1', theearthMinutes: 9000, timecardMinutes: 10000, diffMinutes: 1000 }),
      diffRow({ driverCd: '2', theearthMinutes: 500, timecardMinutes: 500, diffMinutes: 0 }),
      diffRow({ driverCd: '3', kind: 'theearth-only', theearthMinutes: 8000, timecardMinutes: null, diffMinutes: null }),
      diffRow({ driverCd: '4', kind: 'timecard-only', theearthMinutes: null, timecardMinutes: 7000, diffMinutes: null }),
      diffRow({ driverCd: '5', kind: 'both', theearthMinutes: null, timecardMinutes: null, diffMinutes: null }),
    ])
    expect(s).toEqual({
      comparedCount: 2,
      matchedCount: 1,
      differentCount: 1,
      theearthOnlyCount: 1,
      timecardOnlyCount: 1,
      bothButNoValueCount: 1,
      theearthMinutes: 9500,
      timecardMinutes: 10500,
      diffMinutes: 1000,
    })
  })

  it('0 行なら全部 0', () => {
    expect(summarizeRestraintSourceDiff([])).toMatchObject({ comparedCount: 0, diffMinutes: 0 })
  })
})

describe('restraintSourceDiffUnavailableReason', () => {
  it('1 人でも比べられたら理由を出さない', () => {
    expect(restraintSourceDiffUnavailableReason({ comparedCount: 1, theearthOnlyCount: 40, timecardOnlyCount: 24 }))
      .toBeNull()
  })

  it('どちらも 0 行なら「どちらも取り込まれていない」と言う', () => {
    expect(restraintSourceDiffUnavailableReason({ comparedCount: 0, theearthOnlyCount: 0, timecardOnlyCount: 0 }))
      .toContain('どちらも取り込まれていない')
  })

  it('デジタコが 0 名なら未取り込みを名指しする (「全員一致」と出さない)', () => {
    const msg = restraintSourceDiffUnavailableReason({ comparedCount: 0, theearthOnlyCount: 0, timecardOnlyCount: 24 })
    expect(msg).toContain('デジタコ')
    expect(msg).toContain('拘束CSV取得')
  })

  it('打刻が 0 名なら live-build 側を名指しする', () => {
    const msg = restraintSourceDiffUnavailableReason({ comparedCount: 0, theearthOnlyCount: 40, timecardOnlyCount: 0 })
    expect(msg).toContain('打刻側')
    expect(msg).toContain('フォールバックしません')
  })

  it('両側に人は居るが重ならないときはそう言う', () => {
    expect(restraintSourceDiffUnavailableReason({ comparedCount: 0, theearthOnlyCount: 40, timecardOnlyCount: 24 }))
      .toContain('重なっていません')
  })
})

describe('fmtRestraintSourceDiffMinutes', () => {
  it('null は「-」ではなく「比較不能」', () => {
    expect(fmtRestraintSourceDiffMinutes(null)).toBe('比較不能')
  })

  it('0 は ±0', () => {
    expect(fmtRestraintSourceDiffMinutes(0)).toBe('±0')
  })

  it('正は +、負は絶対値に当ててから符号を前置する (-2h-30m にしない)', () => {
    expect(fmtRestraintSourceDiffMinutes(1539)).toBe('+25h39m')
    expect(fmtRestraintSourceDiffMinutes(-150)).toBe('-2h30m')
  })
})

describe('区分のラベルと注記', () => {
  it('3 区分すべてにラベルと注記がある', () => {
    for (const kind of ['both', 'theearth-only', 'timecard-only'] as const) {
      expect(RESTRAINT_SOURCE_DIFF_KIND_LABEL[kind]).toBeTruthy()
      expect(RESTRAINT_SOURCE_DIFF_KIND_NOTE[kind]).toBeTruthy()
    }
  })

  it('「デジタコのみ」の注記は打刻を「欠けている」と書かない (#613)', () => {
    const note = RESTRAINT_SOURCE_DIFF_KIND_NOTE['theearth-only']
    expect(note).toContain('正常')
    expect(note).not.toContain('欠け')
  })
})

describe('restraintSourceDiffKindLabel', () => {
  it('差を出せた行はラベルそのまま', () => {
    expect(restraintSourceDiffKindLabel(diffRow())).toBe('両方あり')
  })

  it('片側しかない行はラベルそのまま (値の列が空でも矛盾しない)', () => {
    expect(restraintSourceDiffKindLabel(diffRow({ kind: 'theearth-only', timecardMinutes: null, diffMinutes: null })))
      .toBe('デジタコのみ')
    expect(restraintSourceDiffKindLabel(diffRow({ kind: 'timecard-only', theearthMinutes: null, diffMinutes: null })))
      .toBe('打刻のみ')
  })

  it('両方に居るのに比べられない行は、どちら側が空かまで言う (「両方あり」+「-」の矛盾を潰す)', () => {
    expect(restraintSourceDiffKindLabel(diffRow({ theearthMinutes: null, diffMinutes: null })))
      .toBe('両方あり (デジタコの拘束が空)')
    expect(restraintSourceDiffKindLabel(diffRow({ timecardMinutes: null, diffMinutes: null })))
      .toBe('両方あり (打刻の拘束が空)')
    expect(restraintSourceDiffKindLabel(diffRow({ theearthMinutes: null, timecardMinutes: null, diffMinutes: null })))
      .toBe('両方あり (両方とも拘束が空)')
  })
})
