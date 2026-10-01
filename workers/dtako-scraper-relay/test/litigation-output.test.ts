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
  buildLitigationExpiredVersionListStatement,
  buildLitigationOutputFileCountStatement,
  buildLitigationOutputFileGetStatement,
  buildLitigationOutputFileListStatement,
  buildLitigationOutputFileUpsertStatement,
  buildLitigationOutputR2Key,
  buildLitigationOutputVersionFileListStatement,
  buildLitigationOutputVersionGetStatement,
  buildLitigationOutputVersionId,
  buildLitigationOutputVersionInsertStatement,
  buildLitigationOutputVersionListResponse,
  buildLitigationOutputVersionListStatement,
  buildLitigationOutputVersionPurgeStatements,
  buildLitigationOutputVersionResponse,
  isLitigationAdminRoute,
  isLitigationOutputTooLarge,
  LITIGATION_ADMIN_FORBIDDEN,
  LITIGATION_DELETED_RETENTION_DAYS,
  LITIGATION_OUTPUT_LABEL_MAX_LENGTH,
  LITIGATION_OUTPUT_LIST_LIMIT,
  LITIGATION_OUTPUT_MAX_FILE_BYTES,
  LITIGATION_OUTPUT_MAX_FILES,
  LITIGATION_OUTPUT_MAX_RESULTS_CHARS,
  LITIGATION_SWEEP_MAX_CASES,
  LITIGATION_SWEEP_MAX_VERSIONS,
  litigationDeletedCutoffIso,
  litigationOutputContentType,
  litigationOutputDeclaredTooLarge,
  normalizeLitigationOutputCaseId,
  normalizeLitigationOutputCreate,
  normalizeLitigationOutputFileName,
  normalizeLitigationOutputLabel,
  normalizeLitigationOutputVersionId,
  type LitigationDeletedCaseD1Row,
  type LitigationOutputFileD1Row,
  type LitigationOutputVersionD1Row,
} from "../src/litigation-output";
import { LitigationCaseError } from "../src/litigation-case";
import { pickSupersededVersionKeys } from "../src/theearth-restraint-client";
import {
  openLitigationD1,
  seedCase,
  seedCheck,
  seedDeletedCase,
  seedVersion,
  type SqliteD1,
} from "./helpers/litigation-d1";

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
  it("案件の DELETE・削除した一覧・復活と、出力の 5 口だけが当たる (method と path の組)", () => {
    expect(isLitigationAdminRoute("DELETE", "/restraint-api/litigation-cases")).toBe(true);
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-cases/deleted")).toBe(true);
    expect(isLitigationAdminRoute("POST", "/restraint-api/litigation-cases/restore")).toBe(true);
    // 出力: 版の作成 / 一覧と 1 件 (同じ method・path) / ファイルの上げ下げ
    expect(isLitigationAdminRoute("POST", "/restraint-api/litigation-outputs")).toBe(true);
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-outputs")).toBe(true);
    expect(isLitigationAdminRoute("PUT", "/restraint-api/litigation-outputs/file")).toBe(true);
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-outputs/file")).toBe(true);
  });

  it("案件の GET / PUT・検知結果・method 違いは当たらない (役割の制限を広げない)", () => {
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-cases")).toBe(false);
    expect(isLitigationAdminRoute("PUT", "/restraint-api/litigation-cases")).toBe(false);
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-checks")).toBe(false);
    expect(isLitigationAdminRoute("PUT", "/restraint-api/litigation-checks")).toBe(false);
    expect(isLitigationAdminRoute("POST", "/restraint-api/litigation-cases/deleted")).toBe(false);
    expect(isLitigationAdminRoute("GET", "/restraint-api/litigation-cases/restore")).toBe(false);
    expect(isLitigationAdminRoute("DELETE", "/restraint-api/litigation-cases/")).toBe(false);
    expect(isLitigationAdminRoute("DELETE", "/restraint-api/litigation-outputs")).toBe(false);
    expect(isLitigationAdminRoute("POST", "/restraint-api/litigation-outputs/file")).toBe(false);
    expect(isLitigationAdminRoute("POST", "/restraint-api/litigation/alc-upload-driver")).toBe(false);
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

// ===========================================================================
// 出力の版
// ===========================================================================

const PREFIX = "restraint";
const OTHER_PREFIX = "restraint-staging";
const V1 = "20260901T000000Z-aaaaaa";
const V2 = "20260902T000000Z-bbbbbb";

describe("case_id の形 (出力の口が R2 のキーに使う)", () => {
  it("UUID・英数字と _ - は通る", () => {
    for (const id of ["case-test-1", "0b9f4c1e-7c1d-4a52-9d3e-2f6a8b1c0d9e", "A_b-9", "x".repeat(64)]) {
      expect(normalizeLitigationOutputCaseId(id)).toBe(id);
    }
  });

  it("空・/・..・長すぎ・/csv/ を含むもの・文字列以外は LitigationCaseError", () => {
    for (const id of ["", "a/b", "..", "a..b", "x".repeat(65), "x/csv/y", "案件", " a", null, undefined, 1]) {
      expect(() => normalizeLitigationOutputCaseId(id), JSON.stringify(id)).toThrow(LitigationCaseError);
    }
  });
});

describe("version_id の採番", () => {
  it("時刻 (UTC、秒まで) + 乱数 6 文字。形の検証を通る", () => {
    const id = buildLitigationOutputVersionId(new Date("2026-10-01T03:04:05.678Z"), new Uint8Array([0, 10, 35, 36, 255, 1, 99]));
    expect(id).toBe("20261001T030405Z-0az031");
    expect(normalizeLitigationOutputVersionId(id)).toBe(id);
  });

  it("形に合わない version_id は LitigationCaseError", () => {
    for (const id of ["", "v-20261001T030405", "20261001T030405Z", "20261001T030405Z-ABCDEF", "20261001T030405Z-abc/ef", null, 1]) {
      expect(() => normalizeLitigationOutputVersionId(id), JSON.stringify(id)).toThrow(LitigationCaseError);
    }
  });
});

describe("保存用のファイル名と表示名", () => {
  it("ASCII の名前 + .xlsx / .csv は通る (拡張子の大文字も可)", () => {
    for (const name of ["y-time_1001_2025-01.xlsx", "changes.csv", "A.XLSX", `${"x".repeat(115)}.xlsx`]) {
      expect(normalizeLitigationOutputFileName(name)).toBe(name);
    }
  });

  it("空・.. を含む・拡張子なし・別の拡張子・/・日本語・長すぎ・文字列以外は LitigationCaseError", () => {
    const bad = ["", "a..b.xlsx", "xlsx", "csv", "a.txt", "a.xlsx.exe", "a/b.xlsx", "出力.xlsx", "a b.xlsx", `${"x".repeat(116)}.xlsx`, null, 1];
    for (const name of bad) {
      expect(() => normalizeLitigationOutputFileName(name), JSON.stringify(name)).toThrow(LitigationCaseError);
    }
  });

  it("content-type は拡張子で 2 種", () => {
    expect(litigationOutputContentType("a.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(litigationOutputContentType("A.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(litigationOutputContentType("a.csv")).toBe("text/csv");
  });

  it("表示名は日本語可。省略・空は保存用の名前", () => {
    expect(normalizeLitigationOutputLabel("乗務員A 2025年1月.xlsx", "a.xlsx")).toBe("乗務員A 2025年1月.xlsx");
    expect(normalizeLitigationOutputLabel("x".repeat(LITIGATION_OUTPUT_LABEL_MAX_LENGTH), "a.xlsx")).toHaveLength(200);
    for (const empty of [null, undefined, ""]) {
      expect(normalizeLitigationOutputLabel(empty, "a.xlsx")).toBe("a.xlsx");
    }
  });

  it("長すぎ・制御文字・文字列以外の表示名は LitigationCaseError", () => {
    for (const label of ["x".repeat(LITIGATION_OUTPUT_LABEL_MAX_LENGTH + 1), "a\nb", "a\u0000b", "a\u007fb", 1, {}]) {
      expect(() => normalizeLitigationOutputLabel(label, "a.xlsx"), JSON.stringify(label)).toThrow(LitigationCaseError);
    }
  });
});

describe("R2 のキーの組み立て", () => {
  it("{prefix}/{comp}/litigation/{case_id}/{version_id}/{name}", () => {
    expect(buildLitigationOutputR2Key(PREFIX, COMP, "case-test-1", V1, "a.xlsx")).toBe(
      `restraint/9999/litigation/case-test-1/${V1}/a.xlsx`,
    );
    // prefix と comp の境界: 別 env の prefix は別のキー空間になる
    expect(buildLitigationOutputR2Key(OTHER_PREFIX, COMP, "case-test-1", V1, "a.xlsx")).toBe(
      `restraint-staging/9999/litigation/case-test-1/${V1}/a.xlsx`,
    );
  });

  it("★ /csv/ を含むキー・v- で始まる要素を持つキー・.. を含むキーは組まない", () => {
    const bad: Array<[string, string, string, string, string]> = [
      [PREFIX, COMP, "csv", V1, "a.csv"], // case_id が csv → /csv/ を含む
      [PREFIX, COMP, "v-20260101T000000", V1, "a.xlsx"], // case_id が v- 始まり
      [PREFIX, COMP, "case-test-1", V1, "v-a.xlsx"], // name が v- 始まり
      [PREFIX, "v-9999", "case-test-1", V1, "a.xlsx"],
      ["restraint/csv", COMP, "case-test-1", V1, "a.xlsx"],
      ["..", COMP, "case-test-1", V1, "a.xlsx"],
    ];
    for (const args of bad) {
      expect(() => buildLitigationOutputR2Key(...args), args.join("/")).toThrow(LitigationCaseError);
    }
  });

  it("★ 組んだキーは、既存の CSV ダウンロードの口の検証式に弾かれる (.csv のファイルでも)", () => {
    // dtako-scraper-relay-do.ts の handleArchiveCsvDownload と同じ式 (役割の制限が無い口)
    const passesArchiveCsv = (key: string) =>
      key.startsWith(`${PREFIX}/${COMP}/`) && key.includes("/csv/") && !key.includes("..") && key.endsWith(".csv");
    const key = buildLitigationOutputR2Key(PREFIX, COMP, "case-test-1", V1, "changes.csv");
    expect(passesArchiveCsv(key)).toBe(false);
    // 陽性対照: 式そのものは既存の CSV のキーを通す
    expect(passesArchiveCsv(`${PREFIX}/${COMP}/2026-01/all/csv/v-20260101T000000.csv`)).toBe(true);
  });

  it("組んだキーは 7 日 prune の選定に載らない (版の時刻に見える名前でも)", () => {
    const keys = [
      buildLitigationOutputR2Key(PREFIX, COMP, "case-test-1", "20200101T000000Z-aaaaaa", "a.xlsx"),
      buildLitigationOutputR2Key(PREFIX, COMP, "case-test-1", "20200102T000000Z-aaaaaa", "a.xlsx"),
    ];
    expect(pickSupersededVersionKeys(keys, new Date(NOW))).toEqual([]);
  });
});

describe("POST の body と上限", () => {
  it("caseId と results (中身は解釈しない) を取り出す", () => {
    expect(normalizeLitigationOutputCreate({ caseId: "case-test-1", results: { a: [1, "x"] }, compId: "8888" })).toEqual({
      caseId: "case-test-1",
      results: '{"a":[1,"x"]}',
    });
    expect(normalizeLitigationOutputCreate({ caseId: "case-test-1", results: null }).results).toBe("null");
  });

  it("オブジェクト以外・caseId の形・results 無し・results が大きすぎは LitigationCaseError", () => {
    const tooLarge = "x".repeat(LITIGATION_OUTPUT_MAX_RESULTS_CHARS);
    for (const raw of [null, "x", [], { results: {} }, { caseId: "a/b", results: {} }, { caseId: "case-test-1" }, { caseId: "case-test-1", results: tooLarge }]) {
      expect(() => normalizeLitigationOutputCreate(raw)).toThrow(LitigationCaseError);
    }
    // 境界: JSON 文字列がちょうど上限なら通る ("…" の引用符 2 文字ぶんを引く)
    const atLimit = "x".repeat(LITIGATION_OUTPUT_MAX_RESULTS_CHARS - 2);
    expect(normalizeLitigationOutputCreate({ caseId: "case-test-1", results: atLimit }).results).toHaveLength(500_000);
  });

  it("1 ファイルは 20MB まで (ちょうどは通る)。content-length が無い・数字でないときは読んでから判定する", () => {
    expect(LITIGATION_OUTPUT_MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
    expect(LITIGATION_OUTPUT_MAX_FILES).toBe(300);
    expect(isLitigationOutputTooLarge(LITIGATION_OUTPUT_MAX_FILE_BYTES)).toBe(false);
    expect(isLitigationOutputTooLarge(LITIGATION_OUTPUT_MAX_FILE_BYTES + 1)).toBe(true);
    expect(litigationOutputDeclaredTooLarge("20971520")).toBe(false);
    expect(litigationOutputDeclaredTooLarge("20971521")).toBe(true);
    expect(litigationOutputDeclaredTooLarge(" 20971521 ")).toBe(true);
    expect(litigationOutputDeclaredTooLarge(null)).toBe(false);
    expect(litigationOutputDeclaredTooLarge("abc")).toBe(false);
    expect(litigationOutputDeclaredTooLarge("-1")).toBe(false);
  });
});

describe("版とファイルの D1 文 (実物の SQLite)", () => {
  const addVersion = async (versionId: string, r2Prefix: string, createdAt: string, caseId = "case-test-1", compId = COMP) => {
    const s = buildLitigationOutputVersionInsertStatement({
      compId,
      caseId,
      versionId,
      r2Prefix,
      createdAt,
      createdBy: "admin@example.com",
      results: '{"rows":1}',
    });
    await db.prepare(s.sql).bind(...s.params).run();
  };
  const addFile = async (versionId: string, name: string, size = 10, sha256 = "sha-1") => {
    const s = buildLitigationOutputFileUpsertStatement({
      compId: COMP,
      caseId: "case-test-1",
      versionId,
      name,
      label: `表示名 ${name}`,
      size,
      sha256,
      r2Key: buildLitigationOutputR2Key(PREFIX, COMP, "case-test-1", versionId, name),
      uploadedAt: iso(NOW),
    });
    await db.prepare(s.sql).bind(...s.params).run();
  };

  it("版の一覧は自 env の prefix・同じ会社・同じ案件だけを、新しい順に返す (results は引かない)", async () => {
    await addVersion(V1, PREFIX, "2026-09-01T00:00:00.000Z");
    await addVersion(V2, PREFIX, "2026-09-02T00:00:00.000Z");
    await addVersion("20260903T000000Z-cccccc", OTHER_PREFIX, "2026-09-03T00:00:00.000Z");
    await addVersion("20260904T000000Z-dddddd", PREFIX, "2026-09-04T00:00:00.000Z", "case-test-2");
    await addVersion("20260905T000000Z-eeeeee", PREFIX, "2026-09-05T00:00:00.000Z", "case-test-1", OTHER_COMP);

    const rows = await all<LitigationOutputVersionD1Row>(buildLitigationOutputVersionListStatement(COMP, "case-test-1", PREFIX));
    expect(rows).toEqual([
      { version_id: V2, created_at: "2026-09-02T00:00:00.000Z", created_by: "admin@example.com" },
      { version_id: V1, created_at: "2026-09-01T00:00:00.000Z", created_by: "admin@example.com" },
    ]);
    const staging = await all<LitigationOutputVersionD1Row>(
      buildLitigationOutputVersionListStatement(COMP, "case-test-1", OTHER_PREFIX),
    );
    expect(staging.map((r) => r.version_id)).toEqual(["20260903T000000Z-cccccc"]);
  });

  it("版の一覧は新しい順に 50 件まで。ファイルの行もその 50 版のぶんだけ", async () => {
    for (let i = 0; i < LITIGATION_OUTPUT_LIST_LIMIT + 2; i++) {
      const versionId = `20260801T0000${String(i).padStart(2, "0")}Z-aaaaaa`;
      await addVersion(versionId, PREFIX, iso(Date.parse("2026-08-01T00:00:00.000Z") + i * DAY));
      await addFile(versionId, "a.xlsx");
    }
    const rows = await all<LitigationOutputVersionD1Row>(buildLitigationOutputVersionListStatement(COMP, "case-test-1", PREFIX));
    expect(rows).toHaveLength(LITIGATION_OUTPUT_LIST_LIMIT);
    expect(rows[0]!.created_at).toBe(iso(Date.parse("2026-08-01T00:00:00.000Z") + 51 * DAY));
    const files = await all<LitigationOutputFileD1Row>(buildLitigationOutputFileListStatement(COMP, "case-test-1", PREFIX));
    expect(files).toHaveLength(LITIGATION_OUTPUT_LIST_LIMIT);
    expect(new Set(files.map((f) => f.version_id))).toEqual(new Set(rows.map((r) => r.version_id)));
  });

  it("版 1 件は results つき。他 env の prefix・他社の版は引けない", async () => {
    await addVersion(V1, PREFIX, "2026-09-01T00:00:00.000Z");
    expect(await first(buildLitigationOutputVersionGetStatement(COMP, "case-test-1", V1, PREFIX))).toEqual({
      version_id: V1,
      created_at: "2026-09-01T00:00:00.000Z",
      created_by: "admin@example.com",
      results: '{"rows":1}',
    });
    expect(await first(buildLitigationOutputVersionGetStatement(COMP, "case-test-1", V1, OTHER_PREFIX))).toBeNull();
    expect(await first(buildLitigationOutputVersionGetStatement(OTHER_COMP, "case-test-1", V1, PREFIX))).toBeNull();
    expect(await first(buildLitigationOutputVersionGetStatement(COMP, "case-test-2", V1, PREFIX))).toBeNull();
  });

  it("ファイルは 1 行ずつの upsert — 同名は上書き、別名は足される。数は「この名前以外」を数える", async () => {
    await addVersion(V1, PREFIX, "2026-09-01T00:00:00.000Z");
    await addFile(V1, "a.xlsx", 10, "sha-old");
    await addFile(V1, "b.csv", 20, "sha-b");
    await addFile(V1, "a.xlsx", 11, "sha-new");

    const rows = await all<LitigationOutputFileD1Row>(buildLitigationOutputVersionFileListStatement(COMP, "case-test-1", V1));
    expect(rows).toEqual([
      {
        version_id: V1,
        storage_name: "a.xlsx",
        label: "表示名 a.xlsx",
        size: 11,
        sha256: "sha-new",
        r2_key: `restraint/9999/litigation/case-test-1/${V1}/a.xlsx`,
        uploaded_at: iso(NOW),
      },
      expect.objectContaining({ storage_name: "b.csv", size: 20 }),
    ]);
    expect(await first(buildLitigationOutputFileCountStatement(COMP, "case-test-1", V1, "a.xlsx"))).toEqual({ n: 1 });
    expect(await first(buildLitigationOutputFileCountStatement(COMP, "case-test-1", V1, "c.xlsx"))).toEqual({ n: 2 });
  });

  it("★ ファイル 1 行は、版が自 env の prefix のときだけ引ける", async () => {
    await addVersion(V1, PREFIX, "2026-09-01T00:00:00.000Z");
    await addFile(V1, "a.xlsx");
    expect(await first(buildLitigationOutputFileGetStatement(COMP, "case-test-1", V1, "a.xlsx", PREFIX))).toMatchObject({
      storage_name: "a.xlsx",
      r2_key: `restraint/9999/litigation/case-test-1/${V1}/a.xlsx`,
    });
    expect(await first(buildLitigationOutputFileGetStatement(COMP, "case-test-1", V1, "a.xlsx", OTHER_PREFIX))).toBeNull();
    expect(await first(buildLitigationOutputFileGetStatement(COMP, "case-test-1", V1, "b.xlsx", PREFIX))).toBeNull();
    expect(await first(buildLitigationOutputFileGetStatement(OTHER_COMP, "case-test-1", V1, "a.xlsx", PREFIX))).toBeNull();
  });

  it("一覧のファイルの行は、他 env の版のぶんを含まない", async () => {
    seedVersion(db, { compId: COMP, caseId: "case-test-1", versionId: V1, r2Prefix: PREFIX, files: ["a.xlsx"] });
    seedVersion(db, { compId: COMP, caseId: "case-test-1", versionId: V2, r2Prefix: OTHER_PREFIX, files: ["b.xlsx"] });
    const files = await all<LitigationOutputFileD1Row>(buildLitigationOutputFileListStatement(COMP, "case-test-1", PREFIX));
    expect(files.map((f) => f.storage_name)).toEqual(["a.xlsx"]);
  });
});

describe("期限切れの案件の版の掃除 (実物の SQLite)", () => {
  it("期限切れの案件の版だけを、全 prefix から古い順に 3 つまで列挙する", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "expired-a", deletedAt: iso(NOW - 40 * DAY) });
    seedDeletedCase(db, { compId: COMP, caseId: "expired-b", deletedAt: iso(NOW - 35 * DAY) });
    seedDeletedCase(db, { compId: COMP, caseId: "fresh", deletedAt: iso(NOW - 29 * DAY) });
    seedDeletedCase(db, { compId: OTHER_COMP, caseId: "expired-a", deletedAt: iso(NOW - 40 * DAY) });
    seedCase(db, { compId: COMP, caseId: "live" });
    seedVersion(db, { compId: COMP, caseId: "expired-a", versionId: V2, r2Prefix: OTHER_PREFIX });
    seedVersion(db, { compId: COMP, caseId: "expired-a", versionId: V1, r2Prefix: PREFIX });
    seedVersion(db, { compId: COMP, caseId: "expired-b", versionId: V1, r2Prefix: PREFIX });
    seedVersion(db, { compId: COMP, caseId: "expired-b", versionId: V2, r2Prefix: PREFIX });
    seedVersion(db, { compId: COMP, caseId: "fresh", versionId: V1, r2Prefix: PREFIX });
    seedVersion(db, { compId: COMP, caseId: "live", versionId: V1, r2Prefix: PREFIX });
    seedVersion(db, { compId: OTHER_COMP, caseId: "expired-a", versionId: V1, r2Prefix: PREFIX });

    expect(LITIGATION_SWEEP_MAX_VERSIONS).toBe(3);
    expect(await all(buildLitigationExpiredVersionListStatement(COMP, CUTOFF))).toEqual([
      { case_id: "expired-a", version_id: V1 },
      { case_id: "expired-a", version_id: V2 },
      { case_id: "expired-b", version_id: V1 },
    ]);
  });

  it("同じ case_id が cases に在る案件の版は列挙しない (作り直された案件の版を消さない)", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "case-test-1", deletedAt: iso(NOW - 40 * DAY) });
    seedCase(db, { compId: COMP, caseId: "case-test-1" });
    seedVersion(db, { compId: COMP, caseId: "case-test-1", versionId: V1, r2Prefix: PREFIX });
    expect(await all(buildLitigationExpiredVersionListStatement(COMP, CUTOFF))).toEqual([]);
  });

  it("版 1 つの掃除は、その版のファイルの行と版の行だけを消す", async () => {
    seedVersion(db, { compId: COMP, caseId: "case-test-1", versionId: V1, r2Prefix: PREFIX, files: ["a.xlsx", "b.csv"] });
    seedVersion(db, { compId: COMP, caseId: "case-test-1", versionId: V2, r2Prefix: PREFIX, files: ["a.xlsx"] });
    seedVersion(db, { compId: OTHER_COMP, caseId: "case-test-1", versionId: V1, r2Prefix: PREFIX, files: ["a.xlsx"] });

    await batch(buildLitigationOutputVersionPurgeStatements(COMP, "case-test-1", V1));

    expect(db.rows("SELECT comp_id, version_id FROM litigation_output_versions ORDER BY comp_id, version_id")).toEqual([
      { comp_id: OTHER_COMP, version_id: V1 },
      { comp_id: COMP, version_id: V2 },
    ]);
    expect(db.rows("SELECT comp_id, version_id, storage_name FROM litigation_output_files ORDER BY comp_id")).toEqual([
      { comp_id: OTHER_COMP, version_id: V1, storage_name: "a.xlsx" },
      { comp_id: COMP, version_id: V2, storage_name: "a.xlsx" },
    ]);
  });

  it("★ 版が残っている期限切れの案件は、案件の掃除の列挙に出ない (版が無くなってから出る)", async () => {
    seedDeletedCase(db, { compId: COMP, caseId: "with-version", deletedAt: iso(NOW - 40 * DAY) });
    seedDeletedCase(db, { compId: COMP, caseId: "no-version", deletedAt: iso(NOW - 39 * DAY) });
    seedVersion(db, { compId: COMP, caseId: "with-version", versionId: V1, r2Prefix: OTHER_PREFIX });

    expect(await all(buildLitigationExpiredCaseListStatement(COMP, CUTOFF))).toEqual([{ case_id: "no-version" }]);
    await batch(buildLitigationOutputVersionPurgeStatements(COMP, "with-version", V1));
    expect(await all(buildLitigationExpiredCaseListStatement(COMP, CUTOFF))).toEqual([
      { case_id: "with-version" },
      { case_id: "no-version" },
    ]);
  });
});

describe("版の応答の整形", () => {
  const versions: LitigationOutputVersionD1Row[] = [
    { version_id: V2, created_at: "2026-09-02T00:00:00.000Z", created_by: null },
    { version_id: V1, created_at: "2026-09-01T00:00:00.000Z", created_by: "admin@example.com" },
  ];
  const file = (version_id: string, storage_name: string): LitigationOutputFileD1Row => ({
    version_id,
    storage_name,
    label: `表示名 ${storage_name}`,
    size: 10,
    sha256: "sha",
    r2_key: `restraint/9999/litigation/case-test-1/${version_id}/${storage_name}`,
    uploaded_at: "2026-09-01T00:00:01.000Z",
  });

  it("一覧: 版ごとにファイルを振り分ける。results と R2 のキーは出さない", () => {
    const out = buildLitigationOutputVersionListResponse(versions, [file(V1, "a.xlsx"), file(V1, "b.csv"), file(V2, "a.xlsx")]);
    expect(out).toEqual([
      {
        versionId: V2,
        createdAt: "2026-09-02T00:00:00.000Z",
        createdBy: null,
        files: [{ name: "a.xlsx", label: "表示名 a.xlsx", size: 10, sha256: "sha", uploadedAt: "2026-09-01T00:00:01.000Z" }],
      },
      {
        versionId: V1,
        createdAt: "2026-09-01T00:00:00.000Z",
        createdBy: "admin@example.com",
        files: [expect.objectContaining({ name: "a.xlsx" }), expect.objectContaining({ name: "b.csv" })],
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("restraint/");
    expect(JSON.stringify(out)).not.toContain("results");
  });

  it("1 件: results を JSON として返す。読めない・無い results は null", () => {
    expect(buildLitigationOutputVersionResponse({ ...versions[1]!, results: '{"rows":[1]}' }, [file(V1, "a.xlsx")])).toEqual({
      versionId: V1,
      createdAt: "2026-09-01T00:00:00.000Z",
      createdBy: "admin@example.com",
      files: [expect.objectContaining({ name: "a.xlsx" })],
      results: { rows: [1] },
    });
    expect(buildLitigationOutputVersionResponse({ ...versions[1]!, results: "{broken" }, []).results).toBeNull();
    expect(buildLitigationOutputVersionResponse(versions[1]!, []).results).toBeNull();
  });
});
