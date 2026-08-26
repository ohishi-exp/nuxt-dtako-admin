/**
 * 前日分 運転日報 PDF の取得 (Refs #874 の 13)。
 *
 * **PDF は自前で組まない。theearth が出す公式の「運転日報」帳票をそのまま取る。**
 * 以前は `daily-report-pdf.ts` が pdf-lib で A4 の表を組んでいた。やめた理由は 2 つ
 * あり、**どちらも実測**:
 *
 * 1. **netprint が pdf-lib の出力を変換できない。** `register-file` は 200 で受理
 *    するが、その後の `registration-status` が `resultCode` **0 を返さず**、
 *    **予約番号が永久に出ない** (本番実測 2026-08-25、`v0.0.565`。実測値は 1699)。
 *    受付が通るので「登録できた」ように見えるのが厄介なところ。
 *    ※ **`1699` を「変換エラー」と断定しないこと** — あれは `netprint-client.ts` が
 *    `resultCode` 0/1 以外に一律で付けているこちら側のラベルで、**1699 固有の意味は
 *    未確認**。応答の `inquiryURL` に `c=1699` が載るのでセブン側は意味を持っている
 *    可能性がある。実測で言えるのは「**pdf-lib の出力では 0 にならず、公式帳票では
 *    0 になる**」まで
 * 2. **載る情報が足りない。** 公式帳票には作業時間・給油/燃費・ETC 利用明細・
 *    速度オーバー詳細・連続運転明細・2 ページ目の運行記録計まで入っており、自前の
 *    1 行 1 運行の表では再現しきれない
 *
 * ## ★ 原因は 2 つ重なっていた (切り分けの記録)
 *
 * 毎朝の cron は長らく `register-file` が HTTP 500 `code=99999` で落ちていた。
 * これは**この PDF のせいではなく** `User-Agent` 欠落 (`netprint-client.ts` の
 * `NETPRINT_USER_AGENT`、#901 で修正済み) で、**UA の問題が下の層を覆い隠していた**。
 * UA を直して初めて `resultCode=1699` が見えた ⇒ pdf-lib の PDF も本当に駄目だった。
 *
 * 順序が大事: **`code=99999` を「PDF が壊れている」と読むのは誤り**。あれは UA。
 * PDF が駄目なことの根拠は **1699 の方**。両方を混ぜて 1 つの原因にしないこと
 * (混ぜたまま片方だけ直すと、直ったつもりでもう一方を後で踏む)。
 *
 * 公式帳票なら UA 修正後の worker から `printID` まで通ることを実測済み
 * (dev、9 運行 41 ページ / まとめ版で `XNB56U7T`)。
 *
 * ## 経路 (すべて実機で確定、2026-08-25)
 *
 * 1. 対象日 (読取日) の運行を F-DES1010 [運行データ入力(一覧)] から取り、行の
 *    `branchCd` で対象営業所に絞る (`fetchBranchDailyReport`)。**営業所の判定は
 *    ここでしかできない** — F-NRS1010 のグリッドは事業所**名** (`lblDisplayName`)
 *    しか持たず、`netprint_targets` の `branch_cd` と突き合わせられる CD 列が無い
 * 2. F-NRS1010 [運転日報] を GET し、`ctl00$MainContent$Button3` (プレビュー) を
 *    postback する。選択は hidden 4 本 (`txtOperationNo` / `txtStartDateTime` /
 *    `txtCurrentID` / `txtIndex`) に**カンマ区切りで並べる**だけ
 *    (`Scripts/J-GOS0010[OperationDataSelect].js` の `AllSelect`/`MultiProcess` が
 *    ブラウザでやっているのと同じ形)
 * 3. 応答の startup script に
 *    `window.open('F-GRS0010[PreviewDocument].aspx?title=運転日報&fileName=<ts>_0')`
 *    が載る。**`fileName` はサーバが決めた値をここから拾う** (現在時刻から組み立てない
 *    — 押した時刻とはズレるし `_0` の suffix も付く)
 * 4. その URL を GET すると PDF 本体が返る
 *
 * ## 呼び出し単位は 1 運行 (ただし複数選択できることは分かっている)
 *
 * 運用は **1 運行 = 1 PDF = 1 予約番号** (ユーザー判断、`netprint-cron.ts` の doc)。
 * `rows` に 1 件だけ渡すのが通常の使い方。
 *
 * **`rows` に複数渡せば 1 本にまとまった PDF が返る**ことは実機で確認済み
 * (2026-08-25 dev、30 運行 → 93 ページ / 10,105,315 B、9 運行 → 41 ページ / 3,847,664 B。
 * いずれも応答バイト数)。まとめ版に戻したくなったときのために、その時の実測を残しておく:
 *
 * - **選択はサーバ側で 運行No で解決され、その行が今表示中のページに描かれている
 *   必要が無い。** 2 ページ目にしか無い運行を 1 ページ目の postback に混ぜても PDF に
 *   入った (`ddlRowCount` の上限は 30 なので、1 日 34 行だと 2 ページに割れる)
 * - よって**表示条件 (F-GOS0030) の絞込はプレビューには要らない**。この関数は共有設定を
 *   一切触らない — 他の担当者の画面を書き換えるリスクを持ち込まないため。読取日の絞込を
 *   使うのは F-DES1010 の harvest (`withDisplayNarrow`) だけ
 * - **まとめても netprint の 10MB 上限には当たらなかった** (#908 で実測し直し)。上限は
 *   `NETPRINT_MAX_PDF_BYTES = 10_485_760` (`netprint-client.ts`) で、30 運行まとめ版は
 *   **10,104,381 B (PDF 部) / 10,105,315 B (応答全体)** ⇒ **上限内**。`registerPdf` に
 *   渡るのは応答全体の方 (`fetchPreviewDocument` が body を丸ごと返すため。F-GRS0010 は
 *   PDF の後ろに 934 B の HTML を足して返してくるが、実測で `printID` まで通っている)。
 *   1 運行あたりは **209,367〜594,161 B (30 件平均 340,476 B)** とばらつくので、天井は
 *   **17〜50 運行** (平均なら約 30)。実運用の「1 営業所 1 日」は dev 実測で
 *   **9 運行 / 41 ページ / 3,847,664 B = 上限の 37%**
 *   - ★ **旧記述「1 運行 ≈ 0.34 MB ⇒ 約 29 運行が天井、まとめると 10MB 上限に当たる」は
 *     誤り**。**10.1 MB (十進、= 10,105,315 B) と 10 MiB (= 10,485,760 B) を取り違えて
 *     いた** — 「10.1 > 10」と読んで超過と判断したが、単位が違うので実際は下回っている。
 *     同じ取り違えを繰り返さないよう、誤りごと残す
 *   - 測定条件: 2026-08-25 dev、F-NRS1010 の `Button3` プレビュー 1 回ぶんの応答。
 *     **選択件数は依頼側のログではなく、応答 HTML がエコーするサーバ受領値**
 *     (`ctl00$MainContent$T1$txtOperationNo` のカンマ数) で計数。サイズは応答バイト数、
 *     ページ数は `pdfinfo`、1 運行あたりは PDF の incremental revision (`%%EOF` の
 *     間隔。選択 1 件につき 1 revision 追記される) の差分
 *   - **`1 運行 = 1 PDF = 1 予約番号` の運用判断はこの訂正では揺らがない** — 上限は
 *     理由のひとつでしかなく、印刷単位・失敗の局所化といった別の理由は残る
 *
 * ## なぜ F-DES1010 のプレビューを使わないか
 *
 * F-DES1010 にも「日報プレビュー」(`btnDispPreview` → 隠し `btnPreview`) があるが、
 * `Scripts/J-DES1010[OperationEdit].js` の `RowsClick` は選択 hidden を**1 件ぶんで
 * 上書きする**だけで、複数選択の仕組みが無い (`btnDispPreviewClick` も `_SelectIndex`
 * 1 つしか見ない)。1 運行だけなら足りるが、経路を 2 本持つ理由が無いうえ、
 * **F-NRS1010 の帳票の方が中身が揃っている** (作業時間・燃料込み) ため使わない。
 */
import {
  BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchWithJar,
  findFormFieldById,
  postForm,
  serializeFormFields,
  TheearthClientError,
  type CookieJar,
  type FetchLike,
} from "./theearth-client";
import { isLoginRedirect, VenusSessionExpiredError } from "./theearth-venus-client";
import {
  harvestDailyReport,
  ReportParamError,
  withDisplayNarrow,
  type DailyReportRow,
  type HarvestRange,
} from "./theearth-report-client";

/** F-NRS1010 [運転日報]。F-DES1010 とは別ページ (grid の id prefix も `T1_` 付き)。 */
const NRS_DAILY_REPORT_PATH = "/F-NRS1010[DailyOperationReport].aspx";

/** プレビュー (`Button3`) の ClientID。name (`ctl00$MainContent$Button3`) はページから読む。 */
const PREVIEW_BUTTON_ID = "MainContent_Button3";

/** 選択状態を載せる hidden の ClientID。name は ASP.NET の ClientID とは別物なので
 * 都度ページから引く (`findFormFieldById`)。 */
const SELECTION_FIELD_IDS = {
  operationNo: "txtOperationNo",
  startDateTime: "txtStartDateTime",
  currentId: "txtCurrentID",
  index: "txtIndex",
} as const;

/** F-NRS1010 グリッドの行 id prefix (選択 hidden `txtCurrentID` に並べる値の形)。 */
const NRS_ROW_ID_PREFIX = "MainContent_T1_lstOperation_row_";

const DATE_JST_RE = /^\d{4}\/\d{2}\/\d{2}$/;
/** F-DES1010 の lblBranchCD は非パディングの数値文字列 (実測 "1" / "8")。 */
const BRANCH_CD_RE = /^\d{1,8}$/;

/** 対象日 (JST) 1 日ぶんの読取日 range。`withDisplayNarrow` の readDate と
 * `harvestDailyReport` の range の両方にそのまま渡せる形。 */
export function dailyReportReadDateRange(dateJst: string): HarvestRange {
  if (!DATE_JST_RE.test(dateJst)) {
    throw new ReportParamError(`対象日は "YYYY/MM/DD" 形式で指定してください: "${dateJst}"`);
  }
  return { from: `${dateJst} 00:00`, to: `${dateJst} 23:59` };
}

export interface FetchBranchDailyReportParams {
  /** 対象日 (JST) "YYYY/MM/DD"。「前日」の計算は呼び出し側 (cron) の責務。 */
  dateJst: string;
  /** F-DES1010 の `lblBranchCD` の値 (非パディング数値文字列、本社 = "1")。 */
  branchCd: string;
}

export interface BranchDailyReport {
  /** F-DES1010 の行 (対象営業所のみ、退社日時=読取日が対象日の範囲)。 */
  rows: DailyReportRow[];
}

/**
 * 指定日 (読取日 = 退社日時) の全行を harvest し、対象営業所の行を返す。`jar` は
 * ログイン済みセッションの cookie jar (ログインは呼び出し側の責務)。theearth への
 * アクセスはすべて `fetchImpl` 経由 (テストは注入で実 theearth を叩かない)。
 */
export async function fetchBranchDailyReport(
  jar: CookieJar,
  params: FetchBranchDailyReportParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs?: number,
): Promise<BranchDailyReport> {
  if (!BRANCH_CD_RE.test(params.branchCd)) {
    throw new ReportParamError(`営業所CD は 8 桁以内の数値で指定してください: "${params.branchCd}"`);
  }
  const range = dailyReportReadDateRange(params.dateJst);
  return withDisplayNarrow(
    jar,
    { readDate: range },
    async (j, firstPageHtml) => {
      const desRows = await harvestDailyReport(j, range, fetchImpl, timeoutMs, firstPageHtml);
      return { rows: desRows.filter((r) => r.branchCd === params.branchCd) };
    },
    fetchImpl,
    timeoutMs,
  );
}

// ---------------------------------------------------------------------------
// 選択 (pure)
// ---------------------------------------------------------------------------

/** プレビュー postback に載せる選択状態 (hidden 4 本の値)。 */
export interface OperationSelection {
  operationNo: string;
  startDateTime: string;
  currentId: string;
  index: string;
}

/**
 * 対象運行のリストを F-NRS1010 の選択 hidden 4 本の値に畳む。
 *
 * `txtCurrentID` はブラウザでは「クリックした行の DOM id」の羅列で、行の色を戻す
 * 以外に使われない (`J-GOS0010[OperationDataSelect].js` の `CurrentReset`)。サーバは
 * 運行No で解決するため**ページに実在する id である必要は無い**が、`openWaitProcess`
 * が「空なら送らない」判定に使う値でもあるので、他の 2 本と件数を揃えた連番を置く。
 */
export function buildOperationSelection(
  rows: readonly Pick<DailyReportRow, "operationNo" | "startDateTime">[],
): OperationSelection {
  return {
    operationNo: rows.map((r) => r.operationNo).join(","),
    startDateTime: rows.map((r) => r.startDateTime).join(","),
    currentId: rows.map((_, i) => `${NRS_ROW_ID_PREFIX}${i}`).join(","),
    index: "0",
  };
}

/**
 * プレビュー postback の応答から帳票 URL (F-GRS0010) を取り出す。
 *
 * 応答は ScriptManager の startup script で、CDATA 内に生のまま
 * `window.open('F-GRS0010[PreviewDocument].aspx?title=運転日報&fileName=20260825203036_0')`
 * が出る (HTML エンティティ化されない)。**URL は丸ごとそのまま使う** — `title` も
 * `fileName` の `_0` suffix もサーバが決めた値で、組み立て直すと外す。
 */
export function parsePreviewDocumentUrl(html: string): string | null {
  return html.match(/window\.open\('(F-GRS0010\[PreviewDocument\][^']*)'\)/)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// PDF 取得
// ---------------------------------------------------------------------------

/** 帳票の生成完了を待つポーリング間隔 / 最大試行回数の既定。プレビュー postback が
 * 返った時点で生成が終わっているとは限らない (ブラウザでは window.open された URL を
 * 実際に取りに行くまでのラグが猶予になっている) ため、`application/pdf` 以外が返る
 * 間は待って取り直す。 */
export const PREVIEW_POLL_INTERVAL_MS = 2_000;
export const PREVIEW_POLL_MAX_ATTEMPTS = 15;

export interface FetchDailyReportPdfParams {
  /** PDF に含める運行。**通常は 1 件** (1 運行 = 1 PDF = 1 予約番号)。
   * 複数渡すと 1 本にまとまった PDF が返る (module doc 参照)。 */
  rows: readonly Pick<DailyReportRow, "operationNo" | "startDateTime">[];
}

/**
 * プレビュー postback / 帳票ダウンロードの timeout (ms)。
 *
 * **`DEFAULT_REQUEST_TIMEOUT_MS` (30 秒) では足りない。** 帳票生成は選択した運行の
 * 数に比例して重く、9 運行 (41 ページ) をまとめて出したときは 30 秒を超えて timeout
 * した (dev 実機、2026-08-25)。1 運行ずつでも余裕を持たせる — 運行の作業行数次第で
 * 1 件でも重くなりうるうえ、短くして得るものが無いため。theearth のページ自身も `PageInit` に**クライアント側
 * 600 秒**のキャンセルタイマを積んでおり (超過時の文言は「選択する運行データの件数を
 * 減らして、もう一度プレビューしてください。」)、分単位かかりうるのが仕様。
 * ページの上限より短く取って、こちらが先に諦める。 */
export const PREVIEW_TIMEOUT_MS = 300_000;


/** 帳票生成待ちの調整口 (`netprint-client.ts` の `NetprintPollOptions` と同じ流儀)。 */
export interface DailyReportPdfPollOptions {
  sleepImpl?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxAttempts?: number;
  /** プレビュー postback / 帳票ダウンロードの timeout (既定 `PREVIEW_TIMEOUT_MS`)。
   * 一覧の GET はこれとは別で、軽いので `timeoutMs` のまま。 */
  previewTimeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 対象運行ぶんの公式「運転日報」PDF を 1 本取得する。
 *
 * `rows` が空なら**呼んではいけない** (0 行の日は PDF を作らないのが cron の仕様、
 * `runNetprintTargets` 参照)。念のためここでも loud fail する — 空選択のまま
 * postback すると theearth 側が何も選ばれていない扱いで帳票 URL を出さず、
 * 「原因不明で PDF が取れない」に化けるため。ブラウザ側も同じ扱いで、
 * `openWaitProcess` が `txtCurrentID` 空を見て postback 自体をやめる。
 */
export async function fetchDailyReportPdf(
  jar: CookieJar,
  params: FetchDailyReportPdfParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  poll: DailyReportPdfPollOptions = {},
): Promise<Uint8Array> {
  if (params.rows.length === 0) {
    throw new ReportParamError("運転日報 PDF の対象運行が 0 件です");
  }
  const url = `${BASE_URL}${NRS_DAILY_REPORT_PATH}`;
  const listHtml = await fetchDailyOperationReportHtml(jar, url, fetchImpl, timeoutMs);

  const previewButton = findFormFieldById(listHtml, PREVIEW_BUTTON_ID);
  if (!previewButton) {
    throw new TheearthClientError(
      "運転日報のプレビューボタン (Button3) が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }
  const fields = serializeFormFields(listHtml);
  const selection = buildOperationSelection(params.rows);
  for (const [key, id] of Object.entries(SELECTION_FIELD_IDS) as [
    keyof typeof SELECTION_FIELD_IDS,
    string,
  ][]) {
    const field = findFormFieldById(listHtml, id);
    if (!field) {
      throw new TheearthClientError(
        `運転日報の選択フィールド (${id}) が見つかりません — theearth-np のページ仕様変更の可能性があります`,
      );
    }
    fields[field.name] = selection[key];
  }
  fields[previewButton.name] = previewButton.value || "プレビュー";

  const previewTimeoutMs = poll.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS;
  const res = await postForm(
    jar,
    url,
    new URLSearchParams(fields),
    fetchImpl,
    previewTimeoutMs,
    "nippo_preview",
  );
  if (!res.ok) {
    throw new TheearthClientError(`運転日報のプレビューが HTTP ${res.status} を返しました`);
  }
  const previewHtml = await res.text();
  if (isLoginRedirect(previewHtml)) {
    throw new VenusSessionExpiredError(
      "運転日報のプレビュー後にログイン画面が返されました — theearth セッションが切れています",
    );
  }
  const documentUrl = parsePreviewDocumentUrl(previewHtml);
  if (!documentUrl) {
    throw new TheearthClientError(
      `運転日報のプレビュー応答に帳票 URL (F-GRS0010) がありません (対象 ${params.rows.length} 件) — ` +
        "運行の選択がサーバに届いていない可能性があります",
    );
  }
  return fetchPreviewDocument(jar, documentUrl, fetchImpl, previewTimeoutMs, poll);
}

/** F-NRS1010 を GET して full form HTML を返す (プレビュー postback 用)。 */
async function fetchDailyOperationReportHtml(
  jar: CookieJar,
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs, "nippo_list");
  if (!res.ok) {
    throw new TheearthClientError(`運転日報 (F-NRS1010) の取得が HTTP ${res.status} を返しました`);
  }
  const html = await res.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "運転日報 (F-NRS1010) がログイン画面を返しました — theearth セッションが切れています",
    );
  }
  return html;
}

/**
 * 帳票 URL から PDF 本体を取る。生成完了まで時差があるので `application/pdf` が
 * 返るまで待って取り直す。**最後の試行の状況を必ずメッセージに載せる** — 「取れ
 * なかった」だけだと生成待ちなのか別物 (ログイン画面・エラーページ) が返っている
 * のか切り分けられないため。
 */
async function fetchPreviewDocument(
  jar: CookieJar,
  documentUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  poll: DailyReportPdfPollOptions,
): Promise<Uint8Array> {
  const sleep = poll.sleepImpl ?? defaultSleep;
  const intervalMs = poll.pollIntervalMs ?? PREVIEW_POLL_INTERVAL_MS;
  const maxAttempts = poll.maxAttempts ?? PREVIEW_POLL_MAX_ATTEMPTS;
  const url = new URL(documentUrl, `${BASE_URL}/`).toString();
  let lastStatus = 0;
  let lastContentType = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(intervalMs);
    const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs, "nippo_pdf");
    lastStatus = res.status;
    lastContentType = res.headers.get("content-type") ?? "";
    if (res.ok && lastContentType.includes("application/pdf")) {
      return new Uint8Array(await res.arrayBuffer());
    }
    // ログイン画面が返ったら待っても変わらない (セッション切れ) ので即諦める。
    if (lastContentType.includes("text/html") && isLoginRedirect(await res.text())) {
      throw new VenusSessionExpiredError(
        "運転日報 PDF の取得でログイン画面が返されました — theearth セッションが切れています",
      );
    }
  }
  throw new TheearthClientError(
    `運転日報 PDF が ${maxAttempts} 回の試行で取得できませんでした ` +
      `(最後の応答: HTTP ${lastStatus} ${lastContentType || "content-type 不明"})`,
  );
}
