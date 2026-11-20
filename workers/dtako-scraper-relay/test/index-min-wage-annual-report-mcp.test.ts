import { afterEach, describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する。bare class で stub する (index-kintai-gcp-read.test.ts と同じ)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

// PDF 化 (Browser Rendering) は node で動かないので、渡された HTML を記録する stub に差し替える。
const pdfCalls: string[] = [];
vi.mock("../src/pdf-render", () => ({
  renderPdf: vi.fn(async (_binding: unknown, html: string) => {
    pdfCalls.push(html);
    return new TextEncoder().encode("%PDF-fake");
  }),
}));

import worker, { type RelayWorkerEnv } from "../src/index";
import { KYUYO_MCP_UNIDENTIFIED_MESSAGE } from "../src/kintai-relay";

/**
 * `GET /kintai-relay/min-wage-annual-report` — kyuyo-mcp から年間レポートの PDF を取る口 (#p414)。
 *
 * - 共有 secret だけでは開かない (同じ secret を etc-csv-web と front も持ち、front は `/kintai-relay/*` を素通しする)
 * - 呼び手の binding_jwt を auth-worker の `authorizeMcp` で検証してから組み立てる
 * - 門で落ちたら D1・勤怠 Worker・給与大臣・BROWSER のどれも呼ばない
 * - 通れば給与大臣へ同じ `Authorization` と `X-Kyuyo-Auth: mcp` を渡す
 *
 * 名前・金額・会社コードは架空。
 */
const SECRET = "internal-shared-secret";
const COMP_ID = "27324455";
const NAME = "架空 太郎";

interface Setup {
  /** `authorizeMcp` の応答 status (既定 200)。 */
  mcpStatus?: number;
  browser?: boolean;
  /** `false` で DTAKO_DB を置かない。`"empty"` は `results` の無い応答 (D1 の空)。 */
  db?: false | "empty";
  /** 勤怠 Worker の接続が落ちる。 */
  kintaiThrows?: boolean;
}

afterEach(() => {
  pdfCalls.length = 0;
  vi.restoreAllMocks();
});

function setup(opts: Setup = {}) {
  const d1: string[] = [];
  const kintaiCalls: string[] = [];
  const kyuyoCalls: Array<{ url: string; auth: string | null; mode: string | null }> = [];
  const mcpTokens: string[] = [];
  const browserTokens: string[] = [];
  const env = {
    INTERNAL_SHARED_SECRET: SECRET,
    KINTAI_COMP_ID: COMP_ID,
    DTAKO_ACCOUNTS: JSON.stringify([{ comp_id: COMP_ID, tenant_id: "tenant-x" }]),
    KINTAI: {
      fetch: vi.fn(async (url: string) => {
        kintaiCalls.push(url);
        if (opts.kintaiThrows) throw new TypeError("network down");
        return Response.json({
          months: [{ ym: "2025-01", saved: true }],
          rows: [
            {
              driver_cd: "0912",
              driver_name: NAME,
              by_month: { "2025-01": { calc_base: 100, calc_overtime: 0, calc_total: 100, paid_base: 90, paid_overtime: 0 } },
            },
          ],
        });
      }),
    },
    AUTH_KYUYO: {
      authorize: async (token: string) => (browserTokens.push(token), { status: 200, body: "", contentType: null }),
      authorizeMcp: async (token: string) => (
        mcpTokens.push(token), { status: opts.mcpStatus ?? 200, body: "", contentType: null }
      ),
    },
    ICHIBAN_KYUYO: {
      fetch: vi.fn(async (req: Request) => {
        kyuyoCalls.push({ url: req.url, auth: req.headers.get("authorization"), mode: req.headers.get("x-kyuyo-auth") });
        const bonus = req.url.includes("/kyuyo/bonus");
        return Response.json({
          database: "db",
          rows: bonus
            ? [{ employee_code: "0042", employee_code_key: "42", employee_name: NAME, pay_date: "2025-08-10", payments: { 就労調整金: 4 } }]
            : [],
        });
      }),
    },
    ...(opts.browser === false ? {} : { BROWSER: {} }),
    DTAKO_DB: opts.db === false ? undefined : {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => {
            d1.push(`${sql.split(" FROM ")[1]!.split(" ")[0]} ${args.join(",")}`);
            if (opts.db === "empty") return {};
            if (sql.includes("FROM employees")) {
              return { results: [{ company: "0100", payroll_cd: "0042", name: NAME, driver_cd: "0912" }] };
            }
            return { results: [{ payroll_company: "0100" }] };
          },
        }),
      }),
    },
  } as unknown as RelayWorkerEnv;
  const get = (query: string, headers: Record<string, string> = { "X-Alc-Proxy-Secret": SECRET, Authorization: "Bearer mcp-jwt" }) =>
    worker.fetch(new Request(`https://relay.internal/kintai-relay/min-wage-annual-report?${query}`, { headers }), env);
  /** 門の先 (D1・勤怠 Worker・給与大臣・BROWSER) へ届いた呼び出し。 */
  const downstream = () => ({ d1, kintaiCalls, kyuyoCalls, pdfCalls: [...pdfCalls] });
  return { get, downstream, mcpTokens, browserTokens };
}

const NOTHING = { d1: [], kintaiCalls: [], kyuyoCalls: [], pdfCalls: [] };
const Q = `comp_id=${COMP_ID}&driver=912&from_year=2025`;

describe("GET /kintai-relay/min-wage-annual-report の門 (#p414)", () => {
  it("★ secret だけ (トークン無し) は 401。auth-worker にも聞かず、下流は 1 本も呼ばない", async () => {
    const { get, downstream, mcpTokens } = setup();
    const res = await get(Q, { "X-Alc-Proxy-Secret": SECRET });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: KYUYO_MCP_UNIDENTIFIED_MESSAGE });
    expect(mcpTokens).toEqual([]);
    expect(downstream()).toEqual(NOTHING);
  });

  it("secret が違えば (トークンがあっても) 401 で、auth-worker にも下流にも届かない", async () => {
    const { get, downstream, mcpTokens } = setup();
    const res = await get(Q, { "X-Alc-Proxy-Secret": "wrong", Authorization: "Bearer mcp-jwt" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Unauthorized" });
    expect(mcpTokens).toEqual([]);
    expect(downstream()).toEqual(NOTHING);
  });

  it("★ トークン不正 (authorizeMcp が 401) は 401。下流は 1 本も呼ばない", async () => {
    const { get, downstream, mcpTokens, browserTokens } = setup({ mcpStatus: 401 });
    const res = await get(Q);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: KYUYO_MCP_UNIDENTIFIED_MESSAGE });
    // binding_jwt は authorizeMcp にだけ渡す (ブラウザ JWT の検証器 authorize は使わない)
    expect(mcpTokens).toEqual(["mcp-jwt"]);
    expect(browserTokens).toEqual([]);
    expect(downstream()).toEqual(NOTHING);
  });

  it("★ 名簿外 (authorizeMcp が 403) は 403。下流は 1 本も呼ばない", async () => {
    const { get, downstream } = setup({ mcpStatus: 403 });
    const res = await get(Q);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "給与の閲覧許可リストに無いアカウントです" });
    expect(downstream()).toEqual(NOTHING);
  });

  it("★ comp_id が KINTAI_COMP_ID でない (省略を含む) は 400。下流は 1 本も呼ばない", async () => {
    for (const q of ["comp_id=99999999&driver=912&from_year=2025", "driver=912&from_year=2025"]) {
      const { get, downstream } = setup();
      const res = await get(q);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "comp_id は勤怠の対象会社 (KINTAI_COMP_ID) だけを指定できます" });
      expect(downstream()).toEqual(NOTHING);
    }
  });

  it("driver 無しは 400、BROWSER が無ければ 503 (どちらも上流を読まない)", async () => {
    const a = setup();
    const r1 = await a.get(`comp_id=${COMP_ID}&from_year=2025`);
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: "PDF は driver (乗務員CD) の指定が必要です" });
    expect(a.downstream()).toEqual(NOTHING);

    const b = setup({ browser: false });
    const r2 = await b.get(Q);
    expect(r2.status).toBe(503);
    expect(b.downstream()).toEqual(NOTHING);
  });

  it("DTAKO_DB が無ければ 503、D1 が空なら会社対応表なしの 400、勤怠 Worker が落ちたら 502", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = setup({ db: false });
    const r1 = await a.get(Q);
    expect(r1.status).toBe(503);
    expect(await r1.json()).toEqual({ error: "社員マスタ (DTAKO_DB) が未設定です" });
    expect(a.downstream()).toEqual(NOTHING);

    const b = setup({ db: "empty" });
    const r2 = await b.get(Q);
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: string }).error).toContain("給与大臣の会社が登録されていません");
    expect(b.downstream().kyuyoCalls).toEqual([]);

    const c = setup({ kintaiThrows: true });
    const r3 = await c.get(Q);
    expect(r3.status).toBe(502);
    expect(await r3.json()).toEqual({ error: "最低賃金 年間レポートを作れませんでした: TypeError: network down" });
    expect(c.downstream().pdfCalls).toEqual([]);
  });

  it("★ 陽性: 正しいトークンなら PDF を返し、給与大臣へ Authorization と X-Kyuyo-Auth: mcp をそのまま渡す", async () => {
    const { get, downstream } = setup();
    // format=json を付けても PDF (この口は PDF だけ)
    const res = await get(`${Q}&format=json&source=gcp`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="min-wage-annual_912_2025.pdf"');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("%PDF-fake");
    const { d1, kintaiCalls, kyuyoCalls, pdfCalls } = downstream();
    expect(d1).toEqual([`employees ${COMP_ID}`, `comp_payroll_map ${COMP_ID}`]);
    expect(kintaiCalls).toHaveLength(1);
    expect(kintaiCalls[0]).toContain(`comp=${COMP_ID}`);
    expect(kintaiCalls[0]).toContain("source=gcp");
    expect(kintaiCalls[0]).not.toContain("comp_id=");
    expect(kyuyoCalls).toHaveLength(13); // 賞与 1 社 + 月例 12 か月
    expect(kyuyoCalls.every((c) => c.auth === "Bearer mcp-jwt" && c.mode === "mcp")).toBe(true);
    // PDF の HTML は乗務員CD と金額を持ち、氏名を持たない (応答は Claude に渡る。#374)
    expect(pdfCalls).toHaveLength(1);
    expect(pdfCalls[0]).toContain("乗務員CD 0912");
    expect(pdfCalls[0]).toContain("就労調整金");
    expect(pdfCalls[0]).not.toContain(NAME);
  });
});
