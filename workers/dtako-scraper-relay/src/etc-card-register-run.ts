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
  cardRegisterDoneKey,
  cardRegisterErrorKey,
  countNonEtcRows,
  effectiveRegistrationDate,
  findRunForPlate,
  isRunDateUsable,
  parseTollCsv,
  plate4OfVehicleCd,
  runSearchWindow,
  type CardRegisterFields,
  type CardRegisterMode,
  type CardRegisterResult,
  type RunConfirmResult,
} from "./etc-card-register";
import type { EtcCardRegisterOutcome } from "./etc-meisai-client";
import { deriveOpeNoFromUnkoNo, type DerivedOpeNo } from "./kintai-diff";

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
// 走行日を探し直す (手動。alc の運行の一覧で絞り、運行 1 件ぶんの zip を theearth から取り直す)
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

/** 1 回に zip を取る運行の上限 (operation-zip の items と同じ 20)。超えたら新しい方から 20 件、`truncated`。 */
export const RESCAN_MAX_OPERATIONS = 20;

/** 探し直しを alarm 1 回で進める時間の目安。過ぎたら次の運行の前で止め、続きは次の alarm (Refs #1287)。
 * alarm 1 回の上限 (Cloudflare の文書では 15 分) より十分短くし、1 運行の zip が長引いても収まるようにする。 */
export const RESCAN_ALARM_BUDGET_MS = 5 * 60 * 1000;

/** 運行の一覧の 1 ページの件数 (alc-dtako-worker の `MAX_PER_PAGE`)。 */
export const RESCAN_LIST_PER_PAGE = 200;

export interface RescanDeps {
  db: CardRegisterDb;
  now: Date;
  /** alc の内部用の口 (shared-secret class) を `tenantId` で GET する。**alc には何も書かない。** */
  alcGet(tenantId: string, path: string): Promise<{ status: number; text: string }>;
  /** 運行 1 件ぶんの csvdata.zip を theearth から取り、`KUDGSIR.csv` を文字列で返す。無ければ null。
   * ログインは呼び手が 1 回にまとめる。**alc へは上げない** (upload は has_kudgivt をリセットする)。 */
  fetchTollCsv(op: DerivedOpeNo): Promise<string | null>;
}

/** 運行の一覧が非 2xx・JSON でない (探し直しを始められない)。 */
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
      /** plate4 に当たった運行の数 (上限で切る前。`truncated` なら上限 + 1 で止まる)。 */
      operations: number;
      /** zip を取って KUDGSIR を読めた運行の数。 */
      fetched: number;
      /** KUDGSIR が無い・運行 NO の形が違う運行の数。 */
      skipped: number;
      /** zip の取得が失敗した運行の数と、最初の理由。 */
      failed: number;
      firstError: string | null;
      truncated: boolean;
      /** 走行日が見つかった (書いた / 既にあった / 複数一致) ときの結果。無ければ null。 */
      result: RunConfirmResult | null;
    };

/**
 * 「走行日を探し直す」本体 (Refs #1287)。カードを登録する前に alc へ取り込み済みの運行は cron の
 * 確認段 (`confirmRunsFromTollCsv`) が見ず、取り込み済みの zip には KUDGSIR.csv が無いことがあるので、
 * 行 1 つについて運行 1 件ぶんの zip を theearth から取り直す。
 *
 * 1. `GET /api/internal/operations?date_from&date_to&page&per_page` で、実効の登録日〜今日
 *    (`runSearchWindow`) の**読取日**の運行を全ページ引く (一覧は読取日の新しい順)。
 *    **plate4 は車輌CD の下 4 桁 (`車輌CD % 10000`) で、一覧の `vehicle_cd` は完全一致の絞り込みなので
 *    問いには載せない**。`vehicle_cd` が plate4 に当たる運行 (と `vehicle_cd` の無い運行) だけを残す
 * 2. 新しい順に最大 {@link RESCAN_MAX_OPERATIONS} 件、運行 NO から `ope_no_22` / `start_ope` を作り
 *    (`deriveOpeNoFromUnkoNo`) zip の KUDGSIR を読み、確認段と同じ判定に行 id で絞って通す
 * 3. 走行日が見つかったら (`none` 以外) 残りの運行は取らない
 *
 * **途中で止めて続きから進められる** (`opts`)。1 運行の zip は長く、`alarm()` 1 回の時間に 20 運行が
 * 収まる保証が無いので、`shouldPause()` が真なら (今回 1 件は進めた上で) `paused` と途中経過を返す。
 * 呼び手はそれを storage に積み直し、次の回に `progress` で渡す (一覧は引き直さない)。
 *
 * - `tenantId` (呼び手の theearth アカウントの tenant) と行の tenant が違えば `not_found`
 * - 1 運行の取得の失敗は数えて次へ進む。一覧が読めなければ {@link RescanUpstreamError}
 *
 * 呼び手は theearth の同じ会社への同時ログインを避けるため、DO の `enqueueScrape` の中から呼ぶこと。
 */
export async function rescanRunsForRow(
  deps: RescanDeps,
  tenantId: string,
  id: number,
  opts: { progress?: RescanProgress; shouldPause?: () => boolean } = {},
): Promise<RescanStep> {
  const target = await findRescanTarget(deps.db, id);
  if (!target || target.tenant_id !== tenantId) return { kind: "not_found" };
  const progress = opts.progress ?? (await listRescanOperations(deps, tenantId, target));
  let result: RunConfirmResult | null = null;
  const start = progress.next;
  for (let i = start; i < progress.unkoNos.length; i++) {
    // 1 運行ぶんの zip は長い (stage 2)。alarm 1 回の時間に収まらなければ、ここまでを storage に残して
    // 次の alarm で続きから (呼び手が `paused` を積み直す)。今回の 1 件目は必ず進める。
    if (i > start && opts.shouldPause?.()) return { kind: "paused", progress };
    progress.next = i + 1;
    const op = deriveOpeNoFromUnkoNo(progress.unkoNos[i]!);
    if (!op) {
      progress.skipped++;
      continue;
    }
    let csv: string | null;
    try {
      csv = await deps.fetchTollCsv(op);
    } catch (err) {
      progress.failed++;
      progress.firstError ??= `${op.opeNo22}: ${errorMessage(err)}`;
      continue;
    }
    if (csv === null) {
      progress.skipped++;
      continue;
    }
    progress.fetched++;
    const found = (await confirmRunsFromTollCsv(deps, tenantId, csv, id)).results[0];
    if (found && found.kind !== "none") {
      result = found;
      break;
    }
  }
  const { unkoNos: _unkoNos, next: _next, ...counts } = progress;
  return { kind: "done", id, cardNumber: target.card_number, ...counts, result };
}

/** 探し直しの途中経過。`alarm()` をまたいで storage (キューの item) に持つ。 */
export interface RescanProgress {
  from: string;
  to: string;
  /** zip を取る運行 NO (新しい順、最大 {@link RESCAN_MAX_OPERATIONS} 件)。 */
  unkoNos: string[];
  /** 次に取る `unkoNos` の位置。 */
  next: number;
  operations: number;
  truncated: boolean;
  fetched: number;
  skipped: number;
  failed: number;
  firstError: string | null;
}

export type RescanStep = RescanReport | { kind: "paused"; progress: RescanProgress };

/** 手順 1: 運行の一覧を全ページ引いて、zip を取る運行を決める。 */
async function listRescanOperations(deps: RescanDeps, tenantId: string, target: RescanTarget): Promise<RescanProgress> {
  const window = runSearchWindow(deps.now, effectiveRegistrationDate(target.registration_date, target.received_at));
  const unkoNos: string[] = [];
  for (let page = 1; window.from <= window.to; page++) {
    const q = new URLSearchParams({
      date_from: window.from,
      date_to: window.to,
      page: String(page),
      per_page: String(RESCAN_LIST_PER_PAGE),
    });
    const res = await deps.alcGet(tenantId, `/alc-internal-proxy/api/internal/operations?${q}`);
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
      unkoNos.push(unko);
      if (unkoNos.length > RESCAN_MAX_OPERATIONS) break;
    }
    const total = typeof body.total === "number" ? body.total : 0;
    if (unkoNos.length > RESCAN_MAX_OPERATIONS || items.length === 0 || page * RESCAN_LIST_PER_PAGE >= total) break;
  }
  return {
    from: window.from,
    to: window.to,
    unkoNos: unkoNos.slice(0, RESCAN_MAX_OPERATIONS),
    next: 0,
    operations: unkoNos.length,
    truncated: unkoNos.length > RESCAN_MAX_OPERATIONS,
    fetched: 0,
    skipped: 0,
    failed: 0,
    firstError: null,
  };
}

/**
 * 「走行日を探し直す」の今の状態・結果を、行の `last_error` (画面の「最後の誤り」列) に 1 文で残す
 * (Refs #1287)。**結果がログ 1 行にしか出ない間、「動いていない」と「見つからなかった」を画面から
 * 見分けられなかった**ため。`waiting_run` の行だけに書く — 確認段が `failed` にした行 (車両が複数一致)
 * の理由や、先へ進んだ行は上書きしない。登録段が通れば `last_error` は NULL に戻る。
 */
export async function writeRescanNote(db: CardRegisterDb, id: number, text: string, now: Date): Promise<void> {
  await db
    .prepare("UPDATE etc_card_registrations SET last_error = ?, updated_at = ? WHERE id = ? AND status = 'waiting_run'")
    .bind(text, now.toISOString(), id)
    .run();
}

/** `MM-DD HH:mm` (JST)。 */
function jstMinute(at: Date): string {
  return new Date(at.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(5, 16).replace("T", " ");
}

/** 探し直しの結末。`report` は {@link rescanRunsForRow} の戻り、`error` は投げられた例外。 */
export type RescanOutcome =
  | { kind: "queued"; acceptedAt: Date }
  | { kind: "report"; report: RescanStep }
  | { kind: "error"; error: unknown }
  | { kind: "interrupted"; acceptedAt: Date };

/** 行に残す文。`null` = 書かない (確認段が `failed` と理由を書いた `multiple`)。 */
export function rescanNoteText(outcome: RescanOutcome, now: Date): string | null {
  const head = `走行日の探し直し (${jstMinute(now)})`;
  switch (outcome.kind) {
    case "queued":
      return `走行日を探し直し中 (${jstMinute(outcome.acceptedAt)} 受付)。数分後に再読み込みしてください`;
    case "interrupted":
      return `${head}: 中断しました (relay の再起動。${jstMinute(outcome.acceptedAt)} 受付分)。もう一度「走行日を探し直す」を押してください`;
    case "error":
      return `${head}: 失敗しました: ${errorMessage(outcome.error).slice(0, 200)}`;
  }
  const r = outcome.report;
  if (r.kind === "paused") {
    return `走行日を探し直し中 (${jstMinute(now)} 時点で ${r.progress.next}/${r.progress.unkoNos.length} 運行まで見ました)。数分後に再読み込みしてください`;
  }
  if (r.kind === "not_found") return `${head}: 対象の行ではありません (会社が違う・走行待ちでない・下 4 桁が無い)`;
  const result = r.result;
  if (result?.kind === "multiple") return null;
  if (result?.kind === "found") return `${head}: 走行日 ${result.runDate} を見つけました`;
  if (result?.kind === "kept") return `${head}: 走行日 ${result.runDate} は記録済みです (それより新しい走行はありません)`;
  if (r.from > r.to) return `${head}: 探す範囲が空です (登録日 ${r.from} が今日より後)`;
  const parts = [
    `車両の運行 ${r.truncated ? `${RESCAN_MAX_OPERATIONS} 件超 (新しい方から ${RESCAN_MAX_OPERATIONS} 件だけ見ました)` : `${r.operations} 件`}`,
    `料金所 CSV を読めた ${r.fetched} 件`,
  ];
  if (r.skipped > 0) parts.push(`CSV 無し ${r.skipped} 件`);
  if (r.firstError !== null) parts.push(`取得失敗 ${r.failed} 件 (${r.firstError.slice(0, 120)})`);
  return `${head}: 見つかりませんでした (範囲 ${r.from}..${r.to}・${parts.join("・")})`;
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
    if (outcome.kind === "registered") {
      // etc-meisai.jp 側では登録済み。R2 の失敗で error にすると次の tick で再登録しに行くので、結果は registered のまま。
      try {
        await deps.putHtml(cardRegisterDoneKey(deps.r2Prefix, row.id, deps.now), outcome.html);
        return { kind: "registered", runDate, attempted: true };
      } catch (err) {
        return { kind: "registered", runDate, attempted: true, detail: `完了画面の原本を保存できませんでした: ${errorMessage(err)}` };
      }
    }
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
