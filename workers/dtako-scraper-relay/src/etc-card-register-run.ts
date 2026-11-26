/**
 * ETC カード追加登録の 2 段 (Refs ohishi-exp/nuxt-dtako-admin#1287):
 *
 * - `confirmRunsFromTollCsv` — **確認**。dtako の zip 登録時に、その zip の `KUDGSIR.csv` から
 *   走行日を見つけて `run_date` / `unko_no` を書く (status は `waiting_run` のまま)
 * - `runCardRegistrations` — **登録**。ETC cron の 21 時 (UTC) の tick (と手動の 1 件) で、
 *   `run_date` のある行を etc-meisai.jp へ送る
 *
 * I/O (D1・etc-meisai.jp・R2) は deps で受ける (DO は配線するだけ。ここは node vitest で 100%)。
 * 判定の中身は `etc-card-register.ts`。
 *
 * ## 登録段の status の動かし方
 *
 * | 結末 | status | run_date / unko_no | attempts | last_error |
 * |---|---|---|---|---|
 * | 走行日が範囲 (登録日を含む) から外れた (`expired`) | 変えない | **消す** (次の zip で確認し直す) | 触らない | 触らない |
 * | 確認画面まで (`dry_run_ok`) | `dry_run_ok` | 触らない | +1 | NULL |
 * | 完了 (`registered`) | `registered` | 触らない | +1 | NULL |
 * | 登録しない / 弾かれた (`failed`) | `failed` | 触らない | 送ったときだけ +1 | 理由 |
 * | 通信が落ちた (`error`) | **変えない** | 触らない | +1 | 理由 |
 *
 * `error` で status を変えないのは、etc-meisai.jp の一時的な失敗で行を失敗扱いにしないため
 * (次の tick で自然に再試行される)。
 */

import {
  buildCardRegisterFields,
  cardRegisterConfirmKey,
  cardRegisterErrorKey,
  countNonEtcRows,
  effectiveRegistrationDate,
  findRunForPlate,
  isRunDateUsable,
  parseTollCsv,
  parseTollTable,
  plate4OfVehicleCd,
  runSearchWindow,
  type CardRegisterFields,
  type CardRegisterMode,
  type CardRegisterResult,
  type RunConfirmResult,
  type TollRow,
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

// ---------------------------------------------------------------------------
// 確認 (zip 登録時)
// ---------------------------------------------------------------------------

/** 確認段で見る行: `waiting_run` で、明細書を受けた会社 (`etc_card_scans.tenant_id`) が
 * その zip のアカウントの tenant と一致するもの。実効の登録日を作るため `registration_date` と
 * scan の `received_at` も持ってくる。 */
const SELECT_WAITING_BASE_SQL =
  "SELECT r.id, r.card_number, r.plate4, r.run_date, r.registration_date, s.received_at FROM etc_card_registrations r " +
  "JOIN etc_card_scans s ON s.sha256 = r.scan_sha256 " +
  "WHERE r.status = 'waiting_run' AND r.plate4 IS NOT NULL AND s.tenant_id = ?";

export const SELECT_WAITING_FOR_TENANT_SQL = `${SELECT_WAITING_BASE_SQL} ORDER BY r.id`;

/** 「走行日を探し直す」用: 上と同じ条件で、行 id 1 つに絞る (他の waiting_run の行は触らない)。 */
export const SELECT_WAITING_ONE_SQL = `${SELECT_WAITING_BASE_SQL} AND r.id = ? ORDER BY r.id`;

export interface RunConfirmReport {
  results: RunConfirmResult[];
  /** `ETC利用` が "1" でなく数えなかった行の数 (ログに出す)。 */
  nonEtcRows: number;
}

/**
 * zip の `KUDGSIR.csv` (文字列にしたもの) から、`tenantId` の `waiting_run` の行の走行日を確認する。
 * - 範囲 (行ごとの実効の登録日〜。`runSearchWindow`) 内の ETC 走行があり、`run_date` が空かそれより古ければ `run_date` / `unko_no` を書く
 * - plate4 に一致する車輌CD が 2 種類以上あれば `failed` + 「車両が複数一致」
 * - 何も無ければ触らない (登録日より前の走行しか無い行も。走行待ちのまま)
 *
 * `onlyId` を渡すとその 1 行だけを見る (「走行日を探し直す」。tenant の他の行は触らない)。
 */
export async function confirmRunsFromTollCsv(
  deps: { db: CardRegisterDb; now: Date },
  tenantId: string,
  csvText: string,
  onlyId?: number,
): Promise<RunConfirmReport> {
  return confirmRunsFromTolls(deps, tenantId, parseTollCsv(csvText), onlyId);
}

/** {@link confirmRunsFromTollCsv} の本体 (読み終えた料金所の行を受ける)。判定はここ 1 か所。 */
export async function confirmRunsFromTolls(
  deps: { db: CardRegisterDb; now: Date },
  tenantId: string,
  tolls: readonly TollRow[],
  onlyId?: number,
): Promise<RunConfirmReport> {
  const updatedAt = deps.now.toISOString();
  const select =
    onlyId === undefined
      ? deps.db.prepare(SELECT_WAITING_FOR_TENANT_SQL).bind(tenantId)
      : deps.db.prepare(SELECT_WAITING_ONE_SQL).bind(tenantId, onlyId);
  const rows =
    (
      await select
        .all<{
          id: number;
          card_number: string | null;
          plate4: string;
          run_date: string | null;
          registration_date: string | null;
          received_at: string;
        }>()
    ).results ?? [];

  const results: RunConfirmResult[] = [];
  for (const row of rows) {
    const window = runSearchWindow(deps.now, effectiveRegistrationDate(row.registration_date, row.received_at));
    const run = findRunForPlate(tolls, row.plate4, window);
    const base = { id: row.id, cardNumber: row.card_number };
    if (run.kind === "multiple") {
      const detail = `車両が複数一致 (車輌CD ${run.vehicleCds.join(", ")})`;
      await deps.db
        .prepare("UPDATE etc_card_registrations SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
        .bind(detail, updatedAt, row.id)
        .run();
      results.push({ ...base, kind: "multiple", detail });
    } else if (run.kind === "none") {
      results.push({ ...base, kind: "none" });
    } else if (row.run_date !== null && row.run_date >= run.runDate) {
      results.push({ ...base, kind: "kept", runDate: row.run_date });
    } else {
      await deps.db
        .prepare("UPDATE etc_card_registrations SET run_date = ?, unko_no = ?, updated_at = ? WHERE id = ?")
        .bind(run.runDate, run.unkoNo, updatedAt, row.id)
        .run();
      results.push({ ...base, kind: "found", runDate: run.runDate });
    }
  }
  return { results, nonEtcRows: countNonEtcRows(tolls) };
}

// ---------------------------------------------------------------------------
// 走行日を探し直す (手動。alc に取り込み済みの運行の KUDGSIR を読み直す)
// ---------------------------------------------------------------------------

/** 探し直しの対象の行: id 1 つ、`waiting_run` で plate4 あり。tenant (どの会社の運行を読むか) と
 * 実効の登録日の材料も読む。 */
export const SELECT_RESCAN_TARGET_SQL =
  "SELECT r.id, r.card_number, r.plate4, r.registration_date, s.received_at, s.tenant_id FROM etc_card_registrations r " +
  "JOIN etc_card_scans s ON s.sha256 = r.scan_sha256 " +
  "WHERE r.id = ? AND r.status = 'waiting_run' AND r.plate4 IS NOT NULL";

export interface RescanTarget {
  id: number;
  card_number: string | null;
  plate4: string;
  registration_date: string | null;
  received_at: string;
  tenant_id: string;
}

/** 探し直せる行を読む。無い (id 違い・走行待ちでない・下 4 桁が無い) なら null。 */
export async function findRescanTarget(db: CardRegisterDb, id: number): Promise<RescanTarget | null> {
  const rows = (await db.prepare(SELECT_RESCAN_TARGET_SQL).bind(id).all<RescanTarget>()).results ?? [];
  return rows[0] ?? null;
}

/** 1 回に KUDGSIR を読む運行の上限。超えたら新しい (読取日の遅い) 方から上限まで読み、`truncated` を立てる。 */
export const RESCAN_MAX_OPERATIONS = 200;

/** 運行の一覧の 1 ページの件数 (alc-dtako-worker の `MAX_PER_PAGE`)。 */
export const RESCAN_LIST_PER_PAGE = 200;

/** alc の 1 運行の KUDGSIR の口が受ける運行 NO (auth-worker の許可が数字 1〜32 桁に絞っている)。 */
const UNKO_NO_PATH_RE = /^[0-9]{1,32}$/;

/** alc の shared-secret class の口を GET する (`getViaAlcInternalProxy` に tenant と secret を束ねたもの)。 */
export type AlcGet = (path: string) => Promise<{ status: number; text: string }>;

export interface RescanDeps {
  db: CardRegisterDb;
  now: Date;
  /** tenant は呼び手が {@link RescanTarget.tenant_id} で束ねる。 */
  alcGet(tenantId: string, path: string): Promise<{ status: number; text: string }>;
}

export class RescanUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RescanUpstreamError";
  }
}

interface OperationListItem {
  unko_no?: unknown;
  vehicle_cd?: unknown;
}

export type RescanReport =
  | { kind: "not_found" }
  | {
      kind: "done";
      id: number;
      cardNumber: string | null;
      /** 運行を引いた読取日の範囲 (`runSearchWindow`)。 */
      from: string;
      to: string;
      /** KUDGSIR を読めた運行の数。 */
      operations: number;
      /** KUDGSIR が無かった (404) / 運行 NO が数字でなかった運行の数。 */
      skipped: number;
      /** 対象の運行が上限 ({@link RESCAN_MAX_OPERATIONS}) を超え、新しい方だけ読んだ。 */
      truncated: boolean;
      /** その行の確認の結果 (登録日より後の走行が無い・未来の登録日なら null)。 */
      result: RunConfirmResult | null;
    };

/**
 * 「走行日を探し直す」本体 (Refs #1287)。カードを登録する前に alc へ取り込み済みの運行は cron の
 * 確認段 (`confirmRunsFromTollCsv`) が見ないので、行 1 つについて alc の運行を読み直す。
 *
 * 1. `GET /api/internal/operations?date_from&date_to&page&per_page` で、実効の登録日〜今日
 *    (`runSearchWindow`) の**読取日**の運行を全ページ引く (読取日は運行日と同じか遅い)。
 *    **plate4 は車輌CD の下 4 桁 (`車輌CD % 10000`) で、一覧の `vehicle_cd` は完全一致の絞り込みなので
 *    問いには載せない**。一覧の `vehicle_cd` が plate4 に当たる運行 (と `vehicle_cd` の無い運行) だけを残す
 * 2. 各運行の `GET /api/internal/operations/{運行NO}/csv/kudgsir` (`{headers, rows}`) を読む。404 は飛ばして数える
 * 3. 集めた料金所の行を確認段と同じ判定 (`confirmRunsFromTolls`) に 1 回で通す。行 id で絞る
 *
 * **alc には何も書かない (GET だけ)**。D1 に書くのは確認段が書くもの (run_date / unko_no、複数一致の failed) だけ。
 * 一覧・CSV の 404 以外の非 2xx は {@link RescanUpstreamError} で投げる。
 */
export async function rescanRunsForRow(deps: RescanDeps, id: number): Promise<RescanReport> {
  const target = await findRescanTarget(deps.db, id);
  if (!target) return { kind: "not_found" };
  const window = runSearchWindow(deps.now, effectiveRegistrationDate(target.registration_date, target.received_at));
  const get: AlcGet = (path) => deps.alcGet(target.tenant_id, path);
  const base = { kind: "done" as const, id, cardNumber: target.card_number, from: window.from, to: window.to };
  if (window.from > window.to) return { ...base, operations: 0, skipped: 0, truncated: false, result: null };

  const unkoNos: string[] = [];
  let truncated = false;
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({
      date_from: window.from,
      date_to: window.to,
      page: String(page),
      per_page: String(RESCAN_LIST_PER_PAGE),
    });
    const res = await get(`/alc-internal-proxy/api/internal/operations?${q}`);
    if (res.status < 200 || res.status >= 300) {
      throw new RescanUpstreamError(`運行の一覧を読めません (${res.status}): ${res.text.slice(0, 200)}`);
    }
    const body = JSON.parse(res.text) as { operations?: OperationListItem[]; total?: unknown };
    const items = body.operations ?? [];
    for (const op of items) {
      const unko = typeof op.unko_no === "string" ? op.unko_no : "";
      const cd = typeof op.vehicle_cd === "string" ? op.vehicle_cd : null;
      if (cd !== null && plate4OfVehicleCd(cd) !== target.plate4) continue;
      if (unkoNos.includes(unko)) continue; // 2 マン運行は crew_role ごとに行がある
      if (unkoNos.length >= RESCAN_MAX_OPERATIONS) {
        truncated = true;
        break;
      }
      unkoNos.push(unko);
    }
    const total = typeof body.total === "number" ? body.total : 0;
    if (truncated || items.length === 0 || page * RESCAN_LIST_PER_PAGE >= total) break;
  }

  const tolls: TollRow[] = [];
  let operations = 0;
  let skipped = 0;
  for (const unko of unkoNos) {
    if (!UNKO_NO_PATH_RE.test(unko)) {
      skipped++;
      continue;
    }
    const res = await get(`/alc-internal-proxy/api/internal/operations/${unko}/csv/kudgsir`);
    if (res.status === 404) {
      skipped++;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new RescanUpstreamError(`運行 ${unko} の KUDGSIR を読めません (${res.status}): ${res.text.slice(0, 200)}`);
    }
    const table = JSON.parse(res.text) as { headers?: string[]; rows?: string[][] };
    tolls.push(...parseTollTable(table.headers ?? [], table.rows ?? []));
    operations++;
  }

  const result =
    tolls.length === 0 ? null : ((await confirmRunsFromTolls(deps, target.tenant_id, tolls, id)).results[0] ?? null);
  return { ...base, operations, skipped, truncated, result };
}

// ---------------------------------------------------------------------------
// 登録 (ETC cron の 21 時 UTC / 手動)
// ---------------------------------------------------------------------------

export interface CardRegisterRunDeps {
  db: CardRegisterDb;
  now: Date;
  mode: CardRegisterMode;
  /** `ETC_R2_PREFIX` (既定 `etc`)。 */
  r2Prefix: string;
  /** etc-meisai.jp へ送る (ログインは呼び手が 1 回にまとめる)。 */
  register(fields: CardRegisterFields): Promise<EtcCardRegisterOutcome>;
  /** R2 へ HTML を置く。 */
  putHtml(key: string, html: string): Promise<void>;
}

export type CardRegisterTarget = { kind: "cron" } | { kind: "one"; id: number };

/** 1 回に拾う行の上限。 */
export const CARD_REGISTER_BATCH_LIMIT = 20;

interface RegistrationRow {
  id: number;
  card_number: string | null;
  plate4: string | null;
  obu_number: string | null;
  run_date: string | null;
  registration_date: string | null;
  received_at: string;
}

/** 拾う status。cron は live のとき `dry_run_ok` も (dry-run で確認まで通した行を本登録する)。
 * `failed` は自動では拾わない (人が見てから手動で)。 */
export function targetStatuses(target: CardRegisterTarget, mode: CardRegisterMode): string[] {
  if (target.kind === "one") return ["waiting_run", "dry_run_ok", "failed"];
  return mode === "live" ? ["waiting_run", "dry_run_ok"] : ["waiting_run"];
}

/** 対象の行を読む SQL と bind 値。scan を JOIN して実効の登録日の材料も読む。cron は `run_date` のある行だけ。手動は id で引き、
 * `run_date` が無ければ呼び手が 409 にする (`conflict`)。 */
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
  } else {
    where += " AND r.run_date IS NOT NULL";
  }
  params.push(CARD_REGISTER_BATCH_LIMIT);
  return {
    sql:
      "SELECT r.id, r.card_number, r.plate4, r.obu_number, r.run_date, r.registration_date, s.received_at " +
      "FROM etc_card_registrations r JOIN etc_card_scans s ON s.sha256 = r.scan_sha256 " +
      `WHERE ${where} ORDER BY r.id LIMIT ?`,
    params,
  };
}

export interface CardRegisterReport {
  /** 手動 1 件で、対象の行が無かった (id 違い / 拾えない status)。 */
  notFound: boolean;
  /** 手動 1 件で、走行日が未確認 (`run_date` が空)。 */
  conflict: boolean;
  results: CardRegisterResult[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type RowOutcome = Omit<CardRegisterResult, "id" | "cardNumber"> & { attempted?: boolean };

async function processRow(deps: CardRegisterRunDeps, row: RegistrationRow): Promise<RowOutcome> {
  const runDate = row.run_date as string;
  if (!isRunDateUsable(runDate, deps.now, effectiveRegistrationDate(row.registration_date, row.received_at))) return { kind: "expired", runDate };
  const built = buildCardRegisterFields(
    { cardNumber: row.card_number, obuNumber: row.obu_number, plate4: row.plate4, runDate },
    deps.now,
  );
  if (!built.ok) return { kind: "failed", runDate, detail: built.reason };

  try {
    const outcome = await deps.register(built.fields);
    if (outcome.kind === "confirmed") {
      await deps.putHtml(cardRegisterConfirmKey(deps.r2Prefix, row.id, deps.now), outcome.html);
      return { kind: "dry_run_ok", runDate, attempted: true };
    }
    if (outcome.kind === "registered") return { kind: "registered", runDate, attempted: true };
    const key = cardRegisterErrorKey(deps.r2Prefix, row.id, deps.now);
    await deps.putHtml(key, outcome.html);
    return { kind: "failed", runDate, attempted: true, detail: `${outcome.reason} (原本 ${key})` };
  } catch (err) {
    return { kind: "error", runDate, attempted: true, detail: `etc-meisai.jp への登録で失敗: ${errorMessage(err)}` };
  }
}

/** 結末を D1 へ書く。 */
async function persist(deps: CardRegisterRunDeps, id: number, o: RowOutcome): Promise<void> {
  const updatedAt = deps.now.toISOString();
  if (o.kind === "expired") {
    await deps.db
      .prepare("UPDATE etc_card_registrations SET run_date = NULL, unko_no = NULL, updated_at = ? WHERE id = ?")
      .bind(updatedAt, id)
      .run();
    return;
  }
  const attempts = o.attempted ? 1 : 0;
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
      "UPDATE etc_card_registrations SET status = ?, attempts = attempts + ?, last_error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(o.kind, attempts, o.detail ?? null, updatedAt, id)
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
  if (target.kind === "one") {
    if (rows.length === 0) return { notFound: true, conflict: false, results: [] };
    if (rows[0].run_date === null) return { notFound: false, conflict: true, results: [] };
  }

  const results: CardRegisterResult[] = [];
  for (const row of rows) {
    const o = await processRow(deps, row);
    await persist(deps, row.id, o);
    results.push({ id: row.id, cardNumber: row.card_number, kind: o.kind, runDate: o.runDate, detail: o.detail });
  }
  return { notFound: false, conflict: false, results };
}
