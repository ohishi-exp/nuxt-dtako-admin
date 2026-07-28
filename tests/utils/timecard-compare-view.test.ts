import { describe, it, expect } from 'vitest'
import {
  timecardCompareHeadline,
  timecardCompareRowClass,
  timecardCompareStatusLabel,
  fmtTimecardCompareDiff,
  fmtTimecardCompareMinutes,
  toTimecardCompareRows,
  type TimecardCompareDay,
  type TimecardCompareResult,
  type TimecardCompareRow,
} from '~/utils/timecard-compare-view'

function day(over: Partial<TimecardCompareDay> = {}): TimecardCompareDay {
  return {
    date: '2026-04-01',
    nginxMinutes: 570,
    oursMinutes: 570,
    diffMinutes: 0,
    status: 'match',
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
      totals: { nginxMinutes: 0, oursMinutes: 0, diffMinutes: 0 },
      mismatchCount: 0,
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
