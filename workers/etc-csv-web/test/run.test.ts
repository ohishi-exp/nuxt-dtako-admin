import { describe, expect, it } from 'vitest'
import { RELAY_ETC_RUN_URL, runResult, type RelayServiceBinding } from '../src/run'

const SECRET = 'internal-shared-secret'

type RelayCall = { url: string; init?: RequestInit }

/** 呼び出しを記録する偽の service binding。 */
function fakeRelay(respond: () => Response): RelayServiceBinding & { calls: RelayCall[] } {
  const calls: RelayCall[] = []
  return {
    calls,
    async fetch(url: string, init?: RequestInit) {
      calls.push({ url, init })
      return respond()
    },
  }
}

const okBody = { results: [{ kind: 'etc', target: 'etc1', ok: true, detail: 'HTTP 202: {}' }] }
const ok = () => new Response(JSON.stringify(okBody), { status: 200 })

describe('runResult — relay の口を叩く', () => {
  it('cron と同じ口 (POST /kintai-relay/etc-run) を X-Alc-Proxy-Secret 付きで叩く', async () => {
    const relay = fakeRelay(ok)
    const res = await runResult(relay, SECRET)
    expect(relay.calls).toHaveLength(1)
    expect(relay.calls[0].url).toBe(RELAY_ETC_RUN_URL)
    expect(new URL(relay.calls[0].url).pathname).toBe('/kintai-relay/etc-run')
    expect(relay.calls[0].init?.method).toBe('POST')
    expect(relay.calls[0].init?.headers).toEqual({ 'X-Alc-Proxy-Secret': SECRET })
    expect(res).toEqual({ status: 200, body: okBody })
  })

  // 陰性対照: relay 側の口はパラメータを取らない (cron が取らないため)。body を
  // 送り始めると「cron に無い道」がここから生える。
  it('body を送らない', async () => {
    const relay = fakeRelay(ok)
    await runResult(relay, SECRET)
    expect(relay.calls[0].init?.body).toBeUndefined()
  })

  it('Secrets Store binding (.get()) からも secret を読める', async () => {
    const relay = fakeRelay(ok)
    const res = await runResult(relay, { get: async () => SECRET })
    expect(relay.calls[0].init?.headers).toEqual({ 'X-Alc-Proxy-Secret': SECRET })
    expect(res.status).toBe(200)
  })

  it('relay の status と本文をそのまま透過する (畳まない)', async () => {
    const body = { results: [{ kind: 'etc', target: 'etc1', ok: false, detail: 'HTTP 500: boom' }] }
    const relay = fakeRelay(() => new Response(JSON.stringify(body), { status: 502 }))
    expect(await runResult(relay, SECRET)).toEqual({ status: 502, body })
  })

  // relay の手動口は `ETC_ACCOUNTS` 0 件を 404 で落とす (cron の skip とは意図的に
  // 違う)。**その 404 が画面まで届くこと**を固定する — ここで 200 に畳むと
  // 「押したのに何も起きない」が成功として見えてしまう。
  it('relay の 404 (ETC_ACCOUNTS 0 件) をそのまま画面へ返す', async () => {
    const body = { error: 'ETC_ACCOUNTS が未設定です' }
    const relay = fakeRelay(() => new Response(JSON.stringify(body), { status: 404 }))
    expect(await runResult(relay, SECRET)).toEqual({ status: 404, body })
  })

  it('relay が JSON を返さなければ 502 (握って 200 にしない)', async () => {
    const relay = fakeRelay(() => new Response('Internal Server Error', { status: 500 }))
    const res = await runResult(relay, SECRET)
    expect(res.status).toBe(502)
    expect((res.body as { error: string }).error).toContain('Internal Server Error')
  })

  it('長い非 JSON 本文は 200 文字で切る', async () => {
    const relay = fakeRelay(() => new Response('x'.repeat(500), { status: 500 }))
    const res = await runResult(relay, SECRET)
    expect((res.body as { error: string }).error).toBe(`relay: parse failed: ${'x'.repeat(200)}`)
  })
})

describe('runResult — fail-closed (relay を叩かない)', () => {
  it('service binding が無ければ 503', async () => {
    expect(await runResult(undefined, SECRET)).toEqual({
      status: 503,
      body: { error: 'service binding (SCRAPER_RELAY) not available' },
    })
  })

  it.each([
    ['未設定', undefined],
    ['空文字', ''],
    ['get() が空を返す', { get: async () => '' }],
  ])('INTERNAL_SHARED_SECRET が %s なら 503 で relay を叩かない', async (_label, binding) => {
    const relay = fakeRelay(ok)
    const res = await runResult(relay, binding)
    expect(res).toEqual({ status: 503, body: { error: 'INTERNAL_SHARED_SECRET not available' } })
    expect(relay.calls).toEqual([])
  })
})
