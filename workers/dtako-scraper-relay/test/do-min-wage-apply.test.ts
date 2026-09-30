import { describe, expect, it, vi } from "vitest";

// do-min-wage-import.test.ts と同じ手 (cloudflare:workers を素のクラスで差し替える)。
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

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/**
 * POST /restraint-api/min-wage/apply-to-wage-master の driverCds / until (Refs #1133 c1133-21)。
 *
 * 判定そのもの (改定の拾い方・keep・no-branch) は restraint-wage.test.ts が 100% で押さえている。
 * DO ファイルは coverage gate の外なので、ここでは**配線**を測る: body の検証 (400)、
 * 社員マスタを 1 回読んで月ごとに所属を引き直すこと、所属が無い人で全体を 400 にしないこと、
 * dryRun は保存しないこと。値は全部架空 (県・額・乗務員)。
 */
const COMP = "10000001";

function makeR2(init: Record<string, unknown>) {
  const store = new Map<string, string>(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    bucket: {
      get: async (key: string) => (store.has(key) ? { text: async () => store.get(key)! } : null),
      head: async (key: string) => (store.has(key) ? { customMetadata: {} } : null),
      put: async (key: string, body: string | Uint8Array) => void store.set(key, typeof body === "string" ? body : new TextDecoder().decode(body)),
      delete: async (key: string) => void store.delete(key),
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false as const,
      }),
    },
  };
}

/** 9001 は 2025-01 に甲営業所 (架空県) → 乙営業所 (別県) へ異動。9002 は乗務員CD 無し。 */
function makeD1(employeesQueried: { n: number }, empty: boolean) {
  const employees = empty ? [] : [
    { company: "0200", payroll_cd: "1", name: "架空 一郎", driver_cd: "9001", hire_date: null, retire_date: null },
  ];
  const attrs = empty ? [] : [
    { company: "0200", payroll_cd: "1", effective_from: "2020-04-01", branch: "甲営業所", pay_scheme: null, branch_code: null, branch_name: null, job_name: null, pay_kubun: null },
    { company: "0200", payroll_cd: "1", effective_from: "2025-01-01", branch: "乙営業所", pay_scheme: null, branch_code: null, branch_name: null, job_name: null, pay_kubun: null },
  ];
  return {
    prepare: (sql: string) => ({
      bind: () => ({
        all: async () => {
          if (sql.includes("FROM employees ")) employeesQueried.n++;
          return { results: sql.includes("FROM employee_attrs") ? attrs : employees };
        },
      }),
    }),
  };
}

function makeDO({ emptyEmployees = false } = {}) {
  const r2 = makeR2({
    [`restraint/${COMP}/wage-master/latest.json`]: { drivers: {} },
    [`restraint/${COMP}/min-wage/latest.json`]: {
      prefectures: {
        架空県: [{ effectiveFrom: "2023-10-01", rate: 900 }, { effectiveFrom: "2024-10-05", rate: 950 }],
        別県: [{ effectiveFrom: "2024-09-01", rate: 970 }],
      },
      branchToPrefecture: { 甲営業所: "架空県", 乙営業所: "別県" },
    },
  });
  const queried = { n: 0 };
  const env = { RESTRAINT_DEV_VIEWER_COMP: COMP, DTAKO_R2: r2.bucket, DTAKO_DB: makeD1(queried, emptyEmployees) };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const post = (body: unknown) =>
    relay.fetch(
      new Request("https://relay.example/restraint-api/min-wage/apply-to-wage-master", {
        method: "POST",
        headers: { "X-Theearth-Comp-Id": COMP, "X-Theearth-User-B64": "dmlld2Vy", "content-type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
    );
  return { post, r2, queried };
}

describe("POST /restraint-api/min-wage/apply-to-wage-master (driverCds / until)", () => {
  it.each([
    [{ asOf: "2024-01-01", driverCds: "9001" }, "driverCds は空でない文字列の配列"],
    [{ asOf: "2024-01-01", driverCds: [] }, "driverCds は空でない文字列の配列"],
    [{ asOf: "2024-01-01", driverCds: ["9001", ""] }, "driverCds は空でない文字列の配列"],
    [{ asOf: "2024-01-01", driverCds: [9001] }, "driverCds は空でない文字列の配列"],
    [{ asOf: "2024-01-01", until: "2024/12/31" }, "until は asOf 以降"],
    [{ asOf: "2024-01-01", until: "2023-12-31" }, "until は asOf 以降"],
    [{ asOf: "2024-01-01", until: 20241231 }, "until は asOf 以降"],
    [{ asOf: "2024-01-01", until: "2024-12-31", overwrite: true }, "until と overwrite は同時に指定できません"],
  ])("不正な body は 400: %j", async (body, message) => {
    const { post, r2 } = makeDO();
    const before = new Map(r2.store);
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(message);
    expect(r2.store).toEqual(before);
  });

  it("★ dryRun: 期間中の改定を異動先の県も含めて返し、保存しない。社員マスタは 1 回だけ読む", async () => {
    const { post, r2, queried } = makeDO();
    const before = new Map(r2.store);
    const res = await post({ asOf: "2024-01-01", until: "2025-03-31", driverCds: ["9001"], dryRun: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { saved: boolean; until: string; added: number; items: { prefecture: string; rateEffectiveFrom: string; status: string }[] };
    expect(body).toMatchObject({ saved: false, until: "2025-03-31", added: 3 });
    expect(body.items.map((i) => [i.prefecture, i.rateEffectiveFrom, i.status])).toEqual([
      ["架空県", "2023-10-01", "add"],
      ["架空県", "2024-10-05", "add"],
      ["別県", "2024-09-01", "add"],
    ]);
    expect(queried.n).toBe(1);
    expect(r2.store).toEqual(before);
  });

  it("★ 確定: 単価マスタに 3 行入り、もう一度押すと keep (触らない)", async () => {
    const { post, r2 } = makeDO();
    const res = await post({ asOf: "2024-01-01", until: "2025-03-31", driverCds: ["9001"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ saved: true, added: 3 });
    const saved = JSON.parse(r2.store.get(`restraint/${COMP}/wage-master/latest.json`)!) as { drivers: Record<string, { name?: string; rates: unknown[] }> };
    // 別県の改定 (2024-09-01) は甲の最新改定 (2024-10-05) より古いので、異動した月の 1 日から入る
    expect(saved.drivers["9001"]!.rates).toEqual([
      { effectiveFrom: "2023-10-01", hourlyRate: 900, prefecture: "架空県" },
      { effectiveFrom: "2024-10-05", hourlyRate: 950, prefecture: "架空県" },
      { effectiveFrom: "2025-01-01", hourlyRate: 970, prefecture: "別県" },
    ]);
    expect(saved.drivers["9001"]!.name).toBe("架空 一郎");
    const again = (await (await post({ asOf: "2024-01-01", until: "2025-03-31", driverCds: ["9001"] })).json()) as { kept: number; added: number };
    expect(again).toMatchObject({ kept: 1, added: 0 });
  });

  it("★ 社員マスタに所属が 1 人も無くても、driverCds 指定なら 400 にせず no-branch を返す (driverCds 無しは従来どおり 400)", async () => {
    const { post } = makeDO({ emptyEmployees: true });
    const res = await post({ asOf: "2024-01-01", driverCds: ["9999"], dryRun: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unresolved: 1, items: [{ driverCd: "9999", status: "no-branch" }] });
    expect((await post({ asOf: "2024-01-01", dryRun: true })).status).toBe(400);
  });
});
