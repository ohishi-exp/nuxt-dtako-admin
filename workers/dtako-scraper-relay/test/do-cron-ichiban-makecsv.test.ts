import { describe, expect, it, vi } from "vitest";

// do-scrape-alert.test.ts と同じ手。`cloudflare:workers` を素のクラスで差し替える。
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
 * `/cron/ichiban-makecsv` は画面と同じ 2 つの口 (`handleKintaiIchibanCheck` /
 * `handleKintaiIchibanMakecsv`) を呼ぶだけ。その 2 つを差し替えて、**読んだ突合の全行の運行を
 * 500 件ずつ書き出しへ渡し、件数を要約する**ことを固定する。
 */
type Priv = {
  fetch(req: Request): Promise<Response>;
  handleKintaiIchibanCheck: (record: { compId: string }, url: URL) => Promise<Response>;
  handleKintaiIchibanMakecsv: (record: { compId: string }, req: Request) => Promise<Response>;
};

/** 架空の突合 (勤怠 1 行・燃料 2 行。運行 id は 3 本、うち 1 本は 2 行に重複)。 */
const CHECK = {
  diffs: { 勤怠: { 運転: { "9001": { "2026-11-01": "8" } } }, 燃料: { "9002": { k1: 10, k2: 5 } } },
  ids: {
    勤怠: { 運転: { "9001": { "2026-11-01": ["2611010000001"] } } },
    燃料: { "9002": { k1: ["2611020000001", "2611030000001"], k2: ["2611030000001"] } },
  },
};

function makeDo(check: Response, makecsv: (ids: string[]) => Response) {
  const d = Object.create(DtakoScraperRelayDO.prototype) as Priv;
  const seen: Array<{ compId: string; month: string | null; ids?: string[] }> = [];
  d.handleKintaiIchibanCheck = async (record, url) => {
    seen.push({ compId: record.compId, month: url.searchParams.get("month") });
    return check;
  };
  d.handleKintaiIchibanMakecsv = async (record, req) => {
    const ids = ((await req.json()) as { ids: string[] }).ids;
    seen.push({ compId: record.compId, month: null, ids });
    return makecsv(ids);
  };
  return { d, seen };
}

function post(body: unknown): Request {
  return new Request("https://relay.internal/cron/ichiban-makecsv", { method: "POST", body: JSON.stringify(body) });
}

const written = (ids: string[]) =>
  Response.json({ results: ids.map((id) => ({ id, status: "written", written: [`${id}.csv`] })) });

describe("/cron/ichiban-makecsv", () => {
  it("突合の全行の運行 (重複なし) を書き出し、件数を 1 行で返す", async () => {
    const { d, seen } = makeDo(Response.json(CHECK), written);
    const res = await d.fetch(post({ comp_id: "27324455", month: "2026-11" }));
    expect(res.status).toBe(200);
    expect(seen[0]).toEqual({ compId: "27324455", month: "2026-11" });
    expect(seen[1]!.compId).toBe("27324455");
    expect(seen[1]!.ids).toEqual(["2611010000001", "2611020000001", "2611030000001"]);
    expect(await res.text()).toMatch(/^差分 3 行 \/ 運行 3 件 → 書き出した 3 件 \/ 飛ばした 0 件 \/ 失敗 0 件$/);
  });

  it("差が無ければ書き出しを呼ばず 0 件で成功", async () => {
    const { d, seen } = makeDo(Response.json({}), written);
    const res = await d.fetch(post({ comp_id: "27324455", month: "2026-11" }));
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(await res.text()).toBe("差分 0 行 / 運行 0 件 → 書き出した 0 件 / 飛ばした 0 件 / 失敗 0 件");
  });

  it("501 件は 500 + 1 に分けて送る", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => String(2611010000000 + i));
    const check = { diffs: { 燃料: { "1001": { x: 1 } } }, ids: { 燃料: { "1001": { x: ids } } } };
    const { d, seen } = makeDo(Response.json(check), written);
    const res = await d.fetch(post({ comp_id: "27324455", month: "2026-11" }));
    expect(res.status).toBe(200);
    expect(seen.slice(1).map((s) => s.ids!.length)).toEqual([500, 1]);
  });

  it("1 件でも書き出しに失敗があれば 502 (要約は返す)", async () => {
    const { d } = makeDo(Response.json(CHECK), (ids) =>
      Response.json({ results: ids.map((id, i) => ({ id, status: i === 0 ? "error" : "written", reason: "exception" })) }),
    );
    const res = await d.fetch(post({ comp_id: "27324455", month: "2026-11" }));
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("失敗 1 件");
  });

  it("突合が読めなければその応答をそのまま返す (書き出しは呼ばない)", async () => {
    const { d, seen } = makeDo(Response.json({ error: "一番星突合 API の取得に失敗しました" }, { status: 502 }), written);
    const res = await d.fetch(post({ comp_id: "27324455", month: "2026-11" }));
    expect(res.status).toBe(502);
    expect(seen).toHaveLength(1);
  });

  it("書き出しの口が失敗したら status を写し、どこまで書いたかを返す", async () => {
    const { d } = makeDo(Response.json(CHECK), () => Response.json({ error: "勤怠 Worker が 500 を返しました" }, { status: 502 }));
    const res = await d.fetch(post({ comp_id: "27324455", month: "2026-11" }));
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("運行 3 件のうち 0 件まで書き出した後に失敗");
  });

  it("comp_id / month が無ければ 400", async () => {
    const { d, seen } = makeDo(Response.json(CHECK), written);
    const res = await d.fetch(post({ comp_id: "27324455" }));
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
