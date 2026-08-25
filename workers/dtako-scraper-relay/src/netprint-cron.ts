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

/** `NETPRINT_TARGETS` (plain 変数) の 1 エントリ。`branch_cd` は theearth
 * F-DES1010 の行 `lblBranchCD` (非パディング数値) と突き合わせる営業所コード、
 * `branch_name` は任意の表示名 — 0 行の日 (= 行から営業所名を引けない日) の
 * 通知文にも正しい名前を出すための設定で、未設定なら行の `branchName` →
 * `営業所コード{branch_cd}` の順にフォールバックする。
 *
 * **`channel_id` は rust-alc-api の DB テーブル `lineworks_channels` の行 id
 * (Uuid)** であって、LINE WORKS API の channelId そのものではない (Refs #874 の
 * 8 の方針転換)。Bot の credential も実チャンネルも DB 一元管理で、rust 側が
 * この id から tenant ごと解決する。⇒ **通知先を変えるときに触るのは DB (画面)
 * であって、ここの値は「どの行を指すか」だけ**。 */
export interface NetprintTarget {
  branch_cd: string;
  channel_id: string;
  branch_name?: string;
}

/** `channel_id` (= `lineworks_channels` の行 id) の形。Uuid でないものは DB を
 * 引くまでもなく設定ミスなので、alc へ投げる前に弾く — 「LINE WORKS の
 * channelId をそのまま貼った」を静かに 404 にせず、設定した人に見える形で
 * 落とすため。**この検証をするのはここだけ** — auth-worker の allowlist は
 * path しか見ず (`channel_id` は body にある)、rust 側の 404 は「DB に無い行」と
 * 「そもそも id の形ではない」を区別しない。 */
export const NETPRINT_CHANNEL_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `NETPRINT_TARGETS` (JSON 配列 `[{branch_cd, channel_id}, ...]`) をパースする。
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
 * - `branch_cd` + `channel_id` を**揃えて**渡すとその 1 件だけを走らせる
 *   (`NETPRINT_TARGETS` を触らずに試験用チャンネルへ流せる)。**片方だけの指定は
 *   受け付けない** — 設定側の target と混ざって「意図しない宛先へ送る」が起きうる
 *   ため、黙って補完しない。`channel_id` は `lineworks_channels` の行 id (Uuid)
 *   なので、形が違えば 400 で返す (叩いた人がその場で直せるように)。
 * - どちらも省略すると `NETPRINT_TARGETS` の全 target を使う (= cron と同じ動き)。
 *
 * `NETPRINT_TARGETS` が不正 JSON なら `parseNetprintTargets` がそのまま throw する
 * (呼び出し側が loud fail に落とす)。
 */
export function planNetprintRun(
  body: { date?: unknown; branch_cd?: unknown; channel_id?: unknown; branch_name?: unknown },
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
  if (branchCd !== "" || channelId !== "") {
    if (branchCd === "" || channelId === "") {
      return { error: "branch_cd と channel_id は両方まとめて指定してください" };
    }
    if (!NETPRINT_CHANNEL_ID_RE.test(channelId)) {
      return {
        error:
          "channel_id が UUID 形式ではありません (lineworks_channels の行 id を指定してください)",
      };
    }
    const branchName =
      typeof body.branch_name === "string" && body.branch_name !== "" ? body.branch_name : undefined;
    return { date, targets: [{ branch_cd: branchCd, channel_id: channelId, branch_name: branchName }] };
  }
  const targets = parseNetprintTargets(configuredTargetsRaw);
  if (targets.length === 0) {
    return {
      error: "NETPRINT_TARGETS が未設定です — branch_cd と channel_id を body で指定してください",
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
  /** LINE WORKS のトークルームへテキストを送る。`channelId` は
   * `lineworks_channels` の行 id (Uuid) で、実体は rust-alc-api の
   * `POST /api/internal/lineworks/send` (#874-8 `sendLineworksTextViaAlcInternalProxy`)。 */
  sendText(channelId: string, text: string): Promise<void>;
}

export interface NetprintTargetResult {
  branch_cd: string;
  channel_id: string;
  ok: boolean;
  /** branchCd で絞った後の行数。harvest 前に失敗したら null。 */
  rows: number | null;
  print_id: string | null;
  detail: string;
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
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
 * `channel_id` が Uuid でない target は **harvest も PDF 生成もせずに** `ok: false`
 * にする — 通知先が無い以上 netprint に登録しても誰にも番号が届かないし、
 * エラー通知の送り先も同じく無いため (送ろうとしても確実に失敗する)。
 * 1 営業所の設定ミスで他の営業所の通知まで止めないのが target 独立の趣旨。
 */
export async function runNetprintTargets<Harvest extends NetprintHarvest>(
  deps: NetprintCronDeps<Harvest>,
  targets: NetprintTarget[],
  dateYmd: string,
): Promise<NetprintTargetResult[]> {
  const results: NetprintTargetResult[] = [];
  for (const target of targets) {
    // `parseNetprintTargets` は設定 JSON を素通し (`as NetprintTarget[]`) するので、
    // 型が言うほど string とは限らない。`test` の String 化に任せて弾く。
    if (!NETPRINT_CHANNEL_ID_RE.test(target.channel_id)) {
      results.push({
        branch_cd: target.branch_cd,
        channel_id: target.channel_id,
        ok: false,
        rows: null,
        print_id: null,
        detail:
          "channel_id が UUID 形式ではありません (lineworks_channels の行 id を設定してください)",
      });
      continue;
    }
    let report: Harvest | null = null;
    try {
      // F-DES1010 の行の branchCd は非パディング (`1`) なので、設定側の
      // ゼロ埋め表記 (`00000001`) をここで揃えてから絞り込みに渡す。
      report = await deps.fetchReport(dateYmd, normalizeBranchCd(target.branch_cd));
      const branchName = resolveBranchDisplayName(target, report.rows);
      if (report.rows.length === 0) {
        await deps.sendText(target.channel_id, buildNoOperationsNotification(branchName, dateYmd));
        results.push({
          branch_cd: target.branch_cd,
          channel_id: target.channel_id,
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
        target.channel_id,
        buildNetprintNotification(branchName, dateYmd, registration),
      );
      results.push({
        branch_cd: target.branch_cd,
        channel_id: target.channel_id,
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
          target.channel_id,
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
        channel_id: target.channel_id,
        ok: false,
        rows: report === null ? null : report.rows.length,
        print_id: null,
        detail: `${detail}${notifyDetail}`,
      });
    }
  }
  return results;
}
