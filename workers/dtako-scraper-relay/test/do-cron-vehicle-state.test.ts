import { afterEach, describe, expect, it, vi } from 'vitest'

// do-cron-dvr.test.ts と同じ手。`cloudflare:workers` は Workers ランタイムでしか
// 解決できないので、DurableObject を素のクラスで差し替えて
// dtako-scraper-relay-do.ts を node vitest から読み込む。
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

import { DtakoScraperRelayDO, type VehicleStateCronLastRun } from '../src/dtako-scraper-relay-do'

/**
 * 車輌動態 (`dtako_logs`) 取り込み cron (`/cron/vehicle-state`) の**配線**に対する対照
 * (Refs #1098)。
 *
 * pure 側 (`vehicle-state-ingest.test.ts`) が測るのは日時変換・生レコードの不変性・
 * 応答パースまで。ここで測るのは DO にしか無い 3 つ:
 *
 * 1. **device credential 未設定なら 1 度も theearth に触らず 503** (fail-closed)。
 *    片方だけ設定された状態も同じく止まること
 * 2. **`getVehicleStatesRaw` (生) を叩くこと** — 射影版 (`getVehicleStates`) を使うと
 *    列が落ち緯度が丸まるが、**200 が返ったまま**起きるので送信側からは見えない
 * 3. `last_success_at` の持ち回り (失敗した回は前回の値を残す = 無音故障が表に出る)
 *
 * ★ `dtako-scraper-relay-do.ts` は 100% gate の**対象外**なので、
 * **カバレッジが緑であることはこの 3 点の根拠にならない。**
 */

// DO の constructor が使う Workers ランタイムのグローバル (node には無い)。
;(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  }

const COMP_ID = '27324455'
const TENANT_ID = 'tenant-of-27324455' // 架空の値 (実物ではない)
const ACCOUNT = { comp_id: COMP_ID, tenant_id: TENANT_ID, user_name: 'u', user_pass: 'p' }
const ACCOUNTS = [ACCOUNT]

// ★ **架空の値** (実物ではない)。device credential の実物はこの repo (public) の
// コードにもテストにも置かない。
const CRED = { deviceId: 'dummy-device-id', deviceSecret: 'dummy-device-secret' }

/** theearth のログインページ (login() の GET が読む hidden field を持つ)。 */
const LOGIN_PAGE = `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS1" />
  <input name="txtPass" type="password" id="txtPass" />
</form></body></html>`

/** ログイン成功後に着地する一般ページ。 */
const MENU_PAGE = `<html><body><div id="menu">メニュー</div></body></html>`

/** `VehicleStateTableForBranchEx` が返す 1 台ぶん (値は架空)。 */
const VEHICLE_ROW = {
  __type: 'VehicleSetStateData:#Venus',
  VehicleCD: 2131,
  VehicleName: '大型1号',
  DriverName: '運転 太郎',
  // DDMM の生値。射影版を使うと十進度 (34.73…) になるので、ここが対照になる。
  GPSLatitude: 34733210,
  GPSLongitude: 137723450,
  Speed: 42.5,
  DataDateTime: '26/09/03 07:20',
  AddressDispP: '静岡県浜松市中央区',
  AllState: '走行中',
  State2: '積車',
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function venus(d: unknown): Response {
  return new Response(JSON.stringify({ d }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** theearth 側 (login → VenusBridge) を URL で振り分けて答える。 */
function stubTheearth(rows: unknown[]): { venusCalls: Array<{ method: string; body: string }> } {
  const venusCalls: Array<{ method: string; body: string }> = []
  let loginPageServed = false
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('VenusBridgeService')) {
      const method = /\/([A-Za-z_0-9]+)$/.exec(url)?.[1] ?? ''
      venusCalls.push({ method, body: String(init?.body ?? '') })
      if (method === 'VehicleStateTableForBranchEx') return venus(rows)
      throw new Error(`unexpected VenusBridge method: ${method}`)
    }
    if (!loginPageServed) {
      loginPageServed = true
      return html(LOGIN_PAGE)
    }
    return html(MENU_PAGE)
  })
  return { venusCalls }
}

interface AuthCall {
  url: string
  headers: Record<string, string>
  body: unknown
}

function makeDO(
  authResponses: Response[],
  opts: { deviceId?: string; deviceSecret?: string; seedLastRun?: VehicleStateCronLastRun } = {},
): {
  authCalls: AuthCall[]
  relay: DtakoScraperRelayDO
  stored: Map<string, unknown>
} {
  const authCalls: AuthCall[] = []
  const queue = [...authResponses]
  const env = {
    DTAKO_CONFIG_KV: {
      get: async (key: string) => (key === 'dtako_accounts' ? JSON.stringify(ACCOUNTS) : null),
    },
    DTAKO_LOGS_DEVICE_ID: opts.deviceId,
    DTAKO_LOGS_DEVICE_SECRET: opts.deviceSecret,
    AUTH_WORKER: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        authCalls.push({
          url: String(input),
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: init?.body,
        })
        const res = queue.shift()
        if (!res) throw new Error(`unexpected extra auth-worker call (#${authCalls.length})`)
        return res
      },
    },
  }
  const stored = new Map<string, unknown>()
  if (opts.seedLastRun) stored.set('vehicle_state_last_run', opts.seedLastRun)
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => {
        stored.set(key, value)
      },
      delete: async () => {},
    },
  }
  const relay = new DtakoScraperRelayDO(ctx as never, env as never)
  return { authCalls, relay, stored }
}

function cronRequest(body: unknown): Request {
  return new Request('https://relay.internal/cron/vehicle-state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function handle(relay: DtakoScraperRelayDO, request: Request): Promise<Response> {
  return (relay as unknown as { fetch(r: Request): Promise<Response> }).fetch(request)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

const TOKEN_OK = () => json({ access_token: 'jwt-1' })
const BULK_OK = () => json({ success: true, records_added: 1, total_records: 1, message: '' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/cron/vehicle-state — fail-closed', () => {
  it('★★ device credential 未設定なら 503 で、theearth にも auth-worker にも触らない', async () => {
    const { venusCalls } = stubTheearth([VEHICLE_ROW])
    const { authCalls, relay } = makeDO([])

    const res = await handle(relay, cronRequest({ comp_id: COMP_ID }))

    expect(res.status).toBe(503)
    expect((await res.json() as { error: string }).error).toMatch(
      /DTAKO_LOGS_DEVICE_ID \/ DTAKO_LOGS_DEVICE_SECRET 未設定/,
    )
    // ★ 「設定が無い = 全部やらない」。ログインだけして捨てる、にしない。
    expect(venusCalls).toEqual([])
    expect(authCalls).toEqual([])
  })

  it('★ 片方だけ設定された状態も止める (401 を 10 分おきに撃たない)', async () => {
    stubTheearth([VEHICLE_ROW])
    const onlyId = makeDO([], { deviceId: CRED.deviceId })
    expect((await handle(onlyId.relay, cronRequest({ comp_id: COMP_ID }))).status).toBe(503)

    const onlySecret = makeDO([], { deviceSecret: CRED.deviceSecret })
    expect((await handle(onlySecret.relay, cronRequest({ comp_id: COMP_ID }))).status).toBe(503)
  })

  it('comp_id が DTAKO_ACCOUNTS に無ければ 500 (credential を読む前に落ちる)', async () => {
    stubTheearth([VEHICLE_ROW])
    const { authCalls, relay } = makeDO([], CRED)
    const res = await handle(relay, cronRequest({ comp_id: '99999999' }))
    expect(res.status).toBe(500)
    expect(authCalls).toEqual([])
  })

  it('body が JSON でない / comp_id が無いのは 400', async () => {
    stubTheearth([VEHICLE_ROW])
    const { relay } = makeDO([], CRED)
    expect((await handle(relay, cronRequest('{'))).status).toBe(400)
    expect((await handle(relay, cronRequest({}))).status).toBe(400)
  })
})

describe('/cron/vehicle-state — 取得と投入', () => {
  it('★ 生レコードを全事業所ぶん取り、DataDateTime だけ直して bulk へ送る', async () => {
    const { venusCalls } = stubTheearth([VEHICLE_ROW])
    const { authCalls, relay, stored } = makeDO([TOKEN_OK(), BULK_OK()], CRED)

    const res = await handle(relay, cronRequest({ comp_id: COMP_ID }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      comp_id: COMP_ID,
      vehicles: 1,
      records_added: 1,
      total_records: 1,
    })

    // theearth 側: 全事業所 ("00000000") を 1 回だけ。
    expect(venusCalls.map((c) => c.method)).toEqual(['VehicleStateTableForBranchEx'])
    expect(venusCalls[0].body).toContain('00000000')

    // auth-worker 側: mint → bulk の 2 本。
    expect(authCalls.map((c) => new URL(c.url).pathname)).toEqual([
      '/device/token',
      '/device-data-proxy/api/dtako-logs/bulk',
    ])
    expect(authCalls[1].headers.Authorization).toBe('Bearer jwt-1')

    // ★★ 送った body が theearth の生レコードであること。射影版 (getVehicleStates) を
    // 使うと GPSLatitude が 34.73… になり、AddressDispP / AllState / State2 が消える。
    const sent = JSON.parse(String(authCalls[1].body)) as Array<Record<string, unknown>>
    expect(sent[0].GPSLatitude).toBe(34733210)
    expect(sent[0].AddressDispP).toBe('静岡県浜松市中央区')
    expect(sent[0].AllState).toBe('走行中')
    expect(sent[0].State2).toBe('積車')
    expect(sent[0].DataDateTime).toBe('2026-09-03T07:20:00+09:00')

    // ★ `X-Tenant-ID` は付けない — device-data-proxy が device record から注入するので、
    // relay が名乗ると詐称の口になる (Refs ippoan/rust-alc-api#434)。
    expect(Object.keys(authCalls[1].headers)).not.toContain('X-Tenant-ID')

    expect(stored.get('vehicle_state_last_run')).toMatchObject({
      comp_id: COMP_ID,
      ok: true,
      vehicles: 1,
      records_added: 1,
    })
  })

  it('★ theearth が 0 台なら失敗 — 空バッチを送らず last_success_at も進めない', async () => {
    stubTheearth([])
    const { authCalls, relay, stored } = makeDO([], {
      ...CRED,
      seedLastRun: {
        comp_id: COMP_ID,
        started_at: '2026-09-03T00:00:00.000Z',
        finished_at: '2026-09-03T00:00:01.000Z',
        ok: true,
        last_success_at: '2026-09-03T00:00:01.000Z',
        vehicles: 199,
        records_added: 199,
        total_records: 199,
        error: null,
      },
    })

    const res = await handle(relay, cronRequest({ comp_id: COMP_ID }))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, vehicles: 0 })
    // device token の mint すらしない。
    expect(authCalls).toEqual([])

    const last = stored.get('vehicle_state_last_run') as VehicleStateCronLastRun
    expect(last.ok).toBe(false)
    // ★ 前回の成功時刻を持ち回る (無音故障が「最後の成功から N 時間」で表に出る)。
    expect(last.last_success_at).toBe('2026-09-03T00:00:01.000Z')
    expect(last.error).toMatch(/車輌が 1 台も取れませんでした/)
  })

  it('bulk が非 2xx なら 502 で本文を残す', async () => {
    stubTheearth([VEHICLE_ROW])
    const { relay, stored } = makeDO([TOKEN_OK(), json({ error: 'forbidden' }, 403)], CRED)

    const res = await handle(relay, cronRequest({ comp_id: COMP_ID }))
    expect(res.status).toBe(502)
    const last = stored.get('vehicle_state_last_run') as VehicleStateCronLastRun
    expect(last.ok).toBe(false)
    expect(last.last_success_at).toBeNull()
    expect(last.error).toMatch(/403/)
    expect(last.vehicles).toBe(1)
  })
})

describe('GET /cron/vehicle-state/last', () => {
  it('直近 1 回の結末を返す (未実行なら null)', async () => {
    stubTheearth([VEHICLE_ROW])
    const empty = makeDO([], CRED)
    const first = await handle(
      empty.relay,
      new Request('https://relay.internal/cron/vehicle-state/last'),
    )
    expect(await first.json()).toEqual({ last: null })

    const { relay } = makeDO([TOKEN_OK(), BULK_OK()], CRED)
    await handle(relay, cronRequest({ comp_id: COMP_ID }))
    const res = await handle(relay, new Request('https://relay.internal/cron/vehicle-state/last'))
    expect((await res.json() as { last: VehicleStateCronLastRun }).last).toMatchObject({
      comp_id: COMP_ID,
      ok: true,
      vehicles: 1,
    })
  })
})
