import { afterEach, describe, expect, it, vi } from "vitest";

// do-theearth-restraint.test.ts と同じ手。DurableObject を素のクラスで差し替えて node vitest から読む。
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

// 勤怠 Worker への往復・管理表の CSV・.spd の中身はこのテストの対象外 (それぞれの単体テストが持つ)。
// ここで測るのは DO の配線: 候補 → 休息 → NET780 (アーカイブ済み / theearth) → 補正 → apply のときだけ書いて畳む。
vi.mock("../src/kintai-relay", async (orig) => ({
  ...(await orig<typeof import("../src/kintai-relay")>()),
  relayKintaiDaySummaries: vi.fn(),
  relayKintaiAlcEvents: vi.fn(),
  kintaiRestStartWriter: vi.fn(async () => ({ gcp: vi.fn() })),
  putKintaiRestStartOverrides: vi.fn(async (_d: unknown, items: unknown[]) => ({ written: items.length })),
  foldMonth: vi.fn(async () => ({ month: "2026-07", pages: 1, driversWritten: 1, attemptedGateClose: true, capped: false })),
}));
vi.mock("../src/theearth-restraint-client", async (orig) => ({
  ...(await orig<typeof import("../src/theearth-restraint-client")>()),
  parseRestraintCsv: vi.fn(),
}));
vi.mock("../src/net780-spd", async (orig) => ({
  ...(await orig<typeof import("../src/net780-spd")>()),
  spdFromZip: vi.fn(async () => new Uint8Array(1)),
  parseSpd: vi.fn(() => []),
  lastMovementBefore: vi.fn(),
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import {
  foldMonth,
  kintaiRestStartWriter,
  putKintaiRestStartOverrides,
  relayKintaiAlcEvents,
  relayKintaiDaySummaries,
} from "../src/kintai-relay";
import { lastMovementBefore, wallSeconds } from "../src/net780-spd";
import { parseRestraintCsv } from "../src/theearth-restraint-client";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair = class {
  constructor(_req: string, _res: string) {}
};

const COMP_ID = "75700192";
const ACCOUNTS = [{ comp_id: COMP_ID, tenant_id: "tenant-h", user_name: "u", user_pass: "p" }];
const UNKO = "2607150330460000000233";

/** 管理表: 乗務員 11 の 7/17 05:17 (拘束小計 744・実働 680) と、差の無い 7/18。 */
const REPORT = {
  year: 2026,
  month: 7,
  drivers: [
    {
      driverCd: "11",
      header: ["日付", "始業時刻", "拘束時間小計"],
      days: [
        { day: 17, isRestDay: false, startTime: "5:17", workingMinutes: 680, columns: ["", "", "12:24"] },
        { day: 18, isRestDay: false, startTime: "6:02", workingMinutes: 398, columns: ["", "", "7:11"] },
      ],
    },
  ],
};
const DAYS = {
  summaries: {
    "11|2026-07-17|2026-07-17 05:17:00": { restraint_minutes: 745, working_minutes: 681 },
    "11|2026-07-18|2026-07-18 06:02:00": { restraint_minutes: 431, working_minutes: 398 },
  },
};
const ALC = {
  shifts: [{ start: "2026-07-17 05:17:00", end: "2026-07-18 02:26:00" }],
  events: [{ datetime: "2026-07-18 02:26:53", state: "休息", unko_no: UNKO }],
};

function makeDO(opts: { csv?: boolean; archived?: boolean } = {}) {
  const env = {
    DTAKO_CONFIG_KV: { get: async (key: string) => (key === "dtako_accounts" ? JSON.stringify(ACCOUNTS) : null) },
    DTAKO_R2: {
      get: vi.fn(async (key: string) =>
        opts.csv === false || key !== `restraint/${COMP_ID}/2026-07/csv/all/latest.csv`
          ? null
          : { arrayBuffer: async () => new ArrayBuffer(1) },
      ),
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
    waitUntil: () => {},
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never) as unknown as Record<string, unknown>;
  const spies = {
    archived: vi.fn(async () => (opts.archived ? new ArrayBuffer(2) : null)),
    search: vi.fn(async (_a: unknown, jobState: { logins: unknown[] }, _item: unknown, _index: number) => {
      jobState.logins.push({ kicked: false, at: 0 });
      return { ope_no: UNKO, status: "archived", bytes: 3, zip: new ArrayBuffer(3) };
    }),
  };
  relay.buildKintaiRelayContext = vi.fn(async () => ({ deps: { gcp: vi.fn() }, reader: {}, writeToken: "wt" }));
  relay.archivedNet780Zip = spies.archived;
  relay.searchAndArchiveNet780 = spies.search;
  const fetch = (relay as unknown as { fetch(req: Request): Promise<Response> }).fetch.bind(relay);
  const call = (body: unknown) =>
    fetch(
      new Request("https://relay.internal/cron/rest-start-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  return { call, spies, env };
}

function arrange(lastMove: string | null) {
  vi.mocked(parseRestraintCsv).mockReturnValue(REPORT as never);
  vi.mocked(relayKintaiDaySummaries).mockResolvedValue(DAYS);
  vi.mocked(relayKintaiAlcEvents).mockResolvedValue(ALC);
  vi.mocked(lastMovementBefore).mockReturnValue(lastMove === null ? null : wallSeconds(lastMove));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /cron/rest-start-sync", () => {
  it("既定は書かない: 候補 → 休息 → theearth の NET780 → 補正を返すだけ", async () => {
    arrange("2026-07-18 02:25:58");
    const { call, spies } = makeDO();
    const res = await call({ comp_id: COMP_ID, month: "2026-07" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      comp_id: COMP_ID,
      month: "2026-07",
      apply: false,
      candidates: 1,
      written: null,
      fold: null,
      theearth_logins: 1,
      theearth_kicked: false,
      overrides: [{ driver_cd: 11, rest_start_at: "2026-07-18 02:26:53", last_move_at: "2026-07-18 02:25:58", unko_no: UNKO }],
    });
    expect(body.results).toEqual([
      expect.objectContaining({ driverCd: "11", start: "2026-07-17 05:17", status: "override", last_move_at: "2026-07-18 02:25:58" }),
    ]);
    expect(vi.mocked(relayKintaiAlcEvents).mock.calls[0]![1]).toEqual({ driver: "11", from: "2026-06-29", to: "2026-08-02" });
    expect(spies.search.mock.calls[0]![2]).toEqual({ opeNo: UNKO, startOpe: "2026/07/15 3:30:46" });
    expect(putKintaiRestStartOverrides).not.toHaveBeenCalled();
    expect(foldMonth).not.toHaveBeenCalled();
  });

  it("apply: アーカイブ済みの zip を使い、補正を書いて月を畳み直す", async () => {
    arrange("2026-07-18 02:25:58");
    const { call, spies } = makeDO({ archived: true });
    const body = (await (await call({ comp_id: COMP_ID, month: "2026-07", apply: true })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ apply: true, written: 1, theearth_logins: 0, fold: { driversWritten: 1 } });
    expect(spies.search).not.toHaveBeenCalled();
    expect(kintaiRestStartWriter).toHaveBeenCalledWith(expect.anything(), COMP_ID, ACCOUNTS, expect.any(Function));
    expect(vi.mocked(foldMonth).mock.calls[0]![1]).toEqual({ month: "2026-07", apply: true });
  });

  it("最後の動きが同じ分なら補正しない (apply でも書かない)", async () => {
    arrange("2026-07-18 02:26:40");
    const { call } = makeDO({ archived: true });
    const body = (await (await call({ comp_id: COMP_ID, month: "2026-07", apply: true })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ overrides: [], written: null });
    expect(body.results).toEqual([expect.objectContaining({ status: "same_minute" })]);
    expect(putKintaiRestStartOverrides).not.toHaveBeenCalled();
  });

  it("候補の勤務が休息で締まっていなければ NET780 に行かない", async () => {
    arrange(null);
    vi.mocked(relayKintaiAlcEvents).mockResolvedValue({ shifts: [], events: [] });
    const { call, spies } = makeDO();
    const body = (await (await call({ comp_id: COMP_ID, month: "2026-07" })).json()) as Record<string, unknown>;
    expect(body.results).toEqual([expect.objectContaining({ status: "no_closing_rest" })]);
    expect(spies.archived).not.toHaveBeenCalled();
  });

  it("CSV が無ければ 404、入力が壊れていれば 400", async () => {
    const { call } = makeDO({ csv: false });
    expect((await call({ comp_id: COMP_ID, month: "2026-07" })).status).toBe(404);
    expect((await call({ comp_id: COMP_ID, month: "2026-7" })).status).toBe(400);
    expect((await call("x")).status).toBe(400);
  });
});
