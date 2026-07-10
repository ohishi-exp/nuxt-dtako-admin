// Overpass API クエリビルダ + fetch (ミラー切替 / リトライ) (Refs #198)
//
// 公開 Overpass インスタンスは混雑時に 504 / "server too busy" を返すことが
// 多い (2026-07-10 の PoC 時点で本家が busy、kumi ミラーが timeout を実測)。
// 単一エンドポイント前提にせず、エンドポイントをラウンドロビンしながら
// リトライする。

export interface Bbox {
  south: number
  west: number
  north: number
  east: number
}

/** 収集対象リージョン。PoC は九州圏のみ (issue #198 実装ステップ 2) */
export const REGION_BBOX: Record<string, Bbox> = {
  kyushu: { south: 30.9, west: 128.4, north: 34.3, east: 132.2 },
}

export const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

export interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  /** way / relation は `out center` で中心点が入る */
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

export interface OverpassResponse {
  elements: OverpassElement[]
}

/**
 * 休憩ポイント収集クエリを組み立てる。
 * - highway=rest_area: PA / 一般道休憩所
 * - highway=services: SA
 * - amenity=parking + hgv=yes|designated|only: 大型可駐車場
 */
export function buildOverpassQuery(bbox: Bbox, timeoutSec = 180): string {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  return `[out:json][timeout:${timeoutSec}];
(
  nwr["highway"="rest_area"](${bb});
  nwr["highway"="services"](${bb});
  nwr["amenity"="parking"]["hgv"~"^(yes|designated|only)$"](${bb});
);
out center tags;`
}

export interface FetchOverpassOptions {
  endpoints?: string[]
  /** 全エンドポイント合計の最大試行回数 */
  maxAttempts?: number
  /** 試行間の待機 ms */
  retryDelayMs?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Overpass にクエリを投げ、elements を返す。エンドポイントを
 * ラウンドロビンし、HTTP エラー / busy 応答 / JSON でない応答は次の
 * 試行に回す。全試行失敗で throw。
 */
export async function fetchOverpass(
  query: string,
  options: FetchOverpassOptions = {},
): Promise<OverpassElement[]> {
  const {
    endpoints = DEFAULT_ENDPOINTS,
    maxAttempts = 9,
    retryDelayMs = 20_000,
    fetchImpl = fetch,
    sleep = defaultSleep,
    log = () => {},
  } = options

  let lastError: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const endpoint = endpoints[attempt % endpoints.length]!
    try {
      log(`overpass attempt ${attempt + 1}/${maxAttempts}: ${endpoint}`)
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':
            'nuxt-dtako-admin-poi/0.1 (github.com/ohishi-exp/nuxt-dtako-admin)',
        },
        body: new URLSearchParams({ data: query }),
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      // busy 時は HTTP 200 で HTML のエラーページが返ることがある
      const json = JSON.parse(text) as OverpassResponse
      if (!Array.isArray(json.elements)) {
        throw new Error('invalid overpass response: elements missing')
      }
      return json.elements
    } catch (e: unknown) {
      lastError = e
      log(`overpass attempt failed: ${String(e).slice(0, 200)}`)
      if (attempt < maxAttempts - 1) await sleep(retryDelayMs)
    }
  }
  throw new Error(`overpass fetch failed after ${maxAttempts} attempts: ${String(lastError)}`)
}
