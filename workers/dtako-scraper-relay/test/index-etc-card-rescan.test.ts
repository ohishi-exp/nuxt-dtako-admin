import { describe, expect, it, vi } from "vitest";

// index.ts は DO を re-export しており、そちらが "cloudflare:workers" を import する
// (index-etc-card-register.test.ts と同じ手当て)。DO は instantiate しない。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { handleEtcCardRescan, type RelayWorkerEnv } from "../src/index";
import { SELECT_RESCAN_TARGET_SQL } from "../src/etc-card-register-run";

const SECRET = "internal-shared-secret";
const CARD = "0000111122223333"; // 架空値
const TARGET = { id: 3, card_number: CARD, plate4: "1234", registration_date: "2026-11-10", received_at: "2026-11-01T00:00:00.000Z", tenant_id: "tenant-a" };
const WAITING = [{ id: 3, card_number: CARD, plate4: "1234", run_date: null, registration_date: "2026-11-10", received_at: "2026-11-01T00:00:00.000Z" }];
const KUDGSIR = { headers: ["運行NO", "車輌CD", "終了日時", "ETC利用"], rows: [["111", "10001234", "2026/11/20 01:00:00", "1"]] };

/** D1 (行) と AUTH_WORKER (alc の内部用の口) の fake。 */
function fakeEnv(over: Partial<Record<string, unknown>> = {}, target: unknown[] = [TARGET]) {
  const writes: unknown[][] = [];
  const DTAKO_DB = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        all: async () => ({ results: sql === SELECT_RESCAN_TARGET_SQL ? target : WAITING }),
        run: async () => void writes.push(params),
      }),
    }),
  };
  const authFetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/api/internal/operations?")) {
      return Response.json({ operations: [{ unko_no: "111", vehicle_cd: "10001234" }], total: 1 });
    }
    if (url.endsWith("/api/internal/operations/111/csv/kudgsir")) return Response.json(KUDGSIR);
    return new Response("nope", { status: 500 });
  });
  const env = {
    INTERNAL_SHARED_SECRET: SECRET,
    DTAKO_DB,
    AUTH_WORKER: { fetch: authFetch },
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, authFetch, writes };
}

function post(body: string | undefined, secret = SECRET) {
  return new Request("https://relay.internal/etc-card/rescan", {
    method: "POST",
    headers: { "X-Alc-Proxy-Secret": secret },
    ...(body === undefined ? {} : { body }),
  });
}

describe("handleEtcCardRescan (POST /etc-card/rescan、Refs #1287)", () => {
  it("行の tenant で alc の運行と KUDGSIR を GET だけ読み、同期で結果を返す。ログ 1 行 (カードは末尾 5 桁)", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), toFake: ["Date"] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { env, authFetch, writes } = fakeEnv();
    const res = await handleEtcCardRescan(post('{"id":3,"tenant_id":"tenant-b"}'), env);
    vi.useRealTimers();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const out = { id: 3, kind: "found", run_date: "2026-11-20", operations: 1, skipped: 0, truncated: false, from: "2026-11-10", to: "2026-11-26" };
    expect(await res.json()).toEqual(out);
    // GET だけ・行の tenant (body の tenant_id は使わない)・共有秘密
    for (const [, init] of authFetch.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toEqual({ "X-Alc-Proxy-Secret": SECRET, "X-Tenant-ID": "tenant-a" });
    }
    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(writes).toHaveLength(1); // run_date / unko_no の UPDATE だけ
    const line = log.mock.calls.flat().map(String).find((l) => l.includes("etc-card-rescan"))!;
    expect(JSON.parse(line)).toEqual({ cron: "etc-card-rescan", status: "done", card: "*23333", ...out });
    expect(line).not.toContain(CARD);
    log.mockRestore();
  });

  it("走行が見つからなければ kind none / run_date null", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { env, authFetch } = fakeEnv();
    authFetch.mockImplementation(async () => Response.json({ operations: [], total: 0 }));
    const res = await handleEtcCardRescan(post('{"id":3}'), env);
    expect(await res.json()).toMatchObject({ kind: "none", run_date: null, operations: 0 });
    vi.restoreAllMocks();
  });

  it("探し直せる行が無ければ 404 で alc を叩かない", async () => {
    const { env, authFetch } = fakeEnv({}, []);
    const res = await handleEtcCardRescan(post('{"id":3}'), env);
    expect(res.status).toBe(404);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("alc の口が非 2xx なら 502 (本文の理由を返す)、それ以外の例外は 500。どちらもログに出す", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const up = fakeEnv();
    up.authFetch.mockImplementation(async () => new Response("down", { status: 503 }));
    const r1 = await handleEtcCardRescan(post('{"id":3}'), up.env);
    expect(r1.status).toBe(502);
    expect(await r1.json()).toEqual({ error: "運行の一覧を読めません (503): down" });

    const broken = fakeEnv();
    broken.authFetch.mockImplementation(async () => new Response("not json", { status: 200 }));
    expect((await handleEtcCardRescan(post('{"id":3}'), broken.env)).status).toBe(500);

    const thrown = fakeEnv();
    thrown.authFetch.mockImplementation(async () => {
      throw "plain";
    });
    const r3 = await handleEtcCardRescan(post('{"id":3}'), thrown.env);
    expect(r3.status).toBe(500);
    expect(await r3.json()).toEqual({ error: "plain" });
    expect(err.mock.calls.flat().join("\n")).toContain("etc-card-rescan");
    err.mockRestore();
  });

  it.each([
    ["secret 不一致", fakeEnv().env, post('{"id":1}', "wrong"), 401],
    ["INTERNAL_SHARED_SECRET 未設定", fakeEnv({ INTERNAL_SHARED_SECRET: undefined }).env, post('{"id":1}'), 503],
    ["ETC_CARD_REGISTER_MODE=off", fakeEnv({ ETC_CARD_REGISTER_MODE: "off" }).env, post('{"id":1}'), 503],
    ["JSON でない", fakeEnv().env, post("nope"), 400],
    ["id が文字列", fakeEnv().env, post('{"id":"1"}'), 400],
    ["body が null", fakeEnv().env, post("null"), 400],
    ["DTAKO_DB 未設定", fakeEnv({ DTAKO_DB: undefined }).env, post('{"id":1}'), 503],
    ["AUTH_WORKER 未設定", fakeEnv({ AUTH_WORKER: undefined }).env, post('{"id":1}'), 503],
  ])("%s は %i で alc を叩かない", async (_l, env, req, status) => {
    const res = await handleEtcCardRescan(req, env);
    expect(res.status).toBe(status);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("ETC_CARD_REGISTER_MODE=off は D1 も alc も読まない", async () => {
    const { env, authFetch } = fakeEnv({ ETC_CARD_REGISTER_MODE: "off" });
    expect(await (await handleEtcCardRescan(post('{"id":3}'), env)).json()).toEqual({
      error: "この環境では ETC カード追加登録を止めています (ETC_CARD_REGISTER_MODE=off)",
    });
    expect(authFetch).not.toHaveBeenCalled();
  });

  it("worker.fetch の POST /etc-card/rescan はこの handler に届く", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { env, authFetch } = fakeEnv();
    const res = await worker.fetch(post('{"id":3}'), env);
    expect(res.status).toBe(200);
    expect(authFetch).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
