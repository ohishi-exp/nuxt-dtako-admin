import { describe, it, expect, vi } from "vitest";
import { getEtcAccountsTool, runEtcScrapeTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

/** `get_etc_accounts` (Refs ohishi-exp/nuxt-dtako-admin#1287)。user_tail はすべて架空値。 */

const SECRET = "internal-shared-secret";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ accounts: [], pick: { kind: "none", user_tail: null } }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };

describe("get_etc_accounts (Refs ohishi-exp/nuxt-dtako-admin#1287)", () => {
  it("★ read tool — scope を要求しない (ログインしないため)", () => {
    expect("requiresScope" in getEtcAccountsTool).toBe(false);
  });

  it("引数を取らない (未知の引数は弾く)", () => {
    expect(getEtcAccountsTool.inputSchema.safeParse({}).success).toBe(true);
    expect(getEtcAccountsTool.inputSchema.safeParse({ user_id: "x" }).success).toBe(false);
  });

  it("run_etc_scrape の説明が結果の読み口 (get_etc_accounts) を名指しする", () => {
    expect(runEtcScrapeTool.description).toMatch(/結果は get_etc_accounts で見る/);
  });

  it("★ proof を付けて GET /etc-card/accounts を叩き、応答をそのまま返す", async () => {
    const payload = {
      accounts: [
        {
          idx: 0,
          user_tail: "*iexp",
          account_type: "corporate",
          login_path: "/etc/R",
          menu_funccodes: ["1032000000", "1034000000"],
          last_scrape: { at: "2026-11-26T01:00:00.000Z", status: "success" },
        },
      ],
      pick: { kind: "found", user_tail: "*iexp" },
    };
    const e = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) } });
    expect(await getEtcAccountsTool.execute(e)).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/etc-card/accounts");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
  });

  it("relay の失敗は握り潰さない", async () => {
    const bad = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => new Response('{"error":"Unauthorized"}', { status: 401 })) } });
    await expect(getEtcAccountsTool.execute(bad)).rejects.toThrow(/relay: status 401/);
  });
});
