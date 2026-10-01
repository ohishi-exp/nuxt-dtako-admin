import { beforeEach, describe, expect, it } from "vitest";
import type { D1Statement } from "../src/litigation-case";
import { buildLitigationCaseGetStatement } from "../src/litigation-case";
import {
  buildLitigationCaseMoveToDeletedStatements,
  buildLitigationCaseRestoreStatements,
  buildLitigationDeletedCaseGetStatement,
  buildLitigationDeletedCaseListResponse,
  buildLitigationDeletedCaseListStatement,
  buildLitigationExpiredCaseListStatement,
  buildLitigationExpiredCasePurgeStatements,
  isLitigationAdminRoute,
  LITIGATION_ADMIN_FORBIDDEN,
  LITIGATION_DELETED_RETENTION_DAYS,
  LITIGATION_SWEEP_MAX_CASES,
  litigationDeletedCutoffIso,
  type LitigationDeletedCaseD1Row,
} from "../src/litigation-output";
import { openLitigationD1, seedCase, seedCheck, seedDeletedCase, type SqliteD1 } from "./helpers/litigation-d1";

/**
 * `src/litigation-output.ts` (Refs #1133 c1133-32)。**D1 の文は、migrations 0017〜0019 を
 * 当てた実物の SQLite で実行して結果を見る** (`helpers/litigation-d1.ts`)。文字列の一致では
 * 列の数・条件の向きの間違いが捕まらないため。会社・案件・メールは架空。
 */
const COMP = "9999";
const OTHER_COMP = "8888";
const NOW = Date.parse("2026-10-01T03:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
const CUTOFF = litigationDeletedCutoffIso(NOW);

let db: SqliteD1;
beforeEach(async () => {
  db = await openLitigationD1();
});

const all = async <T>(s: D1Statement) => (await db.prepare(s.sql).bind(...s.params).all<T>()).results;
const first = <T>(s: D1Statement) => db.prepare(s.sql).bind(...s.params).first<T>();
const batch = (list: D1Statement[]) => db.batch(list.map((s) => db.prepare(s.sql).bind(...s.params)));

describe("役割を見る口の一覧 (isLitigationAdminRoute)", () => {
  it("案件の DELETE・削除した一覧・復活だけが当たる (method と path の組)", () => {
    expect(isLitigationAdminRoute("DELETE", "/restraint-api/litigation-cases")).toBe(true);
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-cases/deleted")).toBe(true);
    expect(isLitigationAdminRoute("POST", "/restraint-api/litigation-cases/restore")).toBe(true);
  });

  it("案件の GET / PUT・検知結果・method 違いは当たらない (役割の制限を広げない)", () => {
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-cases")).toBe(false);
    expect(isLitigationAdminRoute("PUT", "/restraint-api/litigation-cases")).toBe(false);
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-checks")).toBe(false);
    expect(isLitigationAdminRoute("PUT", "/restraint-api/litigation-checks")).toBe(false);
    expect(isLitigationAdminRoute("POST", "/restraint-api/litigation-cases/deleted")).toBe(false);
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-cases/restore")).toBe(false);
    expect(isLitigationAdminRoute("DELETE", "/restraint-api/litigation-cases/")).toBe(false);
  });

  it("403 の文言は口の用途に依らない", () => {
    expect(LITIGATION_ADMIN_FORBIDDEN).toBe("この操作は admin / payroll のみ実行できます");
  });
});

describe("30 日の期限", () => {
  it("境目は現在時刻のちょうど 30 日前", () => {
    expect(LITIGATION_DELETED_RETENTION_DAYS).toBe(30);
    expect(CUTOFF).toBe("2026-09-01T03:00:00.000Z");
  });

  it("★ 29 日 23 時間・ちょうど 30 日は残り、30 日 + 1 秒だけが期限切れ (一覧・復活・掃除が同じ境目)", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "d-29d23h", deletedAt: iso(NOW - 30 * DAY + 60 * 60 * 1000) });
    seedDeletedCase(db, { compId: COMP, caseId: "d-30d", deletedAt: iso(NOW - 30 * DAY) });
    seedDeletedCase(db, { compId: COMP, caseId: "d-30d1s", deletedAt: iso(NOW - 30 * DAY - 1000) });

    const listed = await all<LitigationDeletedCaseD1Row>(buildLitigationDeletedCaseListStatement(COMP, CUTOFF));
    expect(listed.map((r) => r.case_id)).toEqual(["d-29d23h", "d-30d"]);

    const expired = await all<{ case_id: string }>(buildLitigationExpiredCaseListStatement(COMP, CUTOFF));
    expect(expired.map((r) => r.case_id)).toEqual(["d-30d1s"]);

    expect(await first(buildLitigationDeletedCaseGetStatement(COMP, "d-30d", CUTOFF))).not.toBeNull();
    expect(await first(buildLitigationDeletedCaseGetStatement(COMP, "d-30d1s", CUTOFF))).toBeNull();
  });
});

describe("案件の削除 = 削除した案件の表への移動", () => {
  it("cases の行が列ごと deleted へ写り、cases から消える。検知結果は残る", async () => {
    seedCase(db, { compId: COMP, caseId: "case-test-1", name: "架空の案件" });
    seedCheck(db, COMP, "case-test-1");
    const before = db.rows("SELECT * FROM litigation_cases WHERE case_id = 'case-test-1'")[0]!;

    await batch(buildLitigationCaseMoveToDeletedStatements(COMP, "case-test-1", iso(NOW), "admin@example.com"));

    expect(db.count("litigation_cases")).toBe(0);
    expect(db.rows("SELECT * FROM litigation_deleted_cases")).toEqual([
      { ...before, deleted_at: iso(NOW), deleted_by: "admin@example.com" },
    ]);
    expect(db.count("litigation_check_results")).toBe(1);
  });

  it("他社の同じ case_id・同じ会社の別の案件には触らない", async () => {
    seedCase(db, { compId: COMP, caseId: "case-test-1" });
    seedCase(db, { compId: COMP, caseId: "case-test-2" });
    seedCase(db, { compId: OTHER_COMP, caseId: "case-test-1" });

    await batch(buildLitigationCaseMoveToDeletedStatements(COMP, "case-test-1", iso(NOW), null));

    expect(db.rows("SELECT comp_id, case_id FROM litigation_cases ORDER BY comp_id, case_id")).toEqual([
      { comp_id: OTHER_COMP, case_id: "case-test-1" },
      { comp_id: COMP, case_id: "case-test-2" },
    ]);
    expect(db.rows("SELECT comp_id, case_id, deleted_by FROM litigation_deleted_cases")).toEqual([
      { comp_id: COMP, case_id: "case-test-1", deleted_by: null },
    ]);
  });

  it("cases に無い case_id は 0 行の移動 (冪等。古い deleted の行も変えない)", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "case-test-1", deletedAt: iso(NOW - DAY) });
    await batch(buildLitigationCaseMoveToDeletedStatements(COMP, "case-test-1", iso(NOW), "admin@example.com"));
    expect(db.rows("SELECT deleted_at FROM litigation_deleted_cases")).toEqual([{ deleted_at: iso(NOW - DAY) }]);
  });

  it("同じ case_id の古い deleted の行が在っても落ちず、新しい削除で置き換わる (INSERT OR REPLACE)", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "case-test-1", name: "古い", deletedAt: iso(NOW - 40 * DAY) });
    seedCase(db, { compId: COMP, caseId: "case-test-1", name: "新しい" });
    await batch(buildLitigationCaseMoveToDeletedStatements(COMP, "case-test-1", iso(NOW), "admin@example.com"));
    expect(db.rows("SELECT name, deleted_at FROM litigation_deleted_cases")).toEqual([
      { name: "新しい", deleted_at: iso(NOW) },
    ]);
  });
});

describe("削除した案件の一覧", () => {
  it("同じ会社のものだけを、削除の新しい順に返す", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "older", deletedAt: iso(NOW - 3 * DAY) });
    seedDeletedCase(db, { compId: COMP, caseId: "newer", deletedAt: iso(NOW - DAY), deletedBy: null });
    seedDeletedCase(db, { compId: OTHER_COMP, caseId: "other", deletedAt: iso(NOW - 2 * DAY) });

    const rows = await all<LitigationDeletedCaseD1Row>(buildLitigationDeletedCaseListStatement(COMP, CUTOFF));
    expect(buildLitigationDeletedCaseListResponse(rows)).toEqual([
      {
        case: {
          caseId: "newer",
          name: "案件 newer",
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
      },
      expect.objectContaining({ deletedAt: iso(NOW - 3 * DAY), deletedBy: "admin@example.com" }),
    ]);
  });
});

describe("復活 = cases へ戻す", () => {
  it("削除前の列のまま cases に戻り (updated_at も)、deleted から消える", async () => {
    seedCase(db, { compId: COMP, caseId: "case-test-1", updatedAt: "2025-05-05T05:05:05.000Z" });
    const before = db.rows("SELECT * FROM litigation_cases")[0]!;
    await batch(buildLitigationCaseMoveToDeletedStatements(COMP, "case-test-1", iso(NOW - DAY), "admin@example.com"));

    await batch(buildLitigationCaseRestoreStatements(COMP, "case-test-1", CUTOFF));

    expect(db.rows("SELECT * FROM litigation_cases")).toEqual([before]);
    expect(db.count("litigation_deleted_cases")).toBe(0);
    expect(await first(buildLitigationCaseGetStatement(COMP, "case-test-1"))).toMatchObject({ case_id: "case-test-1" });
  });

  it("期限切れ・他社の deleted の行は戻さない (行も消さない)", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "expired", deletedAt: iso(NOW - 30 * DAY - 1000) });
    seedDeletedCase(db, { compId: OTHER_COMP, caseId: "case-test-1", deletedAt: iso(NOW - DAY) });

    await batch(buildLitigationCaseRestoreStatements(COMP, "expired", CUTOFF));
    await batch(buildLitigationCaseRestoreStatements(COMP, "case-test-1", CUTOFF));

    expect(db.count("litigation_cases")).toBe(0);
    expect(db.count("litigation_deleted_cases")).toBe(2);
  });

  it("cases に同じ case_id が在ると batch ごと落ちて巻き戻る (上書きしない)", async () => {
    seedCase(db, { compId: COMP, caseId: "case-test-1", name: "生きている方" });
    seedDeletedCase(db, { compId: COMP, caseId: "case-test-1", name: "削除した方", deletedAt: iso(NOW - DAY) });

    await expect(batch(buildLitigationCaseRestoreStatements(COMP, "case-test-1", CUTOFF))).rejects.toThrow();

    expect(db.rows("SELECT name FROM litigation_cases")).toEqual([{ name: "生きている方" }]);
    expect(db.count("litigation_deleted_cases")).toBe(1);
  });
});

describe("期限切れの案件の掃除", () => {
  it("検知結果と deleted の行を消す。期限内の案件・他社には触らない", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "expired", deletedAt: iso(NOW - 31 * DAY) });
    seedDeletedCase(db, { compId: COMP, caseId: "fresh", deletedAt: iso(NOW - 29 * DAY) });
    seedDeletedCase(db, { compId: OTHER_COMP, caseId: "expired", deletedAt: iso(NOW - 31 * DAY) });
    seedCheck(db, COMP, "expired");
    seedCheck(db, COMP, "fresh");
    seedCheck(db, OTHER_COMP, "expired");

    await batch(buildLitigationExpiredCasePurgeStatements(COMP, "expired", CUTOFF));

    expect(db.rows("SELECT comp_id, case_id FROM litigation_deleted_cases ORDER BY comp_id, case_id")).toEqual([
      { comp_id: OTHER_COMP, case_id: "expired" },
      { comp_id: COMP, case_id: "fresh" },
    ]);
    expect(db.rows("SELECT comp_id, case_id FROM litigation_check_results ORDER BY comp_id, case_id")).toEqual([
      { comp_id: OTHER_COMP, case_id: "expired" },
      { comp_id: COMP, case_id: "fresh" },
    ]);
  });

  it("deleted の行は期限の条件つきで消す (期限内の行を名指ししても残る)", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "fresh", deletedAt: iso(NOW - DAY) });
    await batch(buildLitigationExpiredCasePurgeStatements(COMP, "fresh", CUTOFF));
    expect(db.count("litigation_deleted_cases")).toBe(1);
  });

  it("列挙は古い順・上限つき。同じ case_id が cases に在るものは外す", async () => {
    for (let i = 0; i < LITIGATION_SWEEP_MAX_CASES + 2; i++) {
      seedDeletedCase(db, {
        compId: COMP,
        caseId: `expired-${String(i).padStart(2, "0")}`,
        deletedAt: iso(NOW - 40 * DAY + i * 1000),
      });
    }
    seedCase(db, { compId: COMP, caseId: "expired-00" });

    const rows = await all<{ case_id: string }>(buildLitigationExpiredCaseListStatement(COMP, CUTOFF));
    expect(rows).toHaveLength(LITIGATION_SWEEP_MAX_CASES);
    expect(rows[0]).toEqual({ case_id: "expired-01" });
    expect(rows.map((r) => r.case_id)).not.toContain("expired-00");
  });
});
