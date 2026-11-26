import { afterEach, describe, expect, it, vi } from "vitest";

// do-cron-ichiban-makecsv.test.ts と同じ手。`cloudflare:workers` を素のクラスで差し替える。
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
import { PromiseQueue } from "../src/promise-queue";

/**
 * ETC カード追加登録の DO 配線 (Refs #1287)。判定は etc-card-register*.test.ts が持つので、
 * ここは「どの口へ何を渡すか」だけ: cron の印 → 同じキューで後段に積む / 手動口の関門 /
 * alc (GET・404 の扱い)・etc-meisai.jp・R2・D1 への配線。**番号はすべて架空値。**
 */
type Priv = {
  fetch(req: Request): Promise<Response>;
  env: Record<string, unknown>;
  ctx: { waitUntil(p: Promise<unknown>): void };
  scrapeQueue: PromiseQueue;
  runCronEtcScrape: (account: unknown) => Promise<void>;
  runEtcCardRegister: (account: unknown, target: unknown) => Promise<unknown>;
};

const ACCOUNTS = JSON.stringify([
  { user_id: "etc-reg", password: "pw-reg" },
  { user_id: "etc-other", password: "pw-o" },
]);

function makeDo(env: Record<string, unknown> = {}) {
  const d = Object.create(DtakoScraperRelayDO.prototype) as Priv;
  const waits: Promise<unknown>[] = [];
  d.ctx = { waitUntil: (p) => waits.push(p) };
  d.env = { ETC_ACCOUNTS: ACCOUNTS, ETC_CARD_REGISTER_USER_ID: "etc-reg", DTAKO_R2: {}, ...env };
  d.scrapeQueue = new PromiseQueue();
  return { d, waits };
}

const post = (path: string, body: unknown) =>
  new Request(`https://relay.internal${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/cron/etc の登録の印", () => {
  it("登録用アカウントに印が来たら、CSV 取得の後に同じキューで登録を回す", async () => {
    const { d, waits } = makeDo();
    const order: string[] = [];
    d.runCronEtcScrape = async () => {
      order.push("scrape");
    };
    d.runEtcCardRegister = async (account, target) => {
      order.push(`register:${(account as { user_id: string }).user_id}:${JSON.stringify(target)}`);
      return { notFound: false, results: [] };
    };
    const res = await d.fetch(post("/cron/etc", { user_id: "etc-reg", card_register: "1" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, user_id: "etc-reg", card_register: true });
    await Promise.all(waits);
    expect(order).toEqual(["scrape", 'register:etc-reg:{"kind":"cron"}']);
  });

  it("印が無い / 登録用でないアカウントには登録を積まない", async () => {
    for (const body of [{ user_id: "etc-reg" }, { user_id: "etc-other", card_register: "1" }]) {
      const { d, waits } = makeDo();
      d.runCronEtcScrape = async () => {};
      d.runEtcCardRegister = vi.fn();
      const res = await d.fetch(post("/cron/etc", body));
      expect((await res.json()) as unknown).toMatchObject({ card_register: false });
      await Promise.all(waits);
      expect(d.runEtcCardRegister).not.toHaveBeenCalled();
    }
  });

  it("登録が throw してもキューを止めず console.error に出す", async () => {
    const { d, waits } = makeDo();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    d.runCronEtcScrape = async () => {};
    d.runEtcCardRegister = async () => {
      throw new Error("boom");
    };
    await d.fetch(post("/cron/etc", { user_id: "etc-reg", card_register: "1" }));
    await Promise.all(waits);
    expect(err.mock.calls.flat().join("\n")).toContain("etc-card-register");
  });
});

describe("/internal/etc-card-register (手動 1 件)", () => {
  it.each([
    ["JSON でない", "nope", 400],
    ["id 無し", {}, 400],
    ["id が負", { id: -1 }, 400],
  ])("%s は 400", async (_l, body, status) => {
    const { d } = makeDo();
    d.runEtcCardRegister = vi.fn();
    expect((await d.fetch(post("/internal/etc-card-register", body))).status).toBe(status);
    expect(d.runEtcCardRegister).not.toHaveBeenCalled();
  });

  it("登録用アカウントが未設定 / ETC_ACCOUNTS に無ければ 503", async () => {
    for (const env of [{ ETC_CARD_REGISTER_USER_ID: undefined }, { ETC_CARD_REGISTER_USER_ID: "nobody" }]) {
      const { d } = makeDo(env);
      expect((await d.fetch(post("/internal/etc-card-register", { id: 1 }))).status).toBe(503);
    }
  });

  it("対象が無ければ 404、あれば結果 (カード番号は末尾 5 桁)、例外は 500", async () => {
    const { d } = makeDo();
    d.runEtcCardRegister = async () => ({ notFound: true, results: [] });
    expect((await d.fetch(post("/internal/etc-card-register", { id: 1 }))).status).toBe(404);

    d.runEtcCardRegister = async (_a, target) => ({
      notFound: false,
      results: [
        { id: (target as { id: number }).id, cardNumber: "0000111122223333", kind: "dry_run_ok" },
        { id: 2, cardNumber: null, kind: "failed" },
      ],
    });
    const ok = await d.fetch(post("/internal/etc-card-register", { id: 7 }));
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(JSON.parse(text).results.map((r: { cardNumber: unknown }) => r.cardNumber)).toEqual(["*23333", null]);
    expect(text).not.toContain("0000111122223333");

    d.runEtcCardRegister = async () => {
      throw new Error("boom");
    };
    expect((await d.fetch(post("/internal/etc-card-register", { id: 7 }))).status).toBe(500);
  });
});

describe("runEtcCardRegister の配線", () => {
  const CARD = "0000111122223333";
  const OBU = "9999988888888777777";

  function fakeD1(rows: unknown[]) {
    const updates: unknown[][] = [];
    return {
      updates,
      db: {
        prepare: (_sql: string) => ({
          bind: (...params: unknown[]) => ({
            all: async () => ({ results: rows }),
            run: async () => {
              updates.push(params);
              return {};
            },
          }),
        }),
      },
    };
  }

  function etcSiteFetch() {
    const top = `<a href="/etc/R?funccode=1013000000&amp;nextfunc=1013000000">ログイン</a>`;
    const login = `<form action="/etc/R?funccode=1013000000"><input type="hidden" name="p" value="lp" /><input name="risLoginId" /><input type="password" name="risPassword" /></form>`;
    const input = `<form name="frm" action="/etc/R"><input type="hidden" name="p" value="ip" /><input name="icCardID" /><input name="icCardIDConfirm" />
<input type="button" name="focusTarget" onclick="submitPage('frm','/etc/R?funccode=1034000000&amp;nextfunc=1034100000')" /></form>`;
    const pages = [top, login, input, "<p>確認</p>"];
    const calls: string[] = [];
    const f = vi.fn(async (url: string) => {
      calls.push(String(url));
      const body = pages.shift();
      if (body === undefined) throw new Error(`unexpected ${url}`);
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    });
    return { f, calls };
  }

  it("alc を GET で読み (404 の運行は飛ばす)、ログインして確認画面まで進め、R2 と D1 に書く", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), toFake: ["Date"] });
    const { f: siteFetch, calls: siteCalls } = etcSiteFetch();
    vi.stubGlobal("fetch", siteFetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const alcCalls: { url: string; method?: string; tenant: string | null }[] = [];
    const AUTH_WORKER = {
      fetch: async (url: string, init: RequestInit) => {
        alcCalls.push({ url, method: init.method, tenant: (init.headers as Record<string, string>)["X-Tenant-ID"] });
        if (url.includes("/api/internal/operations")) {
          return Response.json({
            operations: [
              { unko_no: "U1", vehicle_cd: "10001234", reading_date: "2026-11-21" },
              { unko_no: "U0", vehicle_cd: "10001234", reading_date: "2026-11-20" },
            ],
            total: 2,
            page: 1,
            per_page: 200,
          });
        }
        if (url.includes("/U1/")) return new Response("nf", { status: 404 });
        return Response.json({ headers: ["終了日時", "ETC利用"], rows: [["2026/11/20 08:00:00", "1"]] });
      },
    };
    const puts: { key: string; body: unknown }[] = [];
    const { db, updates } = fakeD1([{ id: 3, card_number: CARD, plate4: "1234", obu_number: OBU, tenant_id: "tenant-a" }]);
    const { d } = makeDo({
      DTAKO_DB: db,
      DTAKO_R2: { put: async (key: string, body: unknown) => void puts.push({ key, body }) },
      INTERNAL_SHARED_SECRET: "s",
      AUTH_WORKER,
    });

    const report = await d.runEtcCardRegister({ user_id: "etc-reg", password: "pw-reg" }, { kind: "cron" });
    vi.useRealTimers();

    expect(report).toMatchObject({ results: [{ id: 3, kind: "dry_run_ok", runDate: "2026-11-20" }] });
    expect(alcCalls.map((c) => [c.url.replace(/\?.*/, ""), c.method, c.tenant])).toEqual([
      ["https://auth-worker.internal/alc-internal-proxy/api/internal/operations", "GET", "tenant-a"],
      ["https://auth-worker.internal/alc-internal-proxy/api/operations/U1/csv/tolls", "GET", "tenant-a"],
      ["https://auth-worker.internal/alc-internal-proxy/api/operations/U0/csv/tolls", "GET", "tenant-a"],
    ]);
    // 既定は dry-run: 確認画面 (nextfunc 1034100000) で止まり、その先へは送らない
    expect(siteCalls.at(-1)).toContain("nextfunc=1034100000");
    expect(siteCalls).toHaveLength(4);
    expect(puts).toEqual([{ key: "etc-card-register/3/20261126090000-confirm.html", body: "<p>確認</p>" }]);
    expect(updates[0]?.slice(0, 3)).toEqual(["dry_run_ok", "2026-11-20", "U0"]);
  });

  it("alc の 404 以外の失敗は error (status は変えない)、ログインもしない", async () => {
    const siteFetch = vi.fn();
    vi.stubGlobal("fetch", siteFetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, updates } = fakeD1([{ id: 3, card_number: CARD, plate4: "1234", obu_number: OBU, tenant_id: "t" }]);
    const { d } = makeDo({
      DTAKO_DB: db,
      DTAKO_R2: { put: vi.fn() },
      INTERNAL_SHARED_SECRET: "s",
      AUTH_WORKER: {
        fetch: async (url: string) =>
          url.includes("/api/internal/operations")
            ? Response.json({ operations: [{ unko_no: "U1", vehicle_cd: "1234", reading_date: "2026-11-21" }], total: 1 })
            : new Response('{"error":"forbidden"}', { status: 403 }),
      },
    });
    const report = (await d.runEtcCardRegister({ user_id: "etc-reg", password: "x" }, { kind: "cron" })) as {
      results: { kind: string; detail: string }[];
    };
    expect(report.results[0]!.kind).toBe("error");
    expect(report.results[0]!.detail).toContain("403");
    expect(siteFetch).not.toHaveBeenCalled();
    expect(updates[0]).toHaveLength(4); // attempts / last_error / updated_at / id だけ
  });

  it("DTAKO_DB / R2 / secret が欠けていれば throw (何も読まない)", async () => {
    for (const env of [{ DTAKO_DB: undefined }, { DTAKO_R2: undefined }, { INTERNAL_SHARED_SECRET: undefined }]) {
      const { d } = makeDo({ DTAKO_DB: fakeD1([]).db, INTERNAL_SHARED_SECRET: "s", AUTH_WORKER: { fetch: vi.fn() }, ...env });
      await expect(d.runEtcCardRegister({ user_id: "etc-reg", password: "x" }, { kind: "cron" })).rejects.toThrow(
        "ETC カード登録を回せません",
      );
    }
  });
});
