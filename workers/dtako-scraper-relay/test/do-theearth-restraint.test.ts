import { afterEach, describe, expect, it, vi } from "vitest";

// do-driver-master-sync.test.ts と同じ手。`cloudflare:workers` は Workers ランタイムでしか
// 解決できないので、DurableObject を素のクラスで差し替えて DO を node vitest から読み込む。
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// theearth への HTTP とパースはこのテストの対象外 (theearth-restraint-client.test.ts が持つ)。
// ここで測るのは DO の配線: 会社の解決・無人ログイン・保存・応答の形。
vi.mock("../src/theearth-restraint-client", async (orig) => ({
  ...(await orig<typeof import("../src/theearth-restraint-client")>()),
  downloadRestraintCsv: vi.fn(),
  parseRestraintCsv: vi.fn(() => ({ maxRestraintHours: 275, drivers: [{ driverCd: "9901" }, { driverCd: "9902" }] })),
  summarizeRestraintDriver: vi.fn((d: { driverCd: string }, limit: number | null) => ({ driverCd: d.driverCd, limit })),
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { TheearthClientError } from "../src/theearth-client";
import { downloadRestraintCsv } from "../src/theearth-restraint-client";

/**
 * `POST /cron/theearth-restraint` — 拘束時間管理表を DTAKO_ACCOUNTS の資格情報で 1 か月ぶん
 * 取り込む無人の口。`dtako-scraper-relay-do.ts` は 100% gate の対象外なので、配線はここで押さえる。
 */

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

const COMP_ID = "00000002";
const ACCOUNTS = [{ comp_id: COMP_ID, tenant_id: "tenant-x", user_name: "u", user_pass: "p" }];

type Spies = {
  login: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  saveNoData: ReturnType<typeof vi.fn>;
  invalidate: ReturnType<typeof vi.fn>;
};

function makeDO(kicked = false): { call: (body: unknown) => Promise<Response>; spies: Spies } {
  const env = {
    DTAKO_CONFIG_KV: {
      get: async (key: string) => (key === "dtako_accounts" ? JSON.stringify(ACCOUNTS) : null),
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
    waitUntil: () => {},
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never) as unknown as Record<string, unknown>;
  const spies: Spies = {
    login: vi.fn(async (_account: unknown, jobState: { logins: unknown[] }, run: (jar: unknown) => Promise<unknown>) => {
      jobState.logins.push({ kicked, at: 0 });
      return run({ cookies: new Map() });
    }),
    save: vi.fn(async () => {}),
    saveNoData: vi.fn(async () => {}),
    invalidate: vi.fn(async () => {}),
  };
  relay.withTheearthLoginSession = spies.login;
  relay.saveRestraintToR2 = spies.save;
  relay.saveRestraintNoDataToR2 = spies.saveNoData;
  relay.invalidateKintaiUpstreamCache = spies.invalidate;
  const fetch = (relay as unknown as { fetch(req: Request): Promise<Response> }).fetch.bind(relay);
  const call = (body: unknown) =>
    fetch(
      new Request("https://relay.internal/cron/theearth-restraint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  return { call, spies };
}

afterEach(() => {
  vi.mocked(downloadRestraintCsv).mockReset();
});

describe("POST /cron/theearth-restraint", () => {
  it("全乗務員一括で 1 回取り、保存して上流キャッシュを当月・前月ぶん無効化する", async () => {
    const csv = { text: "csv", bytes: new ArrayBuffer(3) };
    vi.mocked(downloadRestraintCsv).mockResolvedValue(csv as never);
    const { call, spies } = makeDO();
    const res = await call({ comp_id: COMP_ID, month: "2026-08" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      comp_id: COMP_ID,
      month: "2026-08",
      no_data: false,
      drivers: 2,
      theearth_logins: 1,
      theearth_kicked: false,
    });
    expect(vi.mocked(downloadRestraintCsv).mock.calls[0]![1]).toEqual({
      year: 2026,
      month: 8,
      driverFrom: "",
      driverTo: "",
    });
    expect((spies.login.mock.calls[0]![0] as { comp_id: string }).comp_id).toBe(COMP_ID);
    expect(spies.save).toHaveBeenCalledWith(
      COMP_ID,
      { year: 2026, month: 8, driverFrom: "", driverTo: "" },
      csv.bytes,
      [
        { driverCd: "9901", limit: 275 * 60 },
        { driverCd: "9902", limit: 275 * 60 },
      ],
    );
    expect(spies.invalidate).toHaveBeenCalledWith(["2026-08", "2026-07"], "restraint-report");
    expect(spies.saveNoData).not.toHaveBeenCalled();
  });

  it("該当データ無しは 200 の no_data で、データなしとして記録する", async () => {
    vi.mocked(downloadRestraintCsv).mockResolvedValue(null);
    const { call, spies } = makeDO(true);
    const res = await call({ comp_id: COMP_ID, month: "2026-09" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      comp_id: COMP_ID,
      month: "2026-09",
      no_data: true,
      drivers: 0,
      theearth_logins: 1,
      theearth_kicked: true,
    });
    expect(spies.saveNoData).toHaveBeenCalledWith(COMP_ID, { year: 2026, month: 9, driverFrom: "", driverTo: "" });
    expect(spies.save).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON でない", "not json", "body must be JSON"],
    ["month 無し", { comp_id: COMP_ID }, "comp_id / month は必須です"],
    ["month の形が違う", { comp_id: COMP_ID, month: "2026-8" }, "month は YYYY-MM で指定してください"],
  ])("body が%sなら 400 (theearth に触らない)", async (_l, body, error) => {
    const { call, spies } = makeDO();
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(spies.login).not.toHaveBeenCalled();
  });

  it("DTAKO_ACCOUNTS に無い会社は 500 (theearth に触らない)", async () => {
    const { call, spies } = makeDO();
    const res = await call({ comp_id: "99999999", month: "2026-08" });
    expect(res.status).toBe(500);
    expect(spies.login).not.toHaveBeenCalled();
  });

  it("theearth の失敗は 502 で、文言とログイン回数を返す (保存しない)", async () => {
    vi.mocked(downloadRestraintCsv).mockRejectedValue(new TheearthClientError("CSV ボタンが見つかりません"));
    const { call, spies } = makeDO();
    const res = await call({ comp_id: COMP_ID, month: "2026-08" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "CSV ボタンが見つかりません", theearth_logins: 1, theearth_kicked: false });
    expect(spies.save).not.toHaveBeenCalled();
  });

  it("想定外の例外も 502 で、原因を文言に含める", async () => {
    vi.mocked(downloadRestraintCsv).mockRejectedValue(new Error("boom"));
    const { call } = makeDO();
    const res = await call({ comp_id: COMP_ID, month: "2026-08" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("boom");
  });
});
