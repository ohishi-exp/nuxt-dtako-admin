import { describe, it, expect, vi, afterEach } from "vitest";
import {
  relayKintaiWindow,
  relayKintaiRecalc,
  relayKintaiDaySummaries,
  relayWageRangeGet,
  relayWageSnapshotPut,
  relayKintaiStaleMonths,
  relayKintaiUnkoGaps,
  windowMonths,
  jstMonth,
  tenantForCompId,
  buildDeps,
  KintaiRelayError,
  MAX_MONTH_COUNT,
  decideFoldTrigger,
  judgeFoldScope,
  monthsCoveredByRange,
  foldMonth,
  FOLD_PAGE_MAX_DRIVERS,
  FOLD_CLOSE_MAX_DRIVERS,
  MAX_FOLD_PAGES,
  type KintaiRelayDeps,
} from "../src/kintai-relay";

const MONTH = "2026-07";
const SIG = "a".repeat(64);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** オンプレ / GCP の応答を path で引く stub。呼ばれた順に記録する。 */
function deps(handlers: {
  onprem?: Record<string, unknown | ((init?: RequestInit) => Response)>;
  gcp?: Record<string, unknown | ((init?: RequestInit) => Response)>;
}) {
  const calls: { side: "onprem" | "gcp"; path: string; body?: string }[] = [];
  const pick = (side: "onprem" | "gcp", table: Record<string, unknown> | undefined) => {
    return async (path: string, init?: RequestInit) => {
      calls.push({ side, path, body: init?.body as string | undefined });
      const key = path.split("?")[0]!;
      const hit = table?.[key];
      if (hit === undefined) return new Response("no stub", { status: 404 });
      if (typeof hit === "function") return (hit as (i?: RequestInit) => Response)(init);
      return json(hit);
    };
  };
  const d: KintaiRelayDeps = {
    onprem: pick("onprem", handlers.onprem),
    gcp: pick("gcp", handlers.gcp),
  };
  return { deps: d, calls };
}

const EVENTS = "/api/kintai/timecard/events";
const WINDOW = "/api/kintai/timecard/window";

/** 2026-06-15 12:00 JST。窓の既定を確かめるための固定時刻。 */
const NOW = Date.UTC(2026, 5, 15, 3, 0, 0);

function punch(driver: number, at: string, state: string) {
  return { datetime: at, driver_id: driver, source: "timecard", state };
}

describe("relayKintaiWindow (ohishi-exp/rust-ichibanboshi#205 の 04b)", () => {
  it("**窓の既定は当月 + 前月** — 始業/終業 の後追い修正を拾う幅", () => {
    expect(windowMonths("2026-06", 2)).toEqual(["2026-05", "2026-06"]);
    // 年をまたいでも畳める
    expect(windowMonths("2026-01", 3)).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(windowMonths("2026-06", 1)).toEqual(["2026-06"]);
  });

  it("当月は **JST** で切る (UTC のままだと月初/月末が 1 日ずれる)", () => {
    // 2026-06-30 21:00 UTC = 2026-07-01 06:00 JST
    expect(jstMonth(Date.UTC(2026, 5, 30, 21, 0, 0))).toBe("2026-07");
    expect(jstMonth(Date.UTC(2026, 5, 30, 14, 0, 0))).toBe("2026-06");
  });

  it("**month も now も無ければ実時刻の当月**を使う (既定で呼べる)", async () => {
    const { deps: d } = deps({
      onprem: { [EVENTS]: { drivers: [], events: [] } },
      gcp: { [WINDOW]: {} },
    });
    const r = await relayKintaiWindow(d, {});
    expect(r.months).toHaveLength(2);
    for (const m of r.months) expect(m).toMatch(/^\d{4}-\d{2}$/);
    expect(r.months[1]).toBe(jstMonth(Date.now()));
  });

  it("month / month_count が壊れていれば 1 回も叩かない", async () => {
    const { deps: d, calls } = deps({});
    await expect(relayKintaiWindow(d, { month: "2026-7" })).rejects.toBeInstanceOf(
      KintaiRelayError,
    );
    await expect(relayKintaiWindow(d, { month: "2026-06", monthCount: 0 })).rejects.toThrow(
      /month_count/,
    );
    await expect(
      relayKintaiWindow(d, { month: "2026-06", monthCount: MAX_MONTH_COUNT + 1 }),
    ).rejects.toThrow(/month_count/);
    await expect(relayKintaiWindow(d, { month: "2026-06", monthCount: 1.5 })).rejects.toThrow(
      /month_count/,
    );
    expect(calls).toHaveLength(0);
  });

  it("**1 往復ずつで運びきる。** 続きの位置は無い", async () => {
    const { deps: d, calls } = deps({
      onprem: {
        [EVENTS]: {
          months: ["2026-05", "2026-06"],
          drivers: [1130, 1200],
          events: [punch(1130, "2026-06-01 08:00:00", "始業")],
          elapsed_ms: 140,
        },
      },
      gcp: {
        [WINDOW]: {
          drivers_written: 1,
          days_written: 1,
          days_deleted: 0,
          misplaced: 0,
          unknown_states: ["謎"],
          dry_run: true,
          elapsed_ms: 55,
        },
      },
    });
    const r = await relayKintaiWindow(d, { now: NOW });

    expect(r.months).toEqual(["2026-05", "2026-06"]);
    expect(r.drivers).toBe(2);
    expect(r.events).toBe(1);
    expect(r.daysWritten).toBe(1);
    expect(r.unknownStates).toEqual(["謎"]);
    // オンプレ 1 回 + GCP 1 回だけ
    expect(calls).toHaveLength(2);
    expect(calls[0]!.path).toContain("months=2026-05%2C2026-06");

    // 窓と乗務員をそのまま渡している (ここで突き合わせない)
    const sent = JSON.parse(calls[1]!.body!);
    expect(sent.months).toEqual(["2026-05", "2026-06"]);
    expect(sent.drivers).toEqual([1130, 1200]);
    expect(sent.events).toHaveLength(1);
  });

  it("**apply が無ければ dry_run を立てて渡す** — 受け側に 1 行も書かせない", async () => {
    const { deps: d, calls } = deps({
      onprem: { [EVENTS]: { drivers: [1130], events: [] } },
      gcp: { [WINDOW]: { dry_run: true } },
    });
    const r = await relayKintaiWindow(d, { month: "2026-06" });
    expect(JSON.parse(calls[1]!.body!).dry_run).toBe(true);
    expect(r.dryRun).toBe(true);

    const applied = deps({
      onprem: { [EVENTS]: { drivers: [1130], events: [] } },
      gcp: { [WINDOW]: { dry_run: false } },
    });
    const r2 = await relayKintaiWindow(applied.deps, { month: "2026-06", apply: true });
    expect(JSON.parse(applied.calls[1]!.body!).dry_run).toBe(false);
    expect(r2.dryRun).toBe(false);
  });

  it("応答が欠けていても 0 として積む (drivers / events も同じ)", async () => {
    const { deps: d } = deps({ onprem: { [EVENTS]: {} }, gcp: { [WINDOW]: {} } });
    const r = await relayKintaiWindow(d, { month: "2026-06" });
    expect(r).toMatchObject({
      drivers: 0,
      events: 0,
      driversWritten: 0,
      daysWritten: 0,
      daysDeleted: 0,
      misplaced: 0,
      dryRun: false,
    });
    expect(r.unknownStates).toEqual([]);
  });

  it("**各レグの所要時間を返す。** 相手の自己申告も拾う", async () => {
    const { deps: d } = deps({
      onprem: { [EVENTS]: { drivers: [], events: [], elapsed_ms: 140 } },
      gcp: { [WINDOW]: { elapsed_ms: 55 } },
    });
    const r = await relayKintaiWindow(d, { month: "2026-06" });
    expect(r.timings.onpremEventsMs).toBe(140);
    expect(r.timings.gcpApplyMs).toBe(55);
    for (const k of ["totalMs", "eventsMs", "applyMs"] as const) {
      expect(typeof r.timings[k]).toBe("number");
      expect(r.timings[k]).toBeGreaterThanOrEqual(0);
    }
  });

  it("古い版が相手なら自己申告は null (数でない値も拾わない)", async () => {
    const { deps: d } = deps({
      onprem: { [EVENTS]: { drivers: [], events: [], elapsed_ms: "140" } },
      gcp: { [WINDOW]: {} },
    });
    const r = await relayKintaiWindow(d, { month: "2026-06" });
    expect(r.timings.onpremEventsMs).toBeNull();
    expect(r.timings.gcpApplyMs).toBeNull();
  });

  it("**どちら側が落ちたか**を本文の先頭付きで返す", async () => {
    const fail = () => new Response("boom detail", { status: 502 });
    const onpremDown = deps({ onprem: { [EVENTS]: fail } });
    await expect(relayKintaiWindow(onpremDown.deps, { month: "2026-06" })).rejects.toThrow(
      /onprem events: status 502: boom detail/,
    );

    const gcpDown = deps({
      onprem: { [EVENTS]: { drivers: [], events: [] } },
      gcp: { [WINDOW]: fail },
    });
    await expect(relayKintaiWindow(gcpDown.deps, { month: "2026-06" })).rejects.toThrow(
      /gcp timecard window: status 502/,
    );
  });

  it("JSON でない応答は parse failed で落とす (HTML のログイン画面等)", async () => {
    const { deps: d } = deps({
      onprem: { [EVENTS]: () => new Response("<html>login</html>", { status: 200 }) },
    });
    await expect(relayKintaiWindow(d, { month: "2026-06" })).rejects.toThrow(/parse failed/);
  });
});

const RECALC = "/api/kintai/recalc";

/** `relayKintaiRecalc` は gcp() しか使わない。呼ばれた順に記録する。 */
function gcpStub(table: Record<string, unknown | ((init?: RequestInit) => Response)>) {
  const calls: { path: string; method?: string; body?: string }[] = [];
  const gcp = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method, body: init?.body as string | undefined });
    const key = path.split("?")[0]!;
    const hit = table[key];
    if (hit === undefined) return new Response("no stub", { status: 404 });
    if (typeof hit === "function") return (hit as (i?: RequestInit) => Response)(init);
    return json(hit);
  });
  return { gcp, calls };
}

describe("relayKintaiRecalc (ohishi-exp/rust-ichibanboshi#205 の 10)", () => {
  it("壊れた month は 1 回も叩かずに落ちる", async () => {
    const { gcp, calls } = gcpStub({});
    await expect(relayKintaiRecalc({ gcp }, { month: "2026-7" })).rejects.toBeInstanceOf(
      KintaiRelayError,
    );
    expect(calls).toHaveLength(0);
  });

  it("**month 省略時は JST の当月** (`now` で固定できる)", async () => {
    const { gcp, calls } = gcpStub({ [RECALC]: { month: "2026-06" } });
    await relayKintaiRecalc({ gcp }, { now: NOW });
    expect(calls[0]!.path).toContain("month=2026-06");
  });

  it("**month も now も無ければ実時刻の当月**を使う (既定で呼べる)", async () => {
    const { gcp, calls } = gcpStub({ [RECALC]: {} });
    await relayKintaiRecalc({ gcp }, {});
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.searchParams.get("month")).toBe(jstMonth(Date.now()));
  });

  it("**apply が無ければ GET** — 受け側の書けない口を叩く", async () => {
    const { gcp, calls } = gcpStub({ [RECALC]: { drivers: [], stale: {} } });
    const r = await relayKintaiRecalc(
      { gcp },
      { month: "2026-06", afterDriverCd: 1130, maxDrivers: 10, staleOnly: true },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBeUndefined();
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.pathname).toBe(RECALC);
    expect(url.searchParams.get("month")).toBe("2026-06");
    expect(url.searchParams.get("after_driver_cd")).toBe("1130");
    expect(url.searchParams.get("max_drivers")).toBe("10");
    expect(url.searchParams.get("stale_only")).toBe("true");
    // **受け側の応答をそのまま返す** — reshape しない
    expect(r).toEqual({ drivers: [], stale: {} });
  });

  it("GET の query は省略項目を持たない (欠けた値を 'undefined' 文字列で送らない)", async () => {
    const { gcp, calls } = gcpStub({ [RECALC]: {} });
    await relayKintaiRecalc({ gcp }, { month: "2026-06" });
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.searchParams.has("after_driver_cd")).toBe(false);
    expect(url.searchParams.has("max_drivers")).toBe(false);
    expect(url.searchParams.has("stale_only")).toBe(false);
  });

  it("**apply: true なら POST** — 初めて書く", async () => {
    const { gcp, calls } = gcpStub({
      [RECALC]: { month: "2026-06", apply: true, next_after_driver_cd: 9999 },
    });
    const r = await relayKintaiRecalc(
      { gcp },
      { month: "2026-06", afterDriverCd: 1130, maxDrivers: 10, staleOnly: true, apply: true },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.path).toBe(RECALC);
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      month: "2026-06",
      after_driver_cd: 1130,
      max_drivers: 10,
      stale_only: true,
      apply: true,
    });
    expect(r).toMatchObject({ next_after_driver_cd: 9999 });
  });

  it("POST でも省略項目は素通しする (受け側の Option がそのまま None になる)", async () => {
    const { gcp, calls } = gcpStub({ [RECALC]: {} });
    await relayKintaiRecalc({ gcp }, { month: "2026-06", apply: true });
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.after_driver_cd).toBeUndefined();
    expect(sent.max_drivers).toBeUndefined();
    expect(sent.stale_only).toBe(false);
  });

  it("どちら側が落ちたかを本文の先頭付きで返す (GET / POST 両方)", async () => {
    const fail = () => new Response("boom", { status: 502 });
    const get = gcpStub({ [RECALC]: fail });
    await expect(relayKintaiRecalc(get, { month: "2026-06" })).rejects.toThrow(
      /gcp kintai recalc: status 502: boom/,
    );
    const post = gcpStub({ [RECALC]: fail });
    await expect(relayKintaiRecalc(post, { month: "2026-06", apply: true })).rejects.toThrow(
      /gcp kintai recalc: status 502: boom/,
    );
  });

  it("JSON でない応答は parse failed で落とす", async () => {
    const { gcp } = gcpStub({ [RECALC]: () => new Response("<html>", { status: 200 }) });
    await expect(relayKintaiRecalc({ gcp }, { month: "2026-06" })).rejects.toThrow(
      /parse failed/,
    );
  });
});

describe("judgeFoldScope (Refs #633-22 / #944)", () => {
  it("KINTAI_COMP_ID と一致する会社だけが対象", () => {
    expect(judgeFoldScope({ compId: "27324455", kintaiCompId: "27324455" })).toEqual({
      inScope: true,
    });
    expect(judgeFoldScope({ compId: "75700192", kintaiCompId: "27324455" })).toMatchObject({
      inScope: false,
      reason: "out_of_scope",
    });
  });

  it("**KINTAI_COMP_ID 未設定は「対象外」ではなく not_configured** (Refs #944 — 設定の穴を「意図的に飛ばした」に化けさせない)", () => {
    for (const kintaiCompId of [undefined, "", "   "]) {
      expect(judgeFoldScope({ compId: "27324455", kintaiCompId })).toMatchObject({
        inScope: false,
        reason: "not_configured",
      });
    }
  });

  it("**対象外 と 未設定 は別の理由になる** — 旧実装は両方 false を返し、呼び出し元が両方を skipped_out_of_scope として記録していた (Refs #944)", () => {
    const outOfScope = judgeFoldScope({ compId: "75700192", kintaiCompId: "27324455" });
    const notConfigured = judgeFoldScope({ compId: "27324455", kintaiCompId: undefined });
    expect(outOfScope.inScope).toBe(false);
    expect(notConfigured.inScope).toBe(false);
    if (outOfScope.inScope || notConfigured.inScope) throw new Error("unreachable");
    // ★ ここが本体。`false` どうしでは区別が付かなかった。**文面だけでなく
    // `reason` が割れていること**を見る (文面の差で通ってしまうと空撃ちになる)
    expect(outOfScope.reason).toBe("out_of_scope");
    expect(notConfigured.reason).toBe("not_configured");
    expect(outOfScope.reason).not.toBe(notConfigured.reason);
  });

  it("理由の文面が**どの宣言で決まったか**を名指しする (記録だけ見て (a) 意図的 / (b) 壊れて黙った を切り分けられるように)", () => {
    const verdict = judgeFoldScope({ compId: "75700192", kintaiCompId: "27324455" });
    expect(verdict.inScope).toBe(false);
    if (verdict.inScope) throw new Error("unreachable");
    expect(verdict.detail).toContain("75700192");
    expect(verdict.detail).toContain("KINTAI_COMP_ID");
    expect(verdict.detail).toContain("27324455");

    const missing = judgeFoldScope({ compId: "27324455", kintaiCompId: "" });
    if (missing.inScope) throw new Error("unreachable");
    expect(missing.detail).toContain("KINTAI_COMP_ID");
    expect(missing.detail).toContain("設定の穴");
  });

  it("前後の空白は両側とも無視する (var の書き間違いで静かに全社 skip にしない)", () => {
    expect(judgeFoldScope({ compId: " 27324455 ", kintaiCompId: " 27324455 " })).toEqual({
      inScope: true,
    });
  });
});

describe("decideFoldTrigger (ohishi-exp/rust-ichibanboshi#205 の 10)", () => {
  /** 勤怠の対象会社 (wrangler.toml の KINTAI_COMP_ID)。 */
  const inScope = { compId: "27324455", kintaiCompId: "27324455" };

  it("アップロードが無ければ回さない", () => {
    expect(decideFoldTrigger(null, inScope)).toMatchObject({ run: false, reason: "no_upload" });
  });

  it("**split_failed > 0 の間は回さない** — 不完全データで上書きし成功に見えるより、古い値のままの方がマシ", () => {
    expect(decideFoldTrigger({ splitFailed: 1 }, inScope)).toMatchObject({ run: false, reason: "split_failed" });
    const many = decideFoldTrigger({ splitFailed: 42 }, inScope);
    expect(many).toMatchObject({ run: false, reason: "split_failed" });
    // 何件落ちたかを理由に書く (記録だけで規模が分かるように)
    if (many.run) throw new Error("unreachable");
    expect(many.detail).toContain("42");
  });

  it("split_failed が 0 か不明 (null、旧 alc) なら回す", () => {
    expect(decideFoldTrigger({ splitFailed: 0 }, inScope)).toEqual({ run: true });
    expect(decideFoldTrigger({ splitFailed: null }, inScope)).toEqual({ run: true });
  });

  it("**対象外の会社は取り込みが完全に成功していても回さない** (Refs #633-22 — comp 75700192 の 403 の実害)", () => {
    const outOfScope = { compId: "75700192", kintaiCompId: "27324455" };
    expect(decideFoldTrigger({ splitFailed: 0 }, outOfScope)).toMatchObject({ run: false, reason: "out_of_scope" });
  });

  it("**範囲の判定が先** — 対象外なら no_upload / split_failed ではなく out_of_scope を返す (「直せば畳める」と読めてしまうため)", () => {
    const outOfScope = { compId: "75700192", kintaiCompId: "27324455" };
    expect(decideFoldTrigger(null, outOfScope)).toMatchObject({ run: false, reason: "out_of_scope" });
    expect(decideFoldTrigger({ splitFailed: 3 }, outOfScope)).toMatchObject({ run: false, reason: "out_of_scope" });
  });

  it("**KINTAI_COMP_ID 未設定なら not_configured** — 取り込みが完全に成功していても、対象外とは別の理由で回さない (Refs #944)", () => {
    const unset = { compId: "27324455", kintaiCompId: undefined };
    expect(decideFoldTrigger({ splitFailed: 0 }, unset)).toMatchObject({
      run: false,
      reason: "not_configured",
    });
    expect(decideFoldTrigger(null, unset)).toMatchObject({ run: false, reason: "not_configured" });
  });
});

describe("monthsCoveredByRange (ohishi-exp/rust-ichibanboshi#205 の 10)", () => {
  it("同じ日なら1か月だけ", () => {
    expect(monthsCoveredByRange("2026-06-15", "2026-06-15")).toEqual(["2026-06"]);
  });

  it("月境界をまたげば複数月 (年またぎも畳める)", () => {
    expect(monthsCoveredByRange("2026-06-25", "2026-07-05")).toEqual(["2026-06", "2026-07"]);
    expect(monthsCoveredByRange("2025-12-20", "2026-01-05")).toEqual(["2025-12", "2026-01"]);
  });

  it("壊れた日付は空配列 (fold を回さない側に倒す)", () => {
    expect(monthsCoveredByRange("nope", "2026-06-15")).toEqual([]);
    expect(monthsCoveredByRange("2026-06-15", "nope")).toEqual([]);
  });

  it("start が end より後 (異常な範囲) も空配列", () => {
    expect(monthsCoveredByRange("2026-07-01", "2026-06-01")).toEqual([]);
  });
});

describe("foldMonth (ohishi-exp/rust-ichibanboshi#205 の 10)", () => {
  /** RECALC への呼び出しを順番に台本どおり返す stub。呼ばれた body を記録する。 */
  function scriptedGcp(responses: Array<Record<string, unknown>>) {
    const calls: { body: Record<string, unknown> }[] = [];
    const gcp = vi.fn(async (_path: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      calls.push({ body });
      const r = responses[calls.length - 1];
      return json(r ?? {});
    });
    return { gcp, calls };
  }

  it("1ページで収束したら、続けて封じる1回 (ページングなし・max_drivers=150) を呼ぶ", async () => {
    const { gcp, calls } = scriptedGcp([
      { fold: { drivers_written: 3 }, next_after_driver_cd: null },
      { fold: { drivers_written: 0 }, next_after_driver_cd: null },
    ]);
    const report = await foldMonth({ gcp }, { month: "2026-06", apply: true });
    expect(report).toEqual({
      month: "2026-06",
      pages: 1,
      driversWritten: 3,
      attemptedGateClose: true,
      capped: false,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.max_drivers).toBe(FOLD_PAGE_MAX_DRIVERS);
    expect(calls[0]!.body.after_driver_cd).toBeUndefined();
    expect(calls[1]!.body.max_drivers).toBe(FOLD_CLOSE_MAX_DRIVERS);
    expect(calls[1]!.body.after_driver_cd).toBeUndefined();
  });

  it("複数ページに分かれても next_after_driver_cd を引き継ぎ、収束後に1回だけ封じる", async () => {
    const { gcp, calls } = scriptedGcp([
      { fold: { drivers_written: 50 }, next_after_driver_cd: 1200 },
      { fold: { drivers_written: 50 }, next_after_driver_cd: 1400 },
      { fold: { drivers_written: 20 }, next_after_driver_cd: null },
      { fold: { drivers_written: 0 }, next_after_driver_cd: null },
    ]);
    const report = await foldMonth({ gcp }, { month: "2026-06", apply: true });
    expect(report).toEqual({
      month: "2026-06",
      pages: 3,
      driversWritten: 120,
      attemptedGateClose: true,
      capped: false,
    });
    expect(calls).toHaveLength(4);
    expect(calls[0]!.body.after_driver_cd).toBeUndefined();
    expect(calls[1]!.body.after_driver_cd).toBe(1200);
    expect(calls[2]!.body.after_driver_cd).toBe(1400);
    // 封じる回はページングしない
    expect(calls[3]!.body.after_driver_cd).toBeUndefined();
    expect(calls[3]!.body.max_drivers).toBe(FOLD_CLOSE_MAX_DRIVERS);
  });

  it(`**MAX_FOLD_PAGES (${MAX_FOLD_PAGES}) で打ち切る** — 収束していないので封じる呼び出しはしない`, async () => {
    const responses = Array.from({ length: MAX_FOLD_PAGES }, (_, i) => ({
      fold: { drivers_written: 1 },
      next_after_driver_cd: 1000 + i,
    }));
    const { gcp, calls } = scriptedGcp(responses);
    const report = await foldMonth({ gcp }, { month: "2026-06", apply: true });
    expect(report).toEqual({
      month: "2026-06",
      pages: MAX_FOLD_PAGES,
      driversWritten: MAX_FOLD_PAGES,
      attemptedGateClose: false,
      capped: true,
    });
    // 封じる呼び出しをしていない = ちょうど MAX_FOLD_PAGES 回だけ
    expect(calls).toHaveLength(MAX_FOLD_PAGES);
  });

  it("応答が欠けていても 0 として積む (fold / next_after_driver_cd が無い応答)", async () => {
    const { gcp } = scriptedGcp([{}, {}]);
    const report = await foldMonth({ gcp }, { month: "2026-06", apply: false });
    expect(report).toEqual({
      month: "2026-06",
      pages: 1,
      driversWritten: 0,
      attemptedGateClose: true,
      capped: false,
    });
  });

  it("応答が object ですらない (JSON でも壊れた形) 場合も落ちずに 0 として積む", async () => {
    const gcp = vi.fn(async () => new Response("null", { status: 200 }));
    const report = await foldMonth({ gcp }, { month: "2026-06", apply: false });
    expect(report).toEqual({
      month: "2026-06",
      pages: 1,
      driversWritten: 0,
      attemptedGateClose: true,
      capped: false,
    });
  });
});

const DAY_SUMMARIES = "/api/kintai/day-summaries";

describe("relayKintaiDaySummaries (ohishi-exp/rust-ichibanboshi#205 の 23)", () => {
  /** 受け側が返す形 — キーは `乗務員CD|暦日|開始時刻`、値は shift_source + 分数。 */
  const SAMPLE = {
    month: "2026-06",
    rows: 1,
    summaries: {
      "1130|2026-06-01|2026-06-01 08:00:00": {
        shift_source: "punch",
        restraint_minutes: 720,
        working_minutes: 600,
      },
    },
  };

  it("壊れた month は 1 回も叩かずに落ちる", async () => {
    const { gcp, calls } = gcpStub({});
    await expect(
      relayKintaiDaySummaries({ gcp }, { month: "2026-7" }),
    ).rejects.toBeInstanceOf(KintaiRelayError);
    expect(calls).toHaveLength(0);
  });

  it("**month 省略時は JST の当月** (`now` で固定できる)", async () => {
    const { gcp, calls } = gcpStub({ [DAY_SUMMARIES]: SAMPLE });
    await relayKintaiDaySummaries({ gcp }, { now: NOW });
    expect(calls[0]!.path).toContain("month=2026-06");
  });

  it("**month も now も無ければ実時刻の当月**を使う", async () => {
    const { gcp, calls } = gcpStub({ [DAY_SUMMARIES]: SAMPLE });
    await relayKintaiDaySummaries({ gcp }, {});
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.searchParams.get("month")).toBe(jstMonth(Date.now()));
  });

  it("**GET で読むだけ。** 応答はそのまま返す (突合がそのまま比較できるように)", async () => {
    const { gcp, calls } = gcpStub({ [DAY_SUMMARIES]: SAMPLE });
    const r = await relayKintaiDaySummaries({ gcp }, { month: "2026-06", driver: "1130" });
    expect(calls).toHaveLength(1);
    // method 未指定 = GET。body も無い — この経路は 1 行も書けない
    expect(calls[0]!.method).toBeUndefined();
    expect(calls[0]!.body).toBeUndefined();
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.pathname).toBe(DAY_SUMMARIES);
    expect(url.searchParams.get("month")).toBe("2026-06");
    expect(url.searchParams.get("driver")).toBe("1130");
    // **reshape しない** — 件数の要約も整形も挟まない
    expect(r).toEqual(SAMPLE);
  });

  it("driver を省いたら query に出さない (`driver=` は受け側が 400 にする)", async () => {
    const { gcp, calls } = gcpStub({ [DAY_SUMMARIES]: SAMPLE });
    await relayKintaiDaySummaries({ gcp }, { month: "2026-06" });
    expect(new URL(`https://x${calls[0]!.path}`).searchParams.has("driver")).toBe(false);

    const empty = gcpStub({ [DAY_SUMMARIES]: SAMPLE });
    await relayKintaiDaySummaries(empty, { month: "2026-06", driver: "" });
    expect(new URL(`https://x${empty.calls[0]!.path}`).searchParams.has("driver")).toBe(false);
  });

  it("0 件の月も**そのまま通す** (空と「口が無い」を混ぜない)", async () => {
    const empty = { month: "2026-06", rows: 0, summaries: {} };
    const { gcp } = gcpStub({ [DAY_SUMMARIES]: empty });
    expect(await relayKintaiDaySummaries({ gcp }, { month: "2026-06" })).toEqual(empty);
  });

  it("どちら側が落ちたかを本文の先頭付きで返す", async () => {
    const { gcp } = gcpStub({ [DAY_SUMMARIES]: () => new Response("boom", { status: 502 }) });
    await expect(relayKintaiDaySummaries({ gcp }, { month: "2026-06" })).rejects.toThrow(
      /gcp kintai day-summaries: status 502: boom/,
    );
  });

  it("JSON でない応答は parse failed で落とす", async () => {
    const { gcp } = gcpStub({
      [DAY_SUMMARIES]: () => new Response("<html>", { status: 200 }),
    });
    await expect(relayKintaiDaySummaries({ gcp }, { month: "2026-06" })).rejects.toThrow(
      /parse failed/,
    );
  });
});

const STALE_MONTHS = "/api/kintai/stale-months";

describe("relayKintaiStaleMonths (Refs #620)", () => {
  /** 受け側の確定済みの形 (#620 起票時に確認済み)。 */
  const SAMPLE = {
    logic_version: "0dd618334e44252b",
    from: "2025-07",
    to: "2026-06",
    default_window_months: 12,
    months: [
      { month: "2026-06", stale_drivers: 0, total_drivers: 0 },
      { month: "2026-05", stale_drivers: 0, total_drivers: 12 },
      { month: "2026-04", stale_drivers: 3, total_drivers: 12 },
    ],
  };

  it("**GET で読むだけ。** 応答はそのまま返す (丸めない)", async () => {
    const { gcp, calls } = gcpStub({ [STALE_MONTHS]: SAMPLE });
    const r = await relayKintaiStaleMonths({ gcp }, {});
    expect(calls).toHaveLength(1);
    // method 未指定 = GET。body も無い — この経路は 1 行も書けない
    expect(calls[0]!.method).toBeUndefined();
    expect(calls[0]!.body).toBeUndefined();
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.pathname).toBe(STALE_MONTHS);
    expect(r).toEqual(SAMPLE);
  });

  it("from/to を省略したら query を一切付けない (受け側の既定に任せる)", async () => {
    const { gcp, calls } = gcpStub({ [STALE_MONTHS]: SAMPLE });
    await relayKintaiStaleMonths({ gcp }, {});
    expect(calls[0]!.path).toBe(STALE_MONTHS);
  });

  it("from/to を指定したら query にそのまま乗せる", async () => {
    const { gcp, calls } = gcpStub({ [STALE_MONTHS]: SAMPLE });
    await relayKintaiStaleMonths({ gcp }, { from: "2025-07", to: "2026-06" });
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.pathname).toBe(STALE_MONTHS);
    expect(url.searchParams.get("from")).toBe("2025-07");
    expect(url.searchParams.get("to")).toBe("2026-06");
  });

  it("from だけ指定できる (to は受け側の既定に任せる)", async () => {
    const { gcp, calls } = gcpStub({ [STALE_MONTHS]: SAMPLE });
    await relayKintaiStaleMonths({ gcp }, { from: "2025-07" });
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.searchParams.get("from")).toBe("2025-07");
    expect(url.searchParams.has("to")).toBe(false);
  });

  it("壊れた from は 1 回も叩かずに落ちる", async () => {
    const { gcp, calls } = gcpStub({});
    await expect(
      relayKintaiStaleMonths({ gcp }, { from: "2025-7" }),
    ).rejects.toBeInstanceOf(KintaiRelayError);
    expect(calls).toHaveLength(0);
  });

  it("壊れた to は 1 回も叩かずに落ちる", async () => {
    const { gcp, calls } = gcpStub({});
    await expect(
      relayKintaiStaleMonths({ gcp }, { to: "2026-6" }),
    ).rejects.toBeInstanceOf(KintaiRelayError);
    expect(calls).toHaveLength(0);
  });

  it("どちら側が落ちたかを本文の先頭付きで返す", async () => {
    const { gcp } = gcpStub({ [STALE_MONTHS]: () => new Response("boom", { status: 502 }) });
    await expect(relayKintaiStaleMonths({ gcp }, {})).rejects.toThrow(
      /gcp kintai stale-months: status 502: boom/,
    );
  });

  it("JSON でない応答は parse failed で落とす", async () => {
    const { gcp } = gcpStub({
      [STALE_MONTHS]: () => new Response("<html>", { status: 200 }),
    });
    await expect(relayKintaiStaleMonths({ gcp }, {})).rejects.toThrow(/parse failed/);
  });
});

const UNKO_GAPS = "/api/kintai/unko-gaps";

describe("relayKintaiUnkoGaps (Refs #623-2)", () => {
  /** 受け口の確定済みの形 (issue #623-2 起票時に確認済み)。 */
  const SAMPLE = {
    month: "2026-06",
    driver_cd: null,
    gcp_etags_available: true,
    driver_cds_available: true,
    unko_no_digits: 22,
    drivers: [
      { driver_cd: 1445, unko_nos: ["260601123456000012345600"], truncated: false },
      { driver_cd: 1740, unko_nos: ["260602123456000012345601"], truncated: false },
    ],
    drivers_truncated: false,
    unknown_driver_unko_nos: [],
    unknown_driver_unko_nos_truncated: false,
    elapsed_ms: 12345,
  };

  it("**GET で読むだけ。** 応答はそのまま返す (丸めない)", async () => {
    const { gcp, calls } = gcpStub({ [UNKO_GAPS]: SAMPLE });
    const r = await relayKintaiUnkoGaps({ gcp }, { month: "2026-06" });
    expect(calls).toHaveLength(1);
    // method 未指定 = GET。body も無い — この経路は 1 行も書けない
    expect(calls[0]!.method).toBeUndefined();
    expect(calls[0]!.body).toBeUndefined();
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.pathname).toBe(UNKO_GAPS);
    expect(url.searchParams.get("month")).toBe("2026-06");
    expect(url.searchParams.has("driver_cd")).toBe(false);
    expect(r).toEqual(SAMPLE);
  });

  it("driver_cd を指定したら query にそのまま乗せる", async () => {
    const { gcp, calls } = gcpStub({ [UNKO_GAPS]: SAMPLE });
    await relayKintaiUnkoGaps({ gcp }, { month: "2026-06", driverCd: "1445" });
    const url = new URL(`https://x${calls[0]!.path}`);
    expect(url.searchParams.get("driver_cd")).toBe("1445");
  });

  it("month が無い/壊れていたら 1 回も叩かずに落ちる", async () => {
    const { gcp, calls } = gcpStub({});
    await expect(
      relayKintaiUnkoGaps({ gcp }, { month: "2026-6" }),
    ).rejects.toBeInstanceOf(KintaiRelayError);
    expect(calls).toHaveLength(0);
  });

  it("どちら側が落ちたかを本文の先頭付きで返す", async () => {
    const { gcp } = gcpStub({ [UNKO_GAPS]: () => new Response("boom", { status: 502 }) });
    await expect(relayKintaiUnkoGaps({ gcp }, { month: "2026-06" })).rejects.toThrow(
      /gcp kintai unko-gaps: status 502: boom/,
    );
  });

  it("JSON でない応答は parse failed で落とす", async () => {
    const { gcp } = gcpStub({
      [UNKO_GAPS]: () => new Response("<html>", { status: 200 }),
    });
    await expect(relayKintaiUnkoGaps({ gcp }, { month: "2026-06" })).rejects.toThrow(
      /parse failed/,
    );
  });
});

describe("tenantForCompId", () => {
  const accounts = [
    { comp_id: "1", user_name: "u", user_pass: "p", tenant_id: "tenant-a" },
    { comp_id: "2", user_name: "u", user_pass: "p", tenant_id: "  tenant-b  " },
    { comp_id: "3", user_name: "u", user_pass: "p", tenant_id: "   " },
    { comp_id: "4", user_name: "u", user_pass: "p" },
    // comp_id ごと欠けている行 (KV の手編集で起こりうる)
    { user_name: "u", user_pass: "p", tenant_id: "tenant-orphan" },
    "not an object",
    null,
  ];

  it("comp_id で引ける (前後の空白は落とす)", () => {
    expect(tenantForCompId(accounts, "1")).toBe("tenant-a");
    expect(tenantForCompId(accounts, "2")).toBe("tenant-b");
  });

  it("**tenant が無ければ null。** 既定へ落とさない", () => {
    expect(tenantForCompId(accounts, "3")).toBeNull();
    expect(tenantForCompId(accounts, "4")).toBeNull();
    expect(tenantForCompId(accounts, "999")).toBeNull();
    // **空の comp_id では引けない** — comp_id を持たない壊れた行を拾わせない
    expect(tenantForCompId(accounts, "")).toBeNull();
    // comp_id が数値でも引ける (KV は手編集なので型が揺れる)
    expect(tenantForCompId([{ comp_id: 7, tenant_id: "t7" }], "7")).toBe("t7");
    expect(tenantForCompId(null, "1")).toBeNull();
    expect(tenantForCompId({ comp_id: "1" }, "1")).toBeNull();
  });
});

describe("buildDeps", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function opts(over: Partial<Parameters<typeof buildDeps>[0]> = {}) {
    return {
      ichibanOrigin: "https://rust-ichiban.example/",
      cfAccessClientId: "cid",
      cfAccessClientSecret: "csec",
      authWorker: { fetch: vi.fn(async () => json({})) },
      proxySecret: "proxy-secret",
      tenantId: "tenant-a",
      ...over,
    };
  }

  it("オンプレへは CF Access Service Token を付ける (末尾スラッシュは二重にしない)", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
      seen.push({ url: String(url), init: init as RequestInit });
      return json({});
    }) as unknown as typeof fetch;

    const o = opts();
    await buildDeps(o).onprem("/api/kintai/timecard/drivers");
    expect(seen[0]!.url).toBe("https://rust-ichiban.example/api/kintai/timecard/drivers");
    const h = seen[0]!.init!.headers as Record<string, string>;
    expect(h["CF-Access-Client-Id"]).toBe("cid");
    expect(h["CF-Access-Client-Secret"]).toBe("csec");
  });

  it("GCP へは auth-worker の /ichibanboshi-proxy 経由。**SA key は持たない**", async () => {
    const o = opts();
    await buildDeps(o).gcp("/api/kintai/timecard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const call = vi.mocked(o.authWorker.fetch).mock.calls[0]!;
    expect(call[0]).toBe(
      "https://auth-worker.internal/ichibanboshi-proxy/api/kintai/timecard",
    );
    const h = (call[1] as RequestInit).headers as Record<string, string>;
    expect(h["X-Alc-Proxy-Secret"]).toBe("proxy-secret");
    expect(h["X-Tenant-ID"]).toBe("tenant-a");
    expect(h["content-type"]).toBe("application/json");
    expect((call[1] as RequestInit).method).toBe("POST");
  });
});

describe("賃金スナップショットの中継 (ohishi-exp/nuxt-dtako-admin#677)", () => {
  /** **comp_id は呼び出し元に名乗らせない。** body の値は捨てて relay が上書きする。 */
  it("relayWageSnapshotPut は body の comp_id を認可済みの値で上書きする", async () => {
    let seen: { path: string; init?: RequestInit } | null = null;
    const deps = {
      gcp: async (path: string, init?: RequestInit) => {
        seen = { path, init };
        return json({ saved: 3, skipped_unchanged: false });
      },
    } as unknown as KintaiRelayDeps;

    const out = await relayWageSnapshotPut(deps, "27324455", {
      comp_id: "他社のID",
      month: "2026-01",
      rows: [],
    });

    expect(out).toEqual({ saved: 3, skipped_unchanged: false });
    expect(seen!.path).toBe("/api/kintai/wage-snapshot");
    expect(seen!.init?.method).toBe("POST");
    const sent = JSON.parse(String(seen!.init?.body));
    expect(sent.comp_id).toBe("27324455");
    expect(sent.month).toBe("2026-01");
  });

  it("relayWageRangeGet は comp を上書きし、他のクエリはそのまま渡す", async () => {
    let seenPath = "";
    const deps = {
      gcp: async (path: string) => {
        seenPath = path;
        return json({ from: "2026-01", to: "2026-03", months: [], rows: [] });
      },
    } as unknown as KintaiRelayDeps;

    await relayWageRangeGet(
      deps,
      "27324455",
      new URLSearchParams({
        comp: "他社のID",
        from: "2026-01",
        to: "2026-03",
        source: "gcp",
        salary_item_sha: "a08d07ff",
      }),
    );

    const q = new URLSearchParams(seenPath.split("?")[1]);
    expect(seenPath.startsWith("/api/kintai/wage-range?")).toBe(true);
    expect(q.get("comp")).toBe("27324455");
    expect(q.get("from")).toBe("2026-01");
    expect(q.get("source")).toBe("gcp");
    expect(q.get("salary_item_sha")).toBe("a08d07ff");
  });

  it("受け側が非 2xx を返したら投げる (黙って空を返さない)", async () => {
    const deps = {
      gcp: async () => json({ error: "month は YYYY-MM" }, 400),
    } as unknown as KintaiRelayDeps;
    await expect(relayWageRangeGet(deps, "c", new URLSearchParams())).rejects.toThrow();
  });
});
