import { describe, expect, it, vi } from "vitest";

// index-theearth-restraint-run.test.ts と同じ手当て (DO は instantiate しない)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { handleKintaiRestStartSync, type RelayWorkerEnv } from "../src/index";

/** `POST /kintai-relay/rest-start-sync`。関門は `forwardCompMonthToDo`、転送先は DO の `/cron/rest-start-sync`。 */
const SECRET = "internal-shared-secret";

function fakeEnv() {
  const doFetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ candidates: 0 }));
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) },
    INTERNAL_SHARED_SECRET: SECRET,
    KINTAI_COMP_ID: "00000001",
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, idFromName };
}

function post(body: unknown, secret = SECRET) {
  return new Request("https://relay.internal/kintai-relay/rest-start-sync", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": secret },
    body: JSON.stringify(body),
  });
}

describe("handleKintaiRestStartSync", () => {
  it("secret が違えば 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    expect((await handleKintaiRestStartSync(post({ month: "2026-07" }, "wrong"), env)).status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("会社の DO へ apply を渡して転送する (true のときだけ true)", async () => {
    const { env, doFetch, idFromName } = fakeEnv();
    const res = await worker.fetch(post({ month: "2026-07", comp_id: "75700192", apply: true }), env);
    expect(res.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("scraper-comp-75700192");
    expect(doFetch).toHaveBeenCalledWith("https://relay.internal/cron/rest-start-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comp_id: "75700192", month: "2026-07", apply: true }),
    });
    await worker.fetch(post({ month: "2026-07", comp_id: "75700192", apply: "yes" }), env);
    expect(doFetch.mock.calls[1]![1].body).toBe(JSON.stringify({ comp_id: "75700192", month: "2026-07", apply: false }));
  });
});
