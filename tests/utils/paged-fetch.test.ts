import { describe, it, expect, vi } from 'vitest'
import { fetchAllPages } from '~/utils/paged-fetch'

/** 1 ページ `size` 件で `total` 件を返す偽サーバ。 */
function fakeServer(total: number, size: number) {
  return vi.fn(async (page: number) => ({
    items: Array.from(
      { length: Math.max(0, Math.min(size, total - (page - 1) * size)) },
      (_, i) => (page - 1) * size + i,
    ),
    total,
  }))
}

describe('fetchAllPages', () => {
  it('総件数に届くまでページを進める', async () => {
    const server = fakeServer(450, 200)
    await expect(fetchAllPages(server)).resolves.toHaveLength(450)
    expect(server).toHaveBeenCalledTimes(3)
  })

  it('1 ページで収まるなら 1 回で止める', async () => {
    const server = fakeServer(10, 200)
    await expect(fetchAllPages(server)).resolves.toHaveLength(10)
    expect(server).toHaveBeenCalledTimes(1)
  })

  it('空ページが返ったら止める (total が信用できないときの保険)', async () => {
    const server = vi.fn(async () => ({ items: [] as number[], total: 999 }))
    await expect(fetchAllPages(server)).resolves.toEqual([])
    expect(server).toHaveBeenCalledTimes(1)
  })

  it('maxPages で打ち切る (暴走止め)', async () => {
    const server = vi.fn(async (page: number) => ({ items: [page], total: 999 }))
    await expect(fetchAllPages(server, 3)).resolves.toEqual([1, 2, 3])
    expect(server).toHaveBeenCalledTimes(3)
  })
})
