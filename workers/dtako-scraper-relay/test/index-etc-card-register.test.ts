import { describe, expect, it, vi } from "vitest";

// index.ts は DO を re-export しており、そちらが "cloudflare:workers" を import する
// (index-etc-run.test.ts と同じ手当て)。DO は instantiate しない。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { handleEtcCardRegister, type RelayWorkerEnv } from "../src/index";

const SECRET = "internal-shared-secret";

/** 架空のアカウント。`types` = 各 DO が記録した種別 (`GET /internal/etc-account-type` の応答)。 */
const ACCOUNTS = JSON.stringify([
  { user_id: "etc-p", password: "pw-p" },
  { user_id: "etc-reg", password: "pw-reg" },
  { user_id: "etc-c2", password: "pw-c2" },
]);
const TYPES: Record<string, string | null> = { "etc-p": "personal", "etc-reg": "corporate", "etc-c2": "corporate" };

function fakeEnv(over: Partial<Record<string, unknown>> = {}, types: Record<string, string | null> = TYPES) {
  const doFetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ results: [{ id: 3, kind: "dry_run_ok" }] }), { status: 200 }),
  );
  const idFromName = vi.fn((name: string) => name);
  const get = vi.fn((name: string) => ({
    fetch: (url: string, init?: RequestInit) =>
      url.endsWith("/internal/etc-account-type")
        ? Promise.resolve(Response.json({ account_type: types[name.replace(/^etc-/, "")] ?? null }))
        : doFetch(url, init as RequestInit),
  }));
  const env = {
    RELAY: { idFromName, get },
    INTERNAL_SHARED_SECRET: SECRET,
    ETC_ACCOUNTS: ACCOUNTS,
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, get };
}

function post(body: string | undefined, secret = SECRET) {
  return new Request("https://relay.internal/etc-card/register", {
    method: "POST",
    headers: { "X-Alc-Proxy-Secret": secret },
    ...(body === undefined ? {} : { body }),
  });
}

describe("handleEtcCardRegister (POST /etc-card/register、Refs #1287)", () => {
  it("並び順で最初の法人アカウントの DO へ id と user_id だけ渡し、応答をそのまま返す", async () => {
    const { env, doFetch, get } = fakeEnv();
    const res = await handleEtcCardRegister(post('{"id":3,"extra":"x"}'), env);
    expect(res.status).toBe(200);
    expect(JSON.parse(await res.text())).toEqual({ results: [{ id: 3, kind: "dry_run_ok" }] });
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(get.mock.calls.at(-1)?.[0]).toBe("etc-etc-reg");
    expect(doFetch.mock.calls[0][0]).toBe("https://relay.internal/internal/etc-card-register");
    expect(JSON.parse(String(doFetch.mock.calls[0][1].body))).toEqual({ id: 3, user_id: "etc-reg" });
    expect(String(doFetch.mock.calls[0][1].body)).not.toContain("pw-"); // credential は DO 側で解決する
  });

  it.each([
    ["前のアカウントの種別が未記録", { ...TYPES, "etc-p": null }, "法人アカウントが未確認 (次の ETC cron で確認される)"],
    [
      "法人アカウントが無い",
      { "etc-p": "personal", "etc-reg": "personal", "etc-c2": "personal" },
      "法人アカウントが見つかりません (ETC_ACCOUNTS の全アカウントが個人と判定)",
    ],
  ])("%s なら 503 で DO の登録口を叩かない (未確認と全員個人は文言を分ける)", async (_l, types, message) => {
    const { env, doFetch } = fakeEnv({}, types);
    const res = await handleEtcCardRegister(post('{"id":3}'), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: message });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("DO の status (404 等) を素通しする", async () => {
    const { env, doFetch } = fakeEnv();
    doFetch.mockResolvedValueOnce(new Response('{"error":"x"}', { status: 404 }));
    expect((await handleEtcCardRegister(post('{"id":3}'), env)).status).toBe(404);
  });

  it.each([
    ["secret 不一致", fakeEnv().env, post('{"id":1}', "wrong"), 401],
    ["INTERNAL_SHARED_SECRET 未設定", fakeEnv({ INTERNAL_SHARED_SECRET: undefined }).env, post('{"id":1}'), 503],
    ["ETC_CARD_REGISTER_MODE=off", fakeEnv({ ETC_CARD_REGISTER_MODE: "off" }).env, post('{"id":1}'), 503],
    ["ETC_ACCOUNTS 未設定", fakeEnv({ ETC_ACCOUNTS: undefined }).env, post('{"id":1}'), 503],
    ["ETC_ACCOUNTS が壊れている", fakeEnv({ ETC_ACCOUNTS: "not-json" }).env, post('{"id":1}'), 503],
    ["JSON でない", fakeEnv().env, post("nope"), 400],
    ["id が無い", fakeEnv().env, post("null"), 400],
    ["id が文字列", fakeEnv().env, post('{"id":"1"}'), 400],
    ["id が 0", fakeEnv().env, post('{"id":0}'), 400],
    ["id が小数", fakeEnv().env, post('{"id":1.5}'), 400],
  ])("%s は DO を叩かずに落とす", async (_label, env, req, status) => {
    const res = await handleEtcCardRegister(req as Request, env as RelayWorkerEnv);
    expect(res.status).toBe(status);
  });

  it("MODE=off は種別も読まずに 503", async () => {
    const { env, get } = fakeEnv({ ETC_CARD_REGISTER_MODE: "off" });
    const res = await handleEtcCardRegister(post('{"id":1}'), env);
    expect(await res.json()).toEqual({
      error: "この環境では ETC カード追加登録を止めています (ETC_CARD_REGISTER_MODE=off)",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("関門で落ちたら DO を叩かない", async () => {
    const { env, doFetch } = fakeEnv();
    await handleEtcCardRegister(post('{"id":1}', "wrong"), env);
    await handleEtcCardRegister(post('{"id":-1}'), env);
    expect(doFetch).not.toHaveBeenCalled();
  });
});
