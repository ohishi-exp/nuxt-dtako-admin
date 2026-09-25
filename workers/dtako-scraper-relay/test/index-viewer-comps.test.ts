import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (node vitest では解決できない)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { type RelayWorkerEnv } from "../src/index";

/**
 * `GET /restraint-api/viewer-comps` の振り分け。会社を選ぶ前の口なので theearth routing
 * ヘッダが無い — 他の `/restraint-api/*` と同じ扱いだと 400 で DO に届かない。
 */
function fakeEnv() {
  const idFromName = vi.fn((name: string) => name);
  const doFetch = vi.fn(async () => Response.json({ comps: ["27324455"] }));
  const env = { RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) } } as unknown as RelayWorkerEnv;
  return { env, idFromName, doFetch };
}

describe("relay worker: /restraint-api/viewer-comps", () => {
  it("routing ヘッダ無しでも 400 にせず、固定キー viewer-comps の DO へ渡す", async () => {
    const { env, idFromName, doFetch } = fakeEnv();
    const res = await worker.fetch(new Request("https://relay.example/restraint-api/viewer-comps", {
      headers: { Authorization: "Bearer jwt" },
    }), env);
    expect(res.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("viewer-comps");
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("陰性対照: 他の /restraint-api/* は従来どおり routing ヘッダ無しなら 400 (DO に届かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await worker.fetch(new Request("https://relay.example/restraint-api/comp-map"), env);
    expect(res.status).toBe(400);
    expect(doFetch).not.toHaveBeenCalled();
  });
});
