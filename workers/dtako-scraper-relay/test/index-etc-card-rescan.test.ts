import { describe, expect, it, vi } from "vitest";

// index.ts は DO を re-export しており、そちらが "cloudflare:workers" を import する
// (index-etc-card-register.test.ts と同じ手当て)。DO は instantiate しない。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { handleEtcCardRescan, type RelayWorkerEnv } from "../src/index";
import { SELECT_RESCAN_TARGET_SQL } from "../src/etc-card-register-run";

const SECRET = "internal-shared-secret";

/** 架空の会社。tenant-a は 2 社、tenant-b は 1 社。 */
const ACCOUNTS = JSON.stringify([
  { comp_id: "c1", user_name: "u1", user_pass: "pw-1", tenant_id: "tenant-a" },
  { comp_id: "c2", user_name: "u2", user_pass: "pw-2", tenant_id: "tenant-a" },
  { comp_id: "c3", user_name: "u3", user_pass: "pw-3", tenant_id: "tenant-b" },
]);
const TARGET = { id: 3, card_number: "0000111122223333", registration_date: null, received_at: "2026-11-01T00:00:00.000Z", tenant_id: "tenant-a" };

function fakeEnv(over: Partial<Record<string, unknown>> = {}, rows: unknown[] = [TARGET]) {
  const selects: { sql: string; params: unknown[] }[] = [];
  const DTAKO_DB = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        all: async () => {
          selects.push({ sql, params });
          return { results: rows };
        },
        run: async () => ({}),
      }),
    }),
  };
  const doFetch = vi.fn(
    async (_name: string, _url: string, _init: RequestInit) => new Response('{"accepted":true}', { status: 202 }),
  );
  const RELAY = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((name: string) => ({ fetch: (url: string, init: RequestInit) => doFetch(name, url, init) })),
  };
  const env = {
    RELAY,
    INTERNAL_SHARED_SECRET: SECRET,
    DTAKO_ACCOUNTS: ACCOUNTS,
    DTAKO_DB,
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, selects };
}

function post(body: string | undefined, secret = SECRET) {
  return new Request("https://relay.internal/etc-card/rescan", {
    method: "POST",
    headers: { "X-Alc-Proxy-Secret": secret },
    ...(body === undefined ? {} : { body }),
  });
}

describe("handleEtcCardRescan (POST /etc-card/rescan、Refs #1287)", () => {
  it("行の tenant の会社 (DTAKO_ACCOUNTS の逆引き) の DO へ id と comp_id だけ渡し、202 を返す", async () => {
    const { env, doFetch, selects } = fakeEnv();
    const res = await handleEtcCardRescan(post('{"id":3,"tenant_id":"tenant-b"}'), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, id: 3, comp_ids: ["c1", "c2"] });
    expect(selects).toEqual([{ sql: SELECT_RESCAN_TARGET_SQL, params: [3] }]);
    expect(doFetch.mock.calls.map((c) => c[0])).toEqual(["scraper-comp-c1", "scraper-comp-c2"]);
    expect(doFetch.mock.calls[0]![1]).toBe("https://relay.internal/internal/etc-card-rescan");
    expect(JSON.parse(String(doFetch.mock.calls[0]![2].body))).toEqual({ id: 3, comp_id: "c1" });
    // body の tenant_id は使わない・資格情報も tenant も DO へ運ばない
    expect(doFetch.mock.calls.map((c) => String(c[2].body)).join()).not.toMatch(/pw-|tenant/);
  });

  it("1 社でも受ければ 202 (受けた会社だけ並べる)。どこも受けなければ最後の DO の応答を素通しする", async () => {
    const some = fakeEnv();
    some.doFetch.mockResolvedValueOnce(new Response('{"error":"x"}', { status: 503 }));
    const res = await handleEtcCardRescan(post('{"id":3}'), some.env);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, id: 3, comp_ids: ["c2"] });

    const none = fakeEnv();
    none.doFetch.mockImplementation(async () => new Response('{"error":"off"}', { status: 503 }));
    const r2 = await handleEtcCardRescan(post('{"id":3}'), none.env);
    expect(r2.status).toBe(503);
    expect(await r2.json()).toEqual({ error: "off" });
  });

  it("探し直せる行が無ければ 404 で DO を叩かない。行の会社のアカウントが無くても 404", async () => {
    const noRow = fakeEnv({}, []);
    const r1 = await handleEtcCardRescan(post('{"id":3}'), noRow.env);
    expect(r1.status).toBe(404);
    expect(noRow.doFetch).not.toHaveBeenCalled();

    const noComp = fakeEnv({}, [{ ...TARGET, tenant_id: "tenant-z" }]);
    const r2 = await handleEtcCardRescan(post('{"id":3}'), noComp.env);
    expect(r2.status).toBe(404);
    expect((await r2.json()) as unknown).toEqual({ error: "この行の会社の theearth アカウントがありません (DTAKO_ACCOUNTS)" });
    expect(noComp.doFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["secret 不一致", fakeEnv().env, post('{"id":1}', "wrong"), 401],
    ["INTERNAL_SHARED_SECRET 未設定", fakeEnv({ INTERNAL_SHARED_SECRET: undefined }).env, post('{"id":1}'), 503],
    ["ETC_CARD_REGISTER_MODE=off", fakeEnv({ ETC_CARD_REGISTER_MODE: "off" }).env, post('{"id":1}'), 503],
    ["JSON でない", fakeEnv().env, post("nope"), 400],
    ["id が文字列", fakeEnv().env, post('{"id":"1"}'), 400],
    ["body が null", fakeEnv().env, post("null"), 400],
    ["DTAKO_DB 未設定", fakeEnv({ DTAKO_DB: undefined }).env, post('{"id":1}'), 503],
    ["DTAKO_ACCOUNTS が壊れている", fakeEnv({ DTAKO_ACCOUNTS: "{" }).env, post('{"id":3}'), 503],
  ])("%s は %i", async (_l, env, req, status) => {
    const res = await handleEtcCardRescan(req, env);
    expect(res.status).toBe(status);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("DTAKO_ACCOUNTS の parse が Error 以外を投げても文字列で 503", async () => {
    const { env } = fakeEnv({ DTAKO_CONFIG_KV: { get: async () => { throw "kv down"; } } });
    const res = await handleEtcCardRescan(post('{"id":3}'), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kv down" });
  });

  it("worker.fetch の POST /etc-card/rescan はこの handler に届く", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await worker.fetch(post('{"id":3}'), env);
    expect(res.status).toBe(202);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
});
