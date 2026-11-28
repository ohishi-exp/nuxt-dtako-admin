/**
 * dtako 日次スクレイプが失敗したことを**人へ届ける**ための pure ロジック
 * (Refs #967)。宛先設定 (`SCRAPE_ALERT_TARGET`) のパース/検証と通知文の組み立て
 * だけを持ち、送信そのものは `lineworks-notify.ts` の
 * [`sendLineworksTextViaAlcInternalProxy`]、配線は
 * `dtako-scraper-relay-do.ts` の `runCronDtakoScrape` の catch。
 *
 * **なぜ要るか。** 失敗の出力先はこれまで 3 つあったが、どれも人には届かない:
 * `console.error` (Tail Worker 経由でしか見えない)、DO storage の進捗レコード
 * (`state: "failed"`)、alc の cron 履歴 (`kind: "error"`)。**問題は「失敗して
 * いること」ではなく「失敗が誰にも気づかれないこと」** — 片方の会社で日次
 * スクレイプが半分以上落ちていたのに、数日誰も知らなかった。
 *
 * **リトライは入れない (ユーザー判断、2026-08-29)。** 本番のスクレイプが上流
 * theearth を叩く回数を 1 回も増やさないため。この module がやるのは
 * 「失敗したことを人に届ける」ことだけで、再試行・バックオフ・キュー再投入は
 * 1 行も無い。**通知の送信先は `AUTH_WORKER` service binding (= rust-alc-api)
 * であって theearth ではない**ので、上流への往復は増えない。
 *
 * **単位は「`runCronDtakoScrape` 1 回の失敗 = 1 通」** (netprint cron の
 * `buildNetprintOperationFailureNotification` と同じ流儀、#874 の 13)。日次なので
 * 実質 1 社 1 日 1 通、多くて 2 通。**重複抑制も連続失敗の閾値も持たない** —
 * netprint 側も持っておらず、「同じ日に 2 回鳴る」より「鳴らない日がある」方が
 * この issue の欠陥そのものだから。
 */

import { formatDateSlash } from "./netprint-cron";
import {
  resolveLineworksDestination,
  type LineworksDestinationConfig,
  type LineworksDestinationResolution,
} from "./lineworks-notify";
import { PAGE_EXCERPT_MARKER } from "./theearth-client";

/** 宛先を置く plain 変数の名前。ログの文言に埋めるので定数にする
 * (変数名を変えた時に「直っていない側」が残らないように)。 */
export const SCRAPE_ALERT_TARGET_VAR = "SCRAPE_ALERT_TARGET";

/** 通知文に載せる失敗理由の上限 (文字)。
 *
 * **短く切るのは体裁のためではない。** `describeScrapeFailure` の message は
 * 上流由来の文字列を含みうる (下の [`sanitizeScrapeFailureDetail`] の doc) ので、
 * 抜粋を落とした後もなお長い場合に備えた二段目の歯止め。原本の全文は R2 に
 * 在るので、通知は「何が起きたか」が読めれば足りる。 */
export const SCRAPE_ALERT_DETAIL_MAX = 200;

export type ScrapeAlertTargetResolution = LineworksDestinationResolution;

/**
 * `SCRAPE_ALERT_TARGET` (JSON 1 件 `{"channel_id":"…"}` または
 * `{"recipient_id":"…"}`) を宛先 1 つに解決する。
 *
 * **`NETPRINT_TARGETS` を流用しない** (親の決定、#967)。あちらは
 * **営業所 × 運転日報**の宛先で、スクレイプ失敗のアラートを混ぜると「日報が
 * 届く人」に別種の通知が飛ぶ (#874 の誤配と同じ型)。作法は `ETC_ACCOUNTS` と
 * 同じ **Cloudflare dashboard の plain 変数 + `keep_vars = true`** で、値は
 * commit しない。
 *
 * **未設定は fail-closed。** `{ok: false}` を返し、呼び出し側は「宛先が未設定
 * なので通知を送っていない」を `console.error` に明示する。**黙って何もしないのが
 * 一番危ない状態**で、それはこの issue が直そうとしている欠陥そのもの。
 *
 * 排他 (`channel_id` と `recipient_id` の両方 / 両方無し) と Uuid 検証は
 * [`resolveLineworksDestination`] が持つ — netprint cron と同じ規則・同じ文言。
 */
export function resolveScrapeAlertTarget(raw: unknown): ScrapeAlertTargetResolution {
  if (typeof raw !== "string") {
    return { ok: false, error: describeUnsetTarget() };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: describeUnsetTarget() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: `${SCRAPE_ALERT_TARGET_VAR} が JSON としてパースできません`,
    };
  }
  if (parsed === null) {
    return { ok: false, error: describeNotAnObject() };
  }
  if (Array.isArray(parsed)) {
    return { ok: false, error: describeNotAnObject() };
  }
  if (typeof parsed !== "object") {
    return { ok: false, error: describeNotAnObject() };
  }
  const resolved = resolveLineworksDestination(parsed as LineworksDestinationConfig);
  if (resolved.ok) {
    return resolved;
  }
  return { ok: false, error: `${SCRAPE_ALERT_TARGET_VAR}: ${resolved.error}` };
}

/** 未設定の理由。**「送っていない」と「どこに何を入れれば送れるようになるか」の
 * 両方**を書く — この 1 行を読む人は、通知が来ないことに気づいて Tail Worker を
 * 覗いた運用者で、次にやることが決まる形でないと意味が無い。 */
function describeUnsetTarget(): string {
  return (
    `${SCRAPE_ALERT_TARGET_VAR} が未設定のため、スクレイプ失敗の通知を送っていません ` +
    `(Cloudflare dashboard の plain 変数に {"channel_id":"<uuid>"} か {"recipient_id":"<uuid>"} を 1 件入れてください)`
  );
}

/** JSON ではあるが 1 件のオブジェクトではない時の理由。**配列を名指しする** —
 * `NETPRINT_TARGETS` が JSON 配列なので、そちらの形をそのまま貼る間違いが起きうる。 */
function describeNotAnObject(): string {
  return (
    `${SCRAPE_ALERT_TARGET_VAR} は JSON オブジェクト 1 件である必要があります ` +
    `(NETPRINT_TARGETS のような配列ではありません)`
  );
}

/**
 * 失敗理由 (`describeScrapeFailure` の message) を**人へ転送してよい形**に落とす。
 *
 * **★ 親の見立てとの食い違い (#967 で実測)。** 「message はそのまま載せてよい」と
 * 読める指示だったが、`theearth-client.ts` の `TheearthClientError` は
 * `describePage(html)` (= title + 本文先頭 160 字の**生ページテキスト**) を
 * message に埋める箇所を複数持つ (ログイン POST の非 2xx / 強制ログインの非 2xx)。
 * **今回の失敗は theearth 側でエラーページが返る型で、そのページには中間ファイルの
 * UNC パスが載る** — つまり message をそのまま流すと、原本の中身が通知に出る。
 *
 * ⇒ 2 段で落とす:
 *
 * 1. [`PAGE_EXCERPT_MARKER`] 以降 (本文抜粋) を捨てる。**残るのは自前で書いた
 *    文 (「ログイン POST が HTTP 500 を返しました」等) だけ**で、そこが原因の
 *    種類を読むのに一番効く部分
 * 2. なお残る Windows パス表記 (UNC `\\host\share\…` / ドライブ `C:\…`) を伏せる。
 *    `describeUnknownError` 経由の想定外例外や、`診断: ${licenceOver.raw}` の
 *    ように marker を通らない埋め込みが他にもあるため、**marker 頼みにしない**
 *
 * 最後に [`SCRAPE_ALERT_DETAIL_MAX`] で切る。**原本の全文は R2 に在る**ので、
 * 通知は取っ掛かりで足りる。
 */
export function sanitizeScrapeFailureDetail(message: string): string {
  const markerAt = message.indexOf(PAGE_EXCERPT_MARKER);
  const withoutExcerpt = markerAt < 0 ? message : `${message.slice(0, markerAt)} (本文抜粋は省略)`;
  const masked = maskWindowsPaths(withoutExcerpt).trim();
  if (masked.length <= SCRAPE_ALERT_DETAIL_MAX) {
    return masked;
  }
  return `${masked.slice(0, SCRAPE_ALERT_DETAIL_MAX)}…`;
}

/** UNC (`\\host\share\…`) と ドライブ (`C:\…`) のパス表記を伏せる。
 * **区切りが 1 つでも続けば拾う** — `\\srv\share` のように短いものも UNC。 */
function maskWindowsPaths(text: string): string {
  return text
    .replace(/\\\\[^\s"'<>|]+/g, "(パス省略)")
    .replace(/[A-Za-z]:\\[^\s"'<>|]*/g, "(パス省略)");
}

export interface ScrapeFailureNotificationInput {
  /** theearth の会社 ID。**会社名は relay が持っていない**ので comp_id で名指しする。 */
  compId: string;
  /** 読取日の範囲 (`YYYY-MM-DD`)。日次 cron は同日 1 日ぶんなので通常は同じ値。 */
  startDate: string;
  endDate: string;
  /** `describeScrapeFailure` の message。**[`sanitizeScrapeFailureDetail`] を
   * 通してから渡すのではなく、生のまま渡してよい** — この関数の中で落とす
   * (呼び出し側が通し忘れる余地を作らない)。 */
  message: string;
  /** 原本 (theearth の生 HTML) を R2 に保存できたか。
   * **キーは載せない** — 通知に貼ると、原本の在り処と中身の手掛かりが LINE WORKS の
   * 履歴に残り続ける。「在る」ことだけ伝われば、調べる人は
   * `POST /cron/dtako/scrape-errors` (Refs #1052) で引ける。 */
  artifactSaved: boolean;
}

/**
 * 失敗 1 回ぶんの通知文。
 *
 * netprint の [`buildNetprintErrorNotification`] と**同じ形**にする
 * (`【見出し】 対象 日付分の … に失敗しました: 理由`) — 受け取る人にとっては
 * 同じ Bot から来る通知なので、種類が違っても頭の読み方が変わらない方がよい。
 *
 * 載せるのは **会社 / 読取日 / 理由 / 原本の有無**だけ。原本 (theearth の HTML)
 * の中身も R2 のキーも載せない ([`ScrapeFailureNotificationInput`] の doc)。
 */
export function buildScrapeFailureNotification(input: ScrapeFailureNotificationInput): string {
  const detail = sanitizeScrapeFailureDetail(input.message);
  const lines = [
    `【dtako スクレイプ】comp_id ${input.compId} の ${formatReadingDateRange(input.startDate, input.endDate)}分の自動取り込みに失敗しました: ${detail}`,
  ];
  if (input.artifactSaved) {
    lines.push("失敗した応答の原本は R2 に保存済みです (キーは通知に載せません)。");
  } else {
    lines.push("失敗した応答の原本は保存されていません (保存対象外か R2 への書き込みに失敗)。");
  }
  return lines.join("\n");
}

/** 読取日の範囲表記。日次 cron は 1 日ぶん (start === end) なので、その時は
 * 1 日だけ出す — 「2026/08/28〜2026/08/28」は読む人の手が止まる。 */
export function formatReadingDateRange(startDate: string, endDate: string): string {
  if (startDate === endDate) {
    return formatDateSlash(startDate);
  }
  return `${formatDateSlash(startDate)}〜${formatDateSlash(endDate)}`;
}
