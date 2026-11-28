/**
 * dtako の取り込み失敗を**メールでも**人へ届けるための pure ロジック (Refs #1206、
 * ippoan/alc-dtako-worker#26)。設定 (KV `scrape_alert_email`) の検証・MIME の組み立て・
 * best-effort の送信手順と、通知に載せる**理由の固定文言**を持つ。`cloudflare:email` の
 * `EmailMessage` を作って binding へ渡す部分は gate の外 (`dtako-scraper-relay-do.ts` の
 * `scrapeAlertEmailSender`) に置き、ここへは `send` 関数として注入する。
 *
 * **なぜ要るか。** LINE WORKS の通知 (`scrape-alert.ts`) は宛先 `SCRAPE_ALERT_TARGET` が
 * 管理画面の plain 変数にしか無く、未設定だと `console.error` 1 行で黙ってスキップする。
 * 2026-10-05・10-06 に 1 社ぶんの取り込みが落ちたのに誰も気づかなかった。メールは
 * LINE WORKS と**互いに独立に**送る (片方が落ちてももう片方は出る)。
 *
 * 方式は同じ Cloudflare アカウントの ippoan/alc-app `cf-alc-recorder` の
 * `notifyCrashByEmail` と同じ (Email Routing の `send_email` binding + `mimetext`)。
 * **送り元・送り先のアドレスは repo に書かない** — KV に置き、本番の deploy が存在を
 * 検証する (`dtako-scraper-relay-deploy.yml` の「Verify scrape_alert_email (KV)」)。
 *
 * **本文に生のエラー文・R2 の key・運行NO を載せない。** 理由は下の固定の語 + 件数で
 * 組み、例外の message を使う経路 (取り込み本体の catch) は `scrape-alert.ts` の
 * `sanitizeScrapeFailureDetail` を通した文面をそのまま本文にする。
 * **例外は成功の本文の「乗務員未登録のまま走った運行」の行だけ** (`driver0-alert.ts` の
 * `driver0MailLines`) で、運行NO を載せる — ユーザーの指示 (「運行NO も載せる」、Refs ippoan/alc-app#676)。
 */

// ★ `mimetext/browser` を使う (既定の `mimetext` は node 版)。node 版は `mime-types` 経由で
// `require("path")` を持ち、この worker の `compatibility_date` (2024-09-19) では
// `node:` 接頭辞の無い built-in を解決できず `wrangler deploy` の build が落ちる。
// browser 版の依存は `js-base64` だけ。
import { createMimeMessage } from "mimetext/browser";
import type { RecalcPendingResult } from "./alc-internal-upload";
import { DTAKO_ACCOUNTS_EMPTY_DETAIL, type CronRunResult } from "./cron";
import type { FoldSkipReason } from "./kintai-relay";
import { formatReadingDateRange } from "./scrape-alert";

/** 設定を置く KV (`DTAKO_CONFIG_KV`) のキー。値は `{"from": "...", "to": "..."}`。 */
export const SCRAPE_ALERT_EMAIL_KV_KEY = "scrape_alert_email";

/** 差出人の表示名。 */
export const SCRAPE_ALERT_EMAIL_SENDER_NAME = "dtako relay";

export interface ScrapeAlertEmailConfig {
  from: string;
  to: string;
}

export type ScrapeAlertEmailConfigResolution =
  | { ok: true; config: ScrapeAlertEmailConfig }
  | { ok: false; reason: string };

/**
 * KV `scrape_alert_email` の JSON を検証する。`from` / `to` はどちらも空でない文字列で
 * `@` を含むこと。**未設定は fail-closed** — 理由を返し、呼び出し側が
 * 「送っていない」をログに出す (黙って何もしないのが一番危ない)。
 * 理由の文言にアドレスの値は載せない (ログに残るため)。
 */
export function parseScrapeAlertEmailConfig(raw: string | null): ScrapeAlertEmailConfigResolution {
  if (raw === null || raw.trim() === "") {
    return {
      ok: false,
      reason: `KV ${SCRAPE_ALERT_EMAIL_KV_KEY} が未設定のため、取り込み失敗のメールを送っていません`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `KV ${SCRAPE_ALERT_EMAIL_KV_KEY} が JSON としてパースできません` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `KV ${SCRAPE_ALERT_EMAIL_KV_KEY} は {"from": "...", "to": "..."} の JSON オブジェクトである必要があります`,
    };
  }
  const { from, to } = parsed as Record<string, unknown>;
  if (!isAddress(from)) {
    return { ok: false, reason: `KV ${SCRAPE_ALERT_EMAIL_KV_KEY} の from がメールアドレスではありません` };
  }
  if (!isAddress(to)) {
    return { ok: false, reason: `KV ${SCRAPE_ALERT_EMAIL_KV_KEY} の to がメールアドレスではありません` };
  }
  return { ok: true, config: { from: from.trim(), to: to.trim() } };
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.includes("@");
}

/** text/plain 1 本の MIME を組む。`raw` は `EmailMessage` の第 3 引数にそのまま渡す。 */
export function buildScrapeAlertEmail(
  config: ScrapeAlertEmailConfig,
  subject: string,
  body: string,
): { from: string; to: string; raw: string } {
  const msg = createMimeMessage();
  msg.setSender({ name: SCRAPE_ALERT_EMAIL_SENDER_NAME, addr: config.from });
  msg.setRecipient(config.to);
  msg.setSubject(subject);
  // 本文は日本語 (UTF-8 の生バイト) なので 8bit を宣言する。mimetext の既定は 7bit で、
  // ASCII 外を 7bit と名乗ると嘘になる。行は短い (1 行 1000 octet 未満) ので 8bit で足りる。
  msg.addMessage({ contentType: "text/plain", encoding: "8bit", data: body });
  return { from: config.from, to: config.to, raw: msg.asRaw() };
}

/** 件名。`[dtako] 取り込み失敗 <読取日 YYYY/MM/DD>`。 */
export function buildScrapeAlertSubject(startDate: string, endDate: string): string {
  return `[dtako] 取り込み失敗 ${formatReadingDateRange(startDate, endDate)}`;
}

/** 成功の件名。`[dtako] 取り込み成功 <読取日 YYYY/MM/DD>`。失敗と同じ宛先へ送る
 * (「メールが来ない」を「失敗していない」と読まないよう、成功も毎回知らせる)。 */
export function buildScrapeSuccessSubject(startDate: string, endDate: string): string {
  return `[dtako] 取り込み成功 ${formatReadingDateRange(startDate, endDate)}`;
}

/** 成功の本文。会社と読取日だけ (失敗の本文と同じく key は載せない)。
 * `foldLine` (勤怠の畳み直しの結果の 1 行。下の `foldDoneMailLine` 等で作る) があれば
 * 2 行目に足す。畳み直しを呼ばなかった経路では渡さない = 1 行だけの本文のまま。
 * `driver0Lines` (乗務員未登録のまま走った運行。`driver0-alert.ts` の `driver0MailLines`) は
 * その後ろに足す。日次 cron の経路だけが渡し、0 件なら空 = 本文は今のまま。**この行だけは運行NO を
 * 載せる** — ユーザーの指示 (「運行NO も載せる」、Refs ippoan/alc-app#676)。 */
export function buildScrapeSuccessBody(
  compId: string,
  startDate: string,
  endDate: string,
  foldLine?: string | null,
  driver0Lines: readonly string[] = [],
): string {
  const head = `【dtako スクレイプ】comp_id ${compId} の ${formatReadingDateRange(startDate, endDate)}分の自動取り込みに成功しました。`;
  return [head, ...(foldLine ? [foldLine] : []), ...driver0Lines].join("\n");
}

// ---------------------------------------------------------------------------
// 成功メールの 2 行目 = 勤怠の畳み直しの結果 (固定の語 + 月と件数)。失敗と
// `not_configured` は今どおり失敗メールの理由 (`ALERT_REASON_FOLD_*`) に入る。
// ---------------------------------------------------------------------------

/** 畳み直しが最後まで回った (`fold_state: "done"`)。所要は秒に丸める。 */
export function foldDoneMailLine(r: {
  months: string[];
  driversWritten: number;
  pages: number;
  elapsedMs: number;
}): string {
  const sec = Math.round(r.elapsedMs / 1000);
  return `勤怠の畳み直し: 成功 (${r.months.join(", ")}、書き直し ${r.driversWritten} 人、勤怠 Worker の呼び出し ${r.pages} 回、所要 ${sec} 秒)`;
}

/** ページ数の上限で打ち切った (`fold_state: "capped"`)。 */
export const FOLD_CAPPED_MAIL_LINE = "勤怠の畳み直し: 途中で打ち切り (ページ数の上限。続きは次回)";

/** 回さなかった理由の固定の語。`decideFoldTrigger` の `detail` (生の文) は載せない。 */
export const FOLD_SKIP_REASON_TEXT: Record<FoldSkipReason, string> = {
  no_upload: "取り込んだ運行が無い",
  split_failed: "CSV 分割の失敗が残っている",
  out_of_scope: "勤怠の対象外の会社",
  not_configured: "設定が未設定",
};

/** `decideFoldTrigger` が回さないと決めた。 */
export function foldSkippedMailLine(reason: FoldSkipReason): string {
  return `勤怠の畳み直し: 回していない (${FOLD_SKIP_REASON_TEXT[reason]})`;
}

export interface ScrapeAlertEmailDeps {
  /** KV `scrape_alert_email` の生の値。**throw してよい** (ここで catch する)。 */
  readConfig: () => Promise<string | null>;
  /** binding (`ALERT_EMAIL`) が無ければ null。 */
  send: ((from: string, to: string, raw: string) => Promise<void>) | null;
}

/**
 * 取り込み失敗のメールを 1 通送る。**best-effort — 例外を外へ出さない。**
 * 送らなかった / 送れなかった理由は必ず `console.error` に 1 行出す
 * (`status: "scrape_alert_email_not_sent"` / `"scrape_alert_email_send_failed"`)。
 * 「メールが来ない」は「失敗していない」と見分けが付かないため。
 *
 * 例外の message はログに出さない (KV や送信 API の応答文にアドレスが混ざりうる)。
 * 種別 (`Error` の name) だけを残す。
 */
export async function sendScrapeAlertEmail(
  deps: ScrapeAlertEmailDeps,
  subject: string,
  body: string,
  logBase: Record<string, unknown> = {},
): Promise<void> {
  const notSent = (reason: string) =>
    console.error(JSON.stringify({ ...logBase, status: "scrape_alert_email_not_sent", reason }));
  if (!deps.send) {
    notSent("send_email binding ALERT_EMAIL が無いため、取り込み失敗のメールを送っていません");
    return;
  }
  let raw: string | null;
  try {
    raw = await deps.readConfig();
  } catch (err) {
    notSent(`KV ${SCRAPE_ALERT_EMAIL_KV_KEY} の読み取りに失敗 (${errorName(err)})`);
    return;
  }
  const resolved = parseScrapeAlertEmailConfig(raw);
  if (!resolved.ok) {
    notSent(resolved.reason);
    return;
  }
  try {
    const mail = buildScrapeAlertEmail(resolved.config, subject, body);
    await deps.send(mail.from, mail.to, mail.raw);
  } catch (err) {
    console.error(
      JSON.stringify({ ...logBase, status: "scrape_alert_email_send_failed", reason: errorName(err) }),
    );
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

// ---------------------------------------------------------------------------
// 通知に載せる理由 (固定の語 + 件数)。生のエラー文・key・運行NO は入れない。
// ---------------------------------------------------------------------------

/** `INTERNAL_SHARED_SECRET` が取れず、取った zip を alc へ上げられなかった。 */
export const ALERT_REASON_NO_SHARED_SECRET =
  "INTERNAL_SHARED_SECRET 未設定のためアップロード不能 (zip は破棄)";

/** 勤怠の畳み直しが失敗した (`fold_state: "failed"`)。 */
export const ALERT_REASON_FOLD_FAILED = "勤怠の畳み直しが失敗";

/** 勤怠の畳み直しに要る設定が欠けていた (`fold_state: "not_configured"`)。 */
export const ALERT_REASON_FOLD_NOT_CONFIGURED = "勤怠の畳み直しに要る設定が未設定";

/** 取り込み後の CSV 分割の失敗。 */
export function splitFailedAlertReason(splitFailed: number): string {
  return `CSV の分割が ${splitFailed} 件失敗`;
}

/**
 * 「要再計算」の戻り値を理由に落とす。失敗でなければ null。
 *
 * **`remaining > 0` だけでは鳴らさない。** 上限回数で止まって続きが残っている状態で、
 * 次の取り込みの後の呼び出しが続きを処理する (`recalcPendingViaAlcInternalProxy` の
 * doc)。失敗ではない。
 */
export function recalcPendingAlertReason(result: RecalcPendingResult): string | null {
  if (result.error) {
    const status = result.error.status === null ? "" : ` HTTP ${result.error.status}`;
    return `要再計算の呼び出しが失敗 (${result.error.kind}${status})`;
  }
  if (result.failed > 0) {
    return `要再計算が ${result.failed} 件失敗`;
  }
  return null;
}

/**
 * 日次 cron (`DTAKO_CRON`) の dispatch 結果から、取り込みを**積めなかった**ことを
 * 理由に落とす。何も無ければ null。DO に入っていないので DO 側の通知は通らない。
 *
 * `SCRAPER_MODE` が `http` でない skip は意図した停止なので鳴らさない。
 */
export function dtakoCronAlertReason(results: CronRunResult[]): string | null {
  const dtako = results.filter((r) => r.kind === "dtako");
  if (dtako.some((r) => r.target === "*" && r.detail === DTAKO_ACCOUNTS_EMPTY_DETAIL)) {
    return "DTAKO_ACCOUNTS が空のため、どの会社の取り込みも積んでいません";
  }
  const failed = dtako.filter((r) => !r.ok).length;
  if (failed > 0) {
    return `${failed} 社ぶんの取り込みを積めませんでした`;
  }
  return null;
}

/** cron が dispatch の前に落ちた (KV の読み取り失敗など)。 */
export const ALERT_REASON_CRON_THREW = "日次 cron が取り込みを積む前に失敗しました";

/** cron 側 (DO の外) で鳴らすときの本文。会社は特定できないので読取日と理由だけ。 */
export function buildDtakoCronAlertBody(date: string, reason: string): string {
  return `【dtako スクレイプ】${formatReadingDateRange(date, date)}分の日次取り込み: ${reason}`;
}

/**
 * 一番星突合の CSV 書き出し cron (`ICHIBAN_MAKECSV_CRON`) の結果メール。**成功でも失敗でも毎回送る**
 * (無人で社内フォルダへ書くので、走ったこと自体を人へ届ける)。月ごとに 1 行 (DO の要約 or 失敗の理由)。
 * 結果が 1 件も無い (dispatch の前に落ちた) ときは `threw` の文面にする。
 */
export function buildIchibanMakecsvEmail(
  results: CronRunResult[],
  now: Date,
  threw = false,
): { subject: string; body: string } {
  const today = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const day = formatReadingDateRange(today, today);
  const ok = !threw && results.length > 0 && results.every((r) => r.ok);
  const lines = threw
    ? ["cron が書き出しを始める前に失敗しました (設定の読み取り等)。"]
    : results.map((r) => `${r.target}: ${r.ok ? "" : "[失敗] "}${r.detail}`);
  return {
    subject: `[dtako] 一番星突合の CSV 書き出し ${ok ? "成功" : "失敗あり"} ${day}`,
    body: [`【一番星×デジタコ突合】${day} 05:00 の自動「すべて出す」`, ...lines].join("\n"),
  };
}
