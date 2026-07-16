/**
 * theearth-np.com F-ERS2010[RestraintDataReport] (乗務員拘束時間管理表) の
 * ブラウザレス CSV 取得 + パース (Refs #241)。
 *
 * 実機確定知見 (2026-07-16、実ブラウザ + DOM 検査 + CSV 実ダウンロードで確認):
 *
 * - CSV 出力は **1 回の WebForms postback** (`btnOutputCsv`、onclick は
 *   `txtRenge()` のクライアント検証のみ)。F-NOS3010 のような 2 段階 postback や
 *   確認ページは無い。
 * - 集計範囲は「年月指定」(`ucMonthDate`)。**年フィールドの maxLength=2 は UI 上の
 *   制限に過ぎず、POST では 4 桁西暦がそのまま通る** (2026/2025 で実測確定)。
 *   2 桁を送ると企業設定 (和暦/西暦) に依存して解釈がぶれる — 実機では 25 (西暦
 *   2 桁のつもり) も 7 (令和のつもり) も「該当データがありません」になり、4 桁
 *   西暦だけが常に成功した。**必ず 4 桁西暦を送る** (detectWareki 不要)。
 * - 乗務員は `txtStartDriver`〜`txtEndDriver` の乗務員CD range。両方空 = 全乗務員
 *   (実測 112 名 378KB)。1 名ずつ取るなら from=to に同じ CD を入れる。
 * - データが無い場合は **HTTP 200 で HTML が返り** startup script
 *   `DispMsg('該当データがありません。')` を含む (CSV は返らない)。未集計の
 *   年月・在籍していない乗務員CD もこれになる。
 * - 成功時は Shift_JIS の CSV (`拘束時間管理表.csv`)。1 行目は
 *   `拘束時間管理表 (YYYY年 M月分)`。
 *
 * 「黙って200」対策: 想定フォーム要素の欠落・CSV 先頭行不一致は必ず throw。
 * 同一 theearth セッションへの並行リクエストはセッションロックで hang/500 する
 * ため、呼び出し側 (DO) は必ず直列化すること。
 */

import {
  BASE_URL,
  DEFAULT_EXPORT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TheearthClientError,
  VenusSessionExpiredError,
  fetchWithJar,
  findFormFieldById,
  findTagById,
  hasLoginForm,
  postForm,
  serializeFormFields,
  type CookieJar,
  type FetchLike,
  type ScrapeTimeouts,
} from "./theearth-client";

export const RESTRAINT_PATH = "/F-ERS2010[RestraintDataReport].aspx";

/** パラメータ不正 (呼び出し側で 400 にマップする)。 */
export class RestraintParamError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "RestraintParamError";
  }
}

export interface RestraintCsvParams {
  /** 4 桁西暦 (上記 doc の通り、2 桁は企業の和暦/西暦設定で解釈がぶれるため不可)。 */
  year: number;
  /** 1-12。 */
  month: number;
  /** 乗務員CD range。両方空文字 = 全乗務員。1 名なら from=to。 */
  driverFrom: string;
  driverTo: string;
}

const DRIVER_CD_RE = /^\d{1,8}$/;

/** RestraintCsvParams を検証する (DO ハンドラの入口で 400 に落とすため)。 */
export function validateRestraintParams(params: RestraintCsvParams): void {
  if (!Number.isInteger(params.year) || params.year < 2000 || params.year > 2100) {
    throw new RestraintParamError(`year は 4 桁西暦で指定してください (受領値: ${params.year})`);
  }
  if (!Number.isInteger(params.month) || params.month < 1 || params.month > 12) {
    throw new RestraintParamError(`month は 1〜12 で指定してください (受領値: ${params.month})`);
  }
  const hasFrom = params.driverFrom !== "";
  const hasTo = params.driverTo !== "";
  if (hasFrom !== hasTo) {
    throw new RestraintParamError("driverFrom / driverTo は両方指定するか両方空 (全乗務員) にしてください");
  }
  for (const [label, value] of [["driverFrom", params.driverFrom], ["driverTo", params.driverTo]] as const) {
    if (value !== "" && !DRIVER_CD_RE.test(value)) {
      throw new RestraintParamError(`${label} は数値の乗務員CDで指定してください (受領値: ${value})`);
    }
  }
}

/** GET ページから抽出必須のフォーム要素 (ClientID)。name (`ctl00$...`) は毎回
 * ページから読む (theearth-client.ts と同じ「id ハードコード + name は都度抽出」方針)。 */
const RESTRAINT_FORM_IDS = [
  "ucMonthDate_txtYear",
  "ucMonthDate_txtMonth",
  "txtStartDriver",
  "txtEndDriver",
  "btnOutputCsv",
] as const;

/** 想定外ページの診断用 (title + タグ除去済み本文の先頭。credential は含まれない)。 */
function describeHtml(html: string): string {
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "(no title)";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `title="${title}" 本文先頭: ${text.slice(0, 160)}`;
}

/** 応答 HTML が「該当データがありません。」の DispMsg を含むか (実機確定の
 * no-data マーカー。未集計・不在乗務員CD・範囲外年月のすべてがこれになる)。 */
export function isNoDataResponse(html: string): boolean {
  return html.includes("該当データがありません");
}

export interface RestraintCsvResult {
  /** Shift_JIS の生 CSV バイト列 (ダウンロード素通し用)。 */
  bytes: ArrayBuffer;
  /** デコード済みテキスト (パース用)。 */
  text: string;
}

/**
 * 年フィールドに試す値の候補を、優先順に返す。
 *
 * 実機確定 (2026-07-16): 検証した企業アカウントでは **4 桁西暦だけが常に成功**し、
 * 2 桁は "25" (西暦のつもり) も "07" (令和のつもり) も「該当データがありません」に
 * なった。一方 **別の企業アカウントでは年入力が "08" (= 令和8年) 表示**になる
 * (和暦設定の企業が存在する) ため、4 桁西暦が全企業で通る保証は無い。
 *
 * → 候補を順に試して「該当データがありません」ならフォールバックする:
 * - 既定: [4桁西暦, 令和2桁ゼロ埋め]
 * - ページの `ucMonthDate_chkUseEra` が checked (和暦入力モードの hint) なら逆順
 * - 令和にならない年 (2018 以前) は 4 桁西暦のみ
 */
export function restraintYearCandidates(year: number, pageHtml: string): string[] {
  const western = String(year);
  const reiwa = year - 2018;
  if (reiwa < 1) return [western];
  const wareki = String(reiwa).padStart(2, "0");
  const eraTag = findTagById(pageHtml, "ucMonthDate_chkUseEra");
  const eraChecked = eraTag !== null && /\bchecked\b/i.test(eraTag);
  return eraChecked ? [wareki, western] : [western, wareki];
}

/** 1 つの年表現で GET → btnOutputCsv postback を 1 回試す。null = 該当データなし。 */
async function attemptRestraintCsv(
  jar: CookieJar,
  params: RestraintCsvParams,
  yearValue: string,
  pageHtml: string,
  fetchImpl: FetchLike,
  exportTimeoutMs: number,
): Promise<RestraintCsvResult | null> {
  const pageUrl = `${BASE_URL}${RESTRAINT_PATH}`;
  const fields = serializeFormFields(pageHtml);
  const refs = new Map<string, { name: string; value: string }>();
  for (const id of RESTRAINT_FORM_IDS) {
    const ref = findFormFieldById(pageHtml, id);
    if (!ref) {
      throw new TheearthClientError(
        `拘束時間管理表フォームの要素 (id=${id}) が見つかりません — theearth-np のページ仕様が変更された可能性があります`,
      );
    }
    refs.set(id, ref);
  }

  fields[refs.get("ucMonthDate_txtYear")!.name] = yearValue;
  fields[refs.get("ucMonthDate_txtMonth")!.name] = String(params.month);
  fields[refs.get("txtStartDriver")!.name] = params.driverFrom;
  fields[refs.get("txtEndDriver")!.name] = params.driverTo;

  const btn = refs.get("btnOutputCsv")!;
  const body = new URLSearchParams({ ...fields, [btn.name]: btn.value || "CSV" });

  // CSV 生成は全乗務員だと数十秒かかりうる (378KB 実測) ため export 用の長い
  // タイムアウトを使う。
  const res = await postForm(jar, pageUrl, body, fetchImpl, exportTimeoutMs);
  if (!res.ok) {
    const errHtml = await res.text();
    throw new TheearthClientError(
      `拘束時間管理表 CSV の postback が HTTP ${res.status} を返しました (${describeHtml(errHtml)})`,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();

  if (contentType.includes("text/html")) {
    // aspx の HTML 応答は UTF-8 (CSV 本体だけが Shift_JIS)。ここを Shift_JIS で
    // デコードすると「該当データがありません」マーカーが文字化けして判定不能になる。
    const pageHtml2 = new TextDecoder("utf-8").decode(buf);
    if (hasLoginForm(pageHtml2)) {
      throw new VenusSessionExpiredError(
        "拘束時間管理表 CSV の postback がログイン画面を返しました — theearth セッションが切れています",
      );
    }
    if (isNoDataResponse(pageHtml2)) return null;
    throw new TheearthClientError(
      `拘束時間管理表 CSV の postback が想定外の HTML を返しました (${describeHtml(pageHtml2)})`,
    );
  }

  const text = new TextDecoder("shift_jis").decode(buf);

  // 「黙って200」対策: CSV の 1 行目マジック (`拘束時間管理表 (YYYY年 M月分)`)。
  if (!text.startsWith("拘束時間管理表")) {
    throw new TheearthClientError(
      `取得したデータが拘束時間管理表 CSV ではありません (content-type=${contentType || "(none)"}, ${buf.byteLength} bytes)`,
    );
  }
  return { bytes: buf, text };
}

/**
 * F-ERS2010 から拘束時間管理表 CSV を取得する。
 *
 * - 戻り値 `null` = 「該当データがありません」(異常ではない — 未集計月・
 *   その月に在籍しない乗務員CD など)。
 * - full-form 直列化 (`serializeFormFields`) で送る: 出力基準 radio
 *   (`ctl00$RangeType`、既定 = 令和6年4月改正基準)・絞込条件・優先項目は
 *   ページの現在値をそのまま維持する (一部だけ送ると ASP.NET が既定値に
 *   落とす罠は F-DES1010 で実証済み)。
 * - 年は企業の和暦/西暦設定に依存するため、`restraintYearCandidates` の順に
 *   試して「該当データがありません」なら次の表現でリトライする (各試行とも
 *   ページを GET し直す)。全候補が該当なしなら null。
 */
export async function downloadRestraintCsv(
  jar: CookieJar,
  params: RestraintCsvParams,
  fetchImpl: FetchLike = fetch,
  timeouts: ScrapeTimeouts = {},
): Promise<RestraintCsvResult | null> {
  validateRestraintParams(params);
  const requestTimeoutMs = timeouts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const exportTimeoutMs = timeouts.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const pageUrl = `${BASE_URL}${RESTRAINT_PATH}`;

  let candidates: string[] | null = null;
  for (let i = 0; candidates === null || i < candidates.length; i++) {
    const getRes = await fetchWithJar(jar, pageUrl, { method: "GET" }, fetchImpl, requestTimeoutMs);
    const html = await getRes.text();
    if (hasLoginForm(html)) {
      throw new VenusSessionExpiredError(
        "拘束時間管理表ページがログイン画面を返しました — theearth セッションが切れています",
      );
    }
    candidates ??= restraintYearCandidates(params.year, html);
    const result = await attemptRestraintCsv(jar, params, candidates[i], html, fetchImpl, exportTimeoutMs);
    if (result !== null) return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSV パース
// ---------------------------------------------------------------------------

/** "H:mm" (H は 3 桁以上になりうる、例 "345:50") を分に変換する。空・非該当は null。 */
export function parseHmmToMinutes(value: string | undefined): number | null {
  if (!value) return null;
  const m = value.trim().match(/^(\d+):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export interface RestraintDayRow {
  /** "6月1日" 等の生ラベル。 */
  date: string;
  /** 日 (1-31)。ラベルから抽出できなければ null。 */
  day: number | null;
  /** 休日行 ("休")。 */
  isRestDay: boolean;
  startTime: string;
  endTime: string;
  /** 運転時間 (分)。 */
  drivingMinutes: number | null;
  /** 荷役時間 (分)。 */
  loadingMinutes: number | null;
  /** 休憩時間 (分)。 */
  breakMinutes: number | null;
  /** 拘束時間合計 (分)。 */
  restraintMinutes: number | null;
  /** 拘束時間累計 (分)。 */
  restraintCumulativeMinutes: number | null;
  /** 休息時間 (分)。 */
  restMinutes: number | null;
  /** 実働時間 (分)。 */
  workingMinutes: number | null;
  /** 時間外時間 (分)。 */
  overtimeMinutes: number | null;
  /** 摘要 (摘要1/摘要2 の非空のみ)。 */
  notes: string[];
  /** ヘッダと同順の生カラム (フロントで全列表示する用)。 */
  columns: string[];
}

export interface RestraintDriverTotals {
  /** 合計行の生カラム。 */
  columns: string[];
  drivingMinutes: number | null;
  loadingMinutes: number | null;
  breakMinutes: number | null;
  /** 月間拘束時間 (合計行の「拘束時間小計」列 — 実 CSV では合計はこの列に入る)。 */
  restraintMinutes: number | null;
  restMinutes: number | null;
  workingMinutes: number | null;
  overtimeMinutes: number | null;
}

export interface RestraintDriverBlock {
  branchName: string;
  /** 乗務員分類1〜5 (ラベル → 値)。 */
  categories: Record<string, string>;
  driverName: string;
  driverCd: string;
  /** 日別テーブルのヘッダ (実ページの列名そのまま)。 */
  header: string[];
  days: RestraintDayRow[];
  totals: RestraintDriverTotals | null;
  /** 「4月～M月 累計拘束時間」行の値 (分)。空欄 (年度頭など) は null。 */
  fiscalCumulativeMinutes: number | null;
  /** 「YYYY年度 拘束時間」行の値 (時間、例 3300)。 */
  fiscalLimitHours: number | null;
}

export interface RestraintReport {
  /** 1 行目そのまま (例 "拘束時間管理表 (2025年 4月分)")。 */
  title: string;
  year: number;
  month: number;
  /** 2 行目の注記そのまま。 */
  maxRestraintNote: string;
  drivers: RestraintDriverBlock[];
}

/** ヘッダ列名 → index。実 CSV の列名で引く (列順変更に気づけるように)。 */
function col(header: string[], name: string): number {
  return header.indexOf(name);
}

function at(columns: string[], index: number): string {
  return index >= 0 && index < columns.length ? columns[index] : "";
}

/**
 * 拘束時間管理表 CSV (Shift_JIS デコード済みテキスト) をパースする。
 *
 * 構造 (実 CSV 確定、単一/複数乗務員共通):
 * ```
 * 拘束時間管理表 (2025年 4月分)
 * ※当月の最大拘束時間 : 275 時間（労使協定により時間を記入する）
 * (空行)
 * 事業所,<名>,乗務員分類1,<値>,...,乗務員分類5,<値>
 * 氏名,<名>,乗務員コード,<CD>
 * 日付,始業時刻,終業時刻,...(ヘッダ 24 列)
 * 4月1日,17:11,18:29,...   ← 日別行 (休日は "4月6日,休," の短縮形)
 * 合計,,,239:39,...
 * 4月～5月 累計拘束時間,592時間 50分,   ← 空欄のこともある
 * 2025年度　拘束時間,3300時間
 * D2 : 2分割休息 ... (凡例)
 * (空行)                              ← 次の乗務員ブロックが続く
 * ```
 *
 * 摘要にカンマが含まれるとその行の列が後ろへずれる可能性があるが、実 CSV は
 * クォート無しの素朴な生成のため、主要列 (日付〜時間外深夜、index 0..21) を
 * 位置で読み、22 以降を摘要として結合する。
 */
export function parseRestraintCsv(text: string): RestraintReport {
  const lines = text.split(/\r\n|\n/);
  if (!lines[0]?.startsWith("拘束時間管理表")) {
    throw new TheearthClientError("拘束時間管理表 CSV の 1 行目が想定と異なります (パース不能)");
  }
  const titleMatch = lines[0].match(/\((\d{4})年\s*(\d{1,2})月分\)/);
  if (!titleMatch) {
    throw new TheearthClientError(`拘束時間管理表 CSV のタイトルから年月を読めません: ${lines[0]}`);
  }

  const report: RestraintReport = {
    title: lines[0],
    year: parseInt(titleMatch[1], 10),
    month: parseInt(titleMatch[2], 10),
    maxRestraintNote: lines[1] ?? "",
    drivers: [],
  };

  let current: RestraintDriverBlock | null = null;
  let headerIdx: Record<string, number> | null = null;

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split(",");
    const first = cols[0];

    if (first === "事業所") {
      // 新しい乗務員ブロックの開始。categories は "乗務員分類N,値" のペア並び。
      const categories: Record<string, string> = {};
      for (let c = 2; c + 1 < cols.length; c += 2) {
        // ループ条件 (c + 1 < cols.length) により cols[c + 1] は必ず存在する
        if (cols[c]) categories[cols[c]] = cols[c + 1]!;
      }
      current = {
        branchName: cols[1] ?? "",
        categories,
        driverName: "",
        driverCd: "",
        header: [],
        days: [],
        totals: null,
        fiscalCumulativeMinutes: null,
        fiscalLimitHours: null,
      };
      headerIdx = null;
      report.drivers.push(current);
      continue;
    }
    if (!current) continue; // ブロック開始前の想定外行は無視 (凡例等)

    if (first === "氏名") {
      current.driverName = cols[1] ?? "";
      const cdIdx = cols.indexOf("乗務員コード");
      current.driverCd = cdIdx >= 0 ? (cols[cdIdx + 1] ?? "").trim() : "";
      continue;
    }
    if (first === "日付") {
      current.header = cols;
      headerIdx = {
        driving: col(cols, "運転時間"),
        loading: col(cols, "荷役時間"),
        brk: col(cols, "休憩時間"),
        restraintSubtotal: col(cols, "拘束時間小計"),
        restraintTotal: col(cols, "拘束時間合計"),
        restraintCumulative: col(cols, "拘束時間累計"),
        rest: col(cols, "休息時間"),
        working: col(cols, "実働時間"),
        overtime: col(cols, "時間外時間"),
        notes1: col(cols, "摘要1"),
      };
      continue;
    }
    if (first === "合計") {
      const h = headerIdx;
      current.totals = {
        columns: cols,
        drivingMinutes: parseHmmToMinutes(at(cols, h?.driving ?? -1)),
        loadingMinutes: parseHmmToMinutes(at(cols, h?.loading ?? -1)),
        breakMinutes: parseHmmToMinutes(at(cols, h?.brk ?? -1)),
        // 合計行では月間拘束時間が「拘束時間小計」列に入る (実 CSV 確定 —
        // 「拘束時間合計」列は空で、最終日の累計と小計列が一致する)。
        restraintMinutes: parseHmmToMinutes(at(cols, h?.restraintSubtotal ?? -1)),
        restMinutes: parseHmmToMinutes(at(cols, h?.rest ?? -1)),
        workingMinutes: parseHmmToMinutes(at(cols, h?.working ?? -1)),
        overtimeMinutes: parseHmmToMinutes(at(cols, h?.overtime ?? -1)),
      };
      continue;
    }
    if (/累計拘束時間$/.test(first)) {
      // 例: "4月～5月 累計拘束時間,592時間 50分," (空欄は " 時間   分")
      const m = (cols[1] ?? "").match(/(\d+)時間\s*(\d+)?分?/);
      current.fiscalCumulativeMinutes = m
        ? parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0)
        : null;
      continue;
    }
    if (/^\d{4}年度/.test(first)) {
      // 例: "2025年度　拘束時間,3300時間"
      const m = (cols[1] ?? "").match(/(\d+)時間/);
      current.fiscalLimitHours = m ? parseInt(m[1], 10) : null;
      continue;
    }
    const dayMatch = first.match(/^(\d{1,2})月(\d{1,2})日$/);
    if (dayMatch) {
      const h = headerIdx;
      const isRestDay = (cols[1] ?? "").trim() === "休";
      const notesStart = h?.notes1 ?? -1;
      const notes =
        notesStart >= 0 ? cols.slice(notesStart).map((s) => s.trim()).filter(Boolean) : [];
      current.days.push({
        date: first,
        day: parseInt(dayMatch[2], 10),
        isRestDay,
        startTime: isRestDay ? "" : (cols[1] ?? ""),
        endTime: isRestDay ? "" : (cols[2] ?? ""),
        drivingMinutes: parseHmmToMinutes(at(cols, h?.driving ?? -1)),
        loadingMinutes: parseHmmToMinutes(at(cols, h?.loading ?? -1)),
        breakMinutes: parseHmmToMinutes(at(cols, h?.brk ?? -1)),
        restraintMinutes: parseHmmToMinutes(at(cols, h?.restraintTotal ?? -1)),
        restraintCumulativeMinutes: parseHmmToMinutes(at(cols, h?.restraintCumulative ?? -1)),
        restMinutes: parseHmmToMinutes(at(cols, h?.rest ?? -1)),
        workingMinutes: parseHmmToMinutes(at(cols, h?.working ?? -1)),
        overtimeMinutes: parseHmmToMinutes(at(cols, h?.overtime ?? -1)),
        notes,
        columns: cols,
      });
      continue;
    }
    // 凡例行 ("D2 : ..." 等)・未知の行は無視 (パースを落とさない)
  }

  if (report.drivers.length === 0) {
    throw new TheearthClientError("拘束時間管理表 CSV に乗務員ブロックが見つかりません (パース不能)");
  }
  return report;
}

// ---------------------------------------------------------------------------
// R2 アーカイブの key 設計 (pure — R2 I/O は DO 側)
// ---------------------------------------------------------------------------

/**
 * 拘束時間管理表の R2 アーカイブ key 群 (Refs #241)。
 *
 * 取得パターンは「乗務員別 × 1 年分 (12 回)」「全員 × 1 ヶ月 (1 回)」等さまざま
 * なので、**生 CSV は取得単位 (年月 × 乗務員range)**、**サマリは乗務員 × 年月**
 * に正規化して保存する。theearth 側の再集計・編集で同じ年月の値が変わりうる
 * (CSV は最終形が確定するまで動く) ため、次のバージョン管理を行う:
 *
 * - `latest` = 常に最新。customMetadata に `sha256` / `fetchedAt` (この内容を
 *   最初に取得した時刻) / `lastVerifiedAt` (最後に同一内容を確認した時刻) を持つ。
 *   再取得で内容不変なら `lastVerifiedAt` だけ更新 — **「いつの時点までこの値が
 *   合っていたか」** が分かる。
 * - `v-{取得時刻}` = 内容が変わった取得の時だけ追加される版。各版の有効期間は
 *   「自身の fetchedAt 〜 次の版の fetchedAt」。
 * - **新しい版に置き換えられた旧版は、後継版の出現から
 *   `RESTRAINT_VERSION_RETENTION_MS` (7 日) 経過後に削除**する (保存時に
 *   `pickSupersededVersionKeys` で選定。最新版と latest は常に残る)。
 */
export interface RestraintR2Paths {
  /** 生 CSV のディレクトリ (版一覧の list 用)。 */
  csvDir: string;
  /** 生 CSV の最新スナップショット。 */
  csvLatest: string;
  /** 生 CSV の版 (内容が変わった取得時のみ追加)。 */
  csvVersion(ts: string): string;
  /** 取得ごとの確認履歴 (JSONL、1 取得 = 1 行)。「変わっていなかった」という
   * 結果も残す — `lastVerifiedAt` (最新値のみ) と違い、いつ確認して
   * unchanged / new-version だったかの時系列が全部残る。 */
  csvHistory: string;
  /** 乗務員別サマリ JSON のディレクトリ。 */
  summaryDir(driverCd: string): string;
  /** 乗務員別サマリ JSON の最新。 */
  summaryLatest(driverCd: string): string;
  /** 乗務員別サマリ JSON の版。 */
  summaryVersion(driverCd: string, ts: string): string;
}

export function restraintR2Paths(
  prefix: string,
  compId: string,
  year: number,
  month: number,
  driverRange: string,
): RestraintR2Paths {
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const base = `${prefix}/${compId}/${ym}`;
  const summaryDir = (driverCd: string) => `${base}/summary/${driverCd || "unknown"}`;
  return {
    csvDir: `${base}/csv/${driverRange}`,
    csvLatest: `${base}/csv/${driverRange}/latest.csv`,
    csvVersion: (ts) => `${base}/csv/${driverRange}/v-${ts}.csv`,
    csvHistory: `${base}/csv/${driverRange}/history.jsonl`,
    summaryDir,
    summaryLatest: (driverCd) => `${summaryDir(driverCd)}/latest.json`,
    summaryVersion: (driverCd, ts) => `${summaryDir(driverCd)}/v-${ts}.json`,
  };
}

/** 確認履歴 (history.jsonl) の保持行数上限 (直近のみ。肥大化防止)。 */
export const RESTRAINT_HISTORY_MAX_LINES = 1000;

/** 確認履歴の結果種別。
 * - `new-version`: 内容が変わった (版を追加した)
 * - `unchanged`: 確認したが同一内容だった (「この時点まで値が合っていた」の証跡)
 * - `no-data`: 確認したが「該当データがありません」だった (途中入社・休職・
 *   未集計などで正当にありうる — 未取得とは区別して残す) */
export type RestraintHistoryResult = "new-version" | "unchanged" | "no-data";

/** 確認履歴の 1 行 (JSONL)。no-data は sha256/bytes を持たない。 */
export function restraintHistoryLine(
  ts: string,
  result: RestraintHistoryResult,
  sha256: string | null,
  bytes: number | null,
): string {
  return JSON.stringify({
    ts,
    result,
    ...(sha256 !== null ? { sha256 } : {}),
    ...(bytes !== null ? { bytes } : {}),
  });
}

/** 乗務員単体取得 (from=to) で「該当データなし」だった時の summary マーカー body
 * (決定論 JSON — 何度確認しても同一バイト列なので、版管理上は unchanged 扱いで
 * lastVerifiedAt だけ進む。後にデータが現れたら通常の summary が新しい版になる)。 */
export function stableNoDataSummaryBody(
  compId: string,
  year: number,
  month: number,
  driverCd: string,
): string {
  return JSON.stringify({ compId, year, month, driverCd, noData: true });
}

/** JSONL に 1 行追記して直近 maxLines に丸める (R2 は append 不可のため
 * read-modify-write。DO 側の theearthQueue 直列化が競合を防ぐ)。 */
export function appendHistoryJsonl(
  existing: string | null,
  line: string,
  maxLines: number = RESTRAINT_HISTORY_MAX_LINES,
): string {
  const lines = existing ? existing.split("\n").filter((l) => l.trim() !== "") : [];
  lines.push(line);
  return lines.slice(-maxLines).join("\n") + "\n";
}

/** 置き換えられた旧版の保持期間 (7 日)。後継版の出現時刻からこの期間を過ぎた版を
 * 削除対象にする。 */
export const RESTRAINT_VERSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** `restraintVersionTimestamp` (JST `YYYYMMDDTHHmmss`) を epoch ms に戻す。
 * 形式不一致は null (削除対象の選定から除外 = 安全側で消さない)。 */
export function parseRestraintVersionTimestamp(ts: string): number | null {
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return (
    Date.UTC(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
      parseInt(m[4], 10),
      parseInt(m[5], 10),
      parseInt(m[6], 10),
    ) -
    9 * 3600 * 1000
  );
}

/**
 * `v-{ts}` 版 key の一覧から「新しい版に置き換えられ、retention を過ぎたもの」を
 * 選ぶ (削除フラグ相当。R2 に per-object TTL が無いため保存時に掃除する)。
 *
 * - 最新版は常に残す (置き換えられていない = 現役)
 * - i 番目の版は i+1 番目の版の fetchedAt 時点で superseded とみなし、
 *   そこから `retentionMs` 経過していたら削除対象
 * - タイムスタンプを読めない key は安全側で残す
 */
export function pickSupersededVersionKeys(
  keys: string[],
  now: Date,
  retentionMs: number = RESTRAINT_VERSION_RETENTION_MS,
): string[] {
  const entries: Array<{ key: string; at: number }> = [];
  for (const key of keys) {
    const m = key.match(/v-(\d{8}T\d{6})(\.[A-Za-z0-9]+)?$/);
    const at = m ? parseRestraintVersionTimestamp(m[1]) : null;
    if (at !== null) entries.push({ key, at });
  }
  entries.sort((a, b) => a.at - b.at);
  const stale: string[] = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const supersededAt = entries[i + 1].at;
    if (now.getTime() - supersededAt >= retentionMs) stale.push(entries[i].key);
  }
  return stale;
}

/** RestraintCsvParams の乗務員 range を R2 key 用に正規化する (未指定 = 全乗務員)。 */
export function restraintDriverRangeLabel(params: RestraintCsvParams): string {
  return params.driverFrom ? `${params.driverFrom}-${params.driverTo}` : "all";
}

/** R2 の版 suffix 用タイムスタンプ (JST、`YYYYMMDDTHHmmss`)。 */
export function restraintVersionTimestamp(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}` +
    `T${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}${p(jst.getUTCSeconds())}`
  );
}

/** 乗務員別サマリの R2 保存 body (決定論 JSON)。取得時刻等の揮発情報は
 * customMetadata 側に置き、body は**内容が同じなら常に同一バイト列**になる —
 * SHA-256 の変化検知がそのまま「データが変わったか」になる。 */
export function stableSummaryBody(
  compId: string,
  year: number,
  month: number,
  summary: RestraintDriverSummary,
): string {
  return JSON.stringify({ compId, year, month, ...summary });
}

// ---------------------------------------------------------------------------
// 集計サマリ
// ---------------------------------------------------------------------------

export interface RestraintDriverSummary {
  driverCd: string;
  driverName: string;
  branchName: string;
  /** 出勤日数 (休日でない日別行の数)。 */
  workDays: number;
  restDays: number;
  /** 月間拘束時間 (分、合計行由来。無ければ日別 restraintMinutes の和)。 */
  restraintMinutes: number | null;
  drivingMinutes: number | null;
  workingMinutes: number | null;
  overtimeMinutes: number | null;
  /** 日別の最大拘束時間 (分)。 */
  maxDailyRestraintMinutes: number | null;
  /** 年度累計拘束時間 (分、当月分含まず — CSV の「4月～M月 累計拘束時間」)。 */
  fiscalCumulativeMinutes: number | null;
}

/** 乗務員ブロック 1 件をサマリに畳む (フロントの一覧テーブル用)。 */
export function summarizeRestraintDriver(block: RestraintDriverBlock): RestraintDriverSummary {
  const workRows = block.days.filter((d) => !d.isRestDay);
  const dailyRestraints = block.days
    .map((d) => d.restraintMinutes)
    .filter((v): v is number => v !== null);
  const sumOrNull = (values: Array<number | null>): number | null => {
    const present = values.filter((v): v is number => v !== null);
    return present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
  };
  return {
    driverCd: block.driverCd,
    driverName: block.driverName,
    branchName: block.branchName,
    workDays: workRows.length,
    restDays: block.days.length - workRows.length,
    restraintMinutes:
      block.totals?.restraintMinutes ?? sumOrNull(block.days.map((d) => d.restraintMinutes)),
    drivingMinutes:
      block.totals?.drivingMinutes ?? sumOrNull(block.days.map((d) => d.drivingMinutes)),
    workingMinutes:
      block.totals?.workingMinutes ?? sumOrNull(block.days.map((d) => d.workingMinutes)),
    overtimeMinutes:
      block.totals?.overtimeMinutes ?? sumOrNull(block.days.map((d) => d.overtimeMinutes)),
    maxDailyRestraintMinutes: dailyRestraints.length > 0 ? Math.max(...dailyRestraints) : null,
    fiscalCumulativeMinutes: block.fiscalCumulativeMinutes,
  };
}
