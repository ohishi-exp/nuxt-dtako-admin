import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (node vitest では解決できない)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { handleVehicleStateStatus, type RelayWorkerEnv } from "../src/index";

/**
 * `POST /kintai-relay/vehicle-state-status` — 車輌動態 (`dtako_logs`) 取り込み cron の
 * 無音故障を読む口 (Refs #1098)。
 *
 * ★ ここで測る本題は **comp_id 省略時の母集団が `VEHICLE_STATE_TARGETS` である**こと。
 * `DTAKO_ACCOUNTS` 全社に倒すと、対象外の会社の DO からも `last: null` が返り、
 * **「止まっている」と「そもそも対象外」が見分けられなくなる**
 * (`index-dvr-status.test.ts` と同型)。
 *
 * ★★ **この口が無いこと自体が #1098 の再発**だった — cron は入ったのに結末を読む口が
 * 無く、「取得が止まっている」のか「表示が古い」のかが外から割れなかった。
 */

const SECRET = "internal-shared-secret";
const TENANT = "11111111-1111-1111-1111-111111111111";

/** 対象は 1 社だけ。DTAKO_ACCOUNTS には 2 社入っている (陰性対照)。 */
const VEHICLE_STATE_TARGETS = JSON.stringify([{ comp_id: "00000001" }]);
const ACCOUNTS = JSON.stringify([
  { comp_id: "00000001", user_name: "u1", user_pass: "p1", tenant_id: TENANT },
  { comp_id: "00000002", user_name: "u2", user_pass: "p2", tenant_id: TENANT },
]);

/** DO が 1 件だけ持つ結末 (`VehicleStateCronLastRun`)。 */
function lastRun(compId: string, over: Record<string, unknown> = {}) {
  return {
    comp_id: compId,
    started_at: "2026-09-03T09:59:00.000Z",
    finished_at: "2026-09-03T09:59:12.000Z",
    ok: true,
    last_success_at: "2026-09-03T09:59:12.000Z",
    vehicles: 199,
    records_added: 199,
    total_records: 199,
    error: null,
    ...over,
  };
}

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const doFetch =
    (over.doFetch as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async (url: string) => {
      // ★ 読む先が DVR ではなく車輌動態であること (path を取り違えると、DVR の
      // 結末を車輌動態の結末として読んでしまい、止まっているのに緑に見える)。
      expect(url).toBe("https://relay.internal/cron/vehicle-state/last");
      return new Response(JSON.stringify({ last: lastRun("00000001") }), { status: 200 });
    });
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) },
    INTERNAL_SHARED_SECRET: SECRET,
    DTAKO_ACCOUNTS: ACCOUNTS,
    VEHICLE_STATE_TARGETS,
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, idFromName };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://relay.internal/kintai-relay/vehicle-state-status", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET, ...headers },
    body: JSON.stringify(body),
  });
}

const jsonOf = async (res: Response) => JSON.parse(await res.text());

describe("handleVehicleStateStatus", () => {
  it("secret 不一致なら 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleVehicleStateStatus(post({}, { "X-Alc-Proxy-Secret": "wrong" }), env);
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("secret 未設定なら 503", async () => {
    const { env } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    expect((await handleVehicleStateStatus(post({}), env)).status).toBe(503);
  });

  it("body が JSON でなければ 400", async () => {
    const { env } = fakeEnv();
    const req = new Request("https://relay.internal/kintai-relay/vehicle-state-status", {
      method: "POST",
      headers: { "X-Alc-Proxy-Secret": SECRET },
      body: "not json",
    });
    expect((await handleVehicleStateStatus(req, env)).status).toBe(400);
  });

  it("★ comp_id 省略時の母集団は VEHICLE_STATE_TARGETS — DTAKO_ACCOUNTS 全社ではない", async () => {
    const { env, idFromName } = fakeEnv();
    const res = await handleVehicleStateStatus(post({}), env);
    expect(res.status).toBe(200);
    // 対象は 1 社。DTAKO_ACCOUNTS の 2 社目 (00000002) は読みにいかない
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["scraper-comp-00000001"]);
    expect(await jsonOf(res)).toEqual({
      results: [{ comp_id: "00000001", last: lastRun("00000001") }],
    });
  });

  it("★ 母集団は DVR_TARGETS でもない (2 つの cron は別設定)", async () => {
    // 相乗りしているのは cron の tick と DO だけで、**対象会社の設定は別**。
    // ここを取り違えると、DVR だけ設定されている状態で車輌動態が動いて見える。
    const { env, idFromName } = fakeEnv({
      VEHICLE_STATE_TARGETS: undefined,
      DVR_TARGETS: JSON.stringify([{ comp_id: "00000002" }]),
    });
    const res = await handleVehicleStateStatus(post({}), env);
    expect(res.status).toBe(200);
    expect(idFromName).not.toHaveBeenCalled();
    expect(await jsonOf(res)).toEqual({ results: [] });
  });

  it("comp_id を明示したらその 1 社だけ読む", async () => {
    const { env, idFromName } = fakeEnv();
    const res = await handleVehicleStateStatus(post({ comp_id: " 00000002 " }), env);
    expect(res.status).toBe(200);
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["scraper-comp-00000002"]);
  });

  it("VEHICLE_STATE_TARGETS が壊れていたら 503 (「1 社も無い」と同じ顔にしない)", async () => {
    const { env, doFetch } = fakeEnv({ VEHICLE_STATE_TARGETS: "{" });
    const res = await handleVehicleStateStatus(post({}), env);
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("DO が非 2xx / 例外でも 200 で results に理由を載せる", async () => {
    const failing = vi.fn(async () => new Response("boom", { status: 500 }));
    const res = await handleVehicleStateStatus(post({}), fakeEnv({ doFetch: failing }).env);
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual({
      results: [{ comp_id: "00000001", last: null, error: "HTTP 500: boom" }],
    });

    const throwing = vi.fn(async () => {
      throw new Error("binding down");
    });
    expect(
      await jsonOf(await handleVehicleStateStatus(post({}), fakeEnv({ doFetch: throwing }).env)),
    ).toEqual({
      results: [{ comp_id: "00000001", last: null, error: "binding down" }],
    });
  });

  it("まだ 1 度も走っていない DO は last: null で返る (エラーではない)", async () => {
    // ★ 「まだ走っていない」と「走ったが失敗した」を混ぜない。後者は last.ok=false で
    // 返り、last_success_at が前回のまま据え置かれる。
    const empty = vi.fn(async () => new Response(JSON.stringify({ last: null }), { status: 200 }));
    expect(
      await jsonOf(await handleVehicleStateStatus(post({}), fakeEnv({ doFetch: empty }).env)),
    ).toEqual({ results: [{ comp_id: "00000001", last: null }] });
  });

  it("★ 失敗した回は ok=false + last_success_at 据え置きで読める (無音故障の判定材料)", async () => {
    const failed = vi.fn(async () =>
      new Response(
        JSON.stringify({
          last: lastRun("00000001", {
            ok: false,
            vehicles: 0,
            records_added: null,
            total_records: null,
            last_success_at: "2026-09-03T07:20:00.000Z",
            error: "VehicleStateIngestError: 車輌が 1 台も取れませんでした (空バッチは送りません)",
          }),
        }),
        { status: 200 },
      ),
    );
    const body = await jsonOf(await handleVehicleStateStatus(post({}), fakeEnv({ doFetch: failed }).env));
    expect(body.results[0].last.ok).toBe(false);
    // 「最後に成功したのはいつか」が読めることが、この口の存在理由そのもの。
    expect(body.results[0].last.last_success_at).toBe("2026-09-03T07:20:00.000Z");
  });
});
