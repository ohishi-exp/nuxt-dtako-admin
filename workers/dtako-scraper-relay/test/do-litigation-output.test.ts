import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// do-litigation-alc-upload.test.ts と同じ手。`cloudflare:workers` は Workers ランタイムで
// しか解決できないので、DurableObject を素のクラスで差し替えて DO を実体化する。
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
import { LITIGATION_ADMIN_FORBIDDEN } from "../src/litigation-output";
import { openLitigationD1, seedCase, seedCheck, seedDeletedCase, type SqliteD1 } from "./helpers/litigation-d1";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/**
 * 訴訟準備の 案件の削除・復活 の口 (Refs #1133 c1133-32) の**配線**。
 *
 * pure (`litigation-output.ts`) は 100% gate に載っているが、**DO が「保存済み theearth
 * セッションより前で分ける」「role を見る」「会社を record から取る」「検知結果を消さない」か
 * は gate では捕まらない** (`dtako-scraper-relay-do.ts` は allowlist の外)。D1 は
 * migrations 0017〜0019 を当てた実物の SQLite (`helpers/litigation-d1.ts`)。
 *
 * 会社・tenant・メール・案件はすべて架空。
 */
const OWN_COMP = "9999";
const OTHER_COMP = "8888";
const OWN_TENANT = "tenant-of-own-comp";
const TOKEN = "dummy-jwt";
const EMAIL = "admin@example.com";
const NOW = Date.parse("2026-10-01T03:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const ACCOUNTS = [
  { comp_id: OWN_COMP, user_name: "u1", user_pass: "p", tenant_id: OWN_TENANT },
  { comp_id: OTHER_COMP, user_name: "u2", user_pass: "p", tenant_id: "tenant-of-other-comp" },
];

const MISSING = Symbol("role キーごと欠落");

interface Setup {
  role?: unknown;
  active?: boolean;
  /** 保存済み theearth セッション (routing と token が一致する有効なもの) を置くか */
  storedSession?: boolean;
  devViewerComp?: string;
  /** D1 binding を外す (503 の確認用) */
  noDb?: boolean;
}

interface CallInit {
  json?: unknown;
  /** 生の body (JSON でない body の確認用) */
  raw?: string;
  comp?: string;
  token?: string | null;
}

let db: SqliteD1;

function makeDO(opts: Setup = {}) {
  const introspect: Record<string, unknown> = { active: opts.active ?? true, tenant_id: OWN_TENANT, email: EMAIL };
  if (opts.role !== MISSING) introspect.role = "role" in opts ? opts.role : "admin";

  const introspectCalls: unknown[] = [];
  const background: Promise<unknown>[] = [];
  const env = {
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
    ...(opts.noDb ? {} : { DTAKO_DB: db }),
    ...(opts.devViewerComp ? { RESTRAINT_DEV_VIEWER_COMP: opts.devViewerComp } : {}),
    AUTH_WORKER: {
      fetch: async (req: Request) => {
        introspectCalls.push(req.url);
        return new Response(JSON.stringify(introspect), { status: 200 });
      },
    },
  };
  const stored = opts.storedSession
    ? {
        token: TOKEN,
        compId: OWN_COMP,
        userName: "viewer",
        cookies: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      }
    : undefined;
  const ctx = {
    setWebSocketAutoResponse: () => {},
    waitUntil: (p: Promise<unknown>) => {
      background.push(p);
    },
    storage: { get: async () => stored, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const call = (method: string, path: string, init: CallInit = {}) => {
    const token = init.token === undefined ? TOKEN : init.token;
    const body = init.raw ?? (init.json === undefined ? undefined : JSON.stringify(init.json));
    return relay.fetch(
      new Request(`https://relay.example/restraint-api/${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-Theearth-Comp-Id": init.comp ?? OWN_COMP,
          // base64url("viewer")
          "X-Theearth-User-B64": "dmlld2Vy",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body }),
      }) as never,
    );
  };
  /** `ctx.waitUntil` に渡された処理 (30 日の掃除) が終わるのを待つ。 */
  const settle = () => Promise.all(background);
  return { call, introspectCalls, background, settle };
}

/** 役割を見る口 (method, path, body)。どれも OWN_COMP の `case-test-1` を指す。 */
const ADMIN_CALLS: Array<[string, string, CallInit]> = [
  ["DELETE", "litigation-cases?case_id=case-test-1", {}],
  ["GET", "litigation-cases/deleted", {}],
  ["POST", "litigation-cases/restore", { json: { caseId: "case-test-1" } }],
];

beforeEach(async () => {
  // Date だけ固定する (timers は本物のまま — crypto.subtle の await が止まる)。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  db = await openLitigationD1();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** D1 の全表の行数 (「何も変わっていない」の確認用)。 */
function snapshot() {
  return {
    cases: db.rows("SELECT comp_id, case_id FROM litigation_cases ORDER BY comp_id, case_id"),
    deleted: db.rows("SELECT comp_id, case_id FROM litigation_deleted_cases ORDER BY comp_id, case_id"),
    checks: db.count("litigation_check_results"),
  };
}

describe("役割 (admin / payroll) の前置き — 案件の削除・削除した一覧・復活", () => {
  beforeEach(() => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "case-test-2", deletedAt: iso(NOW - DAY) });
  });

  it("★ role viewer / member / undefined / 型崩れは、どの口も 403 で D1 を変えない", async () => {
    const before = snapshot();
    for (const role of ["viewer", "member", undefined, MISSING, null, 1]) {
      for (const [method, path, init] of ADMIN_CALLS) {
        const { call } = makeDO({ role });
        const res = await call(method, path, init);
        expect(res.status, `${method} ${path} role=${String(role === MISSING ? "欠落" : JSON.stringify(role))}`).toBe(403);
        expect(await res.json()).toEqual({ error: LITIGATION_ADMIN_FORBIDDEN });
      }
    }
    expect(snapshot()).toEqual(before);
  });

  it("role payroll も通る", async () => {
    const { call } = makeDO({ role: "payroll" });
    expect((await call("GET", "litigation-cases/deleted")).status).toBe(200);
    expect((await call("DELETE", "litigation-cases?case_id=case-test-1")).status).toBe(200);
    expect((await call("POST", "litigation-cases/restore", { json: { caseId: "case-test-1" } })).status).toBe(200);
  });

  it("★ 保存済み theearth セッションが在っても introspect を通して role を見る", async () => {
    for (const [method, path, init] of ADMIN_CALLS) {
      // 陰性: 保存済みセッションは有効だが introspect の role が viewer → 403
      const denied = makeDO({ storedSession: true, role: "viewer" });
      expect((await denied.call(method, path, init)).status, `${method} ${path}`).toBe(403);
      expect(denied.introspectCalls).toHaveLength(1);
    }
    // 陽性対照: 同じ保存済みセッションで introspect が admin → 通る
    for (const [method, path, init] of ADMIN_CALLS) {
      const allowed = makeDO({ storedSession: true, role: "admin" });
      expect((await allowed.call(method, path, init)).status, `${method} ${path}`).toBe(200);
      expect(allowed.introspectCalls).toHaveLength(1);
    }
  });

  it("introspect が不成立・Bearer 無し・自 tenant 外の会社は 401 (保存済みセッションに倒れない)", async () => {
    const before = snapshot();
    for (const [method, path, init] of ADMIN_CALLS) {
      const inactive = makeDO({ storedSession: true, active: false });
      expect((await inactive.call(method, path, init)).status).toBe(401);
      expect((await makeDO().call(method, path, { ...init, token: null })).status).toBe(401);
      expect((await makeDO().call(method, path, { ...init, comp: OTHER_COMP })).status).toBe(401);
    }
    expect(snapshot()).toEqual(before);
  });

  it("dev の短絡 (RESTRAINT_DEV_VIEWER_COMP) は role を持たないので 403 (introspect も呼ばない)", async () => {
    for (const [method, path, init] of ADMIN_CALLS) {
      const { call, introspectCalls } = makeDO({ devViewerComp: OWN_COMP });
      expect((await call(method, path, init)).status).toBe(403);
      expect(introspectCalls).toHaveLength(0);
    }
  });

  it("D1 binding が無ければ 503 (役割の判定の後)", async () => {
    for (const [method, path, init] of ADMIN_CALLS) {
      expect((await makeDO({ noDb: true }).call(method, path, init)).status).toBe(503);
      expect((await makeDO({ noDb: true, role: "viewer" }).call(method, path, init)).status).toBe(403);
    }
  });
});

describe("DELETE /restraint-api/litigation-cases — 削除した案件の表への移動", () => {
  it("cases から消えて deleted に入り (日時と人つき)、検知結果は残る", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
    seedCheck(db, OWN_COMP, "case-test-1");

    const res = await makeDO().call("DELETE", "litigation-cases?case_id=case-test-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    expect(db.count("litigation_cases")).toBe(0);
    expect(db.rows("SELECT comp_id, case_id, deleted_at, deleted_by FROM litigation_deleted_cases")).toEqual([
      { comp_id: OWN_COMP, case_id: "case-test-1", deleted_at: iso(NOW), deleted_by: EMAIL },
    ]);
    expect(db.count("litigation_check_results")).toBe(1);
  });

  it("★ 会社は record の compId だけ — query に別の会社を入れても、他社の同じ case_id は消えない", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
    seedCase(db, { compId: OTHER_COMP, caseId: "case-test-1" });

    const res = await makeDO().call("DELETE", `litigation-cases?case_id=case-test-1&comp_id=${OTHER_COMP}`, {
      json: { comp_id: OTHER_COMP, compId: OTHER_COMP },
    });
    expect(res.status).toBe(200);

    expect(db.rows("SELECT comp_id FROM litigation_cases")).toEqual([{ comp_id: OTHER_COMP }]);
    expect(db.rows("SELECT comp_id FROM litigation_deleted_cases")).toEqual([{ comp_id: OWN_COMP }]);
  });

  it("存在しない case_id は冪等に 200 / case_id 無しは 400", async () => {
    const { call } = makeDO();
    const res = await call("DELETE", "litigation-cases?case_id=no-such-case");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(db.count("litigation_deleted_cases")).toBe(0);
    expect((await call("DELETE", "litigation-cases")).status).toBe(400);
  });

  it("case_id の形は問わない (bind の引数にしか使わない)", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "形/に ..合わない" });
    const res = await makeDO().call("DELETE", `litigation-cases?case_id=${encodeURIComponent("形/に ..合わない")}`);
    expect(res.status).toBe(200);
    expect(db.rows("SELECT case_id FROM litigation_deleted_cases")).toEqual([{ case_id: "形/に ..合わない" }]);
  });

  it("D1 が落ちたら 502 (cases は消えない)", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.failWhen = (sql) => sql.includes("DELETE FROM litigation_cases");
    expect((await makeDO().call("DELETE", "litigation-cases?case_id=case-test-1")).status).toBe(502);
    db.failWhen = null;
    expect(db.count("litigation_cases")).toBe(1);
    expect(db.count("litigation_deleted_cases")).toBe(0);
  });
});

describe("GET /restraint-api/litigation-cases/deleted", () => {
  it("同じ会社の、削除から 30 日以内の案件を新しい順に返す", async () => {
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "d-3d", deletedAt: iso(NOW - 3 * DAY) });
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "d-1d", deletedAt: iso(NOW - DAY), deletedBy: null });
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "d-30d", deletedAt: iso(NOW - 30 * DAY) });
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "d-30d1s", deletedAt: iso(NOW - 30 * DAY - 1000) });
    seedDeletedCase(db, { compId: OTHER_COMP, caseId: "other", deletedAt: iso(NOW - DAY) });

    const res = await makeDO().call("GET", "litigation-cases/deleted");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { cases: Array<{ case: { caseId: string }; deletedAt: string; deletedBy: string | null }> };
    expect(body.cases.map((c) => c.case.caseId)).toEqual(["d-1d", "d-3d", "d-30d"]);
    expect(body.cases[0]).toEqual({
      case: {
        caseId: "d-1d",
        name: "案件 d-1d",
        fromMonth: "2025-01",
        toMonth: "2025-03",
        driverCds: ["1001", "1002"],
        memo: "メモ",
        createdBy: "creator@example.com",
        createdAt: "2025-04-01T00:00:00.000Z",
        updatedAt: "2025-04-02T00:00:00.000Z",
      },
      deletedAt: iso(NOW - DAY),
      deletedBy: null,
    });
  });

  it("D1 が落ちたら 502", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.failWhen = () => true;
    expect((await makeDO().call("GET", "litigation-cases/deleted")).status).toBe(502);
  });
});

describe("POST /restraint-api/litigation-cases/restore", () => {
  it("削除 → 復活で、案件・検知結果がそのまま戻る (一覧の応答が削除前と同じ)", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1", updatedAt: "2025-05-05T05:05:05.000Z" });
    seedCheck(db, OWN_COMP, "case-test-1");
    const { call } = makeDO();
    const listBefore = await (await call("GET", "litigation-cases")).json();
    const checksBefore = await (await call("GET", "litigation-checks?case_id=case-test-1")).json();

    expect((await call("DELETE", "litigation-cases?case_id=case-test-1")).status).toBe(200);
    expect(await (await call("GET", "litigation-cases")).json()).toEqual({ cases: [] });

    vi.setSystemTime(new Date(NOW + 29 * DAY));
    const res = await call("POST", "litigation-cases/restore", { json: { caseId: "case-test-1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restored: boolean; case: unknown };
    expect(body.restored).toBe(true);
    expect({ cases: [body.case] }).toEqual(listBefore);

    expect(await (await call("GET", "litigation-cases")).json()).toEqual(listBefore);
    expect(await (await call("GET", "litigation-checks?case_id=case-test-1")).json()).toEqual(checksBefore);
    expect(db.count("litigation_deleted_cases")).toBe(0);
  });

  it("★ 会社は record の compId だけ — body に別の会社を入れても、他社の削除した案件は戻らない", async () => {
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "case-test-1", deletedAt: iso(NOW - DAY) });
    seedDeletedCase(db, { compId: OTHER_COMP, caseId: "case-test-1", deletedAt: iso(NOW - DAY) });

    const res = await makeDO().call("POST", "litigation-cases/restore", {
      json: { caseId: "case-test-1", comp_id: OTHER_COMP, compId: OTHER_COMP },
    });
    expect(res.status).toBe(200);

    expect(db.rows("SELECT comp_id FROM litigation_cases")).toEqual([{ comp_id: OWN_COMP }]);
    expect(db.rows("SELECT comp_id FROM litigation_deleted_cases")).toEqual([{ comp_id: OTHER_COMP }]);
  });

  it("deleted の表に無い・他社のもの・30 日を過ぎたものは 404", async () => {
    seedDeletedCase(db, { compId: OTHER_COMP, caseId: "others-case", deletedAt: iso(NOW - DAY) });
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "d-30d1s", deletedAt: iso(NOW - 30 * DAY - 1000) });
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "d-30d", deletedAt: iso(NOW - 30 * DAY) });
    const { call } = makeDO();
    for (const caseId of ["no-such-case", "others-case", "d-30d1s"]) {
      expect((await call("POST", "litigation-cases/restore", { json: { caseId } })).status, caseId).toBe(404);
    }
    expect(db.count("litigation_cases")).toBe(0);
    // 陽性対照: ちょうど 30 日は戻せる
    expect((await call("POST", "litigation-cases/restore", { json: { caseId: "d-30d" } })).status).toBe(200);
  });

  it("cases に同じ case_id が既に在れば 409 (上書きしない)", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1", name: "生きている方" });
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "case-test-1", name: "削除した方", deletedAt: iso(NOW - DAY) });
    expect((await makeDO().call("POST", "litigation-cases/restore", { json: { caseId: "case-test-1" } })).status).toBe(409);
    expect(db.rows("SELECT name FROM litigation_cases")).toEqual([{ name: "生きている方" }]);
    expect(db.count("litigation_deleted_cases")).toBe(1);
  });

  it("caseId 無し・JSON でない body は 400 / D1 が落ちたら 502", async () => {
    const { call } = makeDO();
    expect((await call("POST", "litigation-cases/restore", { json: {} })).status).toBe(400);
    expect((await call("POST", "litigation-cases/restore", { raw: "not json" })).status).toBe(400);
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.failWhen = () => true;
    expect((await call("POST", "litigation-cases/restore", { json: { caseId: "case-test-1" } })).status).toBe(502);
  });
});

describe("PUT /restraint-api/litigation-cases — caseId が在って案件が無ければ 404", () => {
  const INPUT = { name: "架空の案件", fromMonth: "2025-01", toMonth: "2025-02", driverCds: ["1001"], memo: "" };

  it("★ 削除済みの caseId への PUT は 404 で、案件を作り直さない (役割は問わない)", async () => {
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "case-test-1", deletedAt: iso(NOW - DAY) });
    const res = await makeDO({ role: "viewer" }).call("PUT", "litigation-cases", { json: { ...INPUT, caseId: "case-test-1" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "案件が見つかりません (削除された可能性があります)" });
    expect(db.count("litigation_cases")).toBe(0);
    expect(db.count("litigation_deleted_cases")).toBe(1);
  });

  it("他社に在るだけの caseId も 404", async () => {
    seedCase(db, { compId: OTHER_COMP, caseId: "case-test-1" });
    const res = await makeDO().call("PUT", "litigation-cases", { json: { ...INPUT, caseId: "case-test-1" } });
    expect(res.status).toBe(404);
    expect(db.count("litigation_cases", "comp_id = ?", OWN_COMP)).toBe(0);
  });

  it("caseId 無しの新規作成・既存の更新は今までどおり (役割の制限なし)", async () => {
    const { call } = makeDO({ role: "viewer" });
    const created = await call("PUT", "litigation-cases", { json: INPUT });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { saved: boolean; case: { caseId: string; name: string; createdBy: string } };
    expect(createdBody).toMatchObject({ saved: true, case: { name: "架空の案件", createdBy: EMAIL } });

    vi.setSystemTime(new Date(NOW + 1000));
    const updated = await call("PUT", "litigation-cases", {
      json: { ...INPUT, name: "改名した案件", caseId: createdBody.case.caseId },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      saved: true,
      case: { caseId: createdBody.case.caseId, name: "改名した案件", createdAt: iso(NOW), updatedAt: iso(NOW + 1000) },
    });
    expect(db.count("litigation_cases")).toBe(1);
  });
});

describe("30 日の掃除 — 案件の一覧 (GET /restraint-api/litigation-cases) を読んだとき", () => {
  beforeEach(() => {
    seedCase(db, { compId: OWN_COMP, caseId: "live" });
    seedCheck(db, OWN_COMP, "live");
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "d-29d", deletedAt: iso(NOW - 29 * DAY) });
    seedCheck(db, OWN_COMP, "d-29d");
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "d-30d", deletedAt: iso(NOW - 30 * DAY) });
    seedCheck(db, OWN_COMP, "d-30d");
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "d-30d1s", deletedAt: iso(NOW - 30 * DAY - 1000) });
    seedCheck(db, OWN_COMP, "d-30d1s");
    seedDeletedCase(db, { compId: OTHER_COMP, caseId: "other-expired", deletedAt: iso(NOW - 60 * DAY) });
    seedCheck(db, OTHER_COMP, "other-expired");
  });

  it("★ 30 日を過ぎた案件だけ 検知結果と deleted の行が消え、29 日・ちょうど 30 日・他社は残る", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // 役割の無い viewer の読みでも起動する (起動した人の入力は何も使わない)
    const { call, background, settle } = makeDO({ role: "viewer" });
    const res = await call("GET", "litigation-cases");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cases: Array<{ caseId: string }> }).cases.map((c) => c.caseId)).toEqual(["live"]);
    expect(background).toHaveLength(1);
    await settle();

    expect(db.rows("SELECT comp_id, case_id FROM litigation_deleted_cases ORDER BY case_id")).toEqual([
      { comp_id: OWN_COMP, case_id: "d-29d" },
      { comp_id: OWN_COMP, case_id: "d-30d" },
      { comp_id: OTHER_COMP, case_id: "other-expired" },
    ]);
    expect(db.rows("SELECT comp_id, case_id FROM litigation_check_results ORDER BY case_id")).toEqual([
      { comp_id: OWN_COMP, case_id: "d-29d" },
      { comp_id: OWN_COMP, case_id: "d-30d" },
      { comp_id: OWN_COMP, case_id: "live" },
      { comp_id: OTHER_COMP, case_id: "other-expired" },
    ]);
  });

  it("掃除が落ちても案件の一覧は 200 で、応答は変わらない (失敗は構造化ログ)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    db.failWhen = (sql) => sql.includes("litigation_deleted_cases");
    const { call, settle } = makeDO();
    const res = await call("GET", "litigation-cases");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cases: unknown[] }).cases).toHaveLength(1);
    await expect(settle()).resolves.toBeDefined();
    db.failWhen = null;

    expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ litigation_sweep: "error", comp: OWN_COMP }),
    ]);
    expect(db.count("litigation_deleted_cases", "case_id = 'd-30d1s'")).toBe(1);
  });

  it("消すものが無ければ何も書かない (ログも出さない)", async () => {
    db.exec("DELETE FROM litigation_deleted_cases WHERE case_id = 'd-30d1s'");
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = snapshot();
    const { call, settle } = makeDO();
    await call("GET", "litigation-cases");
    await settle();
    expect(snapshot()).toEqual(before);
    expect(logs).not.toHaveBeenCalled();
  });
});
