import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (node vitest では解決できない)。bare class で
// stub して module を読み込めるようにする — DO は一切 instantiate しない
// (index-kintai-relay-proxy.test.ts と同じ手当て)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { handleDriverMasterRun, type RelayWorkerEnv } from "../src/index";

const SECRET = "internal-shared-secret";
const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "22222222-2222-2222-2222-222222222222";

const ACCOUNTS = JSON.stringify([
  { comp_id: "00000001", user_name: "u1", user_pass: "p1", tenant_id: TENANT },
  { comp_id: "00000002", user_name: "u2", user_pass: "p2", tenant_id: TENANT },
  { comp_id: "00000009", user_name: "u9", user_pass: "p9", tenant_id: OTHER_TENANT },
]);

function doOk(compId: string, over: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      ok: true,
      comp_id: compId,
      rows: 2,
      items: 2,
      created: 1,
      updated: 1,
      skipped: [],
      unreadable: null,
      ...over,
    }),
    { status: 200 },
  );
}

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const doFetch =
    (over.doFetch as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { comp_id: string };
      return doOk(body.comp_id);
    });
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) },
    INTERNAL_SHARED_SECRET: SECRET,
    DTAKO_ACCOUNTS: ACCOUNTS,
    KINTAI_COMP_ID: "00000001",
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, idFromName };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://relay.internal/kintai-relay/driver-master-run", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET, ...headers },
    body: JSON.stringify(body),
  });
}

async function jsonOf(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe("handleDriverMasterRun — 関門 (secret / body)", () => {
  it("X-Alc-Proxy-Secret が不一致なら 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDriverMasterRun(
      post({ comp_id: "00000001" }, { "X-Alc-Proxy-Secret": "wrong" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({ error: "Unauthorized" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("INTERNAL_SHARED_SECRET が未設定なら 503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    const res = await handleDriverMasterRun(post({ comp_id: "00000001" }), env);
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("body が JSON でなければ 400", async () => {
    const { env, doFetch } = fakeEnv();
    const req = new Request("https://relay.internal/kintai-relay/driver-master-run", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET },
      body: "not json",
    });
    const res = await handleDriverMasterRun(req, env);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: "body must be JSON" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("CORS ヘッダを付けない (ブラウザから直に叩く口ではない)", async () => {
    const { env } = fakeEnv();
    const res = await handleDriverMasterRun(post({ comp_id: "00000001" }), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("handleDriverMasterRun — comp_id / tenant_id の排他", () => {
  it("両方指定は 400 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDriverMasterRun(
      post({ comp_id: "00000001", tenant_id: TENANT }),
      env,
    );
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain("同時に指定できません");
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("両方なしは 400 — KINTAI_COMP_ID があっても勝手に同期しない", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDriverMasterRun(post({}), env);
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error).toContain("どちらか一方が必要です");
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("空文字・文字列でない値は「指定なし」として 400", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDriverMasterRun(post({ comp_id: "  ", tenant_id: 42 }), env);
    expect(res.status).toBe(400);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("handleDriverMasterRun — comp_id 単独指定", () => {
  it("1 社を DO へ投げ、results 配列で返す", async () => {
    const { env, doFetch, idFromName } = fakeEnv();
    const res = await handleDriverMasterRun(post({ comp_id: "00000002" }), env);

    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      results: [
        { comp_id: "00000002", status: 200, created: 1, updated: 1, skipped: [] },
      ],
    });
    expect(idFromName).toHaveBeenCalledWith("scraper-comp-00000002");
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0];
    expect(url).toBe("https://relay.internal/cron/driver-master");
    // ★ DO へ渡すのは comp_id だけ (tenant_id は運ばない)。
    expect(JSON.parse(String(init.body))).toEqual({ comp_id: "00000002" });
  });

  it("その 1 社が失敗したら 502 (全社失敗)", async () => {
    const doFetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: "theearth 500" }), { status: 502 }),
    );
    const { env } = fakeEnv({ doFetch });
    const res = await handleDriverMasterRun(post({ comp_id: "00000001" }), env);

    expect(res.status).toBe(502);
    const body = await jsonOf(res);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].error).toContain("HTTP 502");
  });
});

describe("handleDriverMasterRun — tenant_id 指定", () => {
  it("tenant_id を comp_id[] に写して逐次実行し、DO へは comp_id だけ渡す", async () => {
    const seen: string[] = [];
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { comp_id: string; tenant_id?: string };
      expect(body.tenant_id).toBeUndefined();
      seen.push(body.comp_id);
      return doOk(body.comp_id, { created: 2, updated: 3 });
    });
    const { env, idFromName } = fakeEnv({ doFetch });

    const res = await handleDriverMasterRun(post({ tenant_id: TENANT }), env);

    expect(res.status).toBe(200);
    // OTHER_TENANT の 00000009 は含まれない。
    expect(seen).toEqual(["00000001", "00000002"]);
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual([
      "scraper-comp-00000001",
      "scraper-comp-00000002",
    ]);
    const body = await jsonOf(res);
    expect(body.results.map((r: { comp_id: string }) => r.comp_id)).toEqual([
      "00000001",
      "00000002",
    ]);
    expect(body.results[0]).toEqual({
      comp_id: "00000001",
      status: 200,
      created: 2,
      updated: 3,
      skipped: [],
    });
  });

  it("1 社が失敗しても残りを回し、全体は 200 でその社だけ error を持つ", async () => {
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { comp_id } = JSON.parse(String(init.body)) as { comp_id: string };
      if (comp_id === "00000001") {
        return new Response(JSON.stringify({ ok: false, error: "login kicked" }), { status: 502 });
      }
      return doOk(comp_id);
    });
    const { env } = fakeEnv({ doFetch });

    const res = await handleDriverMasterRun(post({ tenant_id: TENANT }), env);

    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    const body = await jsonOf(res);
    expect(body.results[0].error).toContain("HTTP 502");
    expect(body.results[1].error).toBeUndefined();
  });

  it("全社失敗なら 502", async () => {
    const doFetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, error: "down" }), { status: 502 }),
    );
    const { env } = fakeEnv({ doFetch });
    const res = await handleDriverMasterRun(post({ tenant_id: TENANT }), env);
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).results).toHaveLength(2);
  });

  it("tenant_id に該当する account が無ければ 404 で名指しする (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDriverMasterRun(
      post({ tenant_id: "33333333-3333-3333-3333-333333333333" }),
      env,
    );
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error).toBe(
      "tenant_id=33333333-3333-3333-3333-333333333333 に対応する theearth アカウントがありません",
    );
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("DTAKO_ACCOUNTS 未設定でも 404 (空配列 = 該当なし)", async () => {
    const { env, doFetch } = fakeEnv({ DTAKO_ACCOUNTS: undefined });
    const res = await handleDriverMasterRun(post({ tenant_id: TENANT }), env);
    expect(res.status).toBe(404);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("DTAKO_ACCOUNTS が壊れていたら 503 (「該当なし」と同じ顔にしない)", async () => {
    const { env, doFetch } = fakeEnv({ DTAKO_ACCOUNTS: "{not json" });
    const res = await handleDriverMasterRun(post({ tenant_id: TENANT }), env);
    expect(res.status).toBe(503);
    expect((await jsonOf(res)).error).toContain("DTAKO_ACCOUNTS");
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("KV (DTAKO_CONFIG_KV の dtako_accounts) が plain 変数より優先される", async () => {
    const kv = { get: vi.fn(async () => ACCOUNTS) };
    const { env, doFetch } = fakeEnv({ DTAKO_CONFIG_KV: kv, DTAKO_ACCOUNTS: "[]" });
    const res = await handleDriverMasterRun(post({ tenant_id: TENANT }), env);
    expect(kv).toBeDefined();
    expect(kv.get).toHaveBeenCalledWith("dtako_accounts");
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
});
