/**
 * 無人スクレイプ (日次 cron / `run_dtako_scrape`) の結果を **alc のスクレイプ履歴の
 * 行に組み立てる**ための pure ロジック (Refs #931)。
 *
 * ## なぜ要るか — 無人実行だけが履歴に残らない
 *
 * `POST /api/scraper/history` を呼ぶのは `app/utils/api.ts` の `saveScrapeHistory`
 * 1 か所だけで、それを呼ぶのは `app/pages/scraper.vue` = **ブラウザ実行のときだけ**。
 * relay の cron 経路 (`runCronDtakoScrape`) には POST が無いので、**無人実行は
 * 1 件も履歴に載らない**。画面の履歴を見て「今月は 3 回しか回っていない」と読むと
 * 誤る (実際は cron が毎日回っている)。
 *
 * `scrape-dispatch.ts` の `fetchScrapeHistory` の docs が書いているとおり、配布
 * そのものは結果を持たない (`/cron/dtako` は 202 を返して非同期に走る) ので、
 * `status` / `message` は**履歴でしか読めない**。
 *
 * ## ★ 送り先はここでは決めない
 *
 * このモジュールは **行を組み立てるところまで**を持ち、実際の送信は
 * [`SendScrapeHistory`] として**呼び出し側から注入**する。
 *
 * **`/alc-internal-proxy/api/scraper/history` は通らない** — auth-worker の
 * `classifyInternalPath` の allowlist に path が無く、GET / POST とも 403
 * (`{"error":"forbidden"}`、上流へ forward されない)。alc 側で
 * `/scraper/history` は `tenant_router()` = `require_tenant_header` の data 経路で、
 * これは #434 の詐称を塞ぐため**意図的に allowlist から外されている**。
 *
 * その後 device credential (`/device-data-proxy`) を経て、**いまは auth-worker の
 * RPC entrypoint 越し** (`alc-tenant-rpc.ts`、Refs #950)。**3 度 経路が変わったが
 * このモジュールは一度も変えていない** — 注入にしてある理由がこれ。
 *
 * ## 出自を `message` に書く理由 (`status` ではなく)
 *
 * alc の履歴の列は `target_date` / `comp_id` / `status` / `message` の 4 つだけで
 * (`migrations/056_scrape_history.sql`)、列を足すには rust 側の migration が要る。
 * そのうえで `status` は**完全一致で読まれている** —
 * `scrape-dispatch.ts` の `countSplitFailed` が `status === "split_failed"` で数える。
 * ⇒ 出自の印を `status` に混ぜると既存の数え方が壊れるので、**`message` の
 * 先頭に付ける**。人が読める形 ([`SCRAPE_HISTORY_MARKERS`]) にしつつ、数える側は
 * [`readScrapeHistorySource`] で正確に判定できるようにしてある。
 *
 * **印の無い行は「画面 or この PR より前の行」** — 遡って書き換えることはできない
 * ので、`null` を「ブラウザ実行」と決めつけない (`readScrapeHistorySource` の返りは
 * `null` のまま)。
 */

import { addDaysIso } from "./net780-archive";

/** alc の `POST /api/scraper/history` が受ける body (`app/utils/api.ts` の
 * `ScrapeHistoryEntry` と同じ形。rust 側は `ScrapeHistoryEntry` = `dtako_scraper.rs`)。 */
export interface ScrapeHistoryEntry {
  /** "YYYY-MM-DD"。履歴は**範囲ではなく 1 日単位**。 */
  target_date: string;
  comp_id: string;
  status: string;
  message?: string;
}

/** 履歴の行の出自。 */
export type ScrapeHistorySource = "cron" | "browser";

/** `message` の先頭に付ける印。**人が画面で読む文字列**なので日本語。 */
export const SCRAPE_HISTORY_MARKERS: Readonly<Record<ScrapeHistorySource, string>> = {
  cron: "[無人]",
  browser: "[画面]",
};

/**
 * 1 回ぶんの cron スクレイプの結末。**`runCronDtakoScrape` が既に
 * `console.log` / `console.error` に出し分けている 3 通りをそのまま写した形**で、
 * 新しい語彙は作らない (ログと履歴で status がずれると付き合わせられない)。
 */
export type CronScrapeOutcome =
  | { kind: "success" }
  /** 取り込みは成功したが CSV 分割が落ちた回。`status` は `split_failed` — この値は
   * `countSplitFailed` が完全一致で数える。 */
  | { kind: "split_failed"; splitFailed: number }
  | { kind: "error"; message: string };

/**
 * 履歴に展開する日数の上限。**日次 cron も `run_dtako_scrape` も現状 1 日ずつしか
 * 投げない** (`cron.ts` は `yesterdayJst` の 1 日、`dispatchScrapeDates` は 1 日 1 回)
 * が、`/cron/dtako` の body は任意の範囲を受けるので歯止めを置く。1 か月ぶんあれば
 * 取り直しの範囲としては足りる。
 */
export const MAX_HISTORY_DATES = 31;

/** `message` の上限。alc 側は TEXT で制限は無いが、失敗本文をそのまま流し込むと
 * 履歴一覧が読めなくなるので切る。**切ったことが分かる形** (末尾に `…`) にする。 */
export const MAX_HISTORY_MESSAGE = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" として**実在する日**か。`2026-02-30` / `2026-13-01` は正規表現は
 * 通るので、`addDaysIso(d, 0)` で往復させて弾く (繰り上がったら別の日になる)。 */
function isRealDate(date: string): boolean {
  return DATE_RE.test(date) && addDaysIso(date, 0) === date;
}

/**
 * `startDate`..`endDate` (両端含む) を 1 日ずつに展開する。
 *
 * - 日付として読めない / 逆順なら `null` (**呼び出し側が「履歴を書かない」と
 *   判断できるように**、空配列と区別する)
 * - [`MAX_HISTORY_DATES`] を超えたぶんは切るが、**黙って切らない** —
 *   切った日数を `dropped` で返す (この repo の規範)
 */
export function expandScrapeDateRange(
  startDate: string,
  endDate: string,
): { dates: string[]; dropped: number } | null {
  if (!isRealDate(startDate) || !isRealDate(endDate)) return null;
  const spanDays =
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000;
  if (spanDays < 0) return null;
  const total = spanDays + 1;
  const take = Math.min(total, MAX_HISTORY_DATES);
  const dates: string[] = [];
  for (let i = 0; i < take; i++) dates.push(addDaysIso(startDate, i));
  return { dates, dropped: total - take };
}

/** [`MAX_HISTORY_MESSAGE`] で切る。切ったら末尾に `…` を付ける。 */
export function truncateHistoryMessage(message: string): string {
  if (message.length <= MAX_HISTORY_MESSAGE) return message;
  return `${message.slice(0, MAX_HISTORY_MESSAGE - 1)}…`;
}

/** 結末 → `status` と印無しの `message`。**ログの文言と揃える** (上の docs 参照)。 */
function describeOutcome(outcome: CronScrapeOutcome): { status: string; message: string } {
  if (outcome.kind === "success") {
    return { status: "success", message: "取り込み成功" };
  }
  if (outcome.kind === "split_failed") {
    return {
      status: "split_failed",
      message:
        `取り込みは成功したが CSV 分割が ${outcome.splitFailed} 件失敗した ` +
        "(該当運行が読み取り側から消える)",
    };
  }
  return { status: "error", message: outcome.message };
}

/** 印を付けた `message` を組む。 */
export function markHistoryMessage(source: ScrapeHistorySource, message: string): string {
  return truncateHistoryMessage(`${SCRAPE_HISTORY_MARKERS[source]} ${message}`);
}

/**
 * `message` から出自を読む。**印が無ければ `null`** — 「画面から」とは決めつけない
 * (この PR より前の行には印が無い)。
 */
export function readScrapeHistorySource(message: string | null | undefined): ScrapeHistorySource | null {
  if (!message) return null;
  for (const source of ["cron", "browser"] as const) {
    if (message.startsWith(`${SCRAPE_HISTORY_MARKERS[source]} `)) return source;
  }
  return null;
}

export interface BuildScrapeHistoryInput {
  compId: string;
  startDate: string;
  endDate: string;
  outcome: CronScrapeOutcome;
  /** 既定は無人 (`cron`)。画面側から使うときだけ `browser`。 */
  source?: ScrapeHistorySource;
}

/**
 * cron 1 回ぶんの結末を、**読取日 1 日 = 1 行**の履歴に展開する。
 *
 * 範囲を代表 1 行にまとめないのは、**回数を数えたときに誤読させないため**
 * (#931 の完了条件)。画面側 (`scraper.vue`) も 1 日 1 行で書いているので、
 * 2 つの経路の行が同じ粒度で並ぶ。
 *
 * 日付が読めない範囲では**行を作らない** (`entries` が空・`dropped` は 0)。
 * 履歴に嘘の `target_date` を残すより、書かずに呼び出し側のログに出す方を選ぶ。
 */
export function buildScrapeHistoryEntries(input: BuildScrapeHistoryInput): {
  entries: ScrapeHistoryEntry[];
  dropped: number;
} {
  const range = expandScrapeDateRange(input.startDate, input.endDate);
  if (!range) return { entries: [], dropped: 0 };
  const { status, message } = describeOutcome(input.outcome);
  const marked = markHistoryMessage(input.source ?? "cron", message);
  return {
    entries: range.dates.map((target_date) => ({
      target_date,
      comp_id: input.compId,
      status,
      message: marked,
    })),
    dropped: range.dropped,
  };
}

/** 1 行を送る口。**送り先はここでは決めない** (上の docs 参照)。 */
export type SendScrapeHistory = (entry: ScrapeHistoryEntry) => Promise<void>;

export interface ScrapeHistoryRecordReport {
  attempted: number;
  saved: number;
  /** 落ちた行。**握り潰さずここに残す**ので、呼び出し側が 1 行にまとめて鳴らせる。 */
  failed: { target_date: string; error: string }[];
}

/**
 * 履歴を 1 行ずつ送る。**★ 絶対に throw しない。**
 *
 * ## なぜ throw しないか — 履歴が書けないせいで取り込みを止めない
 *
 * これは**診断のための書き込み**であって、取り込み本体の成否とは関係が無い。
 * ここで throw すると `runCronDtakoScrape` の catch に落ち、**取り込みは成功した
 * のに `state: "failed"` で上書きされる** (#205-43 条件3 と同じ事故)。
 * `saveScrapeErrorArtifact` / `recordScrapeJob` が既に採っているのと同じ流儀。
 *
 * **ただし黙らない。** 落ちた行は `log` に 1 行ずつ出し、`failed` にも残す
 * (画面側 `recordScrapeResult` の `.catch(() => {})` は握り潰していて、
 * **無人経路で同じことをすると誰も気づけない**)。
 *
 * 直列に送るのは順序を決定的にするため (行数は最大 [`MAX_HISTORY_DATES`])。
 */
export async function recordScrapeHistoryLoud(
  entries: ScrapeHistoryEntry[],
  send: SendScrapeHistory,
  log: (line: string) => void,
): Promise<ScrapeHistoryRecordReport> {
  const report: ScrapeHistoryRecordReport = { attempted: entries.length, saved: 0, failed: [] };
  for (const entry of entries) {
    try {
      await send(entry);
      report.saved++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      report.failed.push({ target_date: entry.target_date, error });
      log(
        JSON.stringify({
          scrape_history: "save_failed",
          comp_id: entry.comp_id,
          target_date: entry.target_date,
          error,
        }),
      );
    }
  }
  return report;
}
