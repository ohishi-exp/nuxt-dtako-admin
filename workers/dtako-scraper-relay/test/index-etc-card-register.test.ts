import { describe, expect, it, vi } from "vitest";

// index.ts は DO を re-export しており、そちらが "cloudflare:workers" を import する
// (index-etc-run.test.ts と同じ手当て)。DO は instantiate しない。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { handleEtcCardRegister, type RelayWorkerEnv } from "../src/index";

const SECRET = "internal-shared-secret";

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const doFetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ results: [{ id: 3, kind: "dry_run_ok" }] }), { status: 200 }),
  );
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) },
    INTERNAL_SHARED_SECRET: SECRET,
    ETC_CARD_REGISTER_USER_ID: "etc-reg",
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, idFromName };
}

function post(body: string | undefined, secret = SECRET) {
  return new Request("https://relay.internal/etc-card/register", {
    method: "POST",
    headers: { "X-Alc-Proxy-Secret": secret },
    ...(body === undefined ? {} : { body }),
  });
}

describe("handleEtcCardRegister (POST /etc-card/register、Refs #1287)", () => {
  it("登録用アカウントの DO の /internal/etc-card-register へ id だけ渡し、応答をそのまま返す", async () => {
    const { env, doFetch, idFromName } = fakeEnv();
    const res = await handleEtcCardRegister(post('{"id":3,"extra":"x"}'), env);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ results: [{ id: 3, kind: "dry_run_ok" }] });
    expect(idFromName).toHaveBeenCalledWith("etc-etc-reg");
    expect(doFetch.mock.calls[0][0]).toBe("https://relay.internal/internal/etc-card-register");
    expect(JSON.parse(String(doFetch.mock.calls[0][1].body))).toEqual({ id: 3 });
  });

  it("DO の status (404 等) を素通しする", async () => {
    const { env, doFetch } = fakeEnv();
    doFetch.mockResolvedValueOnce(new Response('{"error":"x"}', { status: 404 }));
    expect((await handleEtcCardRegister(post('{"id":3}'), env)).status).toBe(404);
  });

  it.each([
    ["secret 不一致", fakeEnv().env, post('{"id":1}', "wrong"), 401],
    ["INTERNAL_SHARED_SECRET 未設定", fakeEnv({ INTERNAL_SHARED_SECRET: undefined }).env, post('{"id":1}'), 503],
    ["ETC_CARD_REGISTER_USER_ID 未設定", fakeEnv({ ETC_CARD_REGISTER_USER_ID: undefined }).env, post('{"id":1}'), 503],
    ["JSON でない", fakeEnv().env, post("nope"), 400],
    ["id が無い", fakeEnv().env, post("null"), 400],
    ["id が文字列", fakeEnv().env, post('{"id":"1"}'), 400],
    ["id が 0", fakeEnv().env, post('{"id":0}'), 400],
    ["id が小数", fakeEnv().env, post('{"id":1.5}'), 400],
  ])("%s は DO を叩かずに落とす", async (_label, env, req, status) => {
    const res = await handleEtcCardRegister(req as Request, env as RelayWorkerEnv);
    expect(res.status).toBe(status);
  });

  it("関門で落ちたら DO を叩かない", async () => {
    const { env, doFetch } = fakeEnv();
    await handleEtcCardRegister(post('{"id":1}', "wrong"), env);
    await handleEtcCardRegister(post('{"id":-1}'), env);
    expect(doFetch).not.toHaveBeenCalled();
  });
});
