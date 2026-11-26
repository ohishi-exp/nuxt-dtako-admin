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
  confirmEtcRunsFromZip: (account: unknown, zip: ArrayBuffer, range: { startDate: string; endDate: string }) => Promise<void>;
  env: Record<string, unknown>;
  ctx: { waitUntil(p: Promise<unknown>): void; storage: { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void> } };
  scrapeQueue: PromiseQueue;
  runCronEtcScrape: (account: unknown) => Promise<void>;
  runEtcCardRegister: (account: unknown, target: unknown) => Promise<unknown>;
};

const ACCOUNTS = JSON.stringify([
  { user_id: "etc-reg", password: "pw-reg" },
  { user_id: "etc-other", password: "pw-o" },
]);

/** `ownType` = この DO の storage に記録済みの種別、`others` = 他の DO (`etc-{user_id}`) が返す種別。 */
function makeDo(
  env: Record<string, unknown> = {},
  opts: { ownType?: string; others?: Record<string, string | null> } = {},
) {
  const d = Object.create(DtakoScraperRelayDO.prototype) as Priv;
  const waits: Promise<unknown>[] = [];
  const store = new Map<string, unknown>(opts.ownType ? [["etc_account_type", opts.ownType]] : []);
  d.ctx = {
    waitUntil: (p) => waits.push(p),
    storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v) },
  };
  const relayFetch = vi.fn(async (name: string, url: string) => {
    expect(url).toBe("https://relay.internal/internal/etc-account-type");
    return Response.json({ account_type: opts.others?.[name.replace(/^etc-/, "")] ?? null });
  });
  const RELAY = {
    idFromName: (name: string) => name,
    get: (name: string) => ({ fetch: (url: string) => relayFetch(name, url) }),
  };
  d.env = { ETC_ACCOUNTS: ACCOUNTS, DTAKO_R2: {}, RELAY, ...env };
  d.scrapeQueue = new PromiseQueue();
  return { d, waits, store, relayFetch };
}

const post = (path: string, body: unknown) =>
  new Request(`https://relay.internal${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/cron/etc の登録の印", () => {
  function track(d: Priv) {
    const order: string[] = [];
    d.runCronEtcScrape = async () => {
      order.push("scrape");
    };
    d.runEtcCardRegister = async (account, target) => {
      order.push(`register:${(account as { user_id: string }).user_id}:${JSON.stringify(target)}`);
      return { notFound: false, results: [] };
    };
    return order;
  }

  it("並び順で最初の法人アカウントなら、CSV 取得の後に同じキューで登録を回す", async () => {
    const { d, waits, relayFetch } = makeDo({}, { ownType: "corporate" });
    const order = track(d);
    const res = await d.fetch(post("/cron/etc", { user_id: "etc-reg", card_register: "1" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, user_id: "etc-reg", card_register: true });
    await Promise.all(waits);
    expect(order).toEqual(["scrape", 'register:etc-reg:{"kind":"cron"}']);
    // 担当は先頭 (自分) で決まる。後ろの DO は診断ログ用に 1 回だけ読む (readEtcAccountStates は全件読む)
    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(relayFetch.mock.calls[0][0]).toBe("etc-etc-other");
  });

  it("前のアカウントが個人なら、後ろの法人が登録する", async () => {
    const { d, waits, relayFetch } = makeDo({}, { ownType: "corporate", others: { "etc-reg": "personal" } });
    const order = track(d);
    await d.fetch(post("/cron/etc", { user_id: "etc-other", card_register: "1" }));
    await Promise.all(waits);
    expect(order).toEqual(["scrape", 'register:etc-other:{"kind":"cron"}']);
    expect(relayFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["前に法人が居る", { ownType: "corporate", others: { "etc-reg": "corporate" } }, "etc-other"],
    ["前のアカウントの種別が未記録", { ownType: "corporate", others: {} }, "etc-other"],
    ["自分が個人", { ownType: "personal" }, "etc-reg"],
    ["自分の種別が未記録", {}, "etc-reg"],
  ])("%s なら登録しない (ログに出す)", async (_l, opts, userId) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { d, waits, relayFetch } = makeDo({}, opts);
    const order = track(d);
    await d.fetch(post("/cron/etc", { user_id: userId, card_register: "1" }));
    await Promise.all(waits);
    expect(order).toEqual(["scrape"]);
    expect(log.mock.calls.flat().join("\n")).toContain('"status":"skipped"');
    if ((opts as { ownType?: string }).ownType !== "corporate") expect(relayFetch).not.toHaveBeenCalled(); // 個人は他の DO を読まない
  });

  it("ETC_CARD_REGISTER_MODE=off (staging / preview) なら担当でも登録しない (ログに出す)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { d, waits, relayFetch } = makeDo({ ETC_CARD_REGISTER_MODE: "off" }, { ownType: "corporate" });
    const order = track(d);
    await d.fetch(post("/cron/etc", { user_id: "etc-reg", card_register: "1" }));
    await Promise.all(waits);
    expect(order).toEqual(["scrape"]);
    expect(relayFetch).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("ETC_CARD_REGISTER_MODE=off");
  });

  it("印が無ければ登録段を積まない", async () => {
    const { d, waits } = makeDo({}, { ownType: "corporate" });
    const order = track(d);
    const res = await d.fetch(post("/cron/etc", { user_id: "etc-reg" }));
    expect((await res.json()) as unknown).toMatchObject({ card_register: false });
    await Promise.all(waits);
    expect(order).toEqual(["scrape"]);
  });

  it("登録が throw してもキューを止めず console.error に出す", async () => {
    const { d, waits } = makeDo({}, { ownType: "corporate" });
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

describe("GET /internal/etc-account-type", () => {
  it("記録済みの種別・ログイン後パス・機能コード・最後の取得を返す。未記録・不正な値は null", async () => {
    const get = () => new Request("https://relay.internal/internal/etc-account-type");
    const empty = { account_type: null, login_path: null, menu_funccodes: null, last_scrape: null };
    const full = makeDo({}, { ownType: "corporate" });
    full.store.set("etc_login_path", "/etc/R");
    full.store.set("etc_menu_funccodes", ["1032000000", "1034000000"]);
    full.store.set("etc_last_scrape", { at: "2026-11-26T01:00:00.000Z", status: "skipped" });
    expect(await (await full.d.fetch(get())).json()).toEqual({
      account_type: "corporate",
      login_path: "/etc/R",
      menu_funccodes: ["1032000000", "1034000000"],
      last_scrape: { at: "2026-11-26T01:00:00.000Z", status: "skipped" },
    });
    expect(await (await makeDo({}, { ownType: "corporate" }).d.fetch(get())).json()).toEqual({
      ...empty,
      account_type: "corporate",
    });
    expect(await (await makeDo({}, { ownType: "weird" }).d.fetch(get())).json()).toEqual(empty);
    expect(await (await makeDo().d.fetch(get())).json()).toEqual(empty);
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

  it("ETC_CARD_REGISTER_MODE=off なら 503 で回さない", async () => {
    const { d } = makeDo({ ETC_CARD_REGISTER_MODE: "off" });
    d.runEtcCardRegister = vi.fn();
    const res = await d.fetch(post("/internal/etc-card-register", { id: 1, user_id: "etc-reg" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "この環境では ETC カード追加登録を止めています (ETC_CARD_REGISTER_MODE=off)",
    });
    expect(d.runEtcCardRegister).not.toHaveBeenCalled();
  });

  it("user_id が無い / ETC_ACCOUNTS に無ければ 503", async () => {
    for (const body of [{ id: 1 }, { id: 1, user_id: "nobody" }]) {
      const { d } = makeDo();
      d.runEtcCardRegister = vi.fn();
      expect((await d.fetch(post("/internal/etc-card-register", body))).status).toBe(503);
      expect(d.runEtcCardRegister).not.toHaveBeenCalled();
    }
  });

  it("転送されてきた user_id のアカウントで回す", async () => {
    const { d } = makeDo();
    d.runEtcCardRegister = vi.fn(async () => ({ notFound: false, conflict: false, results: [] }));
    expect((await d.fetch(post("/internal/etc-card-register", { id: 1, user_id: "etc-other" }))).status).toBe(200);
    expect(d.runEtcCardRegister).toHaveBeenCalledWith(
      { user_id: "etc-other", password: "pw-o" },
      { kind: "one", id: 1 },
    );
  });

  it("走行日が未確認なら 409", async () => {
    const { d } = makeDo();
    d.runEtcCardRegister = async () => ({ notFound: false, conflict: true, results: [] });
    const res = await d.fetch(post("/internal/etc-card-register", { id: 1, user_id: "etc-reg" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "走行日が未確認 (次の zip 登録で確認される)" });
  });

  it("対象が無ければ 404、あれば結果 (カード番号は末尾 5 桁)、例外は 500", async () => {
    const { d } = makeDo();
    d.runEtcCardRegister = async () => ({ notFound: true, results: [] });
    expect((await d.fetch(post("/internal/etc-card-register", { id: 1, user_id: "etc-reg" }))).status).toBe(404);

    d.runEtcCardRegister = async (_a, target) => ({
      notFound: false,
      conflict: false,
      results: [
        { id: (target as { id: number }).id, cardNumber: "0000111122223333", kind: "dry_run_ok" },
        { id: 2, cardNumber: null, kind: "failed" },
      ],
    });
    const ok = await d.fetch(post("/internal/etc-card-register", { id: 7, user_id: "etc-reg" }));
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(JSON.parse(text).results.map((r: { cardNumber: unknown }) => r.cardNumber)).toEqual(["*23333", null]);
    expect(text).not.toContain("0000111122223333");

    d.runEtcCardRegister = async () => {
      throw new Error("boom");
    };
    expect((await d.fetch(post("/internal/etc-card-register", { id: 7, user_id: "etc-reg" }))).status).toBe(500);
  });
});

const CARD = "0000111122223333";
const OBU = "9999988888888777777";

function fakeD1(rows: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    db: {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          all: async () => {
            calls.push({ sql, params });
            return { results: rows };
          },
          run: async () => {
            calls.push({ sql, params });
            return {};
          },
        }),
      }),
    },
  };
}

/** method 0 (stored) だけの最小の zip。CRC は読まないので 0。 */
function storedZip(name: string, data: Uint8Array): ArrayBuffer {
  const n = new TextEncoder().encode(name);
  const lh = new DataView(new ArrayBuffer(30));
  lh.setUint32(0, 0x04034b50, true);
  lh.setUint32(18, data.length, true);
  lh.setUint32(22, data.length, true);
  lh.setUint16(26, n.length, true);
  const ch = new DataView(new ArrayBuffer(46));
  ch.setUint32(0, 0x02014b50, true);
  ch.setUint32(20, data.length, true);
  ch.setUint32(24, data.length, true);
  ch.setUint16(28, n.length, true);
  const cdOffset = 30 + n.length + data.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, 1, true);
  eocd.setUint16(10, 1, true);
  eocd.setUint32(12, 46 + n.length, true);
  eocd.setUint32(16, cdOffset, true);
  const parts = [new Uint8Array(lh.buffer), n, data, new Uint8Array(ch.buffer), n, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

describe("confirmEtcRunsFromZip (確認段の配線)", () => {
  const ACCOUNT = { comp_id: "c1", tenant_id: "tenant-a", user_name: "u", user_pass: "p" };
  const RANGE = { startDate: "2026-11-25", endDate: "2026-11-25" };
  // Shift_JIS の CSV (「運行NO,車輌CD,終了日時,ETC利用」の見出し) を組むのは手間なので、UTF-8 で渡す。
  // Shift_JIS の判定は etc-card-register.test.ts の decodeCsvBytes が固定している。
  const CSV = new TextEncoder().encode("運行NO,車輌CD,終了日時,ETC利用\r\nU1,10001234,2026/11/20 01:00:00,1\r\n");

  it("zip の KUDGSIR.csv から tenant の行の run_date を書く", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), toFake: ["Date"] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, calls } = fakeD1([{ id: 3, card_number: CARD, plate4: "1234", run_date: null, registration_date: null, received_at: "2026-11-01T00:00:00.000Z" }]);
    const { d } = makeDo({ DTAKO_DB: db });
    await d.confirmEtcRunsFromZip(ACCOUNT, storedZip("KUDGSIR.csv", CSV), RANGE);
    vi.useRealTimers();
    expect(calls[0]!.params).toEqual(["tenant-a"]);
    expect(calls[1]!.params.slice(0, 2)).toEqual(["2026-11-20", "U1"]);
    expect(log.mock.calls.flat().join("\n")).toContain('"status":"confirmed"');
  });

  it("DTAKO_DB が無い環境は skip (ログだけ、メールしない)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sent: unknown[] = [];
    const { d } = makeDo({ DTAKO_DB: undefined, ALERT_EMAIL: { send: async (m: unknown) => void sent.push(m) } });
    await d.confirmEtcRunsFromZip(ACCOUNT, new ArrayBuffer(4), RANGE);
    expect(log.mock.calls.flat().join("\n")).toContain("DTAKO_DB 未設定");
    expect(sent).toEqual([]);
  });

  it("ETC_CARD_REGISTER_MODE=off (staging / preview) は D1 を読まずに skip (ログだけ、メールしない)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sent: unknown[] = [];
    const { db, calls } = fakeD1([{ id: 3, card_number: CARD, plate4: "1234", run_date: null, registration_date: null, received_at: "2026-11-01T00:00:00.000Z" }]);
    const { d } = makeDo({
      DTAKO_DB: db,
      ETC_CARD_REGISTER_MODE: "off",
      ALERT_EMAIL: { send: async (m: unknown) => void sent.push(m) },
    });
    await d.confirmEtcRunsFromZip(ACCOUNT, storedZip("KUDGSIR.csv", CSV), RANGE);
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
    expect(log.mock.calls.flat().join("\n")).toContain("ETC_CARD_REGISTER_MODE=off");
  });

  it("KUDGSIR.csv が無い日はログ 1 行で終わる (D1 を読まない)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { db, calls } = fakeD1([]);
    const { d } = makeDo({ DTAKO_DB: db });
    await d.confirmEtcRunsFromZip(ACCOUNT, storedZip("KUDGURI.csv", CSV), RANGE);
    expect(calls).toEqual([]);
    expect(log.mock.calls.flat().join("\n")).toContain("no_kudgsir");
  });

  it("失敗 (壊れた zip / 複数一致) は throw せずログとメールへ", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sent: string[] = [];
    const mailEnv = {
      DTAKO_CONFIG_KV: { get: async () => JSON.stringify({ from: "relay@example.com", to: "ops@example.com" }) },
      ALERT_EMAIL: { send: async (m: unknown) => void sent.push(JSON.stringify(m)) },
    };
    const broken = makeDo({ DTAKO_DB: fakeD1([]).db, ...mailEnv }).d;
    await expect(broken.confirmEtcRunsFromZip(ACCOUNT, new ArrayBuffer(4), RANGE)).resolves.toBeUndefined();
    expect(err.mock.calls.flat().join("\n")).toContain("EOCD");

    const multi = new TextEncoder().encode("運行NO,車輌CD,終了日時,ETC利用\nU1,10001234,2026/11/20 01:00:00,1\nU2,20001234,2026/11/20 01:00:00,1\n");
    const { db, calls } = fakeD1([{ id: 3, card_number: CARD, plate4: "1234", run_date: null, registration_date: null, received_at: "2026-11-01T00:00:00.000Z" }]);
    await makeDo({ DTAKO_DB: db, ...mailEnv }).d.confirmEtcRunsFromZip(ACCOUNT, storedZip("KUDGSIR.csv", multi), RANGE);
    expect(calls[1]!.sql).toContain("status = 'failed'");
    expect(sent).toHaveLength(2); // 壊れた zip・複数一致で 1 通ずつ
  });
});

describe("runEtcCardRegister の配線 (登録段)", () => {
  function etcSiteFetch() {
    const top = `<a href="/etc/R?funccode=1013000000&amp;nextfunc=1013000000">ログイン</a>`;
    const login = `<form action="/etc/R?funccode=1013000000"><input type="hidden" name="p" value="lp" /><input name="risLoginId" /><input type="password" name="risPassword" /></form>`;
    const input = `<form name="frm" action="/etc/R"><input type="hidden" name="p" value="ip" /><input name="icCardID" /><input name="icCardIDConfirm" />
<input type="button" name="focusTarget" onclick="submitPage('frm','/etc/R?funccode=1034000000&amp;nextfunc=1034100000')" /></form>`;
    const confirm = `<p>確認</p><INPUT type="button" class="btn" value="  次へ  " onClick="submitPage('frm','/etc/R?funccode=1034100000&nextfunc=1034110000');">`;
    const pages = [top, login, input, confirm];
    const calls: string[] = [];
    const f = vi.fn(async (url: string) => {
      calls.push(String(url));
      const body = pages.shift();
      if (body === undefined) throw new Error(`unexpected ${url}`);
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    });
    return { f, calls };
  }

  it("run_date の行をログインして確認画面まで進め (既定 dry-run)、R2 と D1 に書く", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), toFake: ["Date"] });
    const { f: siteFetch, calls: siteCalls } = etcSiteFetch();
    vi.stubGlobal("fetch", siteFetch);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const puts: { key: string; body: unknown }[] = [];
    const { db, calls } = fakeD1([{ id: 3, card_number: CARD, plate4: "1234", obu_number: OBU, run_date: "2026-11-20", registration_date: null, received_at: "2026-11-01T00:00:00.000Z" }]);
    const { d } = makeDo({
      DTAKO_DB: db,
      DTAKO_R2: { put: async (key: string, body: unknown) => void puts.push({ key, body }) },
    });

    const report = await d.runEtcCardRegister({ user_id: "etc-reg", password: "pw-reg" }, { kind: "cron" });
    vi.useRealTimers();

    expect(report).toMatchObject({ results: [{ id: 3, kind: "dry_run_ok", runDate: "2026-11-20" }] });
    expect(siteCalls.at(-1)).toContain("nextfunc=1034100000");
    expect(siteCalls).toHaveLength(4);
    expect(puts).toEqual([{ key: "etc-card-register/3/20261126090000-confirm.html", body: expect.stringContaining("<p>確認</p>") }]);
    expect(calls[1]!.params[0]).toBe("dry_run_ok");
  });

  it("DTAKO_DB / R2 が欠けている・MODE=off なら throw (etc-meisai.jp へ行かない)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch してはいけない"); }));
    const { d: off } = makeDo({ DTAKO_DB: fakeD1([]).db, ETC_CARD_REGISTER_MODE: "off" });
    await expect(off.runEtcCardRegister({ user_id: "etc-reg", password: "x" }, { kind: "cron" })).rejects.toThrow(
      "ETC_CARD_REGISTER_MODE=off",
    );
    for (const env of [{ DTAKO_DB: undefined }, { DTAKO_R2: undefined }]) {
      const { d } = makeDo({ DTAKO_DB: fakeD1([]).db, ...env });
      await expect(d.runEtcCardRegister({ user_id: "etc-reg", password: "x" }, { kind: "cron" })).rejects.toThrow(
        "ETC カード登録を回せません",
      );
    }
  });
});
