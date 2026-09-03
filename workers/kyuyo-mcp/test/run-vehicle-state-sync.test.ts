import { describe, it, expect, vi } from "vitest";
import { runVehicleStateSyncTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

/**
 * `run_vehicle_state_sync` — 車輌動態の取得を cron を待たずに 1 回走らせる
 * (Refs ohishi-exp/nuxt-dtako-admin#1098)。
 *
 * ★ **write tool**。alc の `dtako_logs` へ書き、かつ **1 呼び出しで theearth へ
 * ログインする** (同時ログイン制約 #233 の観点でも read と同じ扱いにしない)。
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

describe("run_vehicle_state_sync (Refs ohishi-exp/nuxt-dtako-admin#1098)", () => {
  it("**write tool として scope を要求する** — read tool と同じ扱いにしない", () => {
    expect(runVehicleStateSyncTool.requiresScope).toBe("mcp.write");
  });

  it("comp_id は任意 (省略すると relay の VEHICLE_STATE_TARGETS に委ねる)", () => {
    expect(runVehicleStateSyncTool.inputSchema.safeParse({}).success).toBe(true);
    expect(runVehicleStateSyncTool.inputSchema.safeParse({ comp_id: COMP_ID }).success).toBe(true);
  });

  it("comp_id は8桁の数字のみ通す (形式不正は弾く)", () => {
    expect(runVehicleStateSyncTool.inputSchema.safeParse({ comp_id: "2732445" }).success).toBe(false);
    expect(runVehicleStateSyncTool.inputSchema.safeParse({ comp_id: "273244556" }).success).toBe(false);
    expect(runVehicleStateSyncTool.inputSchema.safeParse({ comp_id: "2732445a" }).success).toBe(false);
  });

  it("未知の引数は弾く (strict)", () => {
    expect(runVehicleStateSyncTool.inputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it("★ 説明文が「theearth へログインする」ことを名指しする (連打の抑止)", () => {
    // tool 説明が実装と食い違って実作業を止めた前例があるので、説明の側を対照で固定する。
    // 実装は relay の /kintai-relay/vehicle-state-run → DO の /cron/vehicle-state →
    // runVehicleStateCron の withTheearthLoginSession で実際にログインする。
    expect(runVehicleStateSyncTool.description).toMatch(/theearth へ実際にログインする/);
    expect(runVehicleStateSyncTool.description).toMatch(/連打/);
    // 「まず status を読め」の誘導も落とさない
    expect(runVehicleStateSyncTool.description).toMatch(/get_vehicle_state_status/);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runVehicleStateSyncTool.execute(env({ SCRAPER_RELAY: undefined }), {}),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runVehicleStateSyncTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), {}),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/vehicle-state-run を叩き、応答をそのまま返す", async () => {
    const payload = {
      results: [
        {
          kind: "vehicle-state",
          target: COMP_ID,
          ok: true,
          detail: 'HTTP 200: {"ok":true,"vehicles":199,"records_added":199}',
        },
      ],
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    expect(await runVehicleStateSyncTool.execute(e, { comp_id: COMP_ID })).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/vehicle-state-run");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ comp_id: COMP_ID });
  });

  it("comp_id 省略時は空 body を送る (勝手に既定値を捏造しない)", async () => {
    const e = env();
    await runVehicleStateSyncTool.execute(e, {});
    expect(JSON.parse(relayOf(e).fetch.mock.calls[0]![1].body as string)).toEqual({});
  });

  it("★ 失敗本文は 200 文字で切らない (comp ごとの理由が読める長さまで載せる)", async () => {
    const detail = JSON.stringify({
      results: [{ kind: "vehicle-state", target: COMP_ID, ok: false, detail: "の".repeat(600) }],
    });
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(detail, { status: 502 })) },
    });
    await expect(runVehicleStateSyncTool.execute(e, {})).rejects.toThrow(
      new RegExp(`${"の".repeat(300)}`),
    );
  });

  it("relay の失敗と非 JSON は握り潰さない (status と本文抜粋を名指しする)", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 404 })) },
    });
    await expect(runVehicleStateSyncTool.execute(bad, {})).rejects.toThrow(/relay: status 404: nope/);
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(runVehicleStateSyncTool.execute(html, {})).rejects.toThrow(/parse failed/);
  });
});
