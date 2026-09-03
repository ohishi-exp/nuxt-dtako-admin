import { describe, it, expect, vi } from "vitest";
import { getDriverMasterStatusTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";
const COMP_ID = "27324455";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ results: [] }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };

describe("get_driver_master_status (Refs ippoan/alc-app-s3#125)", () => {
  it("★ read tool — scope を要求しない (同期を起動しないため)", () => {
    expect(getDriverMasterStatusTool.requiresScope).toBeUndefined();
  });

  it("comp_id は任意 (省略で全社)。8桁の数字以外は弾き、未知の引数も弾く", () => {
    expect(getDriverMasterStatusTool.inputSchema.safeParse({}).success).toBe(true);
    expect(getDriverMasterStatusTool.inputSchema.safeParse({ comp_id: COMP_ID }).success).toBe(true);
    expect(getDriverMasterStatusTool.inputSchema.safeParse({ comp_id: "2732445" }).success).toBe(false);
    expect(getDriverMasterStatusTool.inputSchema.safeParse({ comp_id: "2732445a" }).success).toBe(false);
    expect(getDriverMasterStatusTool.inputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      getDriverMasterStatusTool.execute(env({ SCRAPER_RELAY: undefined }), {}),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      getDriverMasterStatusTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), {}),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("★ proof を付けて driver-master-status を叩き、cron の結末をそのまま返す", async () => {
    const payload = {
      results: [
        {
          comp_id: COMP_ID,
          last: {
            comp_id: COMP_ID,
            trigger: "cron",
            started_at: "2026-09-02T22:00:03.000Z",
            finished_at: "2026-09-02T22:00:41.000Z",
            ok: true,
            rows: 242,
            items: 242,
            retired: 110,
            chunks: 1,
            created: 0,
            updated: 242,
            skipped: 1,
            error: null,
          },
        },
      ],
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });

    const got = await getDriverMasterStatusTool.execute(e, { comp_id: COMP_ID });

    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/driver-master-status");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ comp_id: COMP_ID });
  });

  it("comp_id 省略なら body は空 (relay 側が全社に広げる)", async () => {
    const e = env();
    await getDriverMasterStatusTool.execute(e, {});
    const init = relayOf(e).fetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(getDriverMasterStatusTool.execute(bad, {})).rejects.toThrow(/relay: status 401: nope/);
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(getDriverMasterStatusTool.execute(html, {})).rejects.toThrow(/parse failed/);
  });
});
