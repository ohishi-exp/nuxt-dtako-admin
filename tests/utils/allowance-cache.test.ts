import { describe, it, expect } from 'vitest'
import type { VehicleDailySlip } from '~/utils/ichiban'
import {
  emptyCache,
  parseCache,
  serializeCache,
  findMonth,
  putMonth,
  planOperationFetch,
  planSlipFetch,
  savedAtLabel,
  CACHE_VERSION,
  MAX_MONTHS,
  type CachedOperation,
  type MonthCache,
} from '~/utils/allowance-cache'

function op(over: Partial<CachedOperation> = {}): CachedOperation {
  return {
    unkoNo: '26070104195900000011091',
    readingDate: '2026-07-01',
    operationDate: '2026-07-01',
    driverName: '中村 一由',
    vehicleName: '帯広800か1109',
    hasKudgivt: true,
    legs: [],
    carryIn: { cities: [], toTs: null },
    error: null,
    ...over,
  }
}

function month(over: Partial<MonthCache> = {}): MonthCache {
  return {
    ym: '2026-07',
    savedAt: '2026-08-21T09:00:00.000Z',
    operations: [op()],
    slips: {},
    ...over,
  }
}

const slip = { rowId: 'r1' } as VehicleDailySlip

describe('parseCache', () => {
  it('保存した形をそのまま読み戻す', () => {
    const file = putMonth(emptyCache(), month())
    expect(parseCache(serializeCache(file))).toEqual(file)
  })

  it('空・壊れた JSON・版違い・配列でない months は空として扱う (投げない)', () => {
    expect(parseCache(null)).toEqual(emptyCache())
    expect(parseCache('')).toEqual(emptyCache())
    expect(parseCache('{')).toEqual(emptyCache())
    expect(parseCache(JSON.stringify({ version: 999, months: [] }))).toEqual(emptyCache())
    expect(parseCache(JSON.stringify({ version: CACHE_VERSION, months: 'x' }))).toEqual(emptyCache())
  })
})

describe('findMonth / putMonth', () => {
  it('同じ月は差し替える', () => {
    const older = month({ savedAt: '2026-08-21T09:00:00.000Z' })
    const newer = month({ savedAt: '2026-08-21T10:00:00.000Z', operations: [] })
    const file = putMonth(putMonth(emptyCache(), older), newer)
    expect(file.months).toHaveLength(1)
    expect(findMonth(file, '2026-07')).toEqual(newer)
  })

  it('保存が新しい順に並べ直す (入れた順ではない)', () => {
    let file = emptyCache()
    file = putMonth(file, month({ ym: '2026-05', savedAt: '2026-08-21T09:00:00.000Z' }))
    file = putMonth(file, month({ ym: '2026-06', savedAt: '2026-08-21T11:00:00.000Z' }))
    file = putMonth(file, month({ ym: '2026-07', savedAt: '2026-08-21T10:00:00.000Z' }))
    expect(file.months.map(m => m.ym)).toEqual(['2026-06', '2026-07', '2026-05'])
  })

  it('無い月は null', () => {
    expect(findMonth(emptyCache(), '2026-07')).toBeNull()
  })

  it(`古い月から捨てて ${MAX_MONTHS} 件だけ残す`, () => {
    let file = emptyCache()
    for (const [i, ym] of ['2026-04', '2026-05', '2026-06', '2026-07'].entries()) {
      file = putMonth(file, month({ ym, savedAt: `2026-08-2${i}T09:00:00.000Z` }))
    }
    expect(file.months.map(m => m.ym)).toEqual(['2026-07', '2026-06', '2026-05'])
    expect(findMonth(file, '2026-04')).toBeNull()
  })
})

describe('planOperationFetch', () => {
  const listed = [
    { unko_no: 'A', has_kudgivt: true },
    { unko_no: 'B', has_kudgivt: true },
  ]

  it('運行NO と has_kudgivt が一致し前回成功していればキャッシュを使う', () => {
    const plan = planOperationFetch(listed, [op({ unkoNo: 'A' })], false)
    expect(plan.reuse.map(o => o.unkoNo)).toEqual(['A'])
    expect(plan.fetch.map(o => o.unko_no)).toEqual(['B'])
  })

  it('has_kudgivt が変わった運行は引き直す (取り込み直しの合図)', () => {
    const plan = planOperationFetch(listed, [op({ unkoNo: 'A', hasKudgivt: false })], false)
    expect(plan.reuse).toEqual([])
    expect(plan.fetch.map(o => o.unko_no)).toEqual(['A', 'B'])
  })

  it('前回失敗していた運行は引き直す (一過性の失敗がありうる)', () => {
    const plan = planOperationFetch(listed, [op({ unkoNo: 'A', error: 'HTTP 500' })], false)
    expect(plan.reuse).toEqual([])
  })

  it('force なら全部引き直す', () => {
    const plan = planOperationFetch(listed, [op({ unkoNo: 'A' }), op({ unkoNo: 'B' })], true)
    expect(plan.reuse).toEqual([])
    expect(plan.fetch).toHaveLength(2)
  })

  it('一覧に無くなった運行はキャッシュから落ちる', () => {
    const plan = planOperationFetch([listed[0]!], [op({ unkoNo: 'A' }), op({ unkoNo: 'Z' })], false)
    expect(plan.reuse.map(o => o.unkoNo)).toEqual(['A'])
  })
})

describe('planSlipFetch', () => {
  it('キャッシュにある車輌C は使い、無いものだけ引く', () => {
    const plan = planSlipFetch(['1109', '0016'], { 1109: [slip] }, false)
    expect(plan.reuse).toEqual({ 1109: [slip] })
    expect(plan.fetch).toEqual(['0016'])
  })

  it('force なら全部引き直す', () => {
    const plan = planSlipFetch(['1109'], { 1109: [slip] }, true)
    expect(plan.reuse).toEqual({})
    expect(plan.fetch).toEqual(['1109'])
  })
})

describe('savedAtLabel', () => {
  it('月/日 時:分 にする', () => {
    const d = new Date(2026, 7, 21, 18, 3)
    expect(savedAtLabel(d.toISOString())).toBe('8/21 18:03')
  })

  it('読めない値は空文字 (画面に Invalid Date を出さない)', () => {
    expect(savedAtLabel('いつか')).toBe('')
  })
})
