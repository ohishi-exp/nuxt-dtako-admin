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

import type { AlcTenantDataInput, AlcTenantDataResult } from '../src/alc-tenant-rpc'
import { DtakoScraperRelayDO, type VehicleStateCronLastRun } from '../src/dtako-scraper-relay-do'

/**
 * 車輌動態 (`dtako_logs`) 取り込み cron (`/cron/vehicle-state`) の**配線**に対する対照
 * (Refs #1098)。
 *
 * pure 側 (`vehicle-state-ingest.test.ts`) が測るのは日時変換・生レコードの不変性・
 * 応答パースまで。ここで測るのは DO にしか無い 3 つ:
 *
 * 1. **`AUTH_WORKER_RPC` binding が無ければ 1 度も theearth に触らず 503** (fail-closed)。
 *    named environment で `entrypoint = "InternalEntrypoint"` を宣言し忘れると、
 *    黙って取得だけして捨てる状態になる
 * 2. **書き先 tenant が `DTAKO_ACCOUNTS` 由来**であること (呼び出し元の body 由来にすると
 *    comp_id を知っている者が任意テナントへ書ける、Refs ippoan/rust-alc-api#434)
 * 3. **`getVehicleStatesRaw` (生) を叩くこと** — 射影版 (`getVehicleStates`) を使うと
 *    列が落ち緯度が丸まるが、**2xx が返ったまま**起きるので送信側からは見えない
 * 4. `last_success_at` の持ち回り (失敗した回は前回の値を残す = 無音故障が表に出る)
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
const OTHER_TENANT = 'tenant-of-99999999' // 陰性対照用の別テナント (架空)
const ACCOUNT = { comp_id: COMP_ID, tenant_id: TENANT_ID, user_name: 'u', user_pass: 'p' }
const ACCOUNTS = [
  ACCOUNT,
  { comp_id: '99999999', tenant_id: OTHER_TENANT, user_name: 'u2', user_pass: 'p2' },
]

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

function makeDO(
  rpcResults: AlcTenantDataResult[],
  opts: { withRpc?: boolean; seedLastRun?: VehicleStateCronLastRun } = {},
): {
  rpcCalls: AlcTenantDataInput[]
  relay: DtakoScraperRelayDO
  stored: Map<string, unknown>
} {
  const rpcCalls: AlcTenantDataInput[] = []
  const queue = [...rpcResults]
  const forwarder = {
    forwardAlcTenantData: async (input: AlcTenantDataInput): Promise<AlcTenantDataResult> => {
      rpcCalls.push(input)
      const res = queue.shift()
      if (!res) throw new Error(`unexpected extra RPC call (#${rpcCalls.length})`)
      return res
    },
  }
  const env = {
    DTAKO_CONFIG_KV: {
      get: async (key: string) => (key === 'dtako_accounts' ? JSON.stringify(ACCOUNTS) : null),
    },
    // opts.withRpc === false で「binding を張り忘れた named environment」を再現する。
    AUTH_WORKER_RPC: opts.withRpc === false ? undefined : forwarder,
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
  return { rpcCalls, relay, stored }
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

const BULK_OK = (): AlcTenantDataResult => ({
  status: 200,
  body: JSON.stringify({ success: true, records_added: 1, total_records: 1, message: '' }),
  contentType: 'application/json',
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/cron/vehicle-state — fail-closed', () => {
  it('★★ AUTH_WORKER_RPC binding が無ければ 503 で、theearth に 1 度も触らない', async () => {
    const { venusCalls } = stubTheearth([VEHICLE_ROW])
    const { rpcCalls, relay } = makeDO([], { withRpc: false })

    const res = await handle(relay, cronRequest({ comp_id: COMP_ID }))

    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toMatch(/AUTH_WORKER_RPC binding/)
    // ★ 「送り先が無い = 取りにも行かない」。ログインだけして捨てる、にしない。
    expect(venusCalls).toEqual([])
    expect(rpcCalls).toEqual([])
  })

  it('comp_id が DTAKO_ACCOUNTS に無ければ 500 (RPC を 1 度も呼ばない)', async () => {
    stubTheearth([VEHICLE_ROW])
    const { rpcCalls, relay } = makeDO([])
    const res = await handle(relay, cronRequest({ comp_id: '00000001' }))
    expect(res.status).toBe(500)
    expect(rpcCalls).toEqual([])
  })

  it('body が JSON でない / comp_id が無いのは 400', async () => {
    stubTheearth([VEHICLE_ROW])
    const { relay } = makeDO([])
    expect((await handle(relay, cronRequest('{'))).status).toBe(400)
    expect((await handle(relay, cronRequest({}))).status).toBe(400)
  })
})

describe('/cron/vehicle-state — 取得と投入', () => {
  it('★ 生レコードを全事業所ぶん取り、DataDateTime だけ直して bulk へ送る', async () => {
    const { venusCalls } = stubTheearth([VEHICLE_ROW])
    const { rpcCalls, relay, stored } = makeDO([BULK_OK()])

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

    // auth-worker 側: RPC 1 回。**device token の mint は無い** (credential 経路を使わない)。
    expect(rpcCalls).toHaveLength(1)
    expect(rpcCalls[0].path).toBe('/api/dtako-logs/bulk')
    expect(rpcCalls[0].method).toBe('POST')

    // ★★ 送った body が theearth の生レコードであること。射影版 (getVehicleStates) を
    // 使うと GPSLatitude が 34.73… になり、AddressDispP / AllState / State2 が消える。
    const sent = JSON.parse(String(rpcCalls[0].body)) as Array<Record<string, unknown>>
    expect(sent[0].GPSLatitude).toBe(34733210)
    expect(sent[0].AddressDispP).toBe('静岡県浜松市中央区')
    expect(sent[0].AllState).toBe('走行中')
    expect(sent[0].State2).toBe('積車')
    expect(sent[0].DataDateTime).toBe('2026-09-03T07:20:00+09:00')

    expect(stored.get('vehicle_state_last_run')).toMatchObject({
      comp_id: COMP_ID,
      ok: true,
      vehicles: 1,
      records_added: 1,
    })
  })

  it('★★ 書き先 tenant は DTAKO_ACCOUNTS 由来 (呼び出し元は tenant を名乗れない)', async () => {
    stubTheearth([VEHICLE_ROW])
    const { rpcCalls, relay } = makeDO([BULK_OK()])
    // body には comp_id しか無い。tenant は DO が DTAKO_ACCOUNTS から引く。
    await handle(relay, cronRequest({ comp_id: COMP_ID, tenant_id: OTHER_TENANT }))
    expect(rpcCalls[0].tenantId).toBe(TENANT_ID)
    expect(rpcCalls[0].tenantId).not.toBe(OTHER_TENANT)
  })

  it('★ theearth が 0 台なら失敗 — 空バッチを送らず last_success_at も進めない', async () => {
    stubTheearth([])
    const { rpcCalls, relay, stored } = makeDO([], {
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
    // RPC を 1 度も呼ばない。
    expect(rpcCalls).toEqual([])

    const last = stored.get('vehicle_state_last_run') as VehicleStateCronLastRun
    expect(last.ok).toBe(false)
    // ★ 前回の成功時刻を持ち回る (無音故障が「最後の成功から N 時間」で表に出る)。
    expect(last.last_success_at).toBe('2026-09-03T00:00:01.000Z')
    expect(last.error).toMatch(/車輌が 1 台も取れませんでした/)
  })

  it('★ allowlist 未反映 (403 path_not_forwardable) は 502 で本文を残す', async () => {
    // auth-worker より先に relay がマージされると必ずこれになる。**本文で気づける**
    // ことが要点 (上流の tenant 拒否 `forbidden` と混ざらない)。
    stubTheearth([VEHICLE_ROW])
    const { relay, stored } = makeDO([
      { status: 403, body: JSON.stringify({ error: 'path_not_forwardable' }), contentType: 'application/json' },
    ])

    const res = await handle(relay, cronRequest({ comp_id: COMP_ID }))
    expect(res.status).toBe(502)
    const last = stored.get('vehicle_state_last_run') as VehicleStateCronLastRun
    expect(last.ok).toBe(false)
    expect(last.last_success_at).toBeNull()
    expect(last.error).toMatch(/path_not_forwardable/)
    expect(last.vehicles).toBe(1)
  })
})

describe('GET /cron/vehicle-state/last', () => {
  it('直近 1 回の結末を返す (未実行なら null)', async () => {
    stubTheearth([VEHICLE_ROW])
    const empty = makeDO([])
    const first = await handle(
      empty.relay,
      new Request('https://relay.internal/cron/vehicle-state/last'),
    )
    expect(await first.json()).toEqual({ last: null })

    const { relay } = makeDO([BULK_OK()])
    await handle(relay, cronRequest({ comp_id: COMP_ID }))
    const res = await handle(relay, new Request('https://relay.internal/cron/vehicle-state/last'))
    expect(((await res.json()) as { last: VehicleStateCronLastRun }).last).toMatchObject({
      comp_id: COMP_ID,
      ok: true,
      vehicles: 1,
    })
  })
})
