import { describe, it, expect } from 'vitest'
import { parseDayEventsLookup } from '~/utils/kintai-day-events-lookup'

const UNKO_NO_23 = '26060507533000000042861'

function body(over: Record<string, unknown> = {}) {
  return {
    driver_cd: '1078',
    date: '2026-06-05',
    ope_no: UNKO_NO_23.slice(0, 22),
    lookup: {
      status: 'found',
      unko_no: UNKO_NO_23,
      candidates: [UNKO_NO_23],
    },
    ...over,
  }
}

describe('parseDayEventsLookup', () => {
  it('found の応答を camelCase に読み替える', () => {
    expect(parseDayEventsLookup(body())).toEqual({
      driverCd: '1078',
      date: '2026-06-05',
      opeNo: UNKO_NO_23.slice(0, 22),
      status: 'found',
      unkoNo: UNKO_NO_23,
      candidates: [UNKO_NO_23],
    })
  })

  it('not_found は unkoNo が null で candidates が空', () => {
    const r = parseDayEventsLookup(
      body({ lookup: { status: 'not_found', unko_no: null, candidates: [] } }),
    )
    expect(r.status).toBe('not_found')
    expect(r.unkoNo).toBeNull()
    expect(r.candidates).toEqual([])
  })

  it('ambiguous は unkoNo が null で candidates が複数 (黙って1件目を選ばない)', () => {
    const other = `${UNKO_NO_23.slice(0, 22)}2`
    const r = parseDayEventsLookup(
      body({ lookup: { status: 'ambiguous', unko_no: null, candidates: [UNKO_NO_23, other] } }),
    )
    expect(r.status).toBe('ambiguous')
    expect(r.unkoNo).toBeNull()
    expect(r.candidates).toEqual([UNKO_NO_23, other])
  })

  it('null/文字列/配列でない入力は壊さず null・空配列に倒す', () => {
    expect(parseDayEventsLookup(null)).toEqual({
      driverCd: null,
      date: null,
      opeNo: null,
      status: null,
      unkoNo: null,
      candidates: [],
    })
    expect(parseDayEventsLookup('garbage')).toEqual({
      driverCd: null,
      date: null,
      opeNo: null,
      status: null,
      unkoNo: null,
      candidates: [],
    })
  })

  it('status が未知の文字列/欠落なら null (found/not_found/ambiguousどれとも混同しない)', () => {
    expect(parseDayEventsLookup(body({ lookup: { status: 'weird' } })).status).toBeNull()
    expect(parseDayEventsLookup(body({ lookup: {} })).status).toBeNull()
    expect(parseDayEventsLookup(body({ lookup: undefined })).status).toBeNull()
  })

  it('candidates が非文字列を含む配列でも文字列だけを残す', () => {
    const r = parseDayEventsLookup(body({ lookup: { status: 'ambiguous', unko_no: null, candidates: [UNKO_NO_23, 123, null] } }))
    expect(r.candidates).toEqual([UNKO_NO_23])
  })

  it('driver_cd/date/ope_no が非文字列なら null', () => {
    const r = parseDayEventsLookup(body({ driver_cd: 1078, date: null, ope_no: undefined }))
    expect(r.driverCd).toBeNull()
    expect(r.date).toBeNull()
    expect(r.opeNo).toBeNull()
  })
})
