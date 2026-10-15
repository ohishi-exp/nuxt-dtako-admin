import { describe, expect, it, vi } from "vitest";

// index-restraint-resummarize.test.ts と同じ手当て (DO は instantiate しない)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { handleTheearthRestraintRun, type RelayWorkerEnv } from "../src/index";

/**
 * `POST /kintai-relay/theearth-restraint-run`。関門 (secret / body) は restraint-sync・
 * restraint-resummarize と共通 (`forwardCompMonthToDo`)、転送先は
 * `scraper-comp-{comp}` の DO の `/cron/theearth-restraint`。
 */
const SECRET = "internal-shared-secret";

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const doFetch = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ comp_id: "00000002", month: "2026-08", no_data: false, drivers: 13 }),
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
  return new Request("https://relay.internal/kintai-relay/theearth-restraint-run", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET, ...headers },
    body: JSON.stringify(body),
  });
}

describe("handleTheearthRestraintRun", () => {
  it("X-Alc-Proxy-Secret が不一致なら 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleTheearthRestraintRun(post({ month: "2026-08" }, { "X-Alc-Proxy-Secret": "wrong" }), env);
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("INTERNAL_SHARED_SECRET が未設定なら 503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    expect((await handleTheearthRestraintRun(post({ month: "2026-08" }), env)).status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("指定した会社の DO の /cron/theearth-restraint へ転送し、応答を素通しする", async () => {
    const { env, doFetch, idFromName } = fakeEnv();
    const res = await worker.fetch(post({ month: "2026-08", comp_id: "00000002" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ comp_id: "00000002", month: "2026-08", no_data: false, drivers: 13 });
    expect(idFromName).toHaveBeenCalledWith("scraper-comp-00000002");
    expect(doFetch).toHaveBeenCalledWith("https://relay.internal/cron/theearth-restraint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comp_id: "00000002", month: "2026-08" }),
    });
  });
});
