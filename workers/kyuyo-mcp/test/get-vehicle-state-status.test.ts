import { describe, it, expect, vi } from "vitest";
import { getVehicleStateStatusTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

/**
 * `get_vehicle_state_status` — 車輌動態取り込みの直近 1 回の結末を読む
 * (Refs ohishi-exp/nuxt-dtako-admin#1098)。
 *
 * ★ **read tool**。取得を起動せず theearth にもログインしないので `requiresScope` を
 * 持たない。**この tool が無かったせいで「取得が止まったのに誰も気づけない」が起きた**
 * のが #1098 なので、`last_success_at` が読めることを対照で固定する。
 */

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

describe("get_vehicle_state_status (Refs ohishi-exp/nuxt-dtako-admin#1098)", () => {
  it("**read tool — scope を要求しない** (取得を起動しない)", () => {
    // `requiresScope` を**持たない**ことを見る (型に無いので in で確かめる。
    // `get-driver-master-status.test.ts` と同じ手)。
    expect("requiresScope" in getVehicleStateStatusTool).toBe(false);
  });

  it("★ 説明文が「起動しない・ログインしない」ことを名指しする", () => {
    // run 側と取り違えて呼ばれると theearth を無駄に蹴る。説明の側を対照で固定する。
    expect(getVehicleStateStatusTool.description).toMatch(/読むだけ/);
    expect(getVehicleStateStatusTool.description).toMatch(/ログインもしない/);
    expect(getVehicleStateStatusTool.description).toMatch(/run_vehicle_state_sync/);
  });

  it("comp_id は任意・8桁の数字のみ・strict", () => {
    expect(getVehicleStateStatusTool.inputSchema.safeParse({}).success).toBe(true);
    expect(getVehicleStateStatusTool.inputSchema.safeParse({ comp_id: COMP_ID }).success).toBe(true);
    expect(getVehicleStateStatusTool.inputSchema.safeParse({ comp_id: "273244" }).success).toBe(false);
    expect(getVehicleStateStatusTool.inputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      getVehicleStateStatusTool.execute(env({ SCRAPER_RELAY: undefined }), {}),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      getVehicleStateStatusTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), {}),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("★ proof を付けて status を叩き、last_success_at まで素通しで返す", async () => {
    const payload = {
      results: [
        {
          comp_id: COMP_ID,
          last: {
            comp_id: COMP_ID,
            started_at: "2026-09-03T08:50:00.000Z",
            finished_at: "2026-09-03T08:50:12.000Z",
            ok: true,
            last_success_at: "2026-09-03T08:50:12.000Z",
            vehicles: 199,
            records_added: 199,
            total_records: 199,
            error: null,
          },
        },
      ],
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = (await getVehicleStateStatusTool.execute(e, { comp_id: COMP_ID })) as typeof payload;
    expect(got).toEqual(payload);
    // 無音故障の判定に要る 2 つが落ちていないこと
    expect(got.results[0].last.last_success_at).toBe("2026-09-03T08:50:12.000Z");
    expect(got.results[0].last.vehicles).toBe(199);

    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/vehicle-state-status");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ comp_id: COMP_ID });
  });

  it("comp_id 省略時は空 body を送る", async () => {
    const e = env();
    await getVehicleStateStatusTool.execute(e, {});
    expect(JSON.parse(relayOf(e).fetch.mock.calls[0]![1].body as string)).toEqual({});
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(getVehicleStateStatusTool.execute(bad, {})).rejects.toThrow(
      /relay: status 401: nope/,
    );
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(getVehicleStateStatusTool.execute(html, {})).rejects.toThrow(/parse failed/);
  });
});
