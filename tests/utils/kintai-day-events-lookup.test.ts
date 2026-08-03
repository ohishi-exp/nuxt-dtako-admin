import { describe, it, expect } from 'vitest'
import { parseDayEventsLookup } from '~/utils/kintai-day-events-lookup'

const UNKO_NO_23 = '26060507533000000042861'

/**
 * relay 実物の形 (Refs #633-2、本番実測 2026-08-04 で確定):
 * `dtako-scraper-relay-do.ts` の `Response.json({ ..., lookup })` の `lookup` は
 * `dtako-day-events-lookup.ts` の `DayEventsLookupResult` (TS オブジェクト) が
 * そのまま JSON になったもの — **`unkoNo` は camelCase**。`unko_no` ではない。
 * (以前の fixture はここを `unko_no` にしていたため、実装のバグと同じ思い込みを
 * 共有しており、CI が原理的に検出できなかった — #630 と同型の失敗。)
 */
function body(over: Record<string, unknown> = {}) {
  return {
    driver_cd: '1078',
    date: '2026-06-05',
    ope_no: UNKO_NO_23.slice(0, 22),
    lookup: {
      status: 'found',
      unkoNo: UNKO_NO_23,
      candidates: [UNKO_NO_23],
    },
    ...over,
  }
}

describe('parseDayEventsLookup', () => {
  it('found の応答を camelCase に読み替える (★ 実物の形。lookup.unkoNo)', () => {
    expect(parseDayEventsLookup(body())).toEqual({
      driverCd: '1078',
      date: '2026-06-05',
      opeNo: UNKO_NO_23.slice(0, 22),
      status: 'found',
      unkoNo: UNKO_NO_23,
      candidates: [UNKO_NO_23],
    })
  })

  it('★ #633-2 で確定したバグの再現・修正確認: lookup.unko_no (snake_case) しか無くても fallback で読む', () => {
    const r = parseDayEventsLookup(
      body({ lookup: { status: 'found', unko_no: UNKO_NO_23, candidates: [UNKO_NO_23] } }),
    )
    expect(r.status).toBe('found')
    expect(r.unkoNo).toBe(UNKO_NO_23)
  })

  it('lookup.unkoNo (camelCase) と lookup.unko_no (snake_case) の両方があれば camelCase を優先する', () => {
    const r = parseDayEventsLookup(
      body({ lookup: { status: 'found', unkoNo: UNKO_NO_23, unko_no: '99999999999999999999999', candidates: [UNKO_NO_23] } }),
    )
    expect(r.unkoNo).toBe(UNKO_NO_23)
  })

  it('not_found は unkoNo が null で candidates が空', () => {
    const r = parseDayEventsLookup(
      body({ lookup: { status: 'not_found', unkoNo: null, candidates: [] } }),
    )
    expect(r.status).toBe('not_found')
    expect(r.unkoNo).toBeNull()
    expect(r.candidates).toEqual([])
  })

  it('ambiguous は unkoNo が null で candidates が複数 (黙って1件目を選ばない)', () => {
    const other = `${UNKO_NO_23.slice(0, 22)}2`
    const r = parseDayEventsLookup(
      body({ lookup: { status: 'ambiguous', unkoNo: null, candidates: [UNKO_NO_23, other] } }),
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
    const r = parseDayEventsLookup(body({ lookup: { status: 'ambiguous', unkoNo: null, candidates: [UNKO_NO_23, 123, null] } }))
    expect(r.candidates).toEqual([UNKO_NO_23])
  })

  it('driver_cd/date/ope_no が非文字列なら null', () => {
    const r = parseDayEventsLookup(body({ driver_cd: 1078, date: null, ope_no: undefined }))
    expect(r.driverCd).toBeNull()
    expect(r.date).toBeNull()
    expect(r.opeNo).toBeNull()
  })
})
