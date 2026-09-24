import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// wage-report-kosoku-state.test.ts と同じ手。`cloudflare:workers` は Workers
// ランタイムでしか解決できないので DurableObject を素のクラスで差し替え、
// **DtakoScraperRelayDO を実体化して本物の fetch() を叩く** — 応答に載る
// `rows[].invariants` (Refs #1121-7) を実コードの経路のまま固定するため。
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

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { checkWageInvariants, type WageConfig } from "../src/restraint-wage";
import type { WageCategoryMinutes } from "../src/restraint-wage";
import type { RestraintDriverSummary } from "../src/theearth-restraint-client";

const COMP_ID = "27324455";
const USER_B64 = "dmlld2Vy"; // "viewer"
const YM = "2026-07";
const PREV_YM = "2026-06";
// ★ この repo は public。実在しうる乗務員CDを避け、明らかなプレースホルダを使う
// (kintai-ops skill の指示)。
const DRIVER = "9999";

/** この経路が使う口だけの R2 (どのキーも未投入 = theearth 側は 0 行)。 */
class FakeR2 {
  async get(_key: string) {
    return null;
  }
  async head(_key: string) {
    return null;
  }
  async put(_key: string, _body: unknown) {}
  async list({ prefix: _prefix }: { prefix: string }) {
    return { objects: [] as Array<{ key: string }>, truncated: false as const };
  }
}

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/** GCP `kintai.day-summaries` の応答形 (`parseGcpDaySummaries` が読む)。当月ぶんの
 * 1 日だけ、**実働 < 時間外** (`working=150 < overtime=400`) にして
 * `hasOvertimeClampedDay` を発火させる — `classifyMonth` の法定時間内クランプが
 * 起きる条件そのもの (`checkWageInvariants` の doc comment 参照)。この 1 日だけ
 * 見えるかどうかが A-3 (truncate 前の summary を渡しているか) の分水嶺になる。 */
function gcpDaySummariesBody(ym: string, withData: boolean) {
  if (!withData) return { summaries: {} };
  return {
    summaries: {
      [`${DRIVER}|${ym}-06|05:00`]: {
        restraint_minutes: 700,
        working_minutes: 150,
        break_minutes: 50,
        overtime_minutes: 400,
        overtime_night_minutes: 0,
        night_minutes: 0,
        legal_holiday_night_minutes: 0,
      },
    },
  };
}

function makeDO() {
  const env = {
    DTAKO_R2: new FakeR2(),
    RESTRAINT_DEV_VIEWER_COMP: COMP_ID,
    RESTRAINT_DEV_VIEWER_EMAIL: "viewer@example.com",
    // live-build が「配線未設定」で諦めないように 3 点を埋める
    NUXT_ICHIBAN_API_URL: "https://ichiban.invalid",
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid",
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: "csecret",
    // `source=gcp` 経路 (day_summaries) の配線
    DTAKO_ACCOUNTS: JSON.stringify([{ comp_id: COMP_ID, tenant_id: "tenant" }]),
    INTERNAL_SHARED_SECRET: "shared",
    AUTH_WORKER: {
      fetch: async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/api/kintai/day-summaries")) {
          const isPrev = url.includes(`month=${PREV_YM}`);
          return Response.json(gcpDaySummariesBody(isPrev ? PREV_YM : YM, !isPrev));
        }
        return new Response("unexpected", { status: 500 });
      },
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  return new DtakoScraperRelayDO(ctx as never, env as never);
}

function req(query: string) {
  return new Request(`https://relay.internal/restraint-api/wage-report?${query}`, {
    headers: { "X-Theearth-Comp-Id": COMP_ID, "X-Theearth-User-B64": USER_B64 },
  });
}

/** 打刻 1 日ぶん (この乗務員 1 名が timecard 由来の行になる)。 */
function dailyBody(ym: string) {
  return {
    rows: [
      {
        driver_id: Number(DRIVER),
        name: "テスト乗務員",
        date: `${ym}-06`,
        start: `${ym}-06 05:00:00`,
        end: `${ym}-06 17:00:00`,
        restraint_minutes: 720,
        sessions: [{ start: `${ym}-06 05:00:00`, end: `${ym}-06 17:00:00` }],
        holiday: "weekday",
        office: "本社",
      },
    ],
  };
}

/** `kosoku-daily` の全乗務員形 (`drivers` 配列)。source=current だけが叩く。 */
function kosokuBody(ym: string) {
  return {
    month: ym,
    drivers: [
      {
        driver: Number(DRIVER),
        days: [
          {
            date: `${ym}-06`,
            restraint_minutes: 600,
            working_minutes: 540,
            parts: [{ date: `${ym}-06`, restraint_minutes: 600, working_minutes: 540 }],
          },
        ],
      },
    ],
  };
}

/** 上流 (ichiban) を URL で振り分ける fetch。wage-source は常に落として R2 (空)
 * へ倒す — この test が測るのは timecard 側だけ。 */
function stubUpstream() {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/restraint/wage-source")) return new Response("nope", { status: 502 });
      if (url.includes("/api/kintai/daily")) {
        const ym = url.includes(PREV_YM) ? PREV_YM : YM;
        return json(dailyBody(ym));
      }
      if (url.includes("/api/kintai/kosoku-daily")) {
        const ym = url.includes(PREV_YM) ? PREV_YM : YM;
        return json(kosokuBody(ym));
      }
      return new Response("unexpected", { status: 500 });
    }),
  );
}

type WageReportBody = {
  config: WageConfig;
  rows: Array<{
    summary: RestraintDriverSummary;
    wage: { minutes: WageCategoryMinutes };
    invariants?: unknown;
  }>;
};

async function wageReport(query: string) {
  stubUpstream();
  const res = await makeDO().fetch(req(query));
  expect(res.status).toBe(200);
  return (await res.json()) as WageReportBody;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-26T06:31:58Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GET /restraint-api/wage-report の rows[].invariants (Refs #1121-7)", () => {
  it("既定経路 (source=current) — 応答の invariants は同じ入力で checkWageInvariants を直接呼んだ結果と一致する", async () => {
    const body = await wageReport(`month=${YM}`);
    const row = body.rows.find((r) => r.summary.driverCd === DRIVER);
    expect(row).toBeDefined();
    // ★ 既定経路では truncate が起きない (gcpOverlay が無い) ので、応答の summary
    // (days を保ったまま) がそのまま checkWageInvariants への入力と一致する
    const expected = checkWageInvariants(row!.summary, row!.wage.minutes, body.config);
    expect(row!.invariants).toEqual(expected);
  });

  it("source=gcp — invariants の判定は応答本文の summary.days が空でも truncate 前の summary を見ている (A-3)", async () => {
    const body = await wageReport(`month=${YM}&source=gcp`);
    const row = body.rows.find((r) => r.summary.driverCd === DRIVER);
    expect(row).toBeDefined();
    // ★ 既定の応答本文を変えないための truncate (2026-08-04 実測) — 応答の summary
    // 自体は days が空であることをまず確認する (この test の前提)
    expect(row!.summary.days).toEqual([]);

    // truncate 後の summary (= 応答の summary そのまま) を入力に checkWageInvariants
    // を呼び直すと、日別行が見えないので clamp を検出できず "other" になる
    const fromTruncated = checkWageInvariants(row!.summary, row!.wage.minutes, body.config);
    expect(fromTruncated.unaccounted?.diffMinutes).not.toBe(0);
    expect(fromTruncated.unaccounted?.kind).toBe("other");

    // ★★ これが A-3 を守る唯一の assertion: 応答の invariants は truncate 後の
    // summary からは導けない "clamp" を返している = ハンドラが truncate 前の
    // summary (GCP overlay 後、days を保ったまま) を checkWageInvariants に
    // 渡している証拠。ここを truncate 後の summary に差し替える regression が
    // 起きると、この行だけが "other" に落ちて test が失敗する。
    expect((row!.invariants as { unaccounted?: { kind?: string } } | undefined)?.unaccounted?.kind).toBe(
      "clamp",
    );

    // 残り 2 条件 (days に依存しない) は truncate の影響を受けないので、そのまま一致する
    expect((row!.invariants as { workingWithinRestraint?: boolean } | undefined)?.workingWithinRestraint).toBe(
      fromTruncated.workingWithinRestraint,
    );
    expect((row!.invariants as { restraintWithinDay?: boolean } | undefined)?.restraintWithinDay).toBe(
      fromTruncated.restraintWithinDay,
    );
  });
});
