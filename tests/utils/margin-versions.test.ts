import { describe, it, expect } from 'vitest'

import {
  MARGIN_VERSION_BODY_LIMIT,
  isMarginVersionKey,
  listMarginVersionEntries,
  marginVersionOmittedCount,
  marginVersionOmittedNote,
  pickMarginVersionTotals,
  sortMarginVersionsDesc,
} from '../../app/utils/margin-versions'
import { emptyMarginTotals } from '../../app/utils/margin'

const DIR = 'profit/2026-07/margin-summary'

describe('MARGIN_VERSION_BODY_LIMIT', () => {
  it('本文を読む上限は 20 本 (名前付き定数で固定する)', () => {
    // 版が何本あるかは月によって違い事前に分からないので、**本数によらず一定の回数**で
    // 済ませる。数を変えるときは画面の注記の文言も一緒に見直すこと。
    expect(MARGIN_VERSION_BODY_LIMIT).toBe(20)
  })
})

describe('isMarginVersionKey', () => {
  it('v-{ts}.json だけを版として拾う', () => {
    expect(isMarginVersionKey(`${DIR}/v-20260824T102030.json`)).toBe(true)
  })

  it('latest.json は版ではない (いま指している内容で、版そのものではない)', () => {
    expect(isMarginVersionKey(`${DIR}/latest.json`)).toBe(false)
  })

  it('history.jsonl は版ではない (確認の記録で、版の一覧に混ぜない)', () => {
    expect(isMarginVersionKey(`${DIR}/history.jsonl`)).toBe(false)
  })

  it('/ を含まないキーでも丸ごと見る', () => {
    expect(isMarginVersionKey('v-20260824T102030.json')).toBe(true)
    expect(isMarginVersionKey('latest.json')).toBe(false)
  })
})

describe('sortMarginVersionsDesc', () => {
  it('ラベルの新しい順に並べる', () => {
    const items = [
      { key: 'a', label: 'v-20260801T000000' },
      { key: 'b', label: 'v-20260824T102030' },
      { key: 'c', label: 'v-20260810T235959' },
    ]
    expect(sortMarginVersionsDesc(items).map(i => i.key)).toEqual(['b', 'c', 'a'])
  })

  it('元の配列を壊さない', () => {
    const items = [
      { key: 'a', label: 'v-20260801T000000' },
      { key: 'b', label: 'v-20260824T102030' },
    ]
    const sorted = sortMarginVersionsDesc(items)
    expect(items.map(i => i.key)).toEqual(['a', 'b'])
    expect(sorted).not.toBe(items)
  })
})

describe('listMarginVersionEntries', () => {
  it('版だけを拾い、ラベルを付けて新しい順に返す', () => {
    const entries = listMarginVersionEntries([
      `${DIR}/latest.json`,
      `${DIR}/v-20260801T000000.json`,
      `${DIR}/history.jsonl`,
      `${DIR}/v-20260824T102030.json`,
    ])
    expect(entries).toEqual([
      { key: `${DIR}/v-20260824T102030.json`, label: 'v-20260824T102030' },
      { key: `${DIR}/v-20260801T000000.json`, label: 'v-20260801T000000' },
    ])
  })

  it('版が 1 つも無ければ空配列', () => {
    expect(listMarginVersionEntries([`${DIR}/latest.json`, `${DIR}/history.jsonl`])).toEqual([])
  })
})

describe('pickMarginVersionTotals', () => {
  it('一覧に出す 4 つだけを抜く (数字は 1 つも作り直さない)', () => {
    const totals = {
      ...emptyMarginTotals(),
      operations: 91,
      totalKm: 12345,
      salesYen: 10260265,
      allowanceYen: 2499500,
      marginYen: 4467597,
      marginSalesYen: 9999999,
    }
    expect(pickMarginVersionTotals(totals)).toEqual({
      operations: 91,
      salesYen: 10260265,
      allowanceYen: 2499500,
      marginYen: 4467597,
    })
  })
})

describe('marginVersionOmittedCount', () => {
  it('上限を超えたぶんを数える', () => {
    expect(marginVersionOmittedCount(23, 20)).toBe(3)
  })

  it('上限に届かなければ 0 (負にしない)', () => {
    expect(marginVersionOmittedCount(5, 20)).toBe(0)
    expect(marginVersionOmittedCount(20, 20)).toBe(0)
  })
})

describe('marginVersionOmittedNote', () => {
  it('省いた本数と、本文を読んだ本数を言う', () => {
    const note = marginVersionOmittedNote(3, 20)
    expect(note).toContain('古い 3 本は金額を省いています')
    expect(note).toContain('新しい 20 本まで')
    // **無い操作を案内しない** — この画面にまだ版を選ぶ口は無い。
    expect(note).not.toContain('選ぶ')
  })

  it('省いていなければ空文字 (何も出さない)', () => {
    expect(marginVersionOmittedNote(0, 20)).toBe('')
  })
})
