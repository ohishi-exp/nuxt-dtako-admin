import { describe, it, expect, vi } from "vitest";
import { runDriverMasterSyncTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";
const COMP_ID = "27324455";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };
const baseArgs = { comp_id: COMP_ID };

describe("run_driver_master_sync (Refs ippoan/alc-app-s3#125)", () => {
  it("**write tool として scope を要求する** — read tool と同じ扱いにしない", () => {
    expect(runDriverMasterSyncTool.requiresScope).toBe("mcp.write");
  });

  it("comp_id は必須 (省略値は無い)", () => {
    expect(runDriverMasterSyncTool.inputSchema.safeParse(baseArgs).success).toBe(true);
    expect(runDriverMasterSyncTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("comp_id は8桁の数字のみ通す (形式不正は弾く)", () => {
    expect(runDriverMasterSyncTool.inputSchema.safeParse({ comp_id: "2732445" }).success).toBe(
      false,
    ); // 7桁
    expect(runDriverMasterSyncTool.inputSchema.safeParse({ comp_id: "273244556" }).success).toBe(
      false,
    ); // 9桁
    expect(runDriverMasterSyncTool.inputSchema.safeParse({ comp_id: "2732445a" }).success).toBe(
      false,
    ); // 数字以外混入
  });

  it("未知の引数は弾く (strict)", () => {
    expect(
      runDriverMasterSyncTool.inputSchema.safeParse({ ...baseArgs, extra: 1 }).success,
    ).toBe(false);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runDriverMasterSyncTool.execute(env({ SCRAPER_RELAY: undefined }), baseArgs),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runDriverMasterSyncTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), baseArgs),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/driver-master-run を叩き、応答をそのまま返す", async () => {
    const payload = {
      ok: true,
      comp_id: COMP_ID,
      rows: 10,
      items: 10,
      created: 2,
      updated: 7,
      skipped: [{ code: "1234", reason: "nfc_id_conflict" }],
      unreadable: null,
      theearth_logins: 1,
      theearth_kicked: false,
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await runDriverMasterSyncTool.execute(e, baseArgs);
    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/driver-master-run");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ comp_id: COMP_ID });
  });

  it("★ 失敗本文は 200 文字で切らない (comp ごとの理由が読める長さまで載せる)", async () => {
    // 2026-09-03: comp 75700192 の失敗理由が 200 文字で切れ、切り分けに詰まった。
    // relay は `{results:[{...,error}]}` を返し、その error に一覧の構造要約まで載る。
    const detail = JSON.stringify({
      results: [{ comp_id: "75700192", status: 502, error: `HTTP 502: ${"の".repeat(600)}` }],
    });
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(detail, { status: 502 })) },
    });
    await expect(runDriverMasterSyncTool.execute(e, baseArgs)).rejects.toThrow(
      new RegExp(`${"の".repeat(300)}`),
    );
  });

  it("relay の失敗と非 JSON は握り潰さない (status と本文抜粋を名指しする)", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(runDriverMasterSyncTool.execute(bad, baseArgs)).rejects.toThrow(
      /relay: status 401: nope/,
    );
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(runDriverMasterSyncTool.execute(html, baseArgs)).rejects.toThrow(
      /parse failed/,
    );
  });
});
