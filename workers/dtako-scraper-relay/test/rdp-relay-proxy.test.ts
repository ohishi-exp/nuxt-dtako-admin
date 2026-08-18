import { describe, expect, it } from 'vitest'
import {
  buildRdpUpstreamUrl,
  proxyRdpWebSocket,
  RDP_UPSTREAM_ORIGIN,
  type RdpRelayEnv,
} from '../src/rdp-relay-proxy'

/**
 * 中継が成立した後 (101 を返す経路) は `WebSocketPair` が要るので node vitest では
 * 触れない。`vitest.config.ts` の coverage include に入れていないのはそのため
 * (index.ts / dtako-scraper-relay-do.ts と同じ理由)。
 *
 * ここで押さえるのは**繋ぐ前に断る分岐**。RDP 中継は社内へ出る口なので、
 * 「通してはいけないものを通さない」側が本体。
 */

/** introspect が `active` を返す auth-worker。 */
function authWorker(active: boolean, ok = true) {
  return {
    fetch: async () =>
      new Response(JSON.stringify({ active }), {
        status: ok ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      }),
  }
}

/** 認証を通る最小の env。上流 (VPC binding) は個々のテストで差し替える。 */
function envWith(vpc?: RdpRelayEnv['RDP_RELAY_VPC']): RdpRelayEnv {
  return {
    RDP_RELAY_VPC: vpc,
    AUTH_WORKER: authWorker(true),
    INTERNAL_SHARED_SECRET: 'shared-secret',
  }
}

const upgrade = { headers: { Upgrade: 'websocket' } }

function wsRequest(query = '?token=t'): Request {
  return new Request(`https://dtako.example/ws/rdp${query}`, upgrade)
}

describe('buildRdpUpstreamUrl', () => {
  it('token と session を落とす (上流には要らない資格情報を配らない)', () => {
    const url = new URL('https://dtako.example/ws/rdp?token=secret&session=abc&w=1024')
    const built = buildRdpUpstreamUrl(url)
    expect(built).toBe(`${RDP_UPSTREAM_ORIGIN}/rdp?w=1024`)
    expect(built).not.toContain('secret')
    expect(built).not.toContain('session')
  })

  it('残るクエリが無ければ ? を付けない', () => {
    const url = new URL('https://dtako.example/ws/rdp?token=secret')
    expect(buildRdpUpstreamUrl(url)).toBe(`${RDP_UPSTREAM_ORIGIN}/rdp`)
  })
})

describe('proxyRdpWebSocket が繋ぐ前に断る条件', () => {
  it('Upgrade が無ければ 426', async () => {
    const req = new Request('https://dtako.example/ws/rdp?token=t')
    const res = await proxyRdpWebSocket(envWith(), req)
    expect(res.status).toBe(426)
  })

  it('token が無ければ 401 (上流を叩く前に断る)', async () => {
    let called = false
    const vpc = {
      fetch: async () => {
        called = true
        return new Response(null, { status: 101 })
      },
    }
    const res = await proxyRdpWebSocket(envWith(vpc), wsRequest('?w=1'))
    expect(res.status).toBe(401)
    expect(called).toBe(false)
  })

  it('introspect が active:false なら 401', async () => {
    const env = { ...envWith(), AUTH_WORKER: authWorker(false) }
    const res = await proxyRdpWebSocket(env, wsRequest())
    expect(res.status).toBe(401)
  })

  it('introspect が失敗したら通さない (落ちている側に倒す)', async () => {
    const env = { ...envWith(), AUTH_WORKER: authWorker(true, false) }
    expect((await proxyRdpWebSocket(env, wsRequest())).status).toBe(401)
  })

  it('shared secret が無ければ 401 (introspect できない)', async () => {
    const env = { ...envWith(), INTERNAL_SHARED_SECRET: undefined }
    expect((await proxyRdpWebSocket(env, wsRequest())).status).toBe(401)
  })

  it('VPC binding が未設定なら 503 (上流ダウンの 502 と区別する)', async () => {
    const res = await proxyRdpWebSocket(envWith(undefined), wsRequest())
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('RDP_RELAY_VPC')
  })

  it('上流への fetch が throw したら 502 で理由を返す', async () => {
    const vpc = {
      fetch: async () => {
        throw new Error('tunnel down')
      },
    }
    const res = await proxyRdpWebSocket(envWith(vpc), wsRequest())
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('接続できません')
  })

  it('上流が WebSocket を返さなければ 502 に status を載せる', async () => {
    // 中継が --auth cf-access のまま動いている等。ここで status を潰すと
    // browser 側は「0 件で切断」しか観測できず切り分けができない。
    const vpc = { fetch: async () => new Response('unauthorized', { status: 401 }) }
    const res = await proxyRdpWebSocket(envWith(vpc), wsRequest())
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('401')
  })
})

describe('introspect へ渡すもの', () => {
  it('origin を送る (無いと auth-worker が通さない。実機で 401 になった)', async () => {
    let sentBody: unknown = null
    const env: RdpRelayEnv = {
      RDP_RELAY_VPC: { fetch: async () => new Response(null, { status: 502 }) },
      AUTH_WORKER: {
        fetch: async (_url: string, init?: RequestInit) => {
          sentBody = JSON.parse(String(init?.body ?? '{}'))
          return new Response(JSON.stringify({ active: true }), { status: 200 })
        },
      },
      INTERNAL_SHARED_SECRET: 'shared-secret',
    }

    await proxyRdpWebSocket(env, wsRequest())

    expect(sentBody).toEqual({ token: 't', origin: 'https://dtako.example' })
  })

  it('SecretsStore binding (.get()) からも secret を取れる', async () => {
    const env: RdpRelayEnv = {
      ...envWith({ fetch: async () => new Response(null, { status: 502 }) }),
      INTERNAL_SHARED_SECRET: { get: async () => 'from-store' },
    }
    // secret が取れていれば introspect まで進み、上流の 502 で弾かれる (401 ではない)
    expect((await proxyRdpWebSocket(env, wsRequest())).status).toBe(502)
  })
})
