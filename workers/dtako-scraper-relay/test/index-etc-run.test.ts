import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (node vitest では解決できない)。bare class で
// stub して module を読み込めるようにする — DO は一切 instantiate しない
// (index-driver-master-run.test.ts と同じ手当て)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { handleEtcRun, type RelayWorkerEnv } from "../src/index";
import { ETC_CRON, runScheduledCron, type CronDoCall } from "../src/cron";

const SECRET = "internal-shared-secret";

const ETC_ACCOUNTS = JSON.stringify([
  { user_id: "etc1", password: "p1" },
  { user_id: "etc2", password: "p2" },
]);

type DoCall = { url: string; body: unknown };

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const calls: DoCall[] = [];
  const doFetch =
    (over.doFetch as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as unknown });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) },
    INTERNAL_SHARED_SECRET: SECRET,
    ETC_ACCOUNTS,
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, idFromName, calls };
}

/** 既定は body を持たない POST — この口はパラメータを取らない。 */
function post(headers: Record<string, string> = {}, body?: BodyInit) {
  return new Request("https://relay.internal/kintai-relay/etc-run", {
    method: "POST",
    headers: { "X-Alc-Proxy-Secret": SECRET, ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

async function jsonOf(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe("handleEtcRun — 関門 (secret)", () => {
  it("X-Alc-Proxy-Secret が不一致なら 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleEtcRun(post({ "X-Alc-Proxy-Secret": "wrong" }), env);
    expect(res.status).toBe(401);
    expect(await jsonOf(res)).toEqual({ error: "Unauthorized" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("secret ヘッダが無ければ 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const req = new Request("https://relay.internal/kintai-relay/etc-run", { method: "POST" });
    const res = await handleEtcRun(req, env);
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("INTERNAL_SHARED_SECRET が未設定なら 503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    const res = await handleEtcRun(post(), env);
    expect(res.status).toBe(503);
    expect(await jsonOf(res)).toEqual({ error: "kintai-relay not configured" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  // 陰性対照: ブラウザから直に叩く口ではないので CORS ヘッダを付けない
  // (index-driver-master-run.test.ts の同名 it と対。**足したら落ちる**)。
  it("CORS ヘッダを付けない (ブラウザから直に叩く口ではない)", async () => {
    const { env } = fakeEnv();
    const res = await handleEtcRun(post(), env);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("handleEtcRun — cron と同じ道", () => {
  it("アカウントごとに etc-{user_id} DO の /cron/etc を叩く", async () => {
    const { env, calls, idFromName } = fakeEnv();
    const res = await handleEtcRun(post(), env);
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { url: "https://relay.internal/cron/etc", body: { user_id: "etc1" } },
      { url: "https://relay.internal/cron/etc", body: { user_id: "etc2" } },
    ]);
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["etc-etc1", "etc-etc2"]);
  });

  it("credential (password) は DO へ運ばない", async () => {
    const { env, calls } = fakeEnv();
    await handleEtcRun(post(), env);
    expect(JSON.stringify(calls)).not.toContain("p1");
    expect(JSON.stringify(calls)).not.toContain("p2");
  });

  /**
   * ★ この口の存在理由そのものを固定する検査。**cron が叩く DO 呼び出しと、
   * 手動口が叩く DO 呼び出しが 1 バイトも違わない**ことを、同じ入力で両方を
   * 走らせて突き合わせる。別実装に分岐したら (`dispatchEtcAccounts` を通さなくなったら)
   * ここが落ちる。
   */
  it("cron (runScheduledCron) と DO 呼び出しが完全に一致する", async () => {
    const cronCalls: Array<{ doKey: string; path: string; body: unknown }> = [];
    const cronDoCall: CronDoCall = async (doKey, path, body) => {
      cronCalls.push({ doKey, path, body });
      return { ok: true, status: 202, text: JSON.stringify({ accepted: true }) };
    };
    const cronResults = await runScheduledCron(
      ETC_CRON,
      { etcAccountsRaw: ETC_ACCOUNTS },
      cronDoCall,
      new Date("2026-09-03T21:00:00Z"),
    );

    const { env, calls } = fakeEnv();
    const manualResults = await jsonOf(await handleEtcRun(post(), env));

    expect(calls.map((c) => ({ path: new URL(c.url).pathname, body: c.body }))).toEqual(
      cronCalls.map((c) => ({ path: c.path, body: c.body })),
    );
    expect(manualResults.results).toEqual(cronResults);
  });

  // この口はパラメータを取らない (cron が取らないため)。body を送っても読まず、
  // 壊れた body で 400 にもしない — 1 件に絞る経路をここにだけ生やさないため。
  it("body を読まない (壊れた body でも cron と同じ全件 dispatch)", async () => {
    const { env, calls } = fakeEnv();
    const res = await handleEtcRun(post({ "content-type": "application/json" }, "not json"), env);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.body)).toEqual([{ user_id: "etc1" }, { user_id: "etc2" }]);
  });
});

describe("handleEtcRun — 設定と失敗", () => {
  it("ETC_ACCOUNTS 未設定は 200 の skip (cron の答えを書き換えない)", async () => {
    const { env, doFetch } = fakeEnv({ ETC_ACCOUNTS: undefined });
    const res = await handleEtcRun(post(), env);
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).results).toEqual([
      { kind: "etc", target: "*", ok: true, detail: "ETC_ACCOUNTS 未設定のため skip" },
    ]);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("ETC_ACCOUNTS が壊れていたら 503 (skip と同じ顔にしない)", async () => {
    const { env, doFetch } = fakeEnv({ ETC_ACCOUNTS: "{" });
    const res = await handleEtcRun(post(), env);
    expect(res.status).toBe(503);
    expect((await jsonOf(res)).error).toContain("ETC_ACCOUNTS");
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("Secrets Store binding (.get()) からも ETC_ACCOUNTS を読める", async () => {
    const { env, calls } = fakeEnv({
      ETC_ACCOUNTS: { get: async () => ETC_ACCOUNTS },
      INTERNAL_SHARED_SECRET: { get: async () => SECRET },
    });
    const res = await handleEtcRun(post(), env);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("1 件でも通れば 200", async () => {
    const doFetch = vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { user_id: string };
      return new Response("boom", { status: body.user_id === "etc1" ? 500 : 202 });
    });
    const { env } = fakeEnv({ doFetch });
    const res = await handleEtcRun(post(), env);
    expect(res.status).toBe(200);
    const results = (await jsonOf(res)).results;
    expect(results.map((r: any) => r.ok)).toEqual([false, true]);
  });

  it("全滅なら 502", async () => {
    const doFetch = vi.fn(async () => new Response("boom", { status: 500 }));
    const { env } = fakeEnv({ doFetch });
    const res = await handleEtcRun(post(), env);
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).results.every((r: any) => !r.ok)).toBe(true);
  });

  it("DO の throw は per-account の error result になる", async () => {
    const doFetch = vi.fn(async () => {
      throw new Error("do down");
    });
    const { env } = fakeEnv({ doFetch });
    const res = await handleEtcRun(post(), env);
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).results[0]).toMatchObject({ ok: false, detail: "do down" });
  });
});
