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
/** 打刻も拘束時間管理表も無く、GCP の day_summaries にだけ居る乗務員 (営業所の乗務員の形)。 */
const GCP_ONLY_DRIVER = "9998";

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
function gcpDaySummariesBody(ym: string, withData: boolean, gcpOnlyDriver = false) {
  if (!withData) return { summaries: {} };
  return {
    summaries: {
      ...(gcpOnlyDriver
        ? {
            [`${GCP_ONLY_DRIVER}|${ym}-08|06:00`]: {
              restraint_minutes: 600,
              working_minutes: 480,
              break_minutes: 120,
              overtime_minutes: 0,
              overtime_night_minutes: 0,
              night_minutes: 0,
              legal_holiday_night_minutes: 0,
            },
          }
        : {}),
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

/** GCP の勤務の重なり (`/api/kintai/shift-overlaps`、上流が `kintai.shifts` を自己結合済み)。
 * 合計が 24h を超えないかぶり (05:00〜17:00 と 07:00〜19:00) を 1 組。 */
function shiftOverlapsBody(ym: string) {
  return {
    month: ym,
    items: [
      {
        driver_cd: Number(DRIVER),
        a_start: `${ym}-06 05:00:00`,
        a_end: `${ym}-06 17:00:00`,
        b_start: `${ym}-06 07:00:00`,
        b_end: `${ym}-06 19:00:00`,
      },
    ],
  };
}

function makeDO(opts: { shiftOverlaps?: () => Response; daySummariesEmpty?: boolean; gcpOnlyDriver?: boolean } = {}) {
  const env = {
    DTAKO_R2: new FakeR2(),
    RESTRAINT_DEV_VIEWER_COMP: COMP_ID,
    // 勤怠の対象会社 (本番 [vars] と同じ)。無いと打刻の live-build / source=gcp が止まる (Refs #1133 c1133-8)
    KINTAI_COMP_ID: COMP_ID,
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
        if (url.includes("/api/kintai/shift-overlaps")) {
          return opts.shiftOverlaps?.() ?? Response.json(shiftOverlapsBody(YM));
        }
        if (url.includes("/api/kintai/day-summaries")) {
          const isPrev = url.includes(`month=${PREV_YM}`);
          return Response.json(
            gcpDaySummariesBody(isPrev ? PREV_YM : YM, !isPrev && !opts.daySummariesEmpty, opts.gcpOnlyDriver),
          );
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
  it("既定経路 (source=current) — invariants を付けない (検証は GCP のときだけ、Refs #1123)", async () => {
    const body = await wageReport(`month=${YM}`);
    const row = body.rows.find((r) => r.summary.driverCd === DRIVER);
    expect(row).toBeDefined();
    // 行はある (陽性対照) が、キーごと無い — 「判定不能」の null とも区別する
    expect(row!.summary.days.length).toBeGreaterThan(0);
    expect("invariants" in row!).toBe(false);
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

    // 条件3 (Refs #1123) は勤務の重なりの組から判定する。組はハンドラが渡している
    // (summary から呼び直すと組を渡さないので判定不能になる)
    expect(fromTruncated.noShiftOverlap).toBeNull();
    const inv = row!.invariants as { noShiftOverlap?: boolean | null; shiftOverlap?: unknown } | undefined;
    expect(inv?.noShiftOverlap).toBe(false);
    expect(inv?.shiftOverlap).toEqual({ start: `${YM}-06 07:00`, end: `${YM}-06 17:00`, count: 1 });

    // 条件2 (days に依存しない) は truncate の影響を受けないので、そのまま一致する
    expect((row!.invariants as { workingWithinRestraint?: boolean } | undefined)?.workingWithinRestraint).toBe(
      fromTruncated.workingWithinRestraint,
    );
  });
});

describe("GET /restraint-api/wage-report?source=gcp の勤務の重なりの取得 (Refs #1123)", () => {
  const invOf = async (res: Response) => {
    expect(res.status).toBe(200);
    const body = (await res.json()) as WageReportBody;
    return body.rows.find((r) => r.summary.driverCd === DRIVER)?.invariants as
      | { noShiftOverlap: boolean | null; shiftOverlap: unknown }
      | undefined;
  };

  it("重なり (shift-overlaps) が落ちたら古い値に倒さず 502", async () => {
    stubUpstream();
    const res = await makeDO({ shiftOverlaps: () => new Response("boom", { status: 500 }) }).fetch(
      req(`month=${YM}&source=gcp`),
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/GCP shift-overlaps \(2026-07\)/);
  });

  it("その乗務員の組が 0 件なら条件3 は充足 (true・null)", async () => {
    stubUpstream();
    const inv = await invOf(
      await makeDO({ shiftOverlaps: () => Response.json({ month: YM, items: [] }) }).fetch(req(`month=${YM}&source=gcp`)),
    );
    expect(inv?.noShiftOverlap).toBe(true);
    expect(inv?.shiftOverlap).toBeNull();
  });

  it("GCP 欠測 (day_summaries にその乗務員の当月行が無い) なら、組があっても条件3 は判定不能 (null・null)", async () => {
    stubUpstream();
    const inv = await invOf(await makeDO({ daySummariesEmpty: true }).fetch(req(`month=${YM}&source=gcp`)));
    expect(inv?.noShiftOverlap).toBeNull();
    expect(inv?.shiftOverlap).toBeNull();
  });
});

describe("GET /restraint-api/wage-report?source=gcp — 元行が無く GCP にだけ居る乗務員", () => {
  const rowsOf = async (query: string) => {
    stubUpstream();
    const res = await makeDO({ gcpOnlyDriver: true }).fetch(req(query));
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        rows: Array<{ summary: RestraintDriverSummary; source?: string; restraint_missing?: boolean; invariants?: unknown }>;
      }
    ).rows;
  };

  it("★ source=gcp では GCP の勤務だけで行になり、source は gcp、不変条件が付く", async () => {
    const rows = await rowsOf(`month=${YM}&source=gcp`);
    const row = rows.find((r) => r.summary.driverCd === GCP_ONLY_DRIVER);
    expect(row).toBeDefined();
    expect(row!.source).toBe("gcp");
    expect(row!.restraint_missing).toBe(false);
    expect(row!.summary.restraintMinutes).toBe(600);
    expect(row!.summary.workingMinutes).toBe(480);
    expect(row!.invariants).toBeDefined();
    // 元行がある乗務員は従来どおり (timecard 由来) で、並びは乗務員CD 順
    expect(rows.map((r) => r.summary.driverCd)).toEqual([GCP_ONLY_DRIVER, DRIVER]);
    expect(rows.find((r) => r.summary.driverCd === DRIVER)!.source).toBe("timecard");
  });

  it("陰性対照: 既定経路 (source=current) では GCP にだけ居る乗務員は行にならない", async () => {
    const rows = await rowsOf(`month=${YM}`);
    expect(rows.some((r) => r.summary.driverCd === GCP_ONLY_DRIVER)).toBe(false);
    expect(rows.some((r) => r.summary.driverCd === DRIVER)).toBe(true);
  });
});
