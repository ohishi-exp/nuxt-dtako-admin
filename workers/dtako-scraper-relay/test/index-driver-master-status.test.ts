import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (node vitest では解決できない)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { handleDriverMasterStatus, type RelayWorkerEnv } from "../src/index";

const SECRET = "internal-shared-secret";
const TENANT = "11111111-1111-1111-1111-111111111111";

const ACCOUNTS = JSON.stringify([
  { comp_id: "00000001", user_name: "u1", user_pass: "p1", tenant_id: TENANT },
  { comp_id: "00000002", user_name: "u2", user_pass: "p2", tenant_id: TENANT },
]);

function lastRun(compId: string, over: Record<string, unknown> = {}) {
  return {
    comp_id: compId,
    trigger: "cron",
    started_at: "2026-09-02T22:00:03.000Z",
    finished_at: "2026-09-02T22:00:41.000Z",
    ok: true,
    rows: 242,
    items: 242,
    retired: 110,
    chunks: 1,
    created: 0,
    updated: 242,
    skipped: 1,
    error: null,
    ...over,
  };
}

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const doFetch =
    (over.doFetch as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async (url: string) => {
      // DO の名前は idFromName の戻り (= 名前そのもの) で分かる形にしてある
      expect(url).toBe("https://relay.internal/cron/driver-master/last");
      return new Response(JSON.stringify({ last: lastRun("00000001") }), { status: 200 });
    });
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) },
    INTERNAL_SHARED_SECRET: SECRET,
    DTAKO_ACCOUNTS: ACCOUNTS,
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, idFromName };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://relay.internal/kintai-relay/driver-master-status", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET, ...headers },
    body: JSON.stringify(body),
  });
}

const jsonOf = async (res: Response) => JSON.parse(await res.text());

describe("handleDriverMasterStatus — 関門", () => {
  it("secret 不一致なら 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDriverMasterStatus(post({}, { "X-Alc-Proxy-Secret": "wrong" }), env);
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("INTERNAL_SHARED_SECRET 未設定なら 503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    const res = await handleDriverMasterStatus(post({}), env);
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("body が JSON でなければ 400", async () => {
    const { env } = fakeEnv();
    const req = new Request("https://relay.internal/kintai-relay/driver-master-status", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET },
      body: "{",
    });
    expect((await handleDriverMasterStatus(req, env)).status).toBe(400);
  });

  it("DTAKO_ACCOUNTS が壊れていれば 503 (「1 社も無い」と同じ顔にしない)", async () => {
    const { env } = fakeEnv({ DTAKO_ACCOUNTS: "{" });
    expect((await handleDriverMasterStatus(post({}), env)).status).toBe(503);
  });
});

describe("handleDriverMasterStatus — 読み出し", () => {
  it("★ comp_id 省略なら DTAKO_ACCOUNTS の全社ぶんを読む (書き込みはしない)", async () => {
    const { env, doFetch, idFromName } = fakeEnv();
    const res = await handleDriverMasterStatus(post({}), env);

    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.results.map((r: { comp_id: string }) => r.comp_id)).toEqual([
      "00000001",
      "00000002",
    ]);
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual([
      "scraper-comp-00000001",
      "scraper-comp-00000002",
    ]);
    // ★ 読むだけ — DO へは GET しか投げない (同期を起動しない)
    for (const call of doFetch.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });

  it("comp_id 指定ならその 1 社だけ", async () => {
    const { env, idFromName } = fakeEnv();
    const res = await handleDriverMasterStatus(post({ comp_id: "00000002" }), env);
    const body = await jsonOf(res);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].comp_id).toBe("00000002");
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["scraper-comp-00000002"]);
  });

  it("★ cron の結末をそのまま返す (trigger が読める)", async () => {
    const { env } = fakeEnv();
    const body = await jsonOf(await handleDriverMasterStatus(post({ comp_id: "00000001" }), env));
    expect(body.results[0].last).toMatchObject({ trigger: "cron", ok: true, updated: 242 });
  });

  it("記録が無ければ last は null (「1 度も走っていない」と断定しない)", async () => {
    const { env } = fakeEnv({
      doFetch: vi.fn(async () => new Response(JSON.stringify({ last: null }), { status: 200 })),
    });
    const body = await jsonOf(await handleDriverMasterStatus(post({}), env));
    expect(body.results[0].last).toBeNull();
    expect(body.results[0].error).toBeUndefined();
  });

  it("★ 1 社が落ちても残りを読む (status と本文抜粋を名指しする)", async () => {
    let n = 0;
    const { env } = fakeEnv({
      doFetch: vi.fn(async () => {
        n += 1;
        if (n === 1) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ last: lastRun("00000002") }), { status: 200 });
      }),
    });
    const body = await jsonOf(await handleDriverMasterStatus(post({}), env));
    expect(body.results[0].error).toContain("HTTP 500: boom");
    expect(body.results[0].last).toBeNull();
    expect(body.results[1].last).toMatchObject({ comp_id: "00000002" });
  });

  it("DO が落ちても例外にせず error に畳む", async () => {
    const { env } = fakeEnv({
      doFetch: vi.fn(async () => {
        throw new Error("DO unreachable");
      }),
    });
    const body = await jsonOf(await handleDriverMasterStatus(post({ comp_id: "00000001" }), env));
    expect(body.results[0].error).toContain("DO unreachable");
  });
});
