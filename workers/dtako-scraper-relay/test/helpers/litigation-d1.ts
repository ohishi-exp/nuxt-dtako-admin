/**
 * 訴訟準備 (Refs #1133) のテスト用 D1。**実物の SQLite (`node:sqlite`) に migrations
 * 0017〜0019 を当てたもの**を、DO が使う D1 の面 (`prepare().bind().first/all/run`・`batch`)
 * だけ被せて返す。
 *
 * 文字列を照合するだけの fake にしない理由: `src/litigation-output.ts` が組む文
 * (`INSERT OR REPLACE … SELECT` の移動・復活、期限の比較、`r2_prefix` の絞り込み) は
 * 実物で走らせないと、列の数や条件の向きの間違いが本番の D1 まで見えない。
 *
 * - tsconfig は @cloudflare/workers-types のみで node 型を持たないため、`node:sqlite` /
 *   `node:fs` は非リテラル指定子の動的 import で型解決を回避する (wrangler-r2-prefix.test.ts と同じ手)
 * - migration のパスは vitest の cwd = `workers/dtako-scraper-relay` 前提 (同上)
 */

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const MIGRATIONS = [
  "0017_create_litigation_cases.sql",
  "0018_create_litigation_check_results.sql",
  "0019_create_litigation_output_versions.sql",
];

/** node:sqlite は行を null prototype の object で返す。toEqual で比べられる形にする。 */
function plain(row: unknown): Record<string, unknown> {
  return { ...(row as Record<string, unknown>) };
}

class SqliteD1Statement {
  constructor(
    private readonly d1: SqliteD1,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  bind(...params: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.d1, this.sql, params);
  }

  /** batch から同期で呼ぶ実体。 */
  runSync(): void {
    this.d1.check(this.sql);
    this.d1.raw.prepare(this.sql).run(...this.params);
  }

  async first<T>(): Promise<T | null> {
    this.d1.check(this.sql);
    const row = this.d1.raw.prepare(this.sql).get(...this.params);
    return row === undefined ? null : (plain(row) as T);
  }

  async all<T>(): Promise<{ results: T[] }> {
    this.d1.check(this.sql);
    return { results: this.d1.raw.prepare(this.sql).all(...this.params).map(plain) as T[] };
  }

  async run(): Promise<{ success: true }> {
    this.runSync();
    return { success: true };
  }
}

export class SqliteD1 {
  /** 真を返した文を「D1 の失敗」として throw させる (失敗経路のテスト用)。 */
  failWhen: ((sql: string) => boolean) | null = null;

  constructor(readonly raw: SqliteDatabase) {}

  check(sql: string): void {
    if (this.failWhen?.(sql)) throw new Error("D1_ERROR: injected failure");
  }

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this, sql, []);
  }

  /** D1 の batch と同じく 1 トランザクション (途中で落ちたら全部巻き戻る)。 */
  async batch(statements: SqliteD1Statement[]): Promise<unknown[]> {
    this.raw.exec("BEGIN");
    try {
      for (const s of statements) s.runSync();
      this.raw.exec("COMMIT");
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
    return statements.map(() => ({ success: true }));
  }

  /** テストの seed・検証用 (DO を通さない直接の読み書き)。 */
  exec(sql: string, ...params: unknown[]): void {
    this.raw.prepare(sql).run(...params);
  }

  rows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.raw.prepare(sql).all(...params).map(plain);
  }

  count(table: string, where = "1 = 1", ...params: unknown[]): number {
    return Number(this.rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)[0]!.n);
  }
}

/** migrations 0017〜0019 を当てた in-memory の SQLite を開く。 */
export async function openLitigationD1(): Promise<SqliteD1> {
  const sqlite = (await import(/* @vite-ignore */ "node" + ":sqlite")) as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const fs = (await import(/* @vite-ignore */ "node" + ":fs")) as {
    readFileSync: (p: string, enc: string) => string;
  };
  const db = new sqlite.DatabaseSync(":memory:");
  for (const name of MIGRATIONS) db.exec(fs.readFileSync(`../../migrations/${name}`, "utf8"));
  return new SqliteD1(db);
}

/** 案件の列 (seed 用)。値はすべて架空。 */
export interface SeedCase {
  compId: string;
  caseId: string;
  name?: string;
  updatedAt?: string;
}

const CASE_VALUES = (c: SeedCase) => [
  c.compId,
  c.caseId,
  c.name ?? `案件 ${c.caseId}`,
  "2025-01",
  "2025-03",
  '["1001","1002"]',
  "メモ",
  "creator@example.com",
  "2025-04-01T00:00:00.000Z",
  c.updatedAt ?? "2025-04-02T00:00:00.000Z",
];

export function seedCase(db: SqliteD1, c: SeedCase): void {
  db.exec(
    `INSERT INTO litigation_cases
       (comp_id, case_id, name, from_month, to_month, driver_cds, memo, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...CASE_VALUES(c),
  );
}

export function seedDeletedCase(db: SqliteD1, c: SeedCase & { deletedAt: string; deletedBy?: string | null }): void {
  db.exec(
    `INSERT INTO litigation_deleted_cases
       (comp_id, case_id, name, from_month, to_month, driver_cds, memo, created_by, created_at, updated_at,
        deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...CASE_VALUES(c),
    c.deletedAt,
    c.deletedBy === undefined ? "admin@example.com" : c.deletedBy,
  );
}

export function seedCheck(db: SqliteD1, compId: string, caseId: string, key = "1001|2025-01"): void {
  db.exec(
    `INSERT INTO litigation_check_results (comp_id, case_id, kind, item_key, payload, checked_at)
     VALUES (?, ?, 'alcOps', ?, '{"ok":true}', '2025-04-03T00:00:00.000Z')`,
    compId,
    caseId,
    key,
  );
}
