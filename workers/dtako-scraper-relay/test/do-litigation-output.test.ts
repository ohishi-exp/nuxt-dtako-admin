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
import {
  LITIGATION_ADMIN_FORBIDDEN,
  LITIGATION_OUTPUT_MAX_FILE_BYTES,
  LITIGATION_OUTPUT_MAX_FILES,
} from "../src/litigation-output";
import { FakeR2 } from "./helpers/fake-r2";
import {
  openLitigationD1,
  seedCase,
  seedCheck,
  seedDeletedCase,
  seedVersion,
  type SqliteD1,
} from "./helpers/litigation-d1";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/**
 * 訴訟準備の 案件の削除・復活 と 出力の版 の口 (Refs #1133 c1133-32) の**配線**。
 *
 * pure (`litigation-output.ts`) は 100% gate に載っているが、**DO が「保存済み theearth
 * セッションより前で分ける」「role を見る」「会社を record から取る」「検知結果と版を消さない」
 * 「版を自 env の prefix で絞る」かは gate では捕まらない** (`dtako-scraper-relay-do.ts` は
 * allowlist の外)。D1 は migrations 0017〜0019 を当てた実物の SQLite
 * (`helpers/litigation-d1.ts`)、R2 は in-memory (`helpers/fake-r2.ts`)。
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
  /** R2 binding を外す (503 の確認用) */
  noBucket?: boolean;
  /** この DO の env の RESTRAINT_R2_PREFIX (既定 = 未設定 → "restraint") */
  r2Prefix?: string;
}

interface CallInit {
  json?: unknown;
  /** 生の body (JSON でない body の確認用) */
  raw?: string;
  /** バイト列の body (ファイルの PUT) */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  comp?: string;
  token?: string | null;
}

let db: SqliteD1;
let bucket: FakeR2;

function makeDO(opts: Setup = {}) {
  const introspect: Record<string, unknown> = { active: opts.active ?? true, tenant_id: OWN_TENANT, email: EMAIL };
  if (opts.role !== MISSING) introspect.role = "role" in opts ? opts.role : "admin";

  const introspectCalls: unknown[] = [];
  const background: Promise<unknown>[] = [];
  const env = {
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
    ...(opts.noDb ? {} : { DTAKO_DB: db }),
    ...(opts.noBucket ? {} : { DTAKO_R2: bucket }),
    ...(opts.r2Prefix ? { RESTRAINT_R2_PREFIX: opts.r2Prefix } : {}),
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
    const body = init.bytes ?? init.raw ?? (init.json === undefined ? undefined : JSON.stringify(init.json));
    return relay.fetch(
      new Request(`https://relay.example/restraint-api/${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-Theearth-Comp-Id": init.comp ?? OWN_COMP,
          // base64url("viewer")
          "X-Theearth-User-B64": "dmlld2Vy",
          "content-type": init.bytes ? "application/octet-stream" : "application/json",
          ...init.headers,
        },
        ...(body === undefined ? {} : { body }),
      }) as never,
    );
  };
  /** `ctx.waitUntil` に渡された処理 (30 日の掃除) が終わるのを待つ。 */
  const settle = () => Promise.all(background);
  return { call, introspectCalls, background, settle };
}

const V_SEED = "20260901T000000Z-seed00";
const FILE_QUERY = `case_id=case-out-1&version_id=${V_SEED}&name=a.xlsx`;

/**
 * 役割を見る 8 口 (method, path, body)。先頭 3 つは案件 `case-test-1` / `case-test-2` を、
 * 出力の 5 口は案件 `case-out-1` (版 `V_SEED`・ファイル `a.xlsx` を seed 済み) を指す —
 * 先頭の DELETE が出力の口の前提 (案件が cases に在る) を壊さないよう分けてある。
 */
const ADMIN_CALLS: Array<[string, string, CallInit]> = [
  ["DELETE", "litigation-cases?case_id=case-test-1", {}],
  ["GET", "litigation-cases/deleted", {}],
  ["POST", "litigation-cases/restore", { json: { caseId: "case-test-2" } }],
  ["POST", "litigation-outputs", { json: { caseId: "case-out-1", results: { ok: true } } }],
  ["PUT", `litigation-outputs/file?${FILE_QUERY}`, { bytes: new Uint8Array([1, 2, 3]) }],
  ["GET", "litigation-outputs?case_id=case-out-1", {}],
  ["GET", `litigation-outputs?case_id=case-out-1&version_id=${V_SEED}`, {}],
  ["GET", `litigation-outputs/file?${FILE_QUERY}`, {}],
];

/** `ADMIN_CALLS` の 8 口が 200 を返せる状態を作る。 */
async function seedForAdminCalls() {
  seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
  seedDeletedCase(db, { compId: OWN_COMP, caseId: "case-test-2", deletedAt: iso(NOW - DAY) });
  seedCase(db, { compId: OWN_COMP, caseId: "case-out-1" });
  const [key] = seedVersion(db, {
    compId: OWN_COMP,
    caseId: "case-out-1",
    versionId: V_SEED,
    r2Prefix: "restraint",
    files: ["a.xlsx"],
  });
  await bucket.put(key!, new Uint8Array([9, 9, 9]));
}

beforeEach(async () => {
  // Date だけ固定する (timers は本物のまま — crypto.subtle の await が止まる)。
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  db = await openLitigationD1();
  bucket = new FakeR2();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** D1 の全表と R2 の中身 (「何も変わっていない」の確認用)。 */
function snapshot() {
  return {
    cases: db.rows("SELECT comp_id, case_id FROM litigation_cases ORDER BY comp_id, case_id"),
    deleted: db.rows("SELECT comp_id, case_id FROM litigation_deleted_cases ORDER BY comp_id, case_id"),
    checks: db.count("litigation_check_results"),
    versions: db.rows("SELECT comp_id, case_id, version_id FROM litigation_output_versions ORDER BY 1, 2, 3"),
    files: db.rows("SELECT version_id, storage_name, sha256 FROM litigation_output_files ORDER BY 1, 2"),
    r2: bucket.keys(),
  };
}

describe("役割 (admin / payroll) の前置き — 案件の削除・削除した一覧・復活・出力の 5 口", () => {
  beforeEach(seedForAdminCalls);

  it("8 口ぶん在る", () => {
    expect(ADMIN_CALLS).toHaveLength(8);
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

  it("role admin / payroll は 8 口とも 200", async () => {
    for (const role of ["admin", "payroll"]) {
      db = await openLitigationD1();
      bucket = new FakeR2();
      await seedForAdminCalls();
      for (const [method, path, init] of ADMIN_CALLS) {
        expect((await makeDO({ role }).call(method, path, init)).status, `${role} ${method} ${path}`).toBe(200);
      }
    }
  });

  it("★ 保存済み theearth セッションが在っても introspect を通して role を見る", async () => {
    for (const [method, path, init] of ADMIN_CALLS) {
      // 陰性: 保存済みセッションは有効だが introspect の role が viewer → 403
      const denied = makeDO({ storedSession: true, role: "viewer" });
      expect((await denied.call(method, path, init)).status, `${method} ${path}`).toBe(403);
      expect(denied.introspectCalls).toHaveLength(1);
    }
    // 陽性対照: 同じ保存済みセッションで introspect が admin → 通る
    db = await openLitigationD1();
    bucket = new FakeR2();
    await seedForAdminCalls();
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

  it("R2 binding が無ければ、ファイルの上げ下げだけ 503 (版の作成・一覧は D1 だけで動く)", async () => {
    const { call } = makeDO({ noBucket: true });
    expect((await call("PUT", `litigation-outputs/file?${FILE_QUERY}`, { bytes: new Uint8Array([1]) })).status).toBe(503);
    expect((await call("GET", `litigation-outputs/file?${FILE_QUERY}`)).status).toBe(503);
    expect((await call("GET", "litigation-outputs?case_id=case-out-1")).status).toBe(200);
    expect((await call("POST", "litigation-outputs", { json: { caseId: "case-out-1", results: {} } })).status).toBe(200);
  });
});

describe("DELETE /restraint-api/litigation-cases — 削除した案件の表への移動", () => {
  it("cases から消えて deleted に入り (日時と人つき)、検知結果と版 (R2 のファイルも) は残る", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
    seedCheck(db, OWN_COMP, "case-test-1");
    const keys = seedVersion(db, {
      compId: OWN_COMP,
      caseId: "case-test-1",
      versionId: V_SEED,
      r2Prefix: "restraint",
      files: ["a.xlsx", "b.csv"],
    });
    for (const key of keys) await bucket.put(key, new Uint8Array([1]));

    const res = await makeDO().call("DELETE", "litigation-cases?case_id=case-test-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    expect(db.count("litigation_cases")).toBe(0);
    expect(db.rows("SELECT comp_id, case_id, deleted_at, deleted_by FROM litigation_deleted_cases")).toEqual([
      { comp_id: OWN_COMP, case_id: "case-test-1", deleted_at: iso(NOW), deleted_by: EMAIL },
    ]);
    expect(db.count("litigation_check_results")).toBe(1);
    expect(db.count("litigation_output_versions")).toBe(1);
    expect(db.count("litigation_output_files")).toBe(2);
    expect(bucket.keys()).toEqual([...keys].sort());
    expect(bucket.deleteCalls).toEqual([]);
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

// ===========================================================================
// 出力の版
// ===========================================================================

const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** 決定的な「乱数」バイト列 (中身に意味は無い)。 */
function fakeBytes(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

type DO = ReturnType<typeof makeDO>;

async function createVersion(relay: DO, caseId: string, results: unknown = { rows: [] }): Promise<string> {
  const res = await relay.call("POST", "litigation-outputs", { json: { caseId, results } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { versionId: string }).versionId;
}

const fileQuery = (caseId: string, versionId: string, name: string, label?: string) =>
  `case_id=${caseId}&version_id=${versionId}&name=${name}${label ? `&label=${encodeURIComponent(label)}` : ""}`;

describe("出力の版 — 作成 → ファイルの上げ → 一覧 → 取り出し", () => {
  beforeEach(() => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
  });

  it("★ 上げたファイルが同じバイト列で返り、sha256 と大きさが一覧・応答・R2 で一致する", async () => {
    const relay = makeDO();
    const created = await relay.call("POST", "litigation-outputs", {
      json: { caseId: "case-test-1", results: { rows: [{ driverCd: "1001", ok: true }] } },
    });
    expect(created.status).toBe(200);
    const { versionId, createdAt } = (await created.json()) as { versionId: string; createdAt: string };
    expect(versionId).toMatch(/^20261001T030000Z-[0-9a-z]{6}$/);
    expect(createdAt).toBe(iso(NOW));
    expect(db.rows("SELECT comp_id, case_id, r2_prefix, created_by FROM litigation_output_versions")).toEqual([
      { comp_id: OWN_COMP, case_id: "case-test-1", r2_prefix: "restraint", created_by: EMAIL },
    ]);

    const xlsx = fakeBytes(300_000, 1);
    const csv = new TextEncoder().encode("乗務員CD,変更\n1001,架空\n");
    vi.setSystemTime(new Date(NOW + 1000));
    const put = await relay.call("PUT", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "y-time_1001_2025-01.xlsx", "乗務員A 2025年1月.xlsx")}`, { bytes: xlsx });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ name: "y-time_1001_2025-01.xlsx", size: 300_000, sha256: await sha256Hex(xlsx) });
    expect((await relay.call("PUT", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "changes.csv")}`, { bytes: csv })).status).toBe(200);

    // R2 のキーの形 (自 env の prefix / 会社 / litigation / 案件 / 版 / 保存用の名前)
    expect(bucket.keys()).toEqual([
      `restraint/${OWN_COMP}/litigation/case-test-1/${versionId}/changes.csv`,
      `restraint/${OWN_COMP}/litigation/case-test-1/${versionId}/y-time_1001_2025-01.xlsx`,
    ]);

    // 一覧 (results と R2 のキーは含めない)
    const list = await relay.call("GET", "litigation-outputs?case_id=case-test-1");
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const listBody = await list.json();
    expect(listBody).toEqual({
      versions: [
        {
          versionId,
          createdAt: iso(NOW),
          createdBy: EMAIL,
          files: [
            { name: "changes.csv", label: "changes.csv", size: csv.byteLength, sha256: await sha256Hex(csv), uploadedAt: iso(NOW + 1000) },
            { name: "y-time_1001_2025-01.xlsx", label: "乗務員A 2025年1月.xlsx", size: 300_000, sha256: await sha256Hex(xlsx), uploadedAt: iso(NOW + 1000) },
          ],
        },
      ],
    });
    expect(JSON.stringify(listBody)).not.toContain("restraint/");

    // 1 件 (results つき)
    const one = await relay.call("GET", `litigation-outputs?case_id=case-test-1&version_id=${versionId}`);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({
      version: {
        ...(listBody as { versions: unknown[] }).versions[0]!,
        results: { rows: [{ driverCd: "1001", ok: true }] },
      },
    });

    // 取り出し: 同じバイト列
    const got = await relay.call("GET", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "y-time_1001_2025-01.xlsx")}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(got.headers.get("content-disposition")).toBe('attachment; filename="y-time_1001_2025-01.xlsx"');
    expect(got.headers.get("cache-control")).toBe("no-store");
    const back = new Uint8Array(await got.arrayBuffer());
    expect(back.byteLength).toBe(xlsx.byteLength);
    expect(await sha256Hex(back)).toBe(await sha256Hex(xlsx));
    const gotCsv = await relay.call("GET", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "changes.csv")}`);
    expect(gotCsv.headers.get("content-type")).toBe("text/csv");
    expect(await gotCsv.text()).toBe("乗務員CD,変更\n1001,架空\n");
  });

  it("1 回の出力 = 1 版 (上書きしない)。一覧は新しい順", async () => {
    const relay = makeDO();
    const v1 = await createVersion(relay, "case-test-1");
    vi.setSystemTime(new Date(NOW + 60_000));
    const v2 = await createVersion(relay, "case-test-1");
    expect(v2).not.toBe(v1);
    const body = (await (await relay.call("GET", "litigation-outputs?case_id=case-test-1")).json()) as {
      versions: Array<{ versionId: string }>;
    };
    expect(body.versions.map((v) => v.versionId)).toEqual([v2, v1]);
  });

  it("同名の上げ直しは上書き (行は 1 つ、中身は新しい方)", async () => {
    const relay = makeDO();
    const versionId = await createVersion(relay, "case-test-1");
    const q = fileQuery("case-test-1", versionId, "a.xlsx");
    await relay.call("PUT", `litigation-outputs/file?${q}`, { bytes: new Uint8Array([1, 1, 1]) });
    await relay.call("PUT", `litigation-outputs/file?${q}`, { bytes: new Uint8Array([2, 2]) });
    expect(db.rows("SELECT storage_name, size FROM litigation_output_files")).toEqual([{ storage_name: "a.xlsx", size: 2 }]);
    const got = await relay.call("GET", `litigation-outputs/file?${q}`);
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([2, 2]);
  });

  it("★ 上限超えは 413 — content-length が超えていれば読む前に、無ければ読んだ長さで", async () => {
    const relay = makeDO();
    const versionId = await createVersion(relay, "case-test-1");
    const q = fileQuery("case-test-1", versionId, "a.xlsx");
    // content-length の申告が上限超え (body は小さい) → 読まずに 413
    const declared = await relay.call("PUT", `litigation-outputs/file?${q}`, {
      bytes: new Uint8Array([1]),
      headers: { "content-length": String(LITIGATION_OUTPUT_MAX_FILE_BYTES + 1) },
    });
    expect(declared.status).toBe(413);
    // 申告なしで実際の長さが上限超え → 413
    const actual = await relay.call("PUT", `litigation-outputs/file?${q}`, {
      bytes: new Uint8Array(LITIGATION_OUTPUT_MAX_FILE_BYTES + 1),
    });
    expect(actual.status).toBe(413);
    expect(bucket.keys()).toEqual([]);
    expect(db.count("litigation_output_files")).toBe(0);
    // 陽性対照: 同じ口・同じ版に小さいファイルは入る
    expect((await relay.call("PUT", `litigation-outputs/file?${q}`, { bytes: new Uint8Array([1]) })).status).toBe(200);
  });

  it("1 版のファイルは 300 個まで (同名の上書きは 300 個在っても通る)", async () => {
    const relay = makeDO();
    const versionId = await createVersion(relay, "case-test-1");
    for (let i = 0; i < LITIGATION_OUTPUT_MAX_FILES; i++) {
      db.exec(
        `INSERT INTO litigation_output_files
           (comp_id, case_id, version_id, storage_name, label, size, sha256, r2_key, uploaded_at)
         VALUES (?, 'case-test-1', ?, ?, 'x', 1, 'sha', 'k', '2026-09-01T00:00:00.000Z')`,
        OWN_COMP,
        versionId,
        `f${i}.xlsx`,
      );
    }
    const over = await relay.call("PUT", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "one-more.xlsx")}`, {
      bytes: new Uint8Array([1]),
    });
    expect(over.status).toBe(400);
    expect(bucket.keys()).toEqual([]);
    const overwrite = await relay.call("PUT", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "f0.xlsx")}`, {
      bytes: new Uint8Array([1]),
    });
    expect(overwrite.status).toBe(200);
  });

  it("形に合わない case_id / version_id / name / label・空の body・results 無しは 400", async () => {
    const relay = makeDO();
    const versionId = await createVersion(relay, "case-test-1");
    const bytes = new Uint8Array([1]);
    const bad: Array<[string, string, CallInit]> = [
      ["POST", "litigation-outputs", { json: { caseId: "a/b", results: {} } }],
      ["POST", "litigation-outputs", { json: { caseId: "case-test-1" } }],
      ["POST", "litigation-outputs", { raw: "not json" }],
      ["GET", "litigation-outputs", {}],
      ["GET", `litigation-outputs?case_id=${encodeURIComponent("a/b")}`, {}],
      ["GET", "litigation-outputs?case_id=case-test-1&version_id=v-1", {}],
      ["PUT", `litigation-outputs/file?${fileQuery(encodeURIComponent("../x"), versionId, "a.xlsx")}`, { bytes }],
      ["PUT", `litigation-outputs/file?${fileQuery("case-test-1", "nope", "a.xlsx")}`, { bytes }],
      ["PUT", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "a.txt")}`, { bytes }],
      ["PUT", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "v-a.xlsx")}`, { bytes }],
      ["PUT", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "a.xlsx", "x".repeat(201))}`, { bytes }],
      ["PUT", `litigation-outputs/file?${fileQuery("case-test-1", versionId, "a.xlsx")}`, { bytes: new Uint8Array(0) }],
      ["PUT", `litigation-outputs/file?case_id=case-test-1&version_id=${versionId}`, { bytes }],
      ["GET", `litigation-outputs/file?${fileQuery("case-test-1", versionId, encodeURIComponent("../a.xlsx"))}`, {}],
      ["GET", `litigation-outputs/file?${fileQuery("case-test-1", "nope", "a.xlsx")}`, {}],
    ];
    for (const [method, path, init] of bad) {
      expect((await relay.call(method, path, init)).status, `${method} ${path}`).toBe(400);
    }
    expect(bucket.keys()).toEqual([]);
    expect(db.count("litigation_output_versions")).toBe(1);
  });

  it("★ R2 のキーに使えない case_id (csv・v-…) の案件は、版を作る前に 400 (行も作らない)", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "csv" });
    seedCase(db, { compId: OWN_COMP, caseId: "v-20260101T000000" });
    const relay = makeDO();
    for (const caseId of ["csv", "v-20260101T000000"]) {
      expect((await relay.call("POST", "litigation-outputs", { json: { caseId, results: {} } })).status, caseId).toBe(400);
    }
    expect(db.count("litigation_output_versions")).toBe(0);
  });

  it("ファイルの行は在るが R2 に実体が無ければ 404 / 無い版・無いファイルも 404", async () => {
    const relay = makeDO();
    seedVersion(db, { compId: OWN_COMP, caseId: "case-test-1", versionId: V_SEED, r2Prefix: "restraint", files: ["a.xlsx"] });
    expect((await relay.call("GET", `litigation-outputs/file?${fileQuery("case-test-1", V_SEED, "a.xlsx")}`)).status).toBe(404);
    expect((await relay.call("GET", `litigation-outputs/file?${fileQuery("case-test-1", V_SEED, "b.xlsx")}`)).status).toBe(404);
    const unknown = "20260101T000000Z-zzzzzz";
    expect((await relay.call("GET", `litigation-outputs?case_id=case-test-1&version_id=${unknown}`)).status).toBe(404);
    expect(
      (await relay.call("PUT", `litigation-outputs/file?${fileQuery("case-test-1", unknown, "a.xlsx")}`, { bytes: new Uint8Array([1]) })).status,
    ).toBe(404);
  });

  it("D1 が落ちたら 502 (構造化ログ)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const relay = makeDO();
    db.failWhen = (sql) => sql.includes("litigation_output_versions");
    expect((await relay.call("POST", "litigation-outputs", { json: { caseId: "case-test-1", results: {} } })).status).toBe(502);
    expect((await relay.call("GET", "litigation-outputs?case_id=case-test-1")).status).toBe(502);
    expect(JSON.parse(String(errors.mock.calls[0]![0]))).toMatchObject({ litigation_outputs: "error" });
  });
});

describe("出力の版 — 会社と env の軸", () => {
  it("★ 他社の案件 (とその版・ファイル) は、5 口とも 404", async () => {
    seedCase(db, { compId: OTHER_COMP, caseId: "case-other-1" });
    const [key] = seedVersion(db, { compId: OTHER_COMP, caseId: "case-other-1", versionId: V_SEED, r2Prefix: "restraint", files: ["a.xlsx"] });
    await bucket.put(key!, new Uint8Array([9]));
    const before = snapshot();
    const relay = makeDO();
    const q = fileQuery("case-other-1", V_SEED, "a.xlsx");
    const calls: Array<[string, string, CallInit]> = [
      ["POST", "litigation-outputs", { json: { caseId: "case-other-1", results: {} } }],
      ["PUT", `litigation-outputs/file?${q}`, { bytes: new Uint8Array([1]) }],
      ["GET", "litigation-outputs?case_id=case-other-1", {}],
      ["GET", `litigation-outputs?case_id=case-other-1&version_id=${V_SEED}`, {}],
      ["GET", `litigation-outputs/file?${q}`, {}],
    ];
    for (const [method, path, init] of calls) {
      expect((await relay.call(method, path, init)).status, `${method} ${path}`).toBe(404);
    }
    expect(snapshot()).toEqual(before);
  });

  it("★ 会社は record の compId だけ — body・query に別の会社を入れても、自社の案件に自社の版が付く", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
    seedCase(db, { compId: OTHER_COMP, caseId: "case-test-1" });
    const [otherKey] = seedVersion(db, { compId: OTHER_COMP, caseId: "case-test-1", versionId: V_SEED, r2Prefix: "restraint", files: ["a.xlsx"] });
    await bucket.put(otherKey!, new Uint8Array([9, 9]));
    const relay = makeDO();

    const created = await relay.call("POST", "litigation-outputs", {
      json: { caseId: "case-test-1", results: {}, comp_id: OTHER_COMP, compId: OTHER_COMP },
    });
    const { versionId } = (await created.json()) as { versionId: string };
    expect(db.rows("SELECT comp_id FROM litigation_output_versions WHERE version_id = ?", versionId)).toEqual([
      { comp_id: OWN_COMP },
    ]);

    const put = await relay.call(
      "PUT",
      `litigation-outputs/file?${fileQuery("case-test-1", versionId, "a.xlsx")}&comp_id=${OTHER_COMP}&compId=${OTHER_COMP}`,
      { bytes: new Uint8Array([1, 2]) },
    );
    expect(put.status).toBe(200);
    expect(bucket.keys()).toEqual([otherKey, `restraint/${OWN_COMP}/litigation/case-test-1/${versionId}/a.xlsx`].sort());

    // 他社の版 (同じ case_id) は、query で会社を名指ししても見えない・取れない
    const list = (await (await relay.call("GET", `litigation-outputs?case_id=case-test-1&comp_id=${OTHER_COMP}`)).json()) as {
      versions: Array<{ versionId: string }>;
    };
    expect(list.versions.map((v) => v.versionId)).toEqual([versionId]);
    expect(
      (await relay.call("GET", `litigation-outputs/file?${fileQuery("case-test-1", V_SEED, "a.xlsx")}&comp_id=${OTHER_COMP}`)).status,
    ).toBe(404);
    expect((await relay.call("GET", `litigation-outputs?case_id=case-test-1&version_id=${V_SEED}&comp_id=${OTHER_COMP}`)).status).toBe(404);
  });

  it("★ 他 env の prefix の版は、一覧に出ず・1 件も取れず・ファイルも上げ下げできない (D1 と bucket は env 共用)", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
    const staging = makeDO({ r2Prefix: "restraint-staging" });
    const prod = makeDO();
    const stagingVersion = await createVersion(staging, "case-test-1");
    const q = fileQuery("case-test-1", stagingVersion, "a.xlsx");
    expect((await staging.call("PUT", `litigation-outputs/file?${q}`, { bytes: new Uint8Array([5, 5]) })).status).toBe(200);
    expect(bucket.keys()).toEqual([`restraint-staging/${OWN_COMP}/litigation/case-test-1/${stagingVersion}/a.xlsx`]);
    vi.setSystemTime(new Date(NOW + 60_000));
    const prodVersion = await createVersion(prod, "case-test-1");

    // 本番 (prefix = restraint) から
    const prodList = (await (await prod.call("GET", "litigation-outputs?case_id=case-test-1")).json()) as {
      versions: Array<{ versionId: string; files: unknown[] }>;
    };
    expect(prodList.versions).toEqual([expect.objectContaining({ versionId: prodVersion, files: [] })]);
    expect((await prod.call("GET", `litigation-outputs?case_id=case-test-1&version_id=${stagingVersion}`)).status).toBe(404);
    expect((await prod.call("GET", `litigation-outputs/file?${q}`)).status).toBe(404);
    expect((await prod.call("PUT", `litigation-outputs/file?${q}`, { bytes: new Uint8Array([6]) })).status).toBe(404);

    // 陽性対照: staging (作った env) からは見える・取れる
    const stagingList = (await (await staging.call("GET", "litigation-outputs?case_id=case-test-1")).json()) as {
      versions: Array<{ versionId: string; files: Array<{ name: string }> }>;
    };
    expect(stagingList.versions).toEqual([expect.objectContaining({ versionId: stagingVersion })]);
    expect(stagingList.versions[0]!.files.map((f) => f.name)).toEqual(["a.xlsx"]);
    const got = await staging.call("GET", `litigation-outputs/file?${q}`);
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([5, 5]);
  });
});

describe("出力の版 — 案件の削除と復活", () => {
  it("★ 削除した案件の版・ファイルは復活するまで取れず (404)、復活すると版の一覧と中身が同じに戻る", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
    const relay = makeDO();
    const versionId = await createVersion(relay, "case-test-1", { rows: [1] });
    const q = fileQuery("case-test-1", versionId, "a.xlsx");
    const bytes = fakeBytes(50_000, 3);
    await relay.call("PUT", `litigation-outputs/file?${q}`, { bytes });
    const listBefore = await (await relay.call("GET", "litigation-outputs?case_id=case-test-1")).json();
    const oneBefore = await (await relay.call("GET", `litigation-outputs?case_id=case-test-1&version_id=${versionId}`)).json();

    expect((await relay.call("DELETE", "litigation-cases?case_id=case-test-1")).status).toBe(200);
    const whileDeleted: Array<[string, string, CallInit]> = [
      ["POST", "litigation-outputs", { json: { caseId: "case-test-1", results: {} } }],
      ["PUT", `litigation-outputs/file?${q}`, { bytes: new Uint8Array([1]) }],
      ["GET", "litigation-outputs?case_id=case-test-1", {}],
      ["GET", `litigation-outputs?case_id=case-test-1&version_id=${versionId}`, {}],
      ["GET", `litigation-outputs/file?${q}`, {}],
    ];
    for (const [method, path, init] of whileDeleted) {
      expect((await relay.call(method, path, init)).status, `${method} ${path}`).toBe(404);
    }

    vi.setSystemTime(new Date(NOW + 10 * DAY));
    expect((await relay.call("POST", "litigation-cases/restore", { json: { caseId: "case-test-1" } })).status).toBe(200);
    expect(await (await relay.call("GET", "litigation-outputs?case_id=case-test-1")).json()).toEqual(listBefore);
    expect(await (await relay.call("GET", `litigation-outputs?case_id=case-test-1&version_id=${versionId}`)).json()).toEqual(oneBefore);
    const got = new Uint8Array(await (await relay.call("GET", `litigation-outputs/file?${q}`)).arrayBuffer());
    expect(await sha256Hex(got)).toBe(await sha256Hex(bytes));
  });
});

describe("30 日の掃除 — 版と R2 のファイル", () => {
  const V = (n: number) => `2026080${n}T000000Z-aaaaaa`;
  let expiredKeys: string[][];
  let freshKeys: string[];

  beforeEach(async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "live" });
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "expired", deletedAt: iso(NOW - 30 * DAY - 1000) });
    seedCheck(db, OWN_COMP, "expired");
    seedDeletedCase(db, { compId: OWN_COMP, caseId: "fresh", deletedAt: iso(NOW - 29 * DAY) });
    seedCheck(db, OWN_COMP, "fresh");
    // 期限切れの案件に版 4 つ (うち 1 つは別 env の prefix、1 つはファイルなし)
    expiredKeys = [
      seedVersion(db, { compId: OWN_COMP, caseId: "expired", versionId: V(1), r2Prefix: "restraint", files: ["a.xlsx", "b.csv"] }),
      seedVersion(db, { compId: OWN_COMP, caseId: "expired", versionId: V(2), r2Prefix: "restraint-staging", files: ["a.xlsx"] }),
      seedVersion(db, { compId: OWN_COMP, caseId: "expired", versionId: V(3), r2Prefix: "restraint" }),
      seedVersion(db, { compId: OWN_COMP, caseId: "expired", versionId: V(4), r2Prefix: "restraint", files: ["a.xlsx"] }),
    ];
    freshKeys = seedVersion(db, { compId: OWN_COMP, caseId: "fresh", versionId: V(1), r2Prefix: "restraint", files: ["a.xlsx"] });
    for (const key of [...expiredKeys.flat(), ...freshKeys]) await bucket.put(key, new Uint8Array([1]));
  });

  const sweep = async (opts: Setup = {}) => {
    const relay = makeDO(opts);
    expect((await relay.call("GET", "litigation-cases")).status).toBe(200);
    await relay.settle();
  };
  const versionsOf = (caseId: string) =>
    db.rows("SELECT version_id FROM litigation_output_versions WHERE case_id = ? ORDER BY 1", caseId).map((r) => r.version_id);

  it("★ 1 回に 3 版まで。R2 は版ごとにキーをまとめて消す。版が残るあいだ deleted の行と検知結果は残る", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await sweep({ role: "viewer" });

    expect(versionsOf("expired")).toEqual([V(4)]);
    expect(bucket.deleteCalls).toEqual([expiredKeys[0], expiredKeys[1]]); // ファイルなしの版は R2 を呼ばない
    expect(bucket.keys()).toEqual([...expiredKeys[3]!, ...freshKeys].sort());
    expect(db.count("litigation_output_files", "case_id = 'expired'")).toBe(1);
    expect(db.count("litigation_deleted_cases", "case_id = 'expired'")).toBe(1);
    expect(db.count("litigation_check_results", "case_id = 'expired'")).toBe(1);

    // 2 回目: 残りの版が消え、版が無くなった案件の 検知結果と deleted の行も消える
    await sweep();
    expect(versionsOf("expired")).toEqual([]);
    expect(db.count("litigation_output_files", "case_id = 'expired'")).toBe(0);
    expect(db.count("litigation_deleted_cases", "case_id = 'expired'")).toBe(0);
    expect(db.count("litigation_check_results", "case_id = 'expired'")).toBe(0);

    // 29 日の案件は 版・ファイル・R2・検知結果・deleted の行が全部残る
    expect(versionsOf("fresh")).toEqual([V(1)]);
    expect(bucket.keys()).toEqual(freshKeys);
    expect(db.count("litigation_output_files", "case_id = 'fresh'")).toBe(1);
    expect(db.count("litigation_deleted_cases", "case_id = 'fresh'")).toBe(1);
    expect(db.count("litigation_check_results", "case_id = 'fresh'")).toBe(1);
  });

  it("★ R2 の削除が失敗した版は行が残り (次回に回す)、他の版は進む。案件の行も残る", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    bucket.failDelete = (keys) => keys.some((k) => k.includes(`/${V(1)}/`));
    await sweep();

    expect(versionsOf("expired")).toEqual([V(1), V(4)]);
    expect(db.count("litigation_output_files", "case_id = 'expired' AND version_id = ?", V(1))).toBe(2);
    expect(bucket.keys()).toEqual([...expiredKeys[0]!, ...expiredKeys[3]!, ...freshKeys].sort());
    expect(db.count("litigation_deleted_cases", "case_id = 'expired'")).toBe(1);
    expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ litigation_sweep: "r2-delete-failed", case_id: "expired", version_id: V(1) }),
    ]);

    // R2 が直れば次回以降に消える
    bucket.failDelete = null;
    await sweep();
    await sweep();
    expect(versionsOf("expired")).toEqual([]);
    expect(db.count("litigation_deleted_cases", "case_id = 'expired'")).toBe(0);
    expect(bucket.keys()).toEqual(freshKeys);
  });

  it("R2 binding が無い env では、ファイルを持つ版の行を消さない (孤児を作らない)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await sweep({ noBucket: true });
    expect(versionsOf("expired")).toEqual([V(1), V(2), V(4)]); // ファイルなしの V(3) だけ消える
    expect(bucket.keys()).toHaveLength(5);
  });
});

describe("既存の 7 日 prune と CSV ダウンロードの口に当たらない", () => {
  it("★ 出力のファイルを置いたまま wage-master の prune を走らせても消えない (陽性対照: wage-master の最古の版は消える)", async () => {
    seedCase(db, { compId: OWN_COMP, caseId: "case-test-1" });
    const relay = makeDO();
    const T0 = Date.parse("2026-08-01T00:00:00.000Z");
    vi.setSystemTime(new Date(T0));
    const versionId = await createVersion(relay, "case-test-1");
    const q = fileQuery("case-test-1", versionId, "changes.csv");
    await relay.call("PUT", `litigation-outputs/file?${q}`, { bytes: new Uint8Array([1, 2, 3]) });
    const outputKey = `restraint/${OWN_COMP}/litigation/case-test-1/${versionId}/changes.csv`;
    expect(bucket.keys()).toEqual([outputKey]);

    // wage-master-route-allowance-rate.test.ts と同じ 3 回の PUT (T0 / +1 日 / +9 日) で prune を起こす
    for (const [i, at] of [T0, T0 + DAY, T0 + 9 * DAY].entries()) {
      vi.setSystemTime(new Date(at));
      const res = await relay.call("PUT", "wage-master", {
        json: { drivers: { "1001": { rates: [{ effectiveFrom: "2026-04-01", hourlyRate: 1000 + i }] } } },
      });
      expect(await res.json()).toMatchObject({ saved: true, changed: true });
    }
    const wageVersions = bucket.keys().filter((k) => k.startsWith(`restraint/${OWN_COMP}/wage-master/v-`));
    expect(wageVersions).toHaveLength(2); // 陽性対照: 3 本のうち最古が prune で消えた

    expect(bucket.keys()).toContain(outputKey);
    const got = await relay.call("GET", `litigation-outputs/file?${q}`);
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([1, 2, 3]);

    // 役割の制限が無い CSV ダウンロードの口に、出力のキーを渡しても取れない
    const viaCsv = await makeDO({ role: "viewer" }).call("GET", `archive/csv?key=${encodeURIComponent(outputKey)}`);
    expect(viaCsv.status).toBe(400);
  });
});
