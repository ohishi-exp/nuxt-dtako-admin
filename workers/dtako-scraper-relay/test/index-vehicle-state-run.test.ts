import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { handleVehicleStateRun, type RelayWorkerEnv } from "../src/index";

/**
 * `POST /kintai-relay/vehicle-state-run` — 車輌動態の取得を cron を待たずに 1 回走らせる
 * 手動口 (Refs #1098)。
 *
 * ★ ここで測る本題は **cron と同じ DO route (`/cron/vehicle-state`) へ行く**こと。
 * 検証専用の別経路を作ると「手で叩くと通るのに cron では通らない」(逆も) が成立して
 * しまう (`handleDriverMasterRun` の doc と同じ理由)。
 *
 * ★★ **0 件を 200 で返さない**ことも本題。手で押した人に「200 だが何も起きていない」を
 * 返すと、`dtako-logs` が止まったままなのに成功に見える — #1098 の故障の再生産になる。
 */

const SECRET = "internal-shared-secret";
const VEHICLE_STATE_TARGETS = JSON.stringify([{ comp_id: "00000001" }]);
const ACCOUNTS = JSON.stringify([
  { comp_id: "00000001", user_name: "u1", user_pass: "p1", tenant_id: "t" },
  { comp_id: "00000002", user_name: "u2", user_pass: "p2", tenant_id: "t" },
]);

/** DO の `/cron/vehicle-state` が返す成功応答 (実物と同じ形)。 */
const DO_OK = JSON.stringify({
  ok: true,
  comp_id: "00000001",
  vehicles: 199,
  records_added: 199,
  total_records: 199,
  theearth_logins: 1,
  theearth_kicked: false,
});

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ doKey: string; url: string; body: unknown }> = [];
  const doFetch =
    (over.doFetch as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ doKey: "", url, body: init?.body });
      return new Response(DO_OK, { status: 200 });
    });
  const idFromName = vi.fn((name: string) => name);
  const env = {
    RELAY: { idFromName, get: vi.fn(() => ({ fetch: doFetch })) },
    INTERNAL_SHARED_SECRET: SECRET,
    DTAKO_ACCOUNTS: ACCOUNTS,
    VEHICLE_STATE_TARGETS,
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, idFromName, calls };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://relay.internal/kintai-relay/vehicle-state-run", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET, ...headers },
    body: JSON.stringify(body),
  });
}

const jsonOf = async (res: Response) => JSON.parse(await res.text());

describe("handleVehicleStateRun", () => {
  it("secret 不一致なら 401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleVehicleStateRun(post({}, { "X-Alc-Proxy-Secret": "wrong" }), env);
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("secret 未設定なら 503", async () => {
    const { env } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    expect((await handleVehicleStateRun(post({}), env)).status).toBe(503);
  });

  it("body が JSON でなければ 400", async () => {
    const { env } = fakeEnv();
    const req = new Request("https://relay.internal/kintai-relay/vehicle-state-run", {
      method: "POST",
      headers: { "X-Alc-Proxy-Secret": SECRET },
      body: "not json",
    });
    expect((await handleVehicleStateRun(req, env)).status).toBe(400);
  });

  it("★ cron と同じ DO route (/cron/vehicle-state) へ comp_id だけを渡す", async () => {
    const { env, doFetch, idFromName } = fakeEnv();
    const res = await handleVehicleStateRun(post({}), env);
    expect(res.status).toBe(200);
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["scraper-comp-00000001"]);
    const [url, init] = doFetch.mock.calls[0]!;
    expect(url).toBe("https://relay.internal/cron/vehicle-state");
    expect((init as RequestInit).method).toBe("POST");
    // body を素通ししない (余計なフィールドを DO へ運ばない)
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ comp_id: "00000001" });
  });

  it("★ 応答は cron の CronRunResult と同じ形 (Workers Logs の行と見比べられる)", async () => {
    const { env } = fakeEnv();
    expect(await jsonOf(await handleVehicleStateRun(post({}), env))).toEqual({
      results: [
        { kind: "vehicle-state", target: "00000001", ok: true, detail: `HTTP 200: ${DO_OK}` },
      ],
    });
  });

  it("★ 母集団は VEHICLE_STATE_TARGETS — DTAKO_ACCOUNTS 全社に倒さない", async () => {
    const { env, idFromName } = fakeEnv();
    await handleVehicleStateRun(post({}), env);
    // DTAKO_ACCOUNTS の 2 社目 (00000002) は走らせない
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["scraper-comp-00000001"]);
  });

  it("comp_id を明示したら設定に無い会社でもその 1 社を走らせる", async () => {
    const { env, idFromName } = fakeEnv();
    const res = await handleVehicleStateRun(post({ comp_id: " 00000002 " }), env);
    expect(res.status).toBe(200);
    expect(idFromName.mock.calls.map((c) => c[0])).toEqual(["scraper-comp-00000002"]);
  });

  it("★★ 対象 0 件は 404 で名指し — 手で押した人に「200 だが何も起きていない」を返さない", async () => {
    // cron 経路は同じ状態を `ok: true` の skip で返す (無人実行では「対象が無いのは正常」)。
    // 手動実行だけ意図的に振る舞いを変えている。
    const { env, doFetch } = fakeEnv({ VEHICLE_STATE_TARGETS: undefined });
    const res = await handleVehicleStateRun(post({}), env);
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error).toMatch(/VEHICLE_STATE_TARGETS が未設定です/);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("設定が壊れていたら 503 (「対象 0 件」の 404 と分ける)", async () => {
    const { env, doFetch } = fakeEnv({ VEHICLE_STATE_TARGETS: "{" });
    expect((await handleVehicleStateRun(post({}), env)).status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("★ 全社失敗のときだけ 502 (1 社でも通れば 200)", async () => {
    const failing = vi.fn(async () => new Response('{"ok":false,"error":"theearth 500"}', { status: 502 }));
    const res = await handleVehicleStateRun(post({}), fakeEnv({ doFetch: failing }).env);
    expect(res.status).toBe(502);
    expect((await jsonOf(res)).results[0]).toMatchObject({ ok: false });

    // 2 社中 1 社だけ成功 → 200
    let n = 0;
    const mixed = vi.fn(async () =>
      ++n === 1 ? new Response("boom", { status: 500 }) : new Response(DO_OK, { status: 200 }),
    );
    const two = fakeEnv({
      doFetch: mixed,
      VEHICLE_STATE_TARGETS: JSON.stringify([{ comp_id: "00000001" }, { comp_id: "00000002" }]),
    });
    expect((await handleVehicleStateRun(post({}), two.env)).status).toBe(200);
  });

  it("DO 呼び出しが例外でも 1 社に閉じて results に理由を載せる", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("binding down");
    });
    const res = await handleVehicleStateRun(post({}), fakeEnv({ doFetch: throwing }).env);
    expect(res.status).toBe(502);
    expect(await jsonOf(res)).toEqual({
      results: [
        { kind: "vehicle-state", target: "00000001", ok: false, detail: "binding down" },
      ],
    });
  });
});
