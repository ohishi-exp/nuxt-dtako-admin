import { describe, it, expect } from 'vitest'
import {
  timecardCompareHeadline,
  timecardCompareRowClass,
  timecardCompareStatusLabel,
  hasFerryMinus,
  fmtTimecardCompareDiff,
  fmtTimecardCompareDiffRange,
  fmtTimecardCompareMinutes,
  fmtTimecardCompareCauseDays,
  fmtTimecardCompareUnknown,
  toTimecardCompareRows,
  summarizeTimecardCompareResult,
  summarizeTimecardCompareResults,
  sortTimecardCompareSummaryRows,
  type TimecardCompareDay,
  type TimecardCompareResult,
  type TimecardCompareRow,
  type TimecardCompareSummaryRow,
} from '~/utils/timecard-compare-view'

function day(over: Partial<TimecardCompareDay> = {}): TimecardCompareDay {
  return {
    date: '2026-04-01',
    nginxMinutes: 570,
    oursMinutes: 570,
    diffMinutes: 0,
    status: 'match',
    ferryMinusMinutes: null,
    cause: 'none',
    explainedMinutes: 0,
    residualMinutes: 0,
    anomalies: [],
    ...over,
  }
}

function row(over: Partial<TimecardCompareRow> = {}): TimecardCompareRow {
  return { ...day(), day: 1, weekdayLabel: '水', isSunday: false, ...over }
}

describe('toTimecardCompareRows', () => {
  it('曜日を添える (UTC 計算でローカル TZ に依存しない)', () => {
    // 2026-04-01 は水曜、2026-04-05 は日曜
    const rows = toTimecardCompareRows([day({ date: '2026-04-01' }), day({ date: '2026-04-05' })])
    expect(rows.map(r => [r.day, r.weekdayLabel, r.isSunday])).toEqual([
      [1, '水', false],
      [5, '日', true],
    ])
  })

  it('日付が読めない行は落とす', () => {
    expect(toTimecardCompareRows([day({ date: '2026-4-1' }), day({ date: '' })])).toEqual([])
  })

  it('元の項目を保つ', () => {
    const rows = toTimecardCompareRows([day({ nginxMinutes: -30, status: 'mismatch', diffMinutes: -30 })])
    expect(rows[0]).toMatchObject({ nginxMinutes: -30, status: 'mismatch', diffMinutes: -30 })
  })
})

describe('timecardCompareStatusLabel', () => {
  it('状態ごとの日本語', () => {
    expect(timecardCompareStatusLabel('match')).toBe('一致')
    expect(timecardCompareStatusLabel('within-tolerance')).toBe('許容内')
    expect(timecardCompareStatusLabel('mismatch')).toBe('差あり')
    expect(timecardCompareStatusLabel('nginx-only')).toBe('nginx のみ')
    expect(timecardCompareStatusLabel('ours-only')).toBe('こちらのみ')
  })

  it('both-empty は何も出さない (稼働の無い日で表を埋めない)', () => {
    expect(timecardCompareStatusLabel('both-empty')).toBe('')
  })
})

describe('timecardCompareRowClass', () => {
  it('nginx 側の異常を最優先する (差が無くても直す対象なので埋もれさせない)', () => {
    const cls = timecardCompareRowClass(row({
      status: 'match',
      anomalies: [{ kind: 'negative-kosoku-type', date: '2026-04-01', field: 'TC_DC', minutes: -60, message: 'x' }],
    }))
    expect(cls).toContain('red')
  })

  it('状態ごとに色を分ける', () => {
    expect(timecardCompareRowClass(row({ status: 'mismatch' }))).toContain('amber')
    expect(timecardCompareRowClass(row({ status: 'nginx-only' }))).toContain('orange')
    expect(timecardCompareRowClass(row({ status: 'ours-only' }))).toContain('orange')
    expect(timecardCompareRowClass(row({ status: 'within-tolerance' }))).toContain('gray')
    expect(timecardCompareRowClass(row({ status: 'match' }))).toBe('')
    expect(timecardCompareRowClass(row({ status: 'both-empty' }))).toBe('')
  })
})

describe('fmtTimecardCompareMinutes', () => {
  it('分を H:MM にする', () => {
    expect(fmtTimecardCompareMinutes(570)).toBe('9:30')
    expect(fmtTimecardCompareMinutes(0)).toBe('0:00')
    expect(fmtTimecardCompareMinutes(5)).toBe('0:05')
    expect(fmtTimecardCompareMinutes(1500)).toBe('25:00')
  })

  it('負は符号つき (nginx#783 の負の拘束を隠さない)', () => {
    expect(fmtTimecardCompareMinutes(-30)).toBe('-0:30')
    expect(fmtTimecardCompareMinutes(-90)).toBe('-1:30')
  })

  it('null は空文字 (「行が無い」と 0 分を書き分ける)', () => {
    expect(fmtTimecardCompareMinutes(null)).toBe('')
  })
})

describe('fmtTimecardCompareDiff', () => {
  it('符号を必ず出す', () => {
    expect(fmtTimecardCompareDiff(30)).toBe('+0:30')
    expect(fmtTimecardCompareDiff(-30)).toBe('-0:30')
    expect(fmtTimecardCompareDiff(0)).toBe('0:00')
    expect(fmtTimecardCompareDiff(null)).toBe('')
  })
})

describe('timecardCompareHeadline', () => {
  function result(over: Partial<TimecardCompareResult> = {}): TimecardCompareResult {
    return {
      month: '2026-04',
      driverCd: '1021',
      name: 'テスト 乗務員',
      toleranceMinutes: 1,
      days: [],
      totals: { nginxMinutes: 0, oursMinutes: 0, diffMinutes: 0, ferryMinusMinutes: 0 },
      mismatchCount: 0,
      unknownCount: 0,
      unknownMinutes: 0,
      anomalies: [],
      ...over,
    }
  }

  it('差が無ければそう言う', () => {
    expect(timecardCompareHeadline(result())).toBe('差なし')
  })

  it('差の日数を出す', () => {
    expect(timecardCompareHeadline(result({ mismatchCount: 3 }))).toBe('差あり 3 日')
  })

  it('差が無くても異常があれば言う (差分と独立に出る)', () => {
    const r = result({
      anomalies: [{ kind: 'negative-kosoku', date: '2026-04-06', field: null, minutes: -30, message: 'x' }],
    })
    expect(timecardCompareHeadline(r)).toBe('差なし / nginx 側の異常 1 件')
  })

  it('フェリー控除があれば月計を出す (差の主因なので合計を読ませる)', () => {
    const r = result({ totals: { nginxMinutes: 0, oursMinutes: 0, diffMinutes: 0, ferryMinusMinutes: 511 } })
    expect(timecardCompareHeadline(r)).toBe('差なし / フェリー控除 511 分')
  })

  it('両方あれば両方出す', () => {
    const r = result({
      mismatchCount: 2,
      anomalies: [
        { kind: 'negative-kosoku', date: '2026-04-06', field: null, minutes: -30, message: 'x' },
        { kind: 'negative-total', date: null, field: 'shukkin', minutes: -1, message: 'y' },
      ],
    })
    expect(timecardCompareHeadline(r)).toBe('差あり 2 日 / nginx 側の異常 2 件')
  })
})

describe('hasFerryMinus', () => {
  const base = {
    month: '2026-03',
    driverCd: '1726',
    name: '',
    toleranceMinutes: 1,
    days: [],
    mismatchCount: 0,
    unknownCount: 0,
    unknownMinutes: 0,
    anomalies: [],
  }

  it('月内に控除が 1 分でもあれば列を出す', () => {
    expect(hasFerryMinus({ ...base, totals: { nginxMinutes: 0, oursMinutes: 0, diffMinutes: 0, ferryMinusMinutes: 78 } })).toBe(true)
  })

  it('無い月は列を出さない (空列を並べない)', () => {
    expect(hasFerryMinus({ ...base, totals: { nginxMinutes: 0, oursMinutes: 0, diffMinutes: 0, ferryMinusMinutes: 0 } })).toBe(false)
  })
})

describe('summarizeTimecardCompareResult', () => {
  function result(over: Partial<TimecardCompareResult> = {}): TimecardCompareResult {
    return {
      month: '2026-04',
      driverCd: '1021',
      name: 'テスト 乗務員',
      toleranceMinutes: 1,
      days: [],
      totals: { nginxMinutes: 0, oursMinutes: 0, diffMinutes: 0, ferryMinusMinutes: 0 },
      mismatchCount: 0,
      unknownCount: 0,
      unknownMinutes: 0,
      anomalies: [],
      ...over,
    }
  }

  it('乗務員CD/氏名/合計をそのまま持つ', () => {
    const srow = summarizeTimecardCompareResult(result({ mismatchCount: 3, unknownCount: 2, unknownMinutes: 45 }))
    expect(srow).toMatchObject({
      driverCd: '1021',
      name: 'テスト 乗務員',
      mismatchCount: 3,
      unknownCount: 2,
      unknownMinutes: 45,
    })
  })

  it('全 status を 0 埋めで持つ (0 件の status も落とさない)', () => {
    const srow = summarizeTimecardCompareResult(result({
      days: [day({ status: 'match' }), day({ status: 'match' }), day({ status: 'mismatch', diffMinutes: -10 })],
    }))
    expect(srow.statusDays).toEqual({
      match: 2,
      'within-tolerance': 0,
      mismatch: 1,
      'nginx-only': 0,
      'ours-only': 0,
      'both-empty': 0,
    })
  })

  it('cause ごとの日数を数える (none は載せない)', () => {
    const srow = summarizeTimecardCompareResult(result({
      days: [
        day({ cause: 'lunch' }),
        day({ cause: 'lunch' }),
        day({ cause: 'ferry' }),
        day({ cause: 'none' }),
      ],
    }))
    expect(srow.causeDays).toEqual({ lunch: 2, ferry: 1 })
  })

  it('anomaly の kind ごとの件数を数える', () => {
    const srow = summarizeTimecardCompareResult(result({
      anomalies: [
        { kind: 'negative-kosoku', date: '2026-04-01', field: null, minutes: -1, message: 'x' },
        { kind: 'negative-kosoku', date: '2026-04-02', field: null, minutes: -1, message: 'x' },
        { kind: 'ferry-minus', date: '2026-04-03', field: null, minutes: 1, message: 'x' },
      ],
    }))
    expect(srow.anomalyCount).toBe(3)
    expect(srow.anomalyKinds).toEqual({ 'negative-kosoku': 2, 'ferry-minus': 1 })
  })

  it('差の幅は mismatch 日の diffMinutes だけで取る (within-tolerance は含めない)', () => {
    const srow = summarizeTimecardCompareResult(result({
      days: [
        day({ status: 'mismatch', diffMinutes: -30 }),
        day({ status: 'mismatch', diffMinutes: 20 }),
        day({ status: 'within-tolerance', diffMinutes: 1000 }),
        // 片側欠けは diffMinutes が null で引き算になっていない
        day({ status: 'mismatch', diffMinutes: null }),
      ],
    }))
    expect(srow.diffRange).toEqual({ min: -30, max: 20 })
  })

  it('mismatch が 1 日も無ければ null', () => {
    const srow = summarizeTimecardCompareResult(result({ days: [day({ status: 'match' })] }))
    expect(srow.diffRange).toBeNull()
  })
})

describe('summarizeTimecardCompareResults / sortTimecardCompareSummaryRows', () => {
  function result(over: Partial<TimecardCompareResult> = {}): TimecardCompareResult {
    return {
      month: '2026-04',
      driverCd: '1021',
      name: '',
      toleranceMinutes: 1,
      days: [],
      totals: { nginxMinutes: 0, oursMinutes: 0, diffMinutes: 0, ferryMinusMinutes: 0 },
      mismatchCount: 0,
      unknownCount: 0,
      unknownMinutes: 0,
      anomalies: [],
      ...over,
    }
  }

  it('入力順のまま畳む', () => {
    const rows = summarizeTimecardCompareResults([
      result({ driverCd: '1021' }),
      result({ driverCd: '1022' }),
    ])
    expect(rows.map(r => r.driverCd)).toEqual(['1021', '1022'])
  })

  it('既定の並びは未説明の残差 (unknownMinutes) が大きい順', () => {
    const rows: TimecardCompareSummaryRow[] = summarizeTimecardCompareResults([
      result({ driverCd: '1001', unknownMinutes: 10 }),
      result({ driverCd: '1002', unknownMinutes: 90 }),
      result({ driverCd: '1003', unknownMinutes: 40 }),
    ])
    expect(sortTimecardCompareSummaryRows(rows).map(r => r.driverCd)).toEqual(['1002', '1003', '1001'])
  })

  it('同値は乗務員CD昇順で安定させる', () => {
    const rows = summarizeTimecardCompareResults([
      result({ driverCd: '1099', unknownMinutes: 0 }),
      result({ driverCd: '1002', unknownMinutes: 0 }),
    ])
    expect(sortTimecardCompareSummaryRows(rows).map(r => r.driverCd)).toEqual(['1002', '1099'])
  })

  it('元の配列を書き換えない', () => {
    const rows = summarizeTimecardCompareResults([
      result({ driverCd: '1001', unknownMinutes: 1 }),
      result({ driverCd: '1002', unknownMinutes: 99 }),
    ])
    const before = rows.map(r => r.driverCd)
    sortTimecardCompareSummaryRows(rows)
    expect(rows.map(r => r.driverCd)).toEqual(before)
  })
})

describe('fmtTimecardCompareUnknown', () => {
  it('日数と分を並べる (0 件でも出す)', () => {
    expect(fmtTimecardCompareUnknown({ unknownCount: 0, unknownMinutes: 0 })).toBe('0日 / 0分')
    expect(fmtTimecardCompareUnknown({ unknownCount: 3, unknownMinutes: 45 })).toBe('3日 / 45分')
  })
})

describe('fmtTimecardCompareDiffRange', () => {
  it('符号つきの範囲にする', () => {
    expect(fmtTimecardCompareDiffRange({ min: -30, max: 20 })).toBe('-0:30〜+0:20')
  })

  it('null は空文字 (mismatch が無い月)', () => {
    expect(fmtTimecardCompareDiffRange(null)).toBe('')
  })
})

describe('fmtTimecardCompareCauseDays', () => {
  it('件数が多い順に cause:件数 を並べる', () => {
    expect(fmtTimecardCompareCauseDays({ lunch: 2, ferry: 5, unknown: 1 })).toBe('ferry:5 / lunch:2 / unknown:1')
  })

  it('同数は cause 名の辞書順', () => {
    expect(fmtTimecardCompareCauseDays({ lunch: 1, ferry: 1 })).toBe('ferry:1 / lunch:1')
  })

  it('0 件の cause は載せない', () => {
    expect(fmtTimecardCompareCauseDays({ lunch: 0, ferry: 2 })).toBe('ferry:2')
  })

  it('空は空文字', () => {
    expect(fmtTimecardCompareCauseDays({})).toBe('')
  })
})
