import { describe, expect, it, vi } from 'vitest'
import {
  REGION_BBOX,
  buildOverpassQuery,
  fetchOverpass,
} from '../../scripts/poi/overpass.ts'

const noSleep = () => Promise.resolve()

function responseOf(body: string, status = 200): Response {
  return new Response(body, { status })
}

describe('buildOverpassQuery', () => {
  it('bbox と 3 セレクタを含むクエリを生成する', () => {
    const q = buildOverpassQuery(REGION_BBOX.kyushu!)
    expect(q).toContain('30.9,128.4,34.3,132.2')
    expect(q).toContain('"highway"="rest_area"')
    expect(q).toContain('"highway"="services"')
    expect(q).toContain('"amenity"="parking"')
    expect(q).toContain('"hgv"~"^(yes|designated|only)$"')
    expect(q).toContain('out center tags;')
  })

  it('timeout を指定できる', () => {
    const q = buildOverpassQuery(REGION_BBOX.kyushu!, 60)
    expect(q).toContain('[timeout:60]')
  })
})

describe('fetchOverpass', () => {
  it('成功時に elements を返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      responseOf(JSON.stringify({ elements: [{ type: 'node', id: 1 }] })),
    )
    const els = await fetchOverpass('q', { fetchImpl, sleep: noSleep })
    expect(els).toEqual([{ type: 'node', id: 1 }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('失敗したら次のエンドポイントに切り替える', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(responseOf('busy', 504))
      .mockResolvedValueOnce(responseOf(JSON.stringify({ elements: [] })))
    const log = vi.fn()
    const els = await fetchOverpass('q', {
      endpoints: ['https://a.example/api', 'https://b.example/api'],
      fetchImpl,
      sleep: noSleep,
      log,
    })
    expect(els).toEqual([])
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://a.example/api', expect.anything())
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://b.example/api', expect.anything())
  })

  it('HTTP 200 でも JSON でない応答 (busy HTML) はリトライする', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(responseOf('<html>busy</html>'))
      .mockResolvedValueOnce(responseOf(JSON.stringify({ elements: [] })))
    const els = await fetchOverpass('q', { fetchImpl, sleep: noSleep })
    expect(els).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('elements が無い JSON はリトライする', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(responseOf(JSON.stringify({ remark: 'timeout' })))
      .mockResolvedValueOnce(responseOf(JSON.stringify({ elements: [] })))
    const els = await fetchOverpass('q', { fetchImpl, sleep: noSleep })
    expect(els).toEqual([])
  })

  it('全試行失敗で throw する', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(
      fetchOverpass('q', { fetchImpl, sleep: noSleep, maxAttempts: 3 }),
    ).rejects.toThrow(/failed after 3 attempts/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})
