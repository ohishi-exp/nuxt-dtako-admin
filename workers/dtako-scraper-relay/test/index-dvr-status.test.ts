import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (node vitest では解決できない)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { handleDvrStatus, type RelayWorkerEnv } from "../src/index";

/**
 * `POST /kintai-relay/dvr-status` — DVR 取り込み cron の無音故障を読む口 (Refs #1094)。
 *
 * ★ ここで測る本題は **comp_id 省略時の母集団が `DVR_TARGETS` である**こと。
 * `DTAKO_ACCOUNTS` 全社に倒すと、DVR を運用していない会社の DO からも `last: null`
 * が返り、**「止まっている」と「そもそも対象外」が見分けられなくなる**。
 */

const SECRET = "internal-shared-secret";
const TENANT = "11111111-1111-1111-1111-111111111111";

/** 対象は 1 社だけ。DTAKO_ACCOUNTS には 2 社入っている (陰性対照)。 */
const DVR_TARGETS = JSON.stringify([{ comp_id: "00000001" }]);
const ACCOUNTS = JSON.stringify([
  { comp_id: "00000001", user_name: "u1", user_pass: "p1", tenant_id: TENANT },
  { comp_id: "00000002", user_name: "u2", user_pass: "p2", tenant_id: TENANT },
]);

function lastRun(compId: string, over: Record<string, unknown> = {}) {
  return {
    comp_id: compId,
    started_at: "2026-07-03T09:59:00.000Z",
    finished_at: "2026-07-03T09:59:12.000Z",
    ok: true,
    last_success_at: "2026-07-03T09:59:12.000Z",
    hours_since_last_success: 0.16,
    notifications: 4,
    in_window: 2,
    undated: 0,
    unusable: 0,
    inserted: 1,
    skipped: 1,
    pending: 1,
    requested: 0,
    stored: 1,
    failed: 0,
    error: null,
    ...over,
  };
}

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const doFetch =
    (over.doFetch as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async (url: string) => {
      expect(url).toBe("https://relay.internal/cron/dvr/last");
      return new Response(JSON.stringify({ last: lastRun("00000001") }), { status: 200 });
    });
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) },
    INTERNAL_SHARED_SECRET: SECRET,
    DTAKO_ACCOUNTS: ACCOUNTS,
    DVR_TARGETS,
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, idFromName };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://relay.internal/kintai-relay/dvr-status", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET, ...headers },
    body: JSON.stringify(body),
  });
}

const jsonOf = async (res: Response) => JSON.parse(await res.text());

describe("handleDvrStatus", () => {
  it("secret 不一致なら 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDvrStatus(post({}, { "X-Alc-Proxy-Secret": "wrong" }), env);
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("secret 未設定なら 503", async () => {
    const { env } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    expect((await handleDvrStatus(post({}), env)).status).toBe(503);
  });

  it("body が JSON でなければ 400", async () => {
    const { env } = fakeEnv();
    const req = new Request("https://relay.internal/kintai-relay/dvr-status", {
      method: "POST",
      headers: { "X-Alc-Proxy-Secret": SECRET },
      body: "not json",
    });
    expect((await handleDvrStatus(req, env)).status).toBe(400);
  });

  it("★ comp_id 省略時の母集団は DVR_TARGETS — DTAKO_ACCOUNTS 全社ではない", async () => {
    const { env, idFromName } = fakeEnv();
    const res = await handleDvrStatus(post({}), env);
    expect(res.status).toBe(200);
    // 対象は 1 社。DTAKO_ACCOUNTS の 2 社目 (00000002) は読みにいかない
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["scraper-comp-00000001"]);
    expect(await jsonOf(res)).toEqual({
      results: [{ comp_id: "00000001", last: lastRun("00000001") }],
    });
  });

  it("comp_id を明示したらその 1 社だけ読む", async () => {
    const { env, idFromName } = fakeEnv();
    const res = await handleDvrStatus(post({ comp_id: " 00000002 " }), env);
    expect(res.status).toBe(200);
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["scraper-comp-00000002"]);
  });

  it("DVR_TARGETS が壊れていたら 503 (「1 社も無い」と同じ顔にしない)", async () => {
    const { env, doFetch } = fakeEnv({ DVR_TARGETS: "{" });
    const res = await handleDvrStatus(post({}), env);
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("DO が非 2xx / 例外でも 200 で results に理由を載せる", async () => {
    const failing = vi.fn(async () => new Response("boom", { status: 500 }));
    const res = await handleDvrStatus(post({}), fakeEnv({ doFetch: failing }).env);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      results: [{ comp_id: "00000001", last: null, error: "HTTP 500: boom" }],
    });

    const throwing = vi.fn(async () => {
      throw new Error("binding down");
    });
    expect(await jsonOf(await handleDvrStatus(post({}), fakeEnv({ doFetch: throwing }).env))).toEqual({
      results: [{ comp_id: "00000001", last: null, error: "binding down" }],
    });
  });

  it("まだ 1 度も走っていない DO は last: null で返る (エラーではない)", async () => {
    const empty = vi.fn(async () => new Response(JSON.stringify({ last: null }), { status: 200 }));
    expect(await jsonOf(await handleDvrStatus(post({}), fakeEnv({ doFetch: empty }).env))).toEqual({
      results: [{ comp_id: "00000001", last: null }],
    });
  });
});
