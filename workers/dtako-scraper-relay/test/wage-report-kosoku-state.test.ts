import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// wage-master-route-allowance-rate.test.ts と同じ手。`cloudflare:workers` は
// Workers ランタイムでしか解決できないので DurableObject を素のクラスで差し替え、
// **DtakoScraperRelayDO を実体化して本物の fetch() を叩く** — 応答に載る
// `timecard_kosoku` (Refs #980) を実コードの経路のまま固定するため。
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

const COMP_ID = "27324455";
const USER_B64 = "dmlld2Vy"; // "viewer"
const YM = "2026-07";
const PREV_YM = "2026-06";
const DRIVER = "1670";

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

function makeDO() {
  const env = {
    DTAKO_R2: new FakeR2(),
    RESTRAINT_DEV_VIEWER_COMP: COMP_ID,
    RESTRAINT_DEV_VIEWER_EMAIL: "viewer@example.com",
    // live-build が「配線未設定」で諦めないように 3 点を埋める
    NUXT_ICHIBAN_API_URL: "https://ichiban.invalid",
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid",
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: "csecret",
    // `source=gcp` 経路 (day_summaries) の配線。GCP 側は空 (この test が見るのは
    // 「kosoku を取りに行かない」ことだけ)
    DTAKO_ACCOUNTS: JSON.stringify([{ comp_id: COMP_ID, tenant_id: "tenant" }]),
    INTERNAL_SHARED_SECRET: "shared",
    AUTH_WORKER: { fetch: async () => Response.json({ summaries: {} }) },
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

/** `kosoku-daily` の全乗務員形 (`drivers` 配列)。 */
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

type UpstreamPlan = {
  /** 当月の kosoku-daily の返し方。 */
  kosokuCur?: "ok" | "error" | "unreadable";
  /** 前月の kosoku-daily の返し方。 */
  kosokuPrev?: "ok" | "error";
  /** 当月の /api/kintai/daily の返し方 (error = live-build ごと失敗)。 */
  dailyCur?: "ok" | "error";
};

/** 上流 (ichiban) を URL で振り分ける fetch。wage-source は常に落として R2
 * (空) へ倒す — この test が測るのは timecard 側だけ。 */
function stubUpstream(plan: UpstreamPlan) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/restraint/wage-source")) return new Response("nope", { status: 502 });
      if (url.includes("/api/kintai/daily")) {
        const ym = url.includes(PREV_YM) ? PREV_YM : YM;
        if (ym === YM && plan.dailyCur === "error") return new Response("nope", { status: 502 });
        return json(dailyBody(ym));
      }
      if (url.includes("/api/kintai/kosoku-daily")) {
        const ym = url.includes(PREV_YM) ? PREV_YM : YM;
        const mode = ym === YM ? (plan.kosokuCur ?? "ok") : (plan.kosokuPrev ?? "ok");
        if (mode === "error") return new Response("nope", { status: 502 });
        // 「形が読めない」= drivers も days も配列でない (Refs #960)
        if (mode === "unreadable") return json({ month: ym, driver: DRIVER, days: null });
        return json(kosokuBody(ym));
      }
      return new Response("unexpected", { status: 500 });
    }),
  );
}

async function wageReport(plan: UpstreamPlan, query = `month=${YM}`) {
  stubUpstream(plan);
  const res = await makeDO().fetch(req(query));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    timecard_kosoku: unknown;
    warnings: string[];
    rows: Array<{ source?: string }>;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-26T06:31:58Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GET /restraint-api/wage-report の timecard_kosoku (Refs #980)", () => {
  it('当月の kosoku-daily が 502 なら "no" — 打刻だけで組んだ表であることが応答から読める', async () => {
    const body = await wageReport({ kosokuCur: "error" });
    // ★ 直す前はこのキーごと存在せず、97 名ぶんの表が黙って 200 で返っていた
    expect(body.timecard_kosoku).toBe("no");
    // 表自体は返る (「拘束は打刻由来が正」の設計どおり止めない)
    expect(body.rows.filter((r) => r.source === "timecard")).toHaveLength(1);
  });

  it('前月だけ 502 なら "yes" — 前月の欠けで当月の表まで疑わせない', async () => {
    // ★ merge (`mergeKosokuShiftMaps`) は片方 null でももう一方を返すので、
    // 合成後の Map で判定すると**当月が落ちた時も "yes"** になる。判定は当月だけ
    const body = await wageReport({ kosokuPrev: "error" });
    expect(body.timecard_kosoku).toBe("yes");
  });

  it("両方取れたら \"yes\"", async () => {
    expect((await wageReport({})).timecard_kosoku).toBe("yes");
  });

  it('当月の応答が drivers でも days でもなければ "unreadable" (読み直しでは直らない)', async () => {
    expect((await wageReport({ kosokuCur: "unreadable" })).timecard_kosoku).toBe("unreadable");
  });

  it("source=gcp では null — kosoku-daily を取りに行っていないので「取れなかった」ではない", async () => {
    // ★ 最低賃金チェックタブの**既定が GCP** (restraint-wage.vue)。ここで "no" を
    // 返すと「取れなかったので打刻由来です」という嘘を、時間が GCP 由来に丸ごと
    // 差し替わった表に出すことになる
    const body = await wageReport({}, `month=${YM}&source=gcp`);
    expect(body.timecard_kosoku).toBeNull();
    // 上流の kosoku-daily を 1 度も叩いていないこと (= 判定材料が無い) を実測で示す
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const urls = calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/kintai/kosoku-daily"))).toBe(false);
  });

  it("live-build ごと失敗したら null — 「打刻だけで組まれた表」自体が存在しない", async () => {
    const body = await wageReport({ dailyCur: "error", kosokuCur: "error" });
    expect(body.timecard_kosoku).toBeNull();
    // 代わりに live 失敗の warning が出る (#606-5、こちらは既存)
    expect(body.warnings.some((w) => w.includes("live-build"))).toBe(true);
    expect(body.rows.filter((r) => r.source === "timecard")).toHaveLength(0);
  });
});
