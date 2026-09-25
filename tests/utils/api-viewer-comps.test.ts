/**
 * `getViewerComps` — 見られる会社 (`GET /restraint-api/viewer-comps`) を取る。
 * ★ 固定の全社に戻してよいのは「口が無い旧 relay」(400/404) のときだけ。401 等を
 * 全社に戻すと「選んだら 401」がまた起きるので、投げて画面のエラー帯に出させる。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getViewerComps, initApi } from '../../app/utils/api'

const API_BASE = 'https://api.example'
let fetchMock: ReturnType<typeof vi.fn>

function httpError(statusCode: number) {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode })
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('$fetch', fetchMock)
})

describe('getViewerComps', () => {
  it('Bearer を付けて叩き、会社ID の配列を返す', async () => {
    initApi(API_BASE, () => 'jwt-1')
    fetchMock.mockResolvedValue({ comps: ['27324455'] })
    expect(await getViewerComps()).toEqual(['27324455'])
    expect(fetchMock).toHaveBeenCalledWith('/restraint-api/viewer-comps', { headers: { Authorization: 'Bearer jwt-1' } })
  })

  it('token が無ければ Authorization を付けない', async () => {
    initApi(API_BASE, () => null)
    fetchMock.mockResolvedValue({ comps: [] })
    expect(await getViewerComps()).toEqual([])
    expect(fetchMock).toHaveBeenCalledWith('/restraint-api/viewer-comps', { headers: {} })
  })

  it('★ 口が無い旧 relay (400: routing ヘッダ無し / 404) は null — 固定の全社に戻す', async () => {
    initApi(API_BASE, () => 'jwt')
    fetchMock.mockRejectedValueOnce(httpError(400))
    expect(await getViewerComps()).toBeNull()
    fetchMock.mockRejectedValueOnce(httpError(404))
    expect(await getViewerComps()).toBeNull()
  })

  it('★ 陰性対照: 401 (ログイン切れ) は null に倒さず投げる', async () => {
    initApi(API_BASE, () => 'jwt')
    fetchMock.mockRejectedValueOnce(httpError(401))
    await expect(getViewerComps()).rejects.toMatchObject({ statusCode: 401 })
  })

  it('応答の形が違えば null', async () => {
    initApi(API_BASE, () => 'jwt')
    fetchMock.mockResolvedValue({ comps: [1] })
    expect(await getViewerComps()).toBeNull()
  })
})
