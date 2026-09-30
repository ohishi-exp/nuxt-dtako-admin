import { afterEach, describe, expect, it, vi } from "vitest";

// do-restraint-viewer-all-comps.test.ts と同じ手 (cloudflare:workers を素のクラスで差し替える)。
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
import { MHLW_REVISION_INDEX_URL } from "../src/min-wage-import";
import nationalListHtml from "./fixtures/mhlw-nationallist-2025.html?raw";
import xlsxBase64 from "./fixtures/mhlw-minwage-history.xlsx.b64?raw";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/**
 * POST /restraint-api/min-wage/import-mhlw の `{source:"history"}` 経路 (Refs #1133 c1133-20)。
 *
 * 分岐の判定そのもの (リンク抽出・zip・シート解析) は min-wage-import.test.ts が 100% で
 * 押さえている。DO ファイルは coverage gate の外なので、ここでは**配線**を測る:
 * 400 と 502 の写像、取得先の固定、UA の明示、R2 への保存。
 * 厚労省へは繋がない (global fetch を差し替える)。R2 は in-memory。
 */
const COMP = "27324455";
const XLSX = Uint8Array.from(atob(xlsxBase64.trim()), (c) => c.charCodeAt(0));
const NATIONAL_LIST_HTML = nationalListHtml;
const XLSX_HREF = "/content/11200000/001753407.xlsx";
const INDEX_HTML = `<a href="${XLSX_HREF}">平成14年度から令和８年度までの地域別最低賃金改定状況［29KB］</a>`;

function makeR2() {
  const store = new Map<string, { body: Uint8Array; meta: Record<string, string> }>();
  const bucket = {
    get: async (key: string) => {
      const o = store.get(key);
      return o ? { text: async () => new TextDecoder().decode(o.body) } : null;
    },
    head: async (key: string) => {
      const o = store.get(key);
      return o ? { customMetadata: o.meta } : null;
    },
    put: async (key: string, body: Uint8Array, opts?: { customMetadata?: Record<string, string> }) => {
      store.set(key, { body, meta: opts?.customMetadata ?? {} });
    },
    delete: async (key: string) => void store.delete(key),
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      truncated: false as const,
    }),
  };
  return { store, bucket };
}

function makeDO(withR2 = true) {
  const r2 = makeR2();
  const env = {
    RESTRAINT_DEV_VIEWER_COMP: COMP,
    ...(withR2 ? { DTAKO_R2: r2.bucket } : {}),
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const post = (body: unknown, contentType: string | null = "application/json") =>
    relay.fetch(
      new Request("https://relay.example/restraint-api/min-wage/import-mhlw", {
        method: "POST",
        headers: {
          "X-Theearth-Comp-Id": COMP,
          "X-Theearth-User-B64": "dmlld2Vy", // base64url("viewer")
          ...(contentType ? { "content-type": contentType } : {}),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }) as never,
    );
  return { post, r2 };
}

type FetchCall = { url: string; ua: string | null };
/** global fetch を差し替える。応答は URL ごとに指定 (無ければ 404)。 */
function stubMhlw(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ua: new Headers(init?.headers).get("User-Agent") });
      const route = routes[url];
      return route ? route() : new Response("not found", { status: 404 });
    }),
  );
  return calls;
}

const okXlsx = () => new Response(XLSX, { status: 200 });
const okIndex = () => new Response(INDEX_HTML, { status: 200 });
const XLSX_URL = `https://www.mhlw.go.jp${XLSX_HREF}`;

afterEach(() => vi.unstubAllGlobals());

describe("POST /restraint-api/min-wage/import-mhlw {source:'history'}", () => {
  it("一覧ページ → xlsx を UA 付きで取り、履歴を R2 に保存して年度範囲を返す", async () => {
    const calls = stubMhlw({ [MHLW_REVISION_INDEX_URL]: okIndex, [XLSX_URL]: okXlsx });
    const { post, r2 } = makeDO();
    const res = await post({ source: "history" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      saved: boolean; source: string; years: { from: string; to: string };
      prefectures: number; added: number; unchanged: number;
      data: { prefectures: Record<string, Array<{ effectiveFrom: string; rate: number }>> };
    };
    expect(body).toMatchObject({
      saved: true, source: "mhlw-history", years: { from: "平成14年度", to: "令和８年度" },
      prefectures: 1126, added: 1126, unchanged: 0,
    });
    expect(body.data.prefectures["福岡県"]!.slice(-5)).toEqual([
      { effectiveFrom: "2022-10-08", rate: 900 },
      { effectiveFrom: "2023-10-06", rate: 941 },
      { effectiveFrom: "2024-10-05", rate: 992 },
      { effectiveFrom: "2025-11-16", rate: 1057 },
      { effectiveFrom: "2026-10-04", rate: 1114 },
    ]);
    // Workers の fetch は UA を送らないので、2 本とも明示している
    expect(calls.map((c) => c.url)).toEqual([MHLW_REVISION_INDEX_URL, XLSX_URL]);
    expect(calls.every((c) => c.ua?.startsWith("nuxt-dtako-admin/min-wage-import"))).toBe(true);
    expect([...r2.store.keys()].some((k) => k.endsWith("min-wage/latest.json"))).toBe(true);
  });

  it("もう一度取り込むと履歴は増えず unchanged になる (既存の最新 1 件と重なる分も同じ)", async () => {
    stubMhlw({ [MHLW_REVISION_INDEX_URL]: okIndex, [XLSX_URL]: okXlsx });
    const { post } = makeDO();
    await post({ source: "history" });
    const again = (await (await post({ source: "history" })).json()) as { changed: boolean; added: number; unchanged: number };
    expect(again).toMatchObject({ changed: false, added: 0, unchanged: 1126 });
  });

  it("source と html を同時に指定すると 400 (何も取りに行かない)", async () => {
    const calls = stubMhlw({});
    const { post, r2 } = makeDO();
    const res = await post({ source: "history", html: NATIONAL_LIST_HTML });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    expect(r2.store.size).toBe(0);
  });

  it("未知の source は 400", async () => {
    const calls = stubMhlw({});
    const res = await makeDO().post({ source: "everything" });
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("取得先が mhlw.go.jp の xlsx でなければ 400 で、xlsx を取りに行かない", async () => {
    const calls = stubMhlw({
      [MHLW_REVISION_INDEX_URL]: () => new Response(`<a href="https://evil.example.com/a.xlsx">改定状況</a>`),
    });
    const { post, r2 } = makeDO();
    const res = await post({ source: "history" });
    expect(res.status).toBe(400);
    expect(calls.map((c) => c.url)).toEqual([MHLW_REVISION_INDEX_URL]);
    expect(r2.store.size).toBe(0);
  });

  it("リンクが 0 本なら 400", async () => {
    stubMhlw({ [MHLW_REVISION_INDEX_URL]: () => new Response("<p>no links</p>") });
    expect((await makeDO().post({ source: "history" })).status).toBe(400);
  });

  it("xlsx が zip でない / deflate が壊れている場合は 500 でなく 400 (何も保存しない)", async () => {
    const broken = new Uint8Array(XLSX);
    const junk = () => new Response(new TextEncoder().encode("<html>not xlsx</html>"));
    stubMhlw({ [MHLW_REVISION_INDEX_URL]: okIndex, [XLSX_URL]: junk });
    const a = makeDO();
    expect((await a.post({ source: "history" })).status).toBe(400);
    expect(a.r2.store.size).toBe(0);
    // 実物の zip の中身 (圧縮データ) を潰す → DecompressionStream が TypeError を投げる
    const entry = "xl/worksheets/sheet1.xml";
    const at = new TextDecoder("latin1").decode(XLSX).indexOf(entry) + entry.length;
    broken.fill(0xff, at, at + 16);
    stubMhlw({ [MHLW_REVISION_INDEX_URL]: okIndex, [XLSX_URL]: () => new Response(broken) });
    const b = makeDO();
    const res = await b.post({ source: "history" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("展開できません");
    expect(b.r2.store.size).toBe(0);
  });

  it("接続できない・非 2xx は 502 (一覧ページ / xlsx のどちらでも)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect refused"); }));
    const refused = await makeDO().post({ source: "history" });
    expect(refused.status).toBe(502);
    expect(await refused.text()).toContain("一覧ページ");

    stubMhlw({ [MHLW_REVISION_INDEX_URL]: () => new Response("x", { status: 503 }) });
    expect((await makeDO().post({ source: "history" })).status).toBe(502);

    stubMhlw({ [MHLW_REVISION_INDEX_URL]: okIndex, [XLSX_URL]: () => new Response("x", { status: 500 }) });
    const xlsx = await makeDO().post({ source: "history" });
    expect(xlsx.status).toBe(502);
    expect(await xlsx.text()).toContain("改定状況 xlsx");
  });

  it("R2 が無ければ 503 (取りに行かない)", async () => {
    const calls = stubMhlw({});
    expect((await makeDO(false).post({ source: "history" })).status).toBe(503);
    expect(calls).toEqual([]);
  });
});

describe("POST /restraint-api/min-wage/import-mhlw (従来の 2 経路は変えない)", () => {
  it("html を貼り付けた経路は source: paste で、years を返さない", async () => {
    const calls = stubMhlw({});
    const res = await makeDO().post({ html: NATIONAL_LIST_HTML });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ source: "paste", prefectures: 47 });
    expect("years" in body).toBe(false);
    expect(calls).toEqual([]);
  });

  it("body 無しは全国一覧 HTML を UA 付きで取りに行く", async () => {
    const url = "https://saiteichingin.mhlw.go.jp/table/page_list_nationallist.php";
    const calls = stubMhlw({ [url]: () => new Response(NATIONAL_LIST_HTML) });
    const { post } = makeDO();
    const res = await post("", null); // 画面の従来ボタンは body も content-type も送らない
    expect(res.status).toBe(200);
    expect(((await res.json()) as { source: string }).source).toBe(url);
    expect(calls[0]!.ua).toContain("min-wage-import");
  });

  it("全国一覧が 404 なら 502、解析できなければ 400", async () => {
    stubMhlw({});
    expect((await makeDO().post({})).status).toBe(502);
    expect((await makeDO().post({ html: "<table></table>" })).status).toBe(400);
  });

  it("JSON が壊れていれば 400", async () => {
    expect((await makeDO().post("{oops")).status).toBe(400);
  });
});
