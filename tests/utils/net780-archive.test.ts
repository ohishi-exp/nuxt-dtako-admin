import { describe, expect, it } from 'vitest'

import {
  NET780_ARCHIVE_BATCH_SIZE,
  NET780_ARCHIVE_MAX_ITEMS,
  chunk,
  formatNet780ArchiveSummary,
  remainingNet780ArchiveTargets,
  summarizeNet780ArchiveResults,
  type Net780ArchiveResultItem,
  type Net780ArchiveStatus,
} from '~/utils/net780-archive'

// 実運行 (中村 2026-07-06)。先頭 12 桁が出庫日時、次の 10 桁が車輌CD。
const UNKO_22 = '2607060418590000001109'

/** 末尾 4 桁だけ変えた 22 桁の運行NO を n 本作る (件数はテスト側で決める)。 */
function unkoNos(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${UNKO_22.slice(0, 18)}${String(i).padStart(4, '0')}`)
}

describe('chunk', () => {
  it('size 件ずつに割り、最後は端数になる', () => {
    const size = 3
    const items = unkoNos(size * 2 + 1)
    const out = chunk(items, size)
    expect(out).toHaveLength(3)
    expect(out.flat()).toEqual(items)
    for (const c of out.slice(0, -1)) expect(c).toHaveLength(size)
    expect(out.at(-1)).toHaveLength(1)
  })

  it('ぴったり割り切れるときは端数の空配列を作らない', () => {
    const out = chunk(unkoNos(NET780_ARCHIVE_MAX_ITEMS * 2), NET780_ARCHIVE_MAX_ITEMS)
    expect(out).toHaveLength(2)
    for (const c of out) expect(c).toHaveLength(NET780_ARCHIVE_MAX_ITEMS)
  })

  it('空なら []', () => {
    expect(chunk([], NET780_ARCHIVE_MAX_ITEMS)).toEqual([])
  })

  it('size 未満は 1 塊', () => {
    const items = unkoNos(NET780_ARCHIVE_MAX_ITEMS - 1)
    expect(chunk(items, NET780_ARCHIVE_MAX_ITEMS)).toEqual([items])
  })
})

describe('NET780_ARCHIVE_BATCH_SIZE', () => {
  it('relay の上限以下で、1 件以上 (Refs #760 の 29)', () => {
    expect(NET780_ARCHIVE_BATCH_SIZE).toBeGreaterThanOrEqual(1)
    expect(NET780_ARCHIVE_BATCH_SIZE).toBeLessThanOrEqual(NET780_ARCHIVE_MAX_ITEMS)
  })

  it('上限より小さい — 進捗が動かない時間を短くするのが目的なので、まとめて投げない', () => {
    expect(NET780_ARCHIVE_BATCH_SIZE).toBeLessThan(NET780_ARCHIVE_MAX_ITEMS)
  })

  it('画面の chunk はこの件数で割る (端数は最後の 1 塊)', () => {
    const items = unkoNos(NET780_ARCHIVE_BATCH_SIZE * 2 + 1)
    const out = chunk(items, NET780_ARCHIVE_BATCH_SIZE)
    expect(out).toHaveLength(3)
    expect(out.flat()).toEqual(items)
    expect(out[0]).toHaveLength(NET780_ARCHIVE_BATCH_SIZE)
    expect(out[1]).toHaveLength(NET780_ARCHIVE_BATCH_SIZE)
    expect(out.at(-1)).toHaveLength(1)
  })
})

describe('summarizeNet780ArchiveResults', () => {
  it('status ごとに数える (合計は results.length)', () => {
    const statuses: Net780ArchiveStatus[] = ['archived', 'already', 'not_found', 'error', 'not_found', 'archived', 'not_found']
    const results = statuses.map((status, i) => ({ ope_no: unkoNos(statuses.length)[i]!, status }))
    const s = summarizeNet780ArchiveResults(results)
    const expected = { archived: 0, already: 0, not_found: 0, error: 0 }
    for (const st of statuses) expected[st] += 1
    expect(s).toEqual(expected)
    expect(s.archived + s.already + s.not_found + s.error).toBe(results.length)
  })

  it('知らない status は error に数える (黙って落とさない)', () => {
    const results = [{ status: 'weird' as Net780ArchiveStatus }, { status: 'archived' as const }]
    const s = summarizeNet780ArchiveResults(results)
    expect(s.error).toBe(1)
    expect(s.archived).toBe(1)
    expect(s.archived + s.already + s.not_found + s.error).toBe(results.length)
  })

  it('空なら全部 0', () => {
    expect(summarizeNet780ArchiveResults([])).toEqual({ archived: 0, already: 0, not_found: 0, error: 0 })
  })
})

describe('formatNet780ArchiveSummary', () => {
  it('4 つとも常に出す (0 でも省かない)', () => {
    const s = { archived: 2, already: 0, not_found: 5, error: 1 }
    expect(formatNet780ArchiveSummary(s)).toBe(`archived ${s.archived} / already ${s.already} / not_found ${s.not_found} / error ${s.error}`)
  })
})

describe('remainingNet780ArchiveTargets', () => {
  it('results に載った運行を status に関わらず落とし、順序は保つ', () => {
    const queue = unkoNos(5)
    const results: Net780ArchiveResultItem[] = [
      { ope_no: queue[1]!, status: 'archived', bytes: 1 },
      { ope_no: queue[3]!, status: 'error', message: 'x' },
    ]
    expect(remainingNet780ArchiveTargets(queue, results)).toEqual([queue[0], queue[2], queue[4]])
  })

  it('23 桁 (オンプレ由来) が混ざっていても先頭 22 桁で突き合わせる', () => {
    const queue = [`${UNKO_22}1`, `${UNKO_22}2`, unkoNos(2)[1]!]
    expect(remainingNet780ArchiveTargets(queue, [{ ope_no: UNKO_22 }])).toEqual([queue[2]])
  })

  it('results が空なら 1 件も減らない (呼び出し側が「進まない」と判定する材料)', () => {
    const queue = unkoNos(3)
    expect(remainingNet780ArchiveTargets(queue, [])).toEqual(queue)
  })

  it('全部載っていれば空', () => {
    const queue = unkoNos(2)
    expect(remainingNet780ArchiveTargets(queue, queue.map(ope_no => ({ ope_no })))).toEqual([])
  })
})
