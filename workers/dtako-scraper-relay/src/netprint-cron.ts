/**
 * 運転日報 netprint cron の 1 回分の実行ロジック (Refs #874)。
 *
 * 毎朝 JST 6:30 (`NETPRINT_CRON`、cron.ts) に前日 (JST) 分の運転日報を
 * 営業所ごとに PDF 化してかんたんnetprint へ登録し、プリント予約番号を
 * LINE WORKS へ通知する。処理の実体 (theearth harvest / PDF 生成 / netprint
 * 登録 / LINE WORKS 送信) は [`NetprintCronDeps`] として注入する —
 * `cron.ts` の `CronDoCall` と同じ流儀で、この module は fetch / DO を
 * 直接触らず node vitest の 100% gate に載せる。配線は
 * `dtako-scraper-relay-do.ts` の `/cron/netprint` handler。
 */

import { CronConfigError } from "./cron";
import type { LineworksDestination } from "./lineworks-notify";

/** `NETPRINT_TARGETS` (plain 変数) の 1 エントリ。`branch_cd` は theearth
 * F-DES1010 の行 `lblBranchCD` (非パディング数値) と突き合わせる営業所コード、
 * `branch_name` は任意の表示名 — 0 行の日 (= 行から営業所名を引けない日) の
 * 通知文にも正しい名前を出すための設定で、未設定なら行の `branchName` →
 * `営業所コード{branch_cd}` の順にフォールバックする。
 *
 * **宛先は `channel_id` と `recipient_id` のどちらか一方**を指定する (両方 /
 * 両方無しは設定ミスとしてその target だけ落とす、Refs #874 の 10)。
 *
 * - `channel_id` — rust-alc-api の DB テーブル `lineworks_channels` の行 id (Uuid)。
 *   **LINE WORKS API の channelId そのものではない** (#874 の 8 の方針転換)
 * - `recipient_id` — 同じく DB `notify_recipients` の行 id (Uuid)。**個人宛**。
 *   実運用ではトークルームが 1 件も登録されておらず、通知先はこちらになる
 *
 * どちらも Bot の credential も実宛先も DB 一元管理で、rust 側が id から tenant
 * ごと解決する。⇒ **通知先を変えるときに触るのは DB (画面) であって、ここの値は
 * 「どの行を指すか」だけ**。 */
export interface NetprintTarget {
  branch_cd: string;
  /** `lineworks_channels` の行 id (トークルーム宛)。`recipient_id` と排他。 */
  channel_id?: string;
  /** `notify_recipients` の行 id (個人宛)。`channel_id` と排他。 */
  recipient_id?: string;
  branch_name?: string;
}

/** 宛先 id (`channel_id` / `recipient_id` のどちらも DB の行 id) の形。Uuid で
 * ないものは DB を引くまでもなく設定ミスなので、alc へ投げる前に弾く —
 * 「LINE WORKS の channelId をそのまま貼った」を静かに 404 にせず、設定した人に
 * 見える形で落とすため。**この検証をするのはここだけ** — auth-worker の allowlist
 * は path しか見ず (宛先は body にある)、rust 側の 404 は「DB に無い行」と
 * 「そもそも id の形ではない」を区別しない。 */
export const NETPRINT_DESTINATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NetprintDestinationResolution =
  | { ok: true; destination: LineworksDestination }
  | { ok: false; error: string };

/**
 * target の `channel_id` / `recipient_id` から送信先を 1 つ決める。
 *
 * **どちらか一方だけ**が要る (rust の `POST /api/internal/lineworks/send` が
 * 両方 / 両方無しを 400 にするのと同じ規則、#874-9)。ここで弾くのは往復を
 * 減らすためではなく、**設定した人がその場で直せる日本語**を返すため —
 * rust の 400 は relay の `detail` を経て画面に出るころには HTTP status に
 * 潰れている。
 *
 * `parseNetprintTargets` は設定 JSON を素通し (`as NetprintTarget[]`) するので、
 * 型が言うほど string とは限らない。`typeof` で見て非文字列は「無い」に倒す。
 */
export function resolveNetprintDestination(target: NetprintTarget): NetprintDestinationResolution {
  const channelId = typeof target.channel_id === "string" ? target.channel_id.trim() : "";
  const recipientId = typeof target.recipient_id === "string" ? target.recipient_id.trim() : "";
  if (channelId !== "" && recipientId !== "") {
    return { ok: false, error: "channel_id と recipient_id はどちらか一方だけ指定してください" };
  }
  if (channelId === "" && recipientId === "") {
    return { ok: false, error: "channel_id と recipient_id のどちらか一方を指定してください" };
  }
  const destination: LineworksDestination =
    channelId !== "" ? { kind: "channel", id: channelId } : { kind: "recipient", id: recipientId };
  if (!NETPRINT_DESTINATION_ID_RE.test(destination.id)) {
    return { ok: false, error: describeBadDestinationId(destination.kind) };
  }
  return { ok: true, destination };
}

/** Uuid でない宛先 id の理由。**どの表を引く id なのか**まで書く (設定した人が
 * 画面のどこから値を持ってくればよいか分かるように)。 */
function describeBadDestinationId(kind: LineworksDestination["kind"]): string {
  return kind === "channel"
    ? "channel_id が UUID 形式ではありません (lineworks_channels の行 id を指定してください)"
    : "recipient_id が UUID 形式ではありません (notify_recipients の行 id を指定してください)";
}

/** `NETPRINT_TARGETS` (JSON 配列 `[{branch_cd, channel_id | recipient_id}, ...]`)
 * をパースする。
 * 未設定は [] (= cron skip)、JSON 不正は loud fail (`parseDtakoAccounts` と
 * 同じ流儀)。 */
export function parseNetprintTargets(raw: string | undefined): NetprintTarget[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CronConfigError("NETPRINT_TARGETS が JSON としてパースできません");
  }
  if (!Array.isArray(parsed)) {
    throw new CronConfigError("NETPRINT_TARGETS は JSON 配列である必要があります");
  }
  return parsed as NetprintTarget[];
}

export type NetprintTargetsValidation =
  | { ok: true; targets: NetprintTarget[] }
  | { ok: false; error: string };

/**
 * 画面から保存される `NETPRINT_TARGETS` (KV `netprint_targets`) の生 JSON を
 * **KV に書く前に**検証し、正規化した配列にする (Refs #874 の 12)。
 *
 * **検証は cron 経路と同じ部品を使う** (`parseNetprintTargets` で JSON 配列の形、
 * `resolveNetprintDestination` で宛先の排他 + Uuid)。画面側に同じ規則を書き写すと、
 * 「画面では保存できたのに cron が落とす」設定が作れてしまう — 通す/落とすの
 * 判断はここ 1 か所に閉じる。
 *
 * 正規化では**知っているキーだけを残す** — 画面が知らないキーを混ぜても KV に
 * 溜まらないようにするため。エラーは「何件目の誰か」まで書く (画面がそのまま
 * 出せば、設定した人が直す行を特定できる)。
 */
export function validateNetprintTargetsPayload(raw: string): NetprintTargetsValidation {
  let parsed: unknown[];
  try {
    parsed = parseNetprintTargets(raw) as unknown[];
  } catch (err) {
    // `parseNetprintTargets` が投げるのは `CronConfigError` だけ (JSON 不正 / 非配列)。
    // `instanceof Error` で分けると**片側が死に分岐**になるので分けない。
    return { ok: false, error: (err as CronConfigError).message };
  }
  const targets: NetprintTarget[] = [];
  for (const [index, entry] of parsed.entries()) {
    const label = `${index + 1} 件目`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `${label}: JSON オブジェクトで指定してください` };
    }
    const candidate = entry as NetprintTarget;
    const branchCd = typeof candidate.branch_cd === "string" ? candidate.branch_cd.trim() : "";
    if (branchCd === "") {
      return { ok: false, error: `${label}: branch_cd (営業所コード) は必須です` };
    }
    const resolved = resolveNetprintDestination(candidate);
    if (!resolved.ok) {
      return { ok: false, error: `${label} (営業所 ${branchCd}): ${resolved.error}` };
    }
    const target: NetprintTarget = { branch_cd: branchCd };
    if (resolved.destination.kind === "channel") target.channel_id = resolved.destination.id;
    else target.recipient_id = resolved.destination.id;
    const branchName = typeof candidate.branch_name === "string" ? candidate.branch_name.trim() : "";
    if (branchName !== "") target.branch_name = branchName;
    targets.push(target);
  }
  return { ok: true, targets };
}

/** 対象日 (JST) の受け渡し形式。cron が渡す値も手動実行の `date` も同じ。 */
export const NETPRINT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 営業所コードの表記ゆれ吸収。theearth の事業所コードはマスタ上 8 桁ゼロ埋め
 * (`00000001`) だが F-DES1010 の行には非パディング (`1`) で載るため、先頭の 0 を
 * 落としてから比較する。 */
export function normalizeBranchCd(cd: string): string {
  return cd.trim().replace(/^0+(?=\d)/, "");
}

/** `YYYY-MM-DD` → `YYYY/MM/DD` (通知文の日付表記)。 */
export function formatDateSlash(dateYmd: string): string {
  return dateYmd.replace(/-/g, "/");
}

/** `YYYY-MM-DD` → `M/D` (0 埋めなし。0 行通知の日付表記)。 */
export function formatMonthDay(dateYmd: string): string {
  const [, month, day] = dateYmd.split("-");
  return `${Number(month)}/${Number(day)}`;
}

/** netprint へ登録する PDF のファイル名。表示されるのは登録一覧くらいなので
 * multipart で事故らない ASCII に寄せる。 */
export function netprintPdfFileName(dateYmd: string): string {
  return `nippo_${dateYmd.replace(/-/g, "")}.pdf`;
}

/** netprint 登録完了 (status poll 完了) の結果のうち通知文が使う部分。 */
export interface NetprintRegistration {
  /** プリント予約番号 (8桁英数、status poll の `printID`)。 */
  printId: string;
  /** 有効期限 (status poll の `endDate` をそのまま表示する)。 */
  endDate: string;
  /** ページ数 (status poll の `page`)。 */
  page: number;
}

/** 予約番号の通知文 (Refs #874 の通知文仕様)。 */
export function buildNetprintNotification(
  branchName: string,
  dateYmd: string,
  registration: NetprintRegistration,
): string {
  return [
    `【運転日報】${branchName} ${formatDateSlash(dateYmd)}分`,
    `プリント予約番号: ${registration.printId}`,
    `有効期限: ${registration.endDate}`,
    `(${registration.page}ページ / A4)`,
    "セブンイレブンのマルチコピー機 →「プリント」→「ネットプリント」で番号を入力すると印刷できます。",
  ].join("\n");
}

/** 前日分の運行が 0 行だった日の通知文。 */
export function buildNoOperationsNotification(branchName: string, dateYmd: string): string {
  return `${branchName} ${formatMonthDay(dateYmd)}分の運行はありませんでした`;
}

/** 途中失敗の通知文 (console.error に加えて可能なら LINE WORKS へも知らせる)。 */
export function buildNetprintErrorNotification(
  branchName: string,
  dateYmd: string,
  detail: string,
): string {
  return `【運転日報】${branchName} ${formatDateSlash(dateYmd)}分の自動登録に失敗しました: ${detail}`;
}

/** 手動実行 (`POST /kintai-relay/netprint-run`) の実行計画。 */
export type NetprintRunPlan = { error: string } | { date: string; targets: NetprintTarget[] };

/**
 * 手動実行の body を実行計画に落とす (cron を待たずに 1 回走らせるための口、
 * Refs #874)。
 *
 * - `date` 省略で `defaultDate` (呼び出し側が `yesterdayJst` で出した前日 JST)。
 *   指定するなら `YYYY-MM-DD`。
 * - `branch_cd` + 宛先 (`channel_id` か `recipient_id` の**どちらか一方**) を
 *   **揃えて**渡すとその 1 件だけを走らせる (`NETPRINT_TARGETS` を触らずに試験用の
 *   宛先へ流せる)。**片方だけの指定は受け付けない** — 設定側の target と混ざって
 *   「意図しない宛先へ送る」が起きうるため、黙って補完しない。宛先の排他と Uuid
 *   の検証は `resolveNetprintDestination` (cron 経路と同じ規則・同じ文言)。
 * - どちらも省略すると `NETPRINT_TARGETS` の全 target を使う (= cron と同じ動き)。
 *
 * `NETPRINT_TARGETS` が不正 JSON なら `parseNetprintTargets` がそのまま throw する
 * (呼び出し側が loud fail に落とす)。
 */
export function planNetprintRun(
  body: {
    date?: unknown;
    branch_cd?: unknown;
    channel_id?: unknown;
    recipient_id?: unknown;
    branch_name?: unknown;
  },
  configuredTargetsRaw: string | undefined,
  defaultDate: string,
): NetprintRunPlan {
  let date = defaultDate;
  if (body.date !== undefined) {
    if (typeof body.date !== "string" || !NETPRINT_DATE_RE.test(body.date)) {
      return { error: "date は YYYY-MM-DD で指定してください" };
    }
    date = body.date;
  }
  const branchCd = typeof body.branch_cd === "string" ? body.branch_cd.trim() : "";
  const channelId = typeof body.channel_id === "string" ? body.channel_id.trim() : "";
  const recipientId = typeof body.recipient_id === "string" ? body.recipient_id.trim() : "";
  const hasDestination = channelId !== "" || recipientId !== "";
  if (branchCd !== "" || hasDestination) {
    if (branchCd === "" || !hasDestination) {
      return {
        error:
          "branch_cd と宛先 (channel_id か recipient_id) は両方まとめて指定してください",
      };
    }
    const branchName =
      typeof body.branch_name === "string" && body.branch_name !== "" ? body.branch_name : undefined;
    const target: NetprintTarget = { branch_cd: branchCd, branch_name: branchName };
    // 指定された側のキーだけを立てる (空文字を残すと「両方指定」に見える)。
    if (channelId !== "") target.channel_id = channelId;
    if (recipientId !== "") target.recipient_id = recipientId;
    const resolved = resolveNetprintDestination(target);
    if (!resolved.ok) return { error: resolved.error };
    return { date, targets: [target] };
  }
  const targets = parseNetprintTargets(configuredTargetsRaw);
  if (targets.length === 0) {
    return {
      error:
        "NETPRINT_TARGETS が未設定です — branch_cd と channel_id (または recipient_id) を body で指定してください",
    };
  }
  return { date, targets };
}

/** 日報行のうちこの cron が読む部分 (`DailyReportRow` の構造的部分型)。 */
export interface NetprintReportRow {
  branchCd: string | null;
  branchName: string | null;
}

/** 1 営業所ぶんの harvest 結果。この cron が読むのは件数と営業所名を出すための
 * `rows` だけで、PDF に要る他の内容 (F-NRS1010 の作業時間・燃料など) は解釈せず
 * そのまま `generatePdf` へ渡す (#874-2 の `BranchDailyReport` が構造的に一致)。 */
export interface NetprintHarvest {
  rows: readonly NetprintReportRow[];
}

/** 処理の実体。`/cron/netprint` handler (`dtako-scraper-relay-do.ts`) が
 * theearth ログイン済みセッション / #874-1〜3 のヘルパを束ねて渡す。 */
export interface NetprintCronDeps<Harvest extends NetprintHarvest = NetprintHarvest> {
  /** 対象日 (JST, YYYY-MM-DD) の日報を対象営業所に絞って取る (theearth ログイン
   * 込み。実体は `fetchBranchDailyReport`、絞り込みもそちらが持つ)。`branchCd` は
   * 正規化済み (非パディング) の値を渡す。 */
  fetchReport(dateYmd: string, branchCd: string): Promise<Harvest>;
  /** harvest 結果を A4 の日報 PDF にする (#874-2 `generateDailyReportPdf`)。 */
  generatePdf(report: Harvest, branchName: string, dateYmd: string): Promise<Uint8Array>;
  /** netprint へ登録し status poll 完了まで待つ (#874-3 `registerPdf` +
   * `waitForReservation`)。 */
  registerPdf(pdf: Uint8Array, fileName: string): Promise<NetprintRegistration>;
  /** LINE WORKS へテキストを送る。`destination` はトークルーム宛
   * (`lineworks_channels` の行 id) か個人宛 (`notify_recipients` の行 id) の
   * どちらかで、実体は rust-alc-api の `POST /api/internal/lineworks/send`
   * (#874-8/9 `sendLineworksTextViaAlcInternalProxy`)。 */
  sendText(destination: LineworksDestination, text: string): Promise<void>;
}

export interface NetprintTargetResult {
  branch_cd: string;
  /** トークルーム宛なら設定された `channel_id`、個人宛なら null。
   * **フィールド名は変えない** — 画面 (#874-5) が読む応答の形を保つため。 */
  channel_id: string | null;
  /** 個人宛なら設定された `recipient_id`、トークルーム宛なら null (#874-10 で追加)。 */
  recipient_id: string | null;
  ok: boolean;
  /** branchCd で絞った後の行数。harvest 前に失敗したら null。 */
  rows: number | null;
  print_id: string | null;
  detail: string;
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** 結果に載せる宛先。**検証前の生値をそのまま**返す (Uuid でない値を弾いたときに
 * 「何を設定していたか」が結果から読めるように)。非文字列は null。 */
function destinationFields(target: NetprintTarget): {
  channel_id: string | null;
  recipient_id: string | null;
} {
  return {
    channel_id: typeof target.channel_id === "string" ? target.channel_id : null,
    recipient_id: typeof target.recipient_id === "string" ? target.recipient_id : null,
  };
}

/** 通知文に使う営業所名。設定 (`branch_name`) が最優先 — 0 行の日でも同じ
 * 名前を出せる。無ければ絞った行の `branchName`、それも無ければコードで代用。 */
export function resolveBranchDisplayName(
  target: NetprintTarget,
  filteredRows: readonly NetprintReportRow[],
): string {
  if (target.branch_name) return target.branch_name;
  const named = filteredRows.find((row) => row.branchName);
  if (named?.branchName) return named.branchName;
  return `営業所コード${target.branch_cd}`;
}

/**
 * 全 target を順に処理する。target 間は独立 — 1 つの失敗 (throw) はその
 * target の結果 (`ok: false` + 可能なら LINE WORKS へのエラー通知) に閉じ、
 * 次の target へ進む。呼び出し側 (DO) は `ok: false` の結果を console.error
 * する (Tail Worker に残す)。
 *
 * 宛先 (`channel_id` / `recipient_id`) の指定が不正な target は **harvest も PDF
 * 生成もせずに** `ok: false` にする — 通知先が無い以上 netprint に登録しても誰にも
 * 番号が届かないし、エラー通知の送り先も同じく無いため (送ろうとしても確実に失敗
 * する)。1 営業所の設定ミスで他の営業所の通知まで止めないのが target 独立の趣旨。
 */
export async function runNetprintTargets<Harvest extends NetprintHarvest>(
  deps: NetprintCronDeps<Harvest>,
  targets: NetprintTarget[],
  dateYmd: string,
): Promise<NetprintTargetResult[]> {
  const results: NetprintTargetResult[] = [];
  for (const target of targets) {
    const ids = destinationFields(target);
    const resolved = resolveNetprintDestination(target);
    if (!resolved.ok) {
      results.push({
        branch_cd: target.branch_cd,
        ...ids,
        ok: false,
        rows: null,
        print_id: null,
        detail: resolved.error,
      });
      continue;
    }
    const destination = resolved.destination;
    let report: Harvest | null = null;
    try {
      // F-DES1010 の行の branchCd は非パディング (`1`) なので、設定側の
      // ゼロ埋め表記 (`00000001`) をここで揃えてから絞り込みに渡す。
      report = await deps.fetchReport(dateYmd, normalizeBranchCd(target.branch_cd));
      const branchName = resolveBranchDisplayName(target, report.rows);
      if (report.rows.length === 0) {
        await deps.sendText(destination, buildNoOperationsNotification(branchName, dateYmd));
        results.push({
          branch_cd: target.branch_cd,
          ...ids,
          ok: true,
          rows: 0,
          print_id: null,
          detail: "運行 0 行 — 「運行はありませんでした」を通知",
        });
        continue;
      }
      const pdf = await deps.generatePdf(report, branchName, dateYmd);
      const registration = await deps.registerPdf(pdf, netprintPdfFileName(dateYmd));
      await deps.sendText(
        destination,
        buildNetprintNotification(branchName, dateYmd, registration),
      );
      results.push({
        branch_cd: target.branch_cd,
        ...ids,
        ok: true,
        rows: report.rows.length,
        print_id: registration.printId,
        detail: `${report.rows.length} 行 / ${registration.page} ページを登録し予約番号を通知`,
      });
    } catch (err) {
      const detail = describeError(err);
      // エラー通知は best-effort — LINE WORKS 側も落ちていたら結果の detail に
      // 併記するだけで飲み込む (次の target を止めない)。
      let notifyDetail = "";
      try {
        await deps.sendText(
          destination,
          buildNetprintErrorNotification(
            resolveBranchDisplayName(target, report?.rows ?? []),
            dateYmd,
            detail,
          ),
        );
      } catch (notifyErr) {
        notifyDetail = ` (エラー通知も失敗: ${describeError(notifyErr)})`;
      }
      results.push({
        branch_cd: target.branch_cd,
        ...ids,
        ok: false,
        rows: report === null ? null : report.rows.length,
        print_id: null,
        detail: `${detail}${notifyDetail}`,
      });
    }
  }
  return results;
}
