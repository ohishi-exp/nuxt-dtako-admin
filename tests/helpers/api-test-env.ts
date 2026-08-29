/* v8 ignore start */
/**
 * API テスト共通環境
 *
 * API_BASE_URL が設定されていれば実 API (live)、未設定なら mock fetch。
 * api.test.ts から使い、同じ CRUD テストを両モードで実行可能にする。
 *
 * dtako-admin は X-Tenant-ID 認証のみ (JWT 不要)。
 */
import { vi, expect } from 'vitest'
import { initApi } from '~/utils/api'
import { TEST_TENANT_ID } from './api-test-data'

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------
export const isLive = !!process.env.API_BASE_URL
const API_BASE = process.env.API_BASE_URL || 'https://api.example.com'

// ---------------------------------------------------------------------------
// Mock helpers (no-op in live mode)
// ---------------------------------------------------------------------------
export const mockFetch = vi.fn()

export function okJson(data: unknown = {}) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) }
}

export function ok204() {
  return { ok: true, status: 204 }
}

export function errResponse(status: number, body = '') {
  return { ok: false, status, statusText: 'Error', text: () => Promise.resolve(body) }
}

/**
 * mock モード: mockFetch にレスポンスをセット
 * live モード: 何もしない (実 fetch が走る)
 */
export function stubResponse(response: unknown) {
  if (!isLive) mockFetch.mockResolvedValueOnce(response)
}

export function stubOk(data: unknown = {}) {
  stubResponse(okJson(data))
}

export function stub204() {
  stubResponse(ok204())
}

export function stubReject(error: Error) {
  if (!isLive) mockFetch.mockRejectedValueOnce(error)
}

/**
 * mock 専用アサーション。live 時は何もしない。
 */
export function assertMock(fn: () => void) {
  if (!isLive) fn()
}

/**
 * API 呼び出し + レスポンス検証 (mock / live 両対応)
 * mock: stubOk/stub204 -> fn() -> result 検証
 * live: fn() -> 実レスポンス検証
 */
export async function verifyApi(
  fn: () => Promise<unknown>,
  mockResponse: unknown = {},
  opts: { expect204?: boolean } = {},
) {
  if (opts.expect204) stub204()
  else stubOk(mockResponse)
  const result = await fn()
  if (opts.expect204) {
    expect(result).toBeUndefined()
  }
  return result
}

/**
 * API 呼び出しを実行。live 時は **上流に届いた上での API エラー (4xx/5xx) だけ**を許容し、
 * **届かなかった場合 (URL 違い・ネットワーク断) は fail** にする。
 *
 * ## ★ 判定を「メッセージの接頭辞」でやってはいけない (Refs #1008)
 *
 * 直す前は `msg.startsWith('API エラー') || msg.startsWith('比較に失敗')` で
 * 「届いた」を判定していた。**画面の文言を変えた瞬間に空撃ちになる。**
 *
 * 実際に #1008 で踏んだ: `compareRestraintCsv` の失敗文言を
 * `比較に失敗: 400` から `400 (…) — …「再比較」を押してください` に変えたところ、
 * **接頭辞が一致せず、届いているのに「ネットワークエラー」として再 throw** され、
 * `compareRestraintCsv` の 4 本が落ちた。
 *
 * **★ ローカルでは絶対に踏めない場所にある。** この 4 本は `API_BASE_URL` 未設定なら
 * skip されるので、**`API Integration` job (実コンテナ) だけが落ちる**。
 * 文言を触る PR が来るたびに、**書いた本人が気づけないところで**壊れる。
 *
 * ## 届いたかどうかは `fetch` の戻りで決まる — 文字列を見る必要が無い
 *
 * | | `fetch` | 判定 |
 * | --- | --- | --- |
 * | URL 違い / ネットワーク断 | **throw** (`Response` が 1 つも無い) | **fail** |
 * | 上流が 4xx/5xx を返した | `Response` が返る (`res.ok === false`) | **許容** |
 *
 * `app/utils/api-error.ts` の `describeFetchThrow(e)` は**この 2 つを分ける関数**だが、
 * ここでは直接使えない — `api.ts` の `rethrowFetchThrow` が **`TypeError` を
 * 素の `Error` に組み直してから投げる**ので、`callApi` に届く時点で
 * `e instanceof TypeError` はもう偽になっている。**だから `fetch` の側で数える。**
 *
 * ## ★ 「全部 return する」に緩めていない — むしろ前より厳しい
 *
 * **非 2xx の `Response` を 1 つも受け取っていない回は、何が投げられていても fail。**
 * ⇒ URL を間違えれば落ちる (このヘルパの本体) し、**2xx が返った後にテスト本体が
 * 投げた例外 (素のバグ) も落ちる** — 直す前は `API エラー` 以外を全部 fail に
 * していたので後者も落ちていた。**その厳しさを保ったまま**、文言依存だけを外してある。
 */
export async function callApi(fn: () => Promise<unknown>) {
  if (!isLive) {
    await fn()
    return
  }
  const realFetch = globalThis.fetch
  /** 非 2xx の `Response` を 1 つでも受け取ったか (= 上流に届いた)。 */
  let reachedUpstream = false
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    // ここで throw されたら `reachedUpstream` は false のまま = 1 度も届いていない。
    const res = await realFetch(...args)
    if (!res.ok) reachedUpstream = true
    return res
  }) as typeof fetch
  try {
    await fn()
  } catch (e: unknown) {
    if (!reachedUpstream) throw e
  } finally {
    globalThis.fetch = realFetch
  }
}

/**
 * live 時に mockFetch.mock.calls のアサーションをスキップするためのヘルパー。
 * expect(mockFetch) が live で失敗しないよう、live 時は noop expect を返す。
 */
export function expectMock(target: unknown) {
  if (isLive) {
    // live 時: 全アサーションが no-op になるプロキシ
    const noop = new Proxy({}, { get: () => () => noop })
    return noop as ReturnType<typeof expect>
  }
  return expect(target)
}

// ---------------------------------------------------------------------------
// Wait for API (live mode 用)
// ---------------------------------------------------------------------------
async function waitForApi(url: string, maxRetries = 30): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`API not ready after ${maxRetries} retries`)
}

// ---------------------------------------------------------------------------
// Setup / Teardown (beforeEach / afterEach から呼ぶ)
// ---------------------------------------------------------------------------
let liveReady = false

/**
 * live 時: happy-dom の FormData/Blob を Node.js native に戻す。
 */
export function restoreNativeApis() {
  if (!isLive) return
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  globalThis.Blob = require('node:buffer').Blob
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  globalThis.URL = require('node:url').URL
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undici = require('undici')
  globalThis.FormData = undici.FormData
  globalThis.fetch = undici.fetch
}

export async function setupApi() {
  if (isLive) {
    if (!liveReady) {
      await waitForApi(API_BASE)
      liveReady = true
    }
    // dtako-admin は X-Tenant-ID 認証のみ (JWT 不要)
    initApi(API_BASE, undefined, undefined, () => TEST_TENANT_ID)
  } else {
    vi.stubGlobal('fetch', mockFetch)
    initApi(API_BASE, undefined, undefined, () => 'test-tenant')
    mockFetch.mockReset()
  }
}

export function teardownApi() {
  if (!isLive) {
    vi.unstubAllGlobals()
  }
}

export { API_BASE }
