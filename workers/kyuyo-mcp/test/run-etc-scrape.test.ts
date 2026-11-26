import { describe, it, expect, vi } from "vitest";
import { runEtcScrapeTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

/**
 * `run_etc_scrape` — ETC 明細 CSV の取得を cron を待たずに 1 回走らせる (Refs ohishi-exp/nuxt-dtako-admin#1287)。
 *
 * ★ **write tool**。etc-meisai.jp へ各アカウントでログインし、R2 と DO の storage に書く。
 * ★ relay の応答の user_id 全桁 (`target` / `detail`) を返さない。user_id はすべて架空値。
 */

const SECRET = "internal-shared-secret";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ results: [] }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };

describe("run_etc_scrape (Refs ohishi-exp/nuxt-dtako-admin#1287)", () => {
  it("**write tool として scope を要求する**", () => {
    expect(runEtcScrapeTool.requiresScope).toBe("mcp.write");
  });

  it("引数を取らない (未知の引数は弾く)", () => {
    expect(runEtcScrapeTool.inputSchema.safeParse({}).success).toBe(true);
    expect(runEtcScrapeTool.inputSchema.safeParse({ user_id: "x" }).success).toBe(false);
  });

  it("説明文が「ログインする」「種別とログイン後のパスを記録する」「受け付けまで」を名指しする", () => {
    expect(runEtcScrapeTool.description).toMatch(/ログインし/);
    expect(runEtcScrapeTool.description).toMatch(/ログイン後のパス/);
    expect(runEtcScrapeTool.description).toMatch(/応答の ok は受け付けただけ/);
    expect(runEtcScrapeTool.description).toMatch(/数十秒〜1 分後/);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(runEtcScrapeTool.execute(env({ SCRAPER_RELAY: undefined }))).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(runEtcScrapeTool.execute(env({ INTERNAL_SHARED_SECRET: "" }))).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("relay の /kintai-relay/etc-run を {} で叩き、target を末尾 4 桁に伏せ detail を捨てて件数を返す", async () => {
    const payload = {
      results: [
        { kind: "etc", target: "fakeuser-0001", ok: true, detail: 'HTTP 202: {"accepted":true,"user_id":"fakeuser-0001"}' },
        { kind: "etc", target: "fakeuser-0002", ok: false, detail: "HTTP 500: boom" },
        { kind: "etc", target: "ab", ok: true, detail: "" },
        { kind: "etc", ok: true },
      ],
    };
    const e = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) } });
    const out = await runEtcScrapeTool.execute(e);
    expect(out).toEqual({
      total: 4,
      ok: 3,
      results: [
        { target: "*0001", ok: true },
        { target: "*0002", ok: false },
        { target: "(不明)", ok: true },
        { target: "(不明)", ok: true },
      ],
    });
    expect(JSON.stringify(out)).not.toContain("fakeuser");
    const [url, init] = relayOf(e).fetch.mock.calls[0]!;
    expect(url).toBe("https://relay.internal/kintai-relay/etc-run");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.headers["X-Alc-Proxy-Secret"]).toBe(SECRET);
  });

  it("results が無い応答は 0 件", async () => {
    expect(await runEtcScrapeTool.execute(env())).toEqual({ total: 0, ok: 0, results: [] });
    const e = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("null")) } });
    expect(await runEtcScrapeTool.execute(e)).toEqual({ total: 0, ok: 0, results: [] });
  });

  it("失敗 (全滅の 502・JSON でない応答) は本文を捨てて status だけ投げる (user_id を漏らさない)", async () => {
    const body = JSON.stringify({ results: [{ kind: "etc", target: "fakeuser-0001", ok: false, detail: "x" }] });
    const e502 = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(body, { status: 502 })) } });
    await expect(runEtcScrapeTool.execute(e502)).rejects.toThrow(/^relay: status 502$/);
    const eText = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("fakeuser-0001 not json")) } });
    await expect(runEtcScrapeTool.execute(eText)).rejects.toThrow(/^relay: parse failed$/);
  });

  it("Error でない例外もそのまま文字列にして投げる", async () => {
    const e = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => { throw "boom"; }) } });
    await expect(runEtcScrapeTool.execute(e)).rejects.toThrow(/^boom$/);
  });
});
