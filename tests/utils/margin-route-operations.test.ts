import { describe, expect, it } from 'vitest'
import type { LegRef } from '~/utils/margin'
import {
  UNKNOWN_RUN_DATE,
  routeOperationRows,
  runDatesByUnkoNo,
} from '~/utils/margin-route-operations'

/**
 * 経路の行 → 運行 (Refs #818)。運行NO は本番と同じ形 (`2607…` = 運行日が頭に付く
 * 22 桁) にしてあるが、**並べ替えは運行日で行う** (運行NO の頭の日付は使わない) ので
 * 日付と運行NO をわざと逆順にした行も置いてある。
 */
const OP_0701 = '2607011000000000001109'
const OP_0703 = '2607031000000000001109'
const OP_0711 = '2607111000000000001109'

function ref(unkoNo: string, seq: number): LegRef {
  return { unkoNo, seq }
}

describe('runDatesByUnkoNo — 運行NO → 運行日 の索引', () => {
  it('運行の一覧から索引を作る', () => {
    const dates = runDatesByUnkoNo([
      { unkoNo: OP_0701, date: '2026-07-01' },
      { unkoNo: OP_0703, date: '2026-07-03' },
    ])
    expect([...dates]).toEqual([[OP_0701, '2026-07-01'], [OP_0703, '2026-07-03']])
  })

  it('★ 運行日が空文字の運行は鍵を作らない (空文字を日付として持ち回らない)', () => {
    const dates = runDatesByUnkoNo([
      { unkoNo: OP_0701, date: '' },
      { unkoNo: OP_0703, date: '2026-07-03' },
    ])
    expect(dates.has(OP_0701)).toBe(false)
    expect(dates.get(OP_0703)).toBe('2026-07-03')
  })

  it('同じ運行NO が 2 度来たら後を採る', () => {
    const dates = runDatesByUnkoNo([
      { unkoNo: OP_0701, date: '2026-07-01' },
      { unkoNo: OP_0701, date: '2026-07-02' },
    ])
    expect(dates.get(OP_0701)).toBe('2026-07-02')
  })

  it('運行が 0 本なら空', () => {
    expect(runDatesByUnkoNo([]).size).toBe(0)
  })
})

describe('routeOperationRows — 運行で畳んで運行日の昇順', () => {
  const dates = runDatesByUnkoNo([
    { unkoNo: OP_0701, date: '2026-07-01' },
    { unkoNo: OP_0703, date: '2026-07-03' },
    { unkoNo: OP_0711, date: '2026-07-11' },
  ])

  it('★ 運行NO で畳み、便を昇順に並べて文字にする', () => {
    const rows = routeOperationRows([ref(OP_0711, 4), ref(OP_0711, 1)], dates)
    expect(rows).toEqual([{
      unkoNo: OP_0711,
      date: '2026-07-11',
      dateLabel: '2026-07-11',
      seqs: [1, 4],
      seqLabel: '便 1, 4',
    }])
  })

  it('★ 運行日の昇順に並べる (legRefs の並びにも運行NO の並びにも従わない)', () => {
    const rows = routeOperationRows([ref(OP_0711, 1), ref(OP_0701, 2), ref(OP_0703, 3)], dates)
    expect(rows.map(r => r.dateLabel)).toEqual(['2026-07-01', '2026-07-03', '2026-07-11'])
  })

  it('同じ運行日の運行は運行NO の昇順', () => {
    const sameDay = runDatesByUnkoNo([
      { unkoNo: '2607011000000000002209', date: '2026-07-01' },
      { unkoNo: OP_0701, date: '2026-07-01' },
    ])
    const rows = routeOperationRows(
      [ref('2607011000000000002209', 1), ref(OP_0701, 1)],
      sameDay,
    )
    expect(rows.map(r => r.unkoNo)).toEqual([OP_0701, '2607011000000000002209'])
  })

  it('同じ便が 2 度来ても 1 つに畳む', () => {
    const rows = routeOperationRows([ref(OP_0703, 2), ref(OP_0703, 2)], dates)
    expect(rows[0]!.seqs).toEqual([2])
    expect(rows[0]!.seqLabel).toBe('便 2')
  })

  it('便が 0 本なら行も 0 本', () => {
    expect(routeOperationRows([], dates)).toEqual([])
  })

  it('★ 打ち切らない — 便 120 本・運行 60 本でも運行 60 行を返す', () => {
    const refs: LegRef[] = []
    const many = new Map<string, string>()
    for (let i = 0; i < 60; i++) {
      const unkoNo = `26070${String(i).padStart(2, '0')}1000000000001109`
      many.set(unkoNo, `2026-07-${String((i % 28) + 1).padStart(2, '0')}`)
      refs.push(ref(unkoNo, 1), ref(unkoNo, 2))
    }
    const rows = routeOperationRows(refs, many)
    expect(rows).toHaveLength(60)
    expect(rows.every(r => r.seqs.length === 2)).toBe(true)
  })

  describe('運行日が引けない運行', () => {
    it('★ 0 や空文字に潰さず null にして末尾へ寄せる', () => {
      const rows = routeOperationRows(
        [ref(OP_0711, 1), ref('2606991000000000009909', 5), ref(OP_0701, 2)],
        dates,
      )
      expect(rows.map(r => r.unkoNo)).toEqual([OP_0701, OP_0711, '2606991000000000009909'])
      expect(rows[2]!.date).toBe(null)
      expect(rows[2]!.dateLabel).toBe(UNKNOWN_RUN_DATE)
      // 便は出す — 日付が引けないだけで、その運行に売上が乗っている事実は変わらない
      expect(rows[2]!.seqLabel).toBe('便 5')
    })

    it('★ 索引の空文字 (画面の date が空だった運行) も同じ扱い', () => {
      const withEmpty = runDatesByUnkoNo([
        { unkoNo: OP_0701, date: '2026-07-01' },
        { unkoNo: OP_0703, date: '' },
      ])
      const rows = routeOperationRows([ref(OP_0703, 1), ref(OP_0701, 1)], withEmpty)
      expect(rows.map(r => [r.unkoNo, r.dateLabel])).toEqual([
        [OP_0701, '2026-07-01'],
        [OP_0703, UNKNOWN_RUN_DATE],
      ])
    })

    it('日付が引けない運行が複数あるときは運行NO の昇順 (日付では並べられない)', () => {
      const rows = routeOperationRows(
        [ref('2606991000000000009909', 1), ref('2606981000000000009909', 2)],
        new Map(),
      )
      expect(rows.map(r => r.unkoNo)).toEqual([
        '2606981000000000009909',
        '2606991000000000009909',
      ])
      expect(rows.every(r => r.date === null)).toBe(true)
    })
  })
})
