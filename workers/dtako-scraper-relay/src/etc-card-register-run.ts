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
  countRangeDays,
  cardRegisterErrorKey,
  countNonEtcRows,
  effectiveRegistrationDate,
  findRunForPlate,
  isRunDateUsable,
  parseTollCsv,
  rescanReadingRanges,
  runSearchWindow,
  type CardRegisterFields,
  type CardRegisterMode,
  type CardRegisterResult,
  type ReadingDateRange,
  type RunConfirmResult,
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
  const tolls = parseTollCsv(csvText);
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
// 走行日を探し直す (手動。取り込み済みの zip を theearth から取り直す)
// ---------------------------------------------------------------------------

/** 探し直しの対象の行: id 1 つ、`waiting_run` で plate4 あり。tenant (どの会社の theearth で
 * 取り直すか) と実効の登録日の材料も読む。 */
export const SELECT_RESCAN_TARGET_SQL =
  "SELECT r.id, r.card_number, r.registration_date, s.received_at, s.tenant_id FROM etc_card_registrations r " +
  "JOIN etc_card_scans s ON s.sha256 = r.scan_sha256 " +
  "WHERE r.id = ? AND r.status = 'waiting_run' AND r.plate4 IS NOT NULL";

export interface RescanTarget {
  id: number;
  card_number: string | null;
  registration_date: string | null;
  received_at: string;
  tenant_id: string;
}

/** 探し直せる行を読む。無い (id 違い・走行待ちでない・下 4 桁が無い) なら null。 */
export async function findRescanTarget(db: CardRegisterDb, id: number): Promise<RescanTarget | null> {
  const rows = (await db.prepare(SELECT_RESCAN_TARGET_SQL).bind(id).all<RescanTarget>()).results ?? [];
  return rows[0] ?? null;
}

export interface RescanDeps {
  db: CardRegisterDb;
  now: Date;
  /** 読取日の範囲の csvdata.zip を theearth から取る (`scrapeViaHttp`)。**alc へは上げない。** */
  fetchZip(range: ReadingDateRange): Promise<ArrayBuffer>;
  /** zip の `KUDGSIR.csv` を文字列にする。無ければ null。 */
  readTollCsv(zip: ArrayBuffer): Promise<string | null>;
}

export interface RescanChunk extends ReadingDateRange {
  status: "confirmed" | "no_kudgsir" | "error";
  results?: RunConfirmResult[];
  error?: string;
}

export type RescanReport =
  | { kind: "not_found" }
  | {
      kind: "done";
      id: number;
      cardNumber: string | null;
      /** 取り直した日数 (全区間の合計)。 */
      days: number;
      chunks: RescanChunk[];
      /** 見つかった (書いた / 既にあった) 走行日のいちばん新しいもの。無ければ null。 */
      runDate: string | null;
    };

/**
 * 「走行日を探し直す」本体 (Refs #1287)。カードを登録する前に alc へ取り込み済みの zip は
 * cron の確認段 (`confirmRunsFromTollCsv`) が見ないので、行 1 つについて実効の登録日〜今日の
 * 読取日の zip を theearth から取り直し、`KUDGSIR.csv` を確認段と同じ関数に渡す。
 *
 * - **alc へは上げない** (`deps` に upload を持たない。上げると has_kudgivt をリセットする)
 * - D1 に書くのは `confirmRunsFromTollCsv` が書くもの (run_date / unko_no、複数一致の failed) だけ。行 id で絞る
 * - `tenantId` (呼び手の theearth アカウントの tenant) と行の tenant が違えば `not_found`
 * - 区間 ({@link rescanReadingRanges}) は古い順に直列。1 区間の失敗は記録して次へ進む
 *
 * 呼び手は theearth の同じ会社への同時ログインを避けるため、DO の `enqueueScrape` の中から呼ぶこと。
 */
export async function rescanRunsForRow(deps: RescanDeps, tenantId: string, id: number): Promise<RescanReport> {
  const target = await findRescanTarget(deps.db, id);
  if (!target || target.tenant_id !== tenantId) return { kind: "not_found" };
  const ranges = rescanReadingRanges(deps.now, effectiveRegistrationDate(target.registration_date, target.received_at));
  const chunks: RescanChunk[] = [];
  let runDate: string | null = null;
  for (const range of ranges) {
    try {
      const csv = await deps.readTollCsv(await deps.fetchZip(range));
      if (csv === null) {
        chunks.push({ ...range, status: "no_kudgsir" });
        continue;
      }
      const { results } = await confirmRunsFromTollCsv(deps, tenantId, csv, id);
      for (const r of results) {
        if (r.runDate !== undefined && (runDate === null || r.runDate > runDate)) runDate = r.runDate;
      }
      chunks.push({ ...range, status: "confirmed", results });
    } catch (err) {
      chunks.push({ ...range, status: "error", error: errorMessage(err) });
    }
  }
  return { kind: "done", id, cardNumber: target.card_number, days: countRangeDays(ranges), chunks, runDate };
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
