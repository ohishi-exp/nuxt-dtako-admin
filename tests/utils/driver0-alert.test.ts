/**
 * `app/utils/driver0-alert.ts` のテスト (Refs ippoan/alc-app#676)。
 */

import { describe, it, expect, vi } from 'vitest'
import type { Operation, OperationFilter, OperationListItem, OperationsResponse } from '../../app/types'
import {
  DRIVER0_PER_PAGE,
  driver0Window,
  formatWallClock,
  isDriver0AlertDistance,
  loadDriver0Alerts,
} from '../../app/utils/driver0-alert'

function item(unko_no: string, total_distance: number | null, vehicle_name: string | null = '車両A'): OperationListItem {
  return { unko_no, total_distance, vehicle_name } as OperationListItem
}

function detail(garage_out_at: string | null, garage_in_at: string | null): Operation {
  return { garage_out_at, garage_in_at } as Operation
}

describe('driver0Window', () => {
  it('JST の今日を含む 30 日 (UTC では前日でも JST の日付で切る)', () => {
    // 2026-11-27T15:30Z = JST 11/28 00:30
    expect(driver0Window(new Date('2026-11-27T15:30:00Z'))).toEqual({ date_from: '2026-10-30', date_to: '2026-11-28' })
    // 2026-11-27T14:59Z = JST 11/27 23:59
    expect(driver0Window(new Date('2026-11-27T14:59:00Z'))).toEqual({ date_from: '2026-10-29', date_to: '2026-11-27' })
  })
})

describe('isDriver0AlertDistance', () => {
  it('10km 以上だけ (ちょうど 10 は出す・距離不明は出さない)', () => {
    expect(isDriver0AlertDistance({ total_distance: 10 })).toBe(true)
    expect(isDriver0AlertDistance({ total_distance: 9.9 })).toBe(false)
    expect(isDriver0AlertDistance({ total_distance: null })).toBe(false)
  })
})

describe('formatWallClock', () => {
  it('Z が付いていても時差を足さずに並べる', () => {
    expect(formatWallClock('2026-11-27T08:15:42Z')).toBe('2026/11/27 08:15')
  })
  it('無い・形が違うと -', () => {
    expect(formatWallClock(null)).toBe('-')
    expect(formatWallClock('')).toBe('-')
    expect(formatWallClock('11/27 08:15')).toBe('-')
  })
})

describe('loadDriver0Alerts', () => {
  const now = new Date('2026-11-28T00:00:00Z')

  it('乗務員CD=0・読取日 30 日で引き、10km 以上だけを運行NO で 1 つにして出庫・帰庫を足す', async () => {
    const getOperations = vi.fn(async (_f: OperationFilter): Promise<OperationsResponse> => ({
      operations: [item('A', 23.9), item('A', 23.9), item('B', 0.2), item('C', 12, null)],
      total: 4,
    } as OperationsResponse))
    const getOperation = vi.fn(async (unko: string) =>
      unko === 'A'
        ? [detail(null, null), detail('2026-11-26T07:00:00Z', '2026-11-26T18:30:00Z')]
        : [detail(null, null)],
    )
    const alerts = await loadDriver0Alerts({ getOperations, getOperation }, now)
    expect(getOperations).toHaveBeenCalledTimes(1)
    expect(getOperations).toHaveBeenCalledWith({
      date_from: '2026-10-30',
      date_to: '2026-11-28',
      driver_cd: '0',
      page: 1,
      per_page: DRIVER0_PER_PAGE,
    })
    expect(getOperation.mock.calls.map(c => c[0])).toEqual(['A', 'C'])
    expect(alerts).toEqual([
      { unko_no: 'A', vehicle_name: '車両A', garage_out_at: '2026-11-26T07:00:00Z', garage_in_at: '2026-11-26T18:30:00Z', total_distance: 23.9 },
      { unko_no: 'C', vehicle_name: null, garage_out_at: null, garage_in_at: null, total_distance: 12 },
    ])
  })

  it('total が 1 ページを超えれば次のページも引き、空のページで止まる', async () => {
    const pages: OperationListItem[][] = [[item('A', 50)], [item('B', 50)], []]
    const getOperations = vi.fn(async (f: OperationFilter) =>
      ({ operations: pages[f.page! - 1], total: DRIVER0_PER_PAGE * 5 } as OperationsResponse))
    const alerts = await loadDriver0Alerts({ getOperations, getOperation: async () => [] }, now)
    expect(getOperations).toHaveBeenCalledTimes(3)
    expect(alerts.map(a => a.unko_no)).toEqual(['A', 'B'])
  })

  it('詳細の取得が失敗したら throw する (0 件に見せない)', async () => {
    const getOperations = async () => ({ operations: [item('A', 50)], total: 1 } as OperationsResponse)
    await expect(
      loadDriver0Alerts({ getOperations, getOperation: async () => { throw new Error('boom') } }, now),
    ).rejects.toThrow('boom')
  })
})
