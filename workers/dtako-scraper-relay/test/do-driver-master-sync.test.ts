import { afterEach, describe, expect, it, vi } from "vitest";

// do-cron-history-tenant.test.ts と同じ手。`cloudflare:workers` は Workers ランタイム
// でしか解決できないので、DurableObject を素のクラスで差し替えて
// dtako-scraper-relay-do.ts を node vitest から読み込む。
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import type { AlcTenantDataInput } from "../src/alc-tenant-rpc";

/**
 * `runDriverMasterSync` の**配線**に対する対照 (Refs ippoan/alc-app-s3#125)。
 *
 * pure 側 (`theearth-driver-master-client.test.ts`) が測るのは parse と畳み方まで。
 * ここで測るのは DO にしか無い 2 つ:
 *
 * 1. **書き先 tenant が DTAKO_ACCOUNTS の `tenant_id` であること** — request body から
 *    運べるようにすると comp_id を知っている呼び出し元が任意テナントへ書ける (#434 の再現)。
 * 2. **`skipped` が warn ログに `code` と `reason` の対で出ること** — 上流
 *    (ippoan/rust-alc-api#603 の `EmployeeUpsertSkipped`) はオブジェクト配列を返すので、
 *    文字列へ潰すと `[object Object]` になり「誰がなぜ弾かれたか」が消える。
 *
 * `dtako-scraper-relay-do.ts` は 100% gate の対象外なので、**カバレッジが緑であることは
 * この 2 点が守られている根拠にならない。**
 */

// DO の constructor が使う Workers ランタイムのグローバル (node には無い)。
(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

const COMP_ID = "27324455";
const TENANT_ID = "tenant-of-27324455"; // 架空の値 (実物ではない)
const OTHER_TENANT = "tenant-of-99999999"; // 陰性対照用の別テナント

const ACCOUNTS = [
  { comp_id: COMP_ID, tenant_id: TENANT_ID, user_name: "u", user_pass: "p" },
  { comp_id: "99999999", tenant_id: OTHER_TENANT, user_name: "u2", user_pass: "p2" },
];

/** theearth のログインページ (login() の GET が読む hidden field を持つ)。 */
const LOGIN_PAGE = `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS1" />
  <input name="txtPass" type="password" id="txtPass" />
</form></body></html>`

/** ログイン成功後に着地する一般ページ (txtPass も重複プロンプトも無い 200)。 */
const MENU_PAGE = `<html><body><div id="menu">メニュー</div></body></html>`

const HEADER_ROW =
  '<tr><th>&nbsp;</th><th>乗務員CD</th><th>乗務員名</th>' +
  '<th>退職年月日</th><th>乗務員分類4</th><th>交付年月日</th><th>有効期限</th></tr>'

function listPage(
  rows: Array<{ cd: string; name: string; issued: string; expires: string; retired?: string }>,
): string {
  const body = rows
    .map(
      (r, i) =>
        `<tr><td>&nbsp;</td>` +
        `<td><span id="lstMain_LabelValue1_${i}">${r.cd}</span></td>` +
        `<td><span id="lstMain_LabelValue2_${i}">${r.name}</span></td>` +
        `<td><span id="lstMain_LabelValue12_${i}">${r.retired ?? ''}</span></td>` +
        `<td><span id="lstMain_LabelValue13_${i}">001:正社員</span></td>` +
        `<td><span id="lstMain_LabelValue22_${i}">${r.issued}</span></td>` +
        `<td><span id="lstMain_LabelValue23_${i}">${r.expires}</span></td></tr>`,
    )
    .join('')
  return `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" value="VS1" />
  <select name="ctl00$ddlSort"><option value="0" selected="selected">全事業所</option></select>
  <select name="ctl00$ddlRowCount"><option value="20" selected="selected">20</option><option value="30">30</option></select>
  <input type="submit" name="ctl00$btnChange" value="表示" />
  <table id="lstMain_itemPlaceholderContainer">${HEADER_ROW}${body}</table>
</form></body></html>`
}

const DRIVERS = [{ cd: '1009', name: '大石 一郎', issued: '2021/04/01', expires: '2026/05/20' }]

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

/** login GET → login POST → 一覧 GET → 表示 POST の 4 往復を順に返す。 */
function stubTheearth(
  rows: Array<{ cd: string; name: string; issued: string; expires: string; retired?: string }> = DRIVERS,
): void {
  const responses = [html(LOGIN_PAGE), html(MENU_PAGE), html(listPage([])), html(listPage(rows))]
  let i = 0
  vi.stubGlobal('fetch', async () => {
    const res = responses[i]
    i += 1
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`)
    return res
  })
}

function makeDO(upstream: { status: number; body: string } | Array<{ status: number; body: string }>) {
  const calls: AlcTenantDataInput[] = []
  const queue = Array.isArray(upstream) ? [...upstream] : null
  const env = {
    DTAKO_CONFIG_KV: {
      get: async (key: string) => (key === 'dtako_accounts' ? JSON.stringify(ACCOUNTS) : null),
    },
    AUTH_WORKER_RPC: {
      forwardAlcTenantData: async (input: AlcTenantDataInput) => {
        calls.push(input)
        const res = queue ? queue.shift() : (upstream as { status: number; body: string })
        if (!res) throw new Error(`unexpected extra upstream call (#${calls.length})`)
        return { status: res.status, body: res.body, contentType: 'application/json' }
      },
    },
  }
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  }
  const relay = new DtakoScraperRelayDO(ctx as never, env as never)
  const run = (
    relay as unknown as {
      runDriverMasterSync(account: { comp_id: string; tenant_id: string; user_name: string; user_pass: string }): Promise<Response>
    }
  ).runDriverMasterSync.bind(relay)
  return { calls, run }
}

const ACCOUNT = ACCOUNTS[0]!

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DtakoScraperRelayDO#runDriverMasterSync', () => {
  it('★ 書き先 tenant は DTAKO_ACCOUNTS の tenant_id で、送るのは 5 列だけ', async () => {
    stubTheearth()
    const { calls, run } = makeDO({ status: 200, body: '{"created":1,"updated":0,"skipped":[]}' })

    const res = await run(ACCOUNT)

    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/api/employees/bulk-by-code')
    expect(calls[0]!.method).toBe('PUT')
    // ★ 対照 — body 由来の tenant を読むようにすると、ここが別テナントに変えられる
    expect(calls[0]!.tenantId).toBe(TENANT_ID)
    expect(calls[0]!.tenantId).not.toBe(OTHER_TENANT)

    const sent = JSON.parse(calls[0]!.body!) as { items: Array<Record<string, unknown>> }
    expect(sent.items).toEqual([
      {
        code: '1009',
        name: '大石 一郎',
        nfc_id: '2021040120260520',
        license_issue_date: '2021-04-01',
        license_expiry_date: '2026-05-20',
      },
    ])
    // tenant を body に混ぜない (上流は tenant をヘッダで受け取る)
    expect(calls[0]!.body).not.toContain('tenant')

    expect(await res.json()).toMatchObject({ ok: true, rows: 1, items: 1, created: 1, updated: 0, skipped: [] })
  })

  it('★ 500 件を超えたら分割して逐次 PUT する (上流の MAX_BULK_UPSERT_ITEMS = 400 の原因)', async () => {
    // 2026-09-02 の本番実行で `alc employees bulk-by-code failed (400): items が不正です`。
    // 上流は 1 リクエスト 500 件までで、501 件目から丸ごと拒否される。
    const many = Array.from({ length: 501 }, (_, i) => ({
      cd: String(1000 + i),
      name: `乗務員${i}`,
      issued: '2021/04/01',
      expires: '2026/05/20',
    }))
    stubTheearth(many)
    const { calls, run } = makeDO([
      { status: 200, body: '{"created":2,"updated":498,"skipped":[]}' },
      { status: 200, body: '{"created":1,"updated":0,"skipped":[]}' },
    ])

    const res = await run(ACCOUNT)

    expect(res.status).toBe(200)
    // ★ 1 回で投げると 400 になる。2 回に割れていることを件数で見る
    expect(calls).toHaveLength(2)
    const sizes = calls.map((c) => (JSON.parse(c.body!) as { items: unknown[] }).items.length)
    expect(sizes).toEqual([500, 1])
    // 全件が 1 度ずつ送られている (重複も欠けも無い)
    const sentCodes = calls.flatMap((c) => (JSON.parse(c.body!) as { items: Array<{ code: string }> }).items.map((i) => i.code))
    expect(new Set(sentCodes).size).toBe(501)
    // 応答の created / updated はチャンクの合計
    expect(await res.json()).toMatchObject({ ok: true, rows: 501, items: 501, chunks: 2, created: 3, updated: 498 })
  })

  it('★ 一覧は読めたが全員退職で在籍者 0 件なら、上流を 1 度も叩かず rows と items を名指しして 502', async () => {
    // 空のまま PUT すると上流は 500 件超と**同じ本文** (`items が不正です`) の 400 を
    // 返すので、原因が切り分けられなくなる。手前で止めて名指しする。
    // (一覧そのものが 0 行の場合は、その手前 `fetchDriverMaster` が構造を添えて落ちる)
    stubTheearth([{ ...DRIVERS[0]!, retired: '2025/03/31' }])
    const { calls, run } = makeDO({ status: 200, body: '{"created":0,"updated":0,"skipped":[]}' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await run(ACCOUNT)
    spy.mockRestore()

    expect(res.status).toBe(502)
    expect(calls).toHaveLength(0)
    const body = (await res.json()) as { ok: boolean; rows: number; items: number; error: string }
    expect(body.ok).toBe(false)
    expect(body.rows).toBe(1)
    expect(body.items).toBe(0)
    expect(body.error).toContain('送れる在籍者が 1 件もありません')
  })

  it('★ 一覧が 1 行も読めなければ、上流を叩かず構造要約を添えて 502 (2026-09-02 の rows=0)', async () => {
    stubTheearth([])
    const { calls, run } = makeDO({ status: 200, body: '{"created":0,"updated":0,"skipped":[]}' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await run(ACCOUNT)
    spy.mockRestore()

    expect(res.status).toBe(502)
    expect(calls).toHaveLength(0)
    const body = (await res.json()) as { ok: boolean; rows: null; error: string }
    // theearth の一覧を読む前に落ちたので件数は null (alc は 1 度も叩いていない)
    expect(body.rows).toBeNull()
    expect(body.error).toContain('乗務員マスタ一覧から 1 行も読めませんでした')
    // ★ 見出しの実物が載る (完全一致で引いているので、記号 1 つの差で 0 行になる)
    expect(body.error).toContain('見出し候補=[')
    expect(body.error).toContain('乗務員CD')
  })

  it('★ 失敗応答にも rows / items が載る (どこまで進んだかが応答だけで分かる)', async () => {
    stubTheearth()
    const { run } = makeDO({ status: 500, body: 'db down' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await run(ACCOUNT)
    spy.mockRestore()

    // 2026-09-02 の 400 は本文が `items が不正です` だけで、0 件なのか 500 件超なのかが
    // 分からず切り分けに 1 往復かかった。件数を応答に残す。
    expect(await res.json()).toMatchObject({ ok: false, rows: 1, items: 1, chunks: 1 })
  })

  it('★ skipped は code と reason の対で warn に出る ([object Object] に潰さない)', async () => {
    stubTheearth()
    const { run } = makeDO({
      status: 200,
      body: '{"created":0,"updated":1,"skipped":[{"code":"1009","reason":"nfc_id_conflict"}]}',
    })
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warns.push(String(line))
    })

    const res = await run(ACCOUNT)
    spy.mockRestore()

    const line = warns.map((w) => JSON.parse(w) as { driver_master_sync?: string; skipped?: unknown }).find((o) => o.driver_master_sync)
    expect(line?.driver_master_sync).toBe('done_with_warnings')
    expect(line?.skipped).toEqual([{ code: '1009', reason: 'nfc_id_conflict' }])
    // ★ 直す前の `String(v)` が復活したらここで落ちる
    expect(warns.join('\n')).not.toContain('[object Object]')
    expect(warns.join('\n')).toContain('nfc_id_conflict')
    expect(await res.json()).toMatchObject({ skipped: [{ code: '1009', reason: 'nfc_id_conflict' }] })
  })

  it('skipped が空なら warn を出さない', async () => {
    stubTheearth()
    const { run } = makeDO({ status: 200, body: '{"created":1,"updated":0,"skipped":[]}' })
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warns.push(String(line))
    })

    await run(ACCOUNT)
    spy.mockRestore()

    expect(warns.filter((w) => w.includes('driver_master_sync'))).toEqual([])
  })

  it('上流の応答が読めないときは job を失敗させず unreadable で warn する', async () => {
    stubTheearth()
    const { run } = makeDO({ status: 200, body: '<html>proxy error</html>' })
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
      warns.push(String(line))
    })

    const res = await run(ACCOUNT)
    spy.mockRestore()

    // 書き込み自体は 2xx で通っているので ok=true のまま。ただし黙らせない。
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    expect(warns.join('\n')).toContain('応答が JSON として読めません')
  })

  it('上流が non-2xx なら 502 で名指しして失敗する', async () => {
    stubTheearth()
    const { run } = makeDO({ status: 500, body: 'db down' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await run(ACCOUNT)
    spy.mockRestore()

    expect(res.status).toBe(502)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('alc employees bulk-by-code failed (500)')
  })

  it('AUTH_WORKER_RPC binding が無ければ theearth に 1 度も繋がず名指しで失敗する', async () => {
    let fetchCalls = 0
    vi.stubGlobal('fetch', async () => {
      fetchCalls += 1
      return html(MENU_PAGE)
    })
    const ctx = { setWebSocketAutoResponse: () => {}, storage: { get: async () => undefined, put: async () => {}, delete: async () => {} } }
    const relay = new DtakoScraperRelayDO(ctx as never, { DTAKO_CONFIG_KV: { get: async () => null } } as never)
    const run = (
      relay as unknown as { runDriverMasterSync(account: unknown): Promise<Response> }
    ).runDriverMasterSync.bind(relay)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await run(ACCOUNT)
    spy.mockRestore()

    expect(res.status).toBe(502)
    expect((await res.json() as { error: string }).error).toContain('AUTH_WORKER_RPC binding がありません')
    // binding が無いと分かっている時に人のセッションを蹴りにいかない
    expect(fetchCalls).toBe(0)
  })
})
