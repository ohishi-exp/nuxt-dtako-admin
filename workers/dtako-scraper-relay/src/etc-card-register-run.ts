/**
 * ETC カード追加登録の 1 回ぶん (cron の 1 tick / 手動の 1 件) を回す
 * (Refs ohishi-exp/nuxt-dtako-admin#1287)。
 *
 * I/O (D1・alc・etc-meisai.jp・R2) はすべて `CardRegisterRunDeps` で受ける
 * (DO は配線するだけ。ここは node vitest で 100%)。判定の中身は `etc-card-register.ts`。
 *
 * ## status の動かし方
 *
 * | 結末 | status | run_date / unko_no | attempts | last_error |
 * |---|---|---|---|---|
 * | 走行が見つからない (`no_run`) | **変えない** | 触らない | 触らない | 触らない |
 * | 確認画面まで (`dry_run_ok`) | `dry_run_ok` | 書く | +1 | NULL |
 * | 完了 (`registered`) | `registered` | 書く | +1 | NULL |
 * | 登録しない / 弾かれた (`failed`) | `failed` | 分かれば書く | 送ったときだけ +1 | 理由 |
 * | 照合・通信が落ちた (`error`) | **変えない** | 触らない | 送ったときだけ +1 | 理由 |
 *
 * `error` で status を変えないのは、alc の一時的な失敗や auth-worker の 403 で
 * 「走行待ち」の行を失敗扱いにしないため (次の tick で自然に再試行される)。
 *
 * ## どの行を拾うか
 *
 * - cron: `waiting_run`。**live のときは `dry_run_ok` も** (dry-run で確認まで通した行を
 *   live に切り替えた後で本登録するため)。`failed` は自動では拾わない (人が見てから手動で)
 * - 手動 (`POST /etc-card/register`): 指定の 1 件が `waiting_run` / `dry_run_ok` / `failed`
 *
 * 1 回に拾うのは `CARD_REGISTER_BATCH_LIMIT` 件まで (alc への subrequest を抑える)。
 */

import {
  buildCardRegisterFields,
  cardRegisterConfirmKey,
  cardRegisterErrorKey,
  hasNextOperationsPage,
  latestEtcRunDate,
  matchVehicle,
  parseOperationsPage,
  runSearchWindow,
  type CardRegisterFields,
  type CardRegisterMode,
  type CardRegisterResult,
  type OperationRef,
} from "./etc-card-register";
import type { EtcCardRegisterOutcome } from "./etc-meisai-client";

/** D1 の最小の面 (テストで差し替えられるように binding 型に依存しない)。 */
export interface CardRegisterDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

export interface CardRegisterRunDeps {
  db: CardRegisterDb;
  now: Date;
  mode: CardRegisterMode;
  /** `ETC_R2_PREFIX` (既定 `etc`)。 */
  r2Prefix: string;
  /** `GET /api/internal/operations{search}` の本文。非 2xx は throw してよい。 */
  getOperations(tenantId: string, search: string): Promise<string>;
  /** `GET /api/operations/{unko_no}/csv/tolls` の本文。**CSV が無い (404) は null**。他の失敗は throw。 */
  getTolls(tenantId: string, unkoNo: string): Promise<string | null>;
  /** etc-meisai.jp へ送る (ログインは呼び手が 1 回にまとめる)。 */
  register(fields: CardRegisterFields): Promise<EtcCardRegisterOutcome>;
  /** R2 へ HTML を置く。 */
  putHtml(key: string, html: string): Promise<void>;
}

export type CardRegisterTarget = { kind: "cron" } | { kind: "one"; id: number };

/** 1 回に拾う行の上限。 */
export const CARD_REGISTER_BATCH_LIMIT = 20;
/** 運行一覧の 1 ページの件数 (上流の上限)。 */
export const OPERATIONS_PER_PAGE = 200;
/** 運行一覧を読むページ数の上限 (62 日 × 全車両でも収まる量。超えたら loud fail)。 */
export const MAX_OPERATION_PAGES = 50;
/** 1 車両あたり料金所 CSV を読む運行数の上限 (読取日の新しい順)。 */
export const MAX_TOLL_FETCHES = 60;

interface RegistrationRow {
  id: number;
  card_number: string | null;
  plate4: string | null;
  obu_number: string | null;
  tenant_id: string | null;
}

/** 拾う status。 */
export function targetStatuses(target: CardRegisterTarget, mode: CardRegisterMode): string[] {
  if (target.kind === "one") return ["waiting_run", "dry_run_ok", "failed"];
  return mode === "live" ? ["waiting_run", "dry_run_ok"] : ["waiting_run"];
}

/** 対象の行を読む SQL と bind 値。tenant は明細書を受けた時の `etc_card_scans.tenant_id`。 */
export function selectRegistrationsQuery(
  target: CardRegisterTarget,
  mode: CardRegisterMode,
): { sql: string; params: unknown[] } {
  const statuses = targetStatuses(target, mode);
  const params: unknown[] = [...statuses];
  let where = `r.status IN (${statuses.map(() => "?").join(", ")})`;
  if (target.kind === "one") {
    where += " AND r.id = ?";
    params.push(target.id);
  }
  params.push(CARD_REGISTER_BATCH_LIMIT);
  return {
    sql:
      "SELECT r.id, r.card_number, r.plate4, r.obu_number, s.tenant_id " +
      "FROM etc_card_registrations r LEFT JOIN etc_card_scans s ON s.sha256 = r.scan_sha256 " +
      `WHERE ${where} ORDER BY r.id LIMIT ?`,
    params,
  };
}

export interface CardRegisterReport {
  /** 手動 1 件で、対象の行が無かった (id 違い / 拾えない status)。 */
  notFound: boolean;
  results: CardRegisterResult[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** tenant の運行一覧 (探す範囲) を全ページ読む。 */
async function loadOperations(deps: CardRegisterRunDeps, tenantId: string): Promise<OperationRef[]> {
  const window = runSearchWindow(deps.now);
  const all: OperationRef[] = [];
  for (let page = 1; ; page += 1) {
    if (page > MAX_OPERATION_PAGES) {
      throw new Error(`運行一覧が ${MAX_OPERATION_PAGES} ページを超えました (読み切れないので止めます)`);
    }
    const search =
      `?date_from=${window.from}&date_to=${window.to}&page=${page}&per_page=${OPERATIONS_PER_PAGE}`;
    const parsed = parseOperationsPage(JSON.parse(await deps.getOperations(tenantId, search)) as unknown);
    all.push(...parsed.operations);
    if (!hasNextOperationsPage(parsed)) return all;
  }
}

type RowOutcome = Omit<CardRegisterResult, "id" | "cardNumber"> & { unkoNo?: string; attempted?: boolean };

async function processRow(
  deps: CardRegisterRunDeps,
  row: RegistrationRow,
  operationsOf: (tenantId: string) => Promise<OperationRef[]>,
): Promise<RowOutcome> {
  if (!row.tenant_id) return { kind: "failed", detail: "明細書の会社 (tenant) が分かりません" };
  if (!row.plate4) return { kind: "failed", detail: "ナンバー下 4 桁がありません" };
  const tenantId = row.tenant_id;

  let runDate: string | null = null;
  let unkoNo: string | undefined;
  try {
    const match = matchVehicle(await operationsOf(tenantId), row.plate4);
    if (match.kind === "none") return { kind: "no_run" };
    if (match.kind === "multiple") {
      return { kind: "failed", detail: `車両が複数一致 (車輌CD ${match.vehicleCds.join(", ")})` };
    }
    const window = runSearchWindow(deps.now);
    for (const u of match.unkoNos.slice(0, MAX_TOLL_FETCHES)) {
      const body = await deps.getTolls(tenantId, u);
      if (body === null) continue;
      const date = latestEtcRunDate(JSON.parse(body) as unknown, window);
      if (date !== null && (runDate === null || date > runDate)) {
        runDate = date;
        unkoNo = u;
      }
    }
  } catch (err) {
    return { kind: "error", detail: `走行の照合に失敗: ${errorMessage(err)}` };
  }
  if (runDate === null) return { kind: "no_run" };

  const built = buildCardRegisterFields(
    { cardNumber: row.card_number, obuNumber: row.obu_number, plate4: row.plate4, runDate },
    deps.now,
  );
  if (!built.ok) return { kind: "failed", runDate, unkoNo, detail: built.reason };

  try {
    const outcome = await deps.register(built.fields);
    if (outcome.kind === "confirmed") {
      await deps.putHtml(cardRegisterConfirmKey(deps.r2Prefix, row.id, deps.now), outcome.html);
      return { kind: "dry_run_ok", runDate, unkoNo, attempted: true };
    }
    if (outcome.kind === "registered") return { kind: "registered", runDate, unkoNo, attempted: true };
    const key = cardRegisterErrorKey(deps.r2Prefix, row.id, deps.now);
    await deps.putHtml(key, outcome.html);
    return { kind: "failed", runDate, unkoNo, attempted: true, detail: `${outcome.reason} (原本 ${key})` };
  } catch (err) {
    return { kind: "error", runDate, unkoNo, attempted: true, detail: `etc-meisai.jp への登録で失敗: ${errorMessage(err)}` };
  }
}

/** 結末を D1 へ書く。`no_run` は何も書かない。 */
async function persist(deps: CardRegisterRunDeps, id: number, o: RowOutcome): Promise<void> {
  if (o.kind === "no_run") return;
  const attempts = o.attempted ? 1 : 0;
  const updatedAt = deps.now.toISOString();
  if (o.kind === "error") {
    await deps.db
      .prepare(
        "UPDATE etc_card_registrations SET attempts = attempts + ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .bind(attempts, String(o.detail), updatedAt, id)
      .run();
    return;
  }
  await deps.db
    .prepare(
      "UPDATE etc_card_registrations SET status = ?, run_date = COALESCE(?, run_date), " +
        "unko_no = COALESCE(?, unko_no), attempts = attempts + ?, last_error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(o.kind, o.runDate ?? null, o.unkoNo ?? null, attempts, o.detail ?? null, updatedAt, id)
    .run();
}

/**
 * 対象の行を順に (直列に) 処理する。**呼び手は etc-meisai.jp の同一アカウントへの
 * 同時ログインを避けるため、DO の `enqueueScrape` の中から呼ぶこと。**
 */
export async function runCardRegistrations(
  deps: CardRegisterRunDeps,
  target: CardRegisterTarget,
): Promise<CardRegisterReport> {
  const q = selectRegistrationsQuery(target, deps.mode);
  const rows = (await deps.db.prepare(q.sql).bind(...q.params).all<RegistrationRow>()).results ?? [];
  if (target.kind === "one" && rows.length === 0) return { notFound: true, results: [] };

  const cache = new Map<string, Promise<OperationRef[]>>();
  const operationsOf = (tenantId: string): Promise<OperationRef[]> => {
    let p = cache.get(tenantId);
    if (!p) {
      p = loadOperations(deps, tenantId);
      cache.set(tenantId, p);
    }
    return p;
  };

  const results: CardRegisterResult[] = [];
  for (const row of rows) {
    const o = await processRow(deps, row, operationsOf);
    await persist(deps, row.id, o);
    results.push({ id: row.id, cardNumber: row.card_number, kind: o.kind, runDate: o.runDate, detail: o.detail });
  }
  return { notFound: false, results };
}
