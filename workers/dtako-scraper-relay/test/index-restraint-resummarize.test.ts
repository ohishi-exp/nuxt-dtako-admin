import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (node vitest では解決できない)。bare class で
// stub する — DO は instantiate しない (index-driver-master-run.test.ts と同じ手当て)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { handleRestraintResummarize, type RelayWorkerEnv } from "../src/index";

/**
 * `POST /kintai-relay/restraint-resummarize` (Refs ohishi-exp/rust-ichibanboshi#322)。
 * 関門 (secret / body) は `/kintai-relay/restraint-sync` と同じ、転送先は
 * `scraper-comp-{comp}` の DO の `/cron/restraint-resummarize`。
 */
const SECRET = "internal-shared-secret";

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const doFetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ month: "2026-06", restraint_push: { onprem: { outcome: "done", puts: 1 } } }),
  );
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) },
    INTERNAL_SHARED_SECRET: SECRET,
    KINTAI_COMP_ID: "00000001",
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, idFromName };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://relay.internal/kintai-relay/restraint-resummarize", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleRestraintResummarize — 関門", () => {
  it("X-Alc-Proxy-Secret が不一致なら 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleRestraintResummarize(post({ month: "2026-06" }, { "X-Alc-Proxy-Secret": "wrong" }), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("X-Alc-Proxy-Secret が無ければ 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const req = new Request("https://relay.internal/kintai-relay/restraint-resummarize", {
      method: "POST",
      body: JSON.stringify({ month: "2026-06" }),
    });
    expect((await handleRestraintResummarize(req, env)).status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("INTERNAL_SHARED_SECRET が未設定なら 503", async () => {
    const { env, doFetch } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    expect((await handleRestraintResummarize(post({ month: "2026-06" }), env)).status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON でない", "not json", "body must be JSON"],
    ["month 無し", {}, "month は必須です"],
    ["month が文字列でない", { month: 202606 }, "month は必須です"],
  ])("body が%sなら 400", async (_l, body, error) => {
    const { env, doFetch } = fakeEnv();
    const res = await handleRestraintResummarize(post(body), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("comp_id 省略かつ KINTAI_COMP_ID 未設定なら 503", async () => {
    const { env, doFetch } = fakeEnv({ KINTAI_COMP_ID: undefined });
    const res = await handleRestraintResummarize(post({ month: "2026-06" }), env);
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("handleRestraintResummarize — 転送", () => {
  it("comp_id 省略時は KINTAI_COMP_ID の DO の /cron/restraint-resummarize へ転送し、応答を素通しする", async () => {
    const { env, doFetch, idFromName } = fakeEnv();
    const res = await handleRestraintResummarize(post({ month: "2026-06" }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      month: "2026-06",
      restraint_push: { onprem: { outcome: "done", puts: 1 } },
    });
    expect(idFromName).toHaveBeenCalledWith("scraper-comp-00000001");
    expect(doFetch).toHaveBeenCalledWith("https://relay.internal/cron/restraint-resummarize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comp_id: "00000001", month: "2026-06" }),
    });
  });

  it("comp_id 指定時はその会社の DO へ。month の形式は DO 側が見るので 400 もそのまま返す", async () => {
    const { env, doFetch, idFromName } = fakeEnv();
    doFetch.mockResolvedValueOnce(Response.json({ error: "month は YYYY-MM で指定してください" }, { status: 400 }));
    const res = await handleRestraintResummarize(post({ month: "2026-6", comp_id: " 00000002 " }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "month は YYYY-MM で指定してください" });
    expect(idFromName).toHaveBeenCalledWith("scraper-comp-00000002");
    expect(JSON.parse(String(doFetch.mock.calls[0]![1].body))).toEqual({ comp_id: "00000002", month: "2026-6" });
  });

  it("worker の fetch が /kintai-relay/restraint-resummarize を受ける", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await worker.fetch(post({ month: "2026-06" }), env);
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
});
