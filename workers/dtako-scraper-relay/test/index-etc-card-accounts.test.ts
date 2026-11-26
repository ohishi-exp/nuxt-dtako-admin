import { describe, expect, it, vi } from "vitest";

// index-etc-card-register.test.ts と同じ手当て (DO は instantiate しない)
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { handleEtcCardAccounts, type RelayWorkerEnv } from "../src/index";

const SECRET = "internal-shared-secret";

/** 架空のアカウント。`records` = 各 DO の `GET /internal/etc-account-type` の応答 (無ければ 500)。 */
const ACCOUNTS = JSON.stringify([
  { user_id: "etc-user-p001", password: "pw-p" },
  { user_id: "etc-user-c002", password: "pw-c" },
]);
const LAST = { at: "2026-11-26T01:00:00.000Z", status: "success" };
const RECORDS: Record<string, unknown> = {
  "etc-user-p001": { account_type: "personal", login_path: "/etc/R", menu_funccodes: ["1032000000"], last_scrape: LAST },
  "etc-user-c002": { account_type: "corporate", login_path: "/etc/R", menu_funccodes: ["1032000000", "1034000000"], last_scrape: LAST },
};

function fakeEnv(over: Partial<Record<string, unknown>> = {}, records: Record<string, unknown> = RECORDS) {
  const reads: string[] = [];
  const get = vi.fn((name: string) => ({
    fetch: async (url: string) => {
      reads.push(`${name} ${url}`);
      const r = records[name.replace(/^etc-/, "")];
      return r === undefined ? new Response("x", { status: 500 }) : Response.json(r);
    },
  }));
  const env = {
    RELAY: { idFromName: (n: string) => n, get },
    INTERNAL_SHARED_SECRET: SECRET,
    ETC_ACCOUNTS: ACCOUNTS,
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, reads };
}

const req = (secret = SECRET) =>
  new Request("https://relay.internal/etc-card/accounts", { headers: { "X-Alc-Proxy-Secret": secret } });

describe("handleEtcCardAccounts (GET /etc-card/accounts、Refs #1287)", () => {
  it("全アカウントの記録と担当を返す (user_id は末尾 4 文字、credential は出さない)", async () => {
    const { env, reads } = fakeEnv();
    const res = await handleEtcCardAccounts(req(), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      accounts: [
        { idx: 0, user_tail: "*p001", ...(RECORDS["etc-user-p001"] as object) },
        { idx: 1, user_tail: "*c002", ...(RECORDS["etc-user-c002"] as object) },
      ],
      pick: { kind: "found", user_tail: "*c002" },
    });
    expect(text).not.toContain("etc-user");
    expect(text).not.toContain("pw-");
    expect(reads).toEqual([
      "etc-etc-user-p001 https://relay.internal/internal/etc-account-type",
      "etc-etc-user-c002 https://relay.internal/internal/etc-account-type",
    ]);
  });

  it("読み失敗は error: true、担当は unconfirmed", async () => {
    const { env } = fakeEnv({}, { "etc-user-c002": RECORDS["etc-user-c002"] });
    const body = (await (await handleEtcCardAccounts(req(), env)).json()) as {
      accounts: { error?: boolean; account_type: unknown }[];
      pick: unknown;
    };
    expect(body.accounts[0]).toMatchObject({ account_type: null, error: true });
    expect(body.pick).toEqual({ kind: "unconfirmed", user_tail: "*p001" });
  });

  it("全員個人なら pick は none (user_tail null)", async () => {
    const { env } = fakeEnv({}, { "etc-user-p001": RECORDS["etc-user-p001"], "etc-user-c002": RECORDS["etc-user-p001"] });
    expect(((await (await handleEtcCardAccounts(req(), env)).json()) as { pick: unknown }).pick).toEqual({
      kind: "none",
      user_tail: null,
    });
  });

  it("読むだけなので ETC_CARD_REGISTER_MODE=off でも返す", async () => {
    const { env } = fakeEnv({ ETC_CARD_REGISTER_MODE: "off" });
    expect((await handleEtcCardAccounts(req(), env)).status).toBe(200);
  });

  it("ETC_ACCOUNTS 未設定は 0 件 (pick none)", async () => {
    const res = await handleEtcCardAccounts(req(), fakeEnv({ ETC_ACCOUNTS: undefined }).env);
    expect(await res.json()).toEqual({ accounts: [], pick: { kind: "none", user_tail: null } });
  });

  it.each([
    ["secret 不一致", fakeEnv().env, req("wrong"), 401],
    ["INTERNAL_SHARED_SECRET 未設定", fakeEnv({ INTERNAL_SHARED_SECRET: undefined }).env, req(), 503],
    ["ETC_ACCOUNTS が壊れている", fakeEnv({ ETC_ACCOUNTS: "not-json" }).env, req(), 503],
  ])("%s なら status を返す", async (_l, env, r, status) => {
    const res = await handleEtcCardAccounts(r, env);
    expect(res.status).toBe(status);
    expect(await res.json()).toHaveProperty("error");
  });

  it("worker の fetch が GET /etc-card/accounts をここへ振る", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(req(), env);
    expect(res.status).toBe(200);
  });
});
