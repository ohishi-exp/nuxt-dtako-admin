/**
 * 前日分 運転日報の PDF 生成 (Refs #874-2)。
 *
 * データ取得は既存 `theearth-report-client.ts` の `withDisplayNarrow` (読取日 range
 * 上書き) + `harvestDailyReport` (F-DES1010 全ページ収集) をそのまま使い、行の
 * `branchCd` で対象営業所に絞る (F-GOS0030 への営業所絞込は実装しない — 1 日分は
 * 行数が少なく worker 側フィルタで足りる)。
 *
 * PDF は `pdf-lib` + `@pdf-lib/fontkit` で A4 横 1 段テーブルを組む。フォントは
 * assets/NotoSansJP-Regular.otf を wrangler の rules (Data module) で同梱し、
 * `embedFont(..., { subset: true })` で使用グリフだけを埋め込む。生成物は classic
 * xref テーブルを持つ正規の PDF (`useObjectStreams: false`) — かんたんnetprint は
 * 壊れた PDF を受付 200 の後段で「エラー」にするため (issue #874 親の実測)。
 *
 * 作業1〜5時間・燃料 (自社/他社) の列は F-DES1010 の一覧に存在しない (F-NRS1010
 * 固有フィールド、theearth-venus skill「F-DES1010 の実グリッド構造」節)。列枠は
 * 設けた上で、`DailyReportRow` から埋められないセルは空欄にしている。
 */
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import notoSansJpFontData from "../assets/NotoSansJP-Regular.otf";
import type { CookieJar, FetchLike } from "./theearth-client";
import {
  harvestDailyReport,
  ReportParamError,
  withDisplayNarrow,
  type DailyReportRow,
  type HarvestRange,
} from "./theearth-report-client";

// ---------------------------------------------------------------------------
// データ取得
// ---------------------------------------------------------------------------

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

/**
 * 指定日 (読取日 = 退社日時) の全行を harvest し、対象営業所の行だけ返す。
 * `jar` はログイン済みセッションの cookie jar (ログインは呼び出し側の責務)。
 * theearth へのアクセスはすべて `fetchImpl` 経由 (テストは注入で実 theearth を叩かない)。
 */
export async function fetchBranchDailyReportRows(
  jar: CookieJar,
  params: FetchBranchDailyReportParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs?: number,
): Promise<DailyReportRow[]> {
  if (!BRANCH_CD_RE.test(params.branchCd)) {
    throw new ReportParamError(`営業所CD は 8 桁以内の数値で指定してください: "${params.branchCd}"`);
  }
  const range = dailyReportReadDateRange(params.dateJst);
  const rows = await withDisplayNarrow(
    jar,
    { readDate: range },
    (j, firstPageHtml) => harvestDailyReport(j, range, fetchImpl, timeoutMs, firstPageHtml),
    fetchImpl,
    timeoutMs,
  );
  return rows.filter((r) => r.branchCd === params.branchCd);
}

// ---------------------------------------------------------------------------
// レイアウト (pure)
// ---------------------------------------------------------------------------

/** PDF の 1 行ぶんのセル文字列。 */
export interface DailyReportPdfRow {
  driverName: string;
  vehicleName: string;
  /** 出社 / 退社 / 出庫 / 帰庫 ("MM/DD HH:mm")。 */
  workStart: string;
  workEnd: string;
  opeStart: string;
  opeEnd: string;
  /** 総走行距離 (km)。 */
  totalDist: string;
  work1: string;
  work2: string;
  work3: string;
  work4: string;
  work5: string;
  /** 燃料 自社 / 他社。 */
  fuelOwn: string;
  fuelOther: string;
}

/** "YYYY/MM/DD HH:mm" → "MM/DD HH:mm" (年を落とす)。その形でなければそのまま。 */
export function stripYear(dateTime: string): string {
  const m = dateTime.match(/^\d{4}\/(.+)$/);
  return m ? m[1] : dateTime;
}

/** `DailyReportRow` (F-DES1010) → PDF 行。F-DES1010 に無い列 (作業1〜5・燃料) は
 * 空欄になる。 */
export function toPdfRow(row: DailyReportRow): DailyReportPdfRow {
  return {
    driverName: row.driverName1 ?? "",
    vehicleName: row.vehicleName ?? "",
    workStart: row.workStartDateTime ?? "",
    workEnd: stripYear(row.workEndDateTime),
    opeStart: row.operationStartDateTime ?? "",
    opeEnd: row.operationEndDateTime ?? "",
    totalDist: row.totalRunningDist ?? "",
    work1: "",
    work2: "",
    work3: "",
    work4: "",
    work5: "",
    fuelOwn: "",
    fuelOther: "",
  };
}

export interface PdfColumn {
  key: keyof DailyReportPdfRow;
  header: string;
  /** 列幅 (pt)。合計は CONTENT_WIDTH に一致する (テストで固定)。 */
  width: number;
  align: "left" | "right";
}

/** A4 横 (595.28 x 841.89 pt を回転)。 */
export const PAGE_WIDTH = 841.89;
export const PAGE_HEIGHT = 595.28;
export const PAGE_MARGIN = 24;
export const CONTENT_WIDTH = 793;

export const PDF_COLUMNS: readonly PdfColumn[] = [
  { key: "driverName", header: "乗務員名", width: 88, align: "left" },
  { key: "vehicleName", header: "車輌名", width: 92, align: "left" },
  { key: "workStart", header: "出社", width: 60, align: "left" },
  { key: "workEnd", header: "退社", width: 60, align: "left" },
  { key: "opeStart", header: "出庫", width: 60, align: "left" },
  { key: "opeEnd", header: "帰庫", width: 60, align: "left" },
  { key: "totalDist", header: "走行距離km", width: 56, align: "right" },
  { key: "work1", header: "作業1", width: 45, align: "right" },
  { key: "work2", header: "作業2", width: 45, align: "right" },
  { key: "work3", header: "作業3", width: 45, align: "right" },
  { key: "work4", header: "作業4", width: 45, align: "right" },
  { key: "work5", header: "作業5", width: 45, align: "right" },
  { key: "fuelOwn", header: "燃料(自社)", width: 46, align: "right" },
  { key: "fuelOther", header: "燃料(他社)", width: 46, align: "right" },
];

export const TITLE_FONT_SIZE = 14;
export const META_FONT_SIZE = 8;
export const CELL_FONT_SIZE = 8;
export const HEADER_ROW_HEIGHT = 16;
export const ROW_HEIGHT = 14;
/** タイトル + 生成日時ブロックの高さ (テーブル開始 y はページ上端からこの分下がる)。 */
export const TITLE_BLOCK_HEIGHT = 40;

/** 1 ページに載せられるデータ行数。 */
export function rowsPerPage(): number {
  const tableTop = PAGE_HEIGHT - PAGE_MARGIN - TITLE_BLOCK_HEIGHT;
  return Math.floor((tableTop - PAGE_MARGIN - HEADER_ROW_HEIGHT) / ROW_HEIGHT);
}

/** 行配列をページごとの塊に分ける (改ページ計算)。 */
export function paginate<T>(items: readonly T[], perPage: number): T[][] {
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new ReportParamError(`1 ページあたりの行数が不正です: ${perPage}`);
  }
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) {
    pages.push(items.slice(i, i + perPage));
  }
  return pages;
}

/** ヘッダタイトル「{営業所名} 運転日報 {YYYY/MM/DD}分」。 */
export function buildTitle(branchName: string, dateJst: string): string {
  return `${branchName} 運転日報 ${dateJst}分`;
}

/** 生成日時 (JST) の表示文字列。 */
export function formatGeneratedAtJst(generatedAt: Date): string {
  const jst = new Date(generatedAt.getTime() + 9 * 3600 * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `生成: ${jst.getUTCFullYear()}/${p(jst.getUTCMonth() + 1)}/${p(jst.getUTCDate())} ` +
    `${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())} JST`;
}

/** セル幅に収まるようテキストを詰める (収まらなければ末尾を "…" に置き換える)。
 * `widthOf` は「その文字列を size pt で描いた幅」を返す測定関数 (pdf-lib の
 * `font.widthOfTextAtSize` を渡す。テストは決定的な fake でよい)。 */
export function fitText(
  text: string,
  maxWidth: number,
  size: number,
  widthOf: (text: string, size: number) => number,
): string {
  if (widthOf(text, size) <= maxWidth) return text;
  const ellipsis = "…";
  for (let len = text.length - 1; len > 0; len--) {
    const candidate = `${text.slice(0, len)}${ellipsis}`;
    if (widthOf(candidate, size) <= maxWidth) return candidate;
  }
  return ellipsis;
}

// ---------------------------------------------------------------------------
// PDF 生成 (pdf-lib)
// ---------------------------------------------------------------------------

export interface GenerateDailyReportPdfParams {
  /** 1 行以上であること (0 行のときは呼び出し側が生成をスキップする判断をする)。 */
  rows: readonly DailyReportRow[];
  branchName: string;
  /** 対象日 (JST) "YYYY/MM/DD"。タイトルに入る。 */
  dateJst: string;
  /** 生成日時 (省略時は現在時刻)。 */
  generatedAt?: Date;
}

/** 運転日報 PDF (A4 横、複数ページ対応) を生成して PDF バイト列を返す。 */
export async function generateDailyReportPdf(
  params: GenerateDailyReportPdfParams,
): Promise<Uint8Array> {
  if (params.rows.length === 0) {
    throw new ReportParamError(
      "運転日報 PDF は 1 行以上の運行行が前提です (0 行のときは呼び出し側で生成しない)",
    );
  }
  const generatedAt = params.generatedAt ?? new Date();
  const pdfRows = params.rows.map(toPdfRow);
  const pages = paginate(pdfRows, rowsPerPage());

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(notoSansJpFontData, { subset: true });
  const widthOf = (text: string, size: number): number => font.widthOfTextAtSize(text, size);
  const gray = rgb(0.45, 0.45, 0.45);
  const lineGray = rgb(0.75, 0.75, 0.75);
  const black = rgb(0, 0, 0);

  pages.forEach((pageRows, pageIndex) => {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const top = PAGE_HEIGHT - PAGE_MARGIN;

    page.drawText(buildTitle(params.branchName, params.dateJst), {
      x: PAGE_MARGIN,
      y: top - TITLE_FONT_SIZE,
      size: TITLE_FONT_SIZE,
      font,
      color: black,
    });
    const meta = `${formatGeneratedAtJst(generatedAt)}  ${pageIndex + 1}/${pages.length} ページ`;
    page.drawText(meta, {
      x: PAGE_WIDTH - PAGE_MARGIN - widthOf(meta, META_FONT_SIZE),
      y: top - TITLE_FONT_SIZE,
      size: META_FONT_SIZE,
      font,
      color: gray,
    });

    // ヘッダ行
    const tableTop = top - TITLE_BLOCK_HEIGHT;
    let x = PAGE_MARGIN;
    const headerBaseline = tableTop - HEADER_ROW_HEIGHT + 4;
    for (const col of PDF_COLUMNS) {
      page.drawText(col.header, {
        x: x + 2,
        y: headerBaseline,
        size: CELL_FONT_SIZE,
        font,
        color: black,
      });
      x += col.width;
    }
    page.drawLine({
      start: { x: PAGE_MARGIN, y: tableTop - HEADER_ROW_HEIGHT },
      end: { x: PAGE_MARGIN + CONTENT_WIDTH, y: tableTop - HEADER_ROW_HEIGHT },
      thickness: 0.8,
      color: black,
    });

    // データ行
    pageRows.forEach((row, rowIndex) => {
      const rowBottom = tableTop - HEADER_ROW_HEIGHT - (rowIndex + 1) * ROW_HEIGHT;
      let cellX = PAGE_MARGIN;
      for (const col of PDF_COLUMNS) {
        const text = fitText(row[col.key], col.width - 4, CELL_FONT_SIZE, widthOf);
        const textX = col.align === "right"
          ? cellX + col.width - 2 - widthOf(text, CELL_FONT_SIZE)
          : cellX + 2;
        page.drawText(text, {
          x: textX,
          y: rowBottom + 4,
          size: CELL_FONT_SIZE,
          font,
          color: black,
        });
        cellX += col.width;
      }
      page.drawLine({
        start: { x: PAGE_MARGIN, y: rowBottom },
        end: { x: PAGE_MARGIN + CONTENT_WIDTH, y: rowBottom },
        thickness: 0.4,
        color: lineGray,
      });
    });
  });

  // かんたんnetprint 対策: xref ストリームではなく classic xref テーブルで保存する
  // (壊れた/珍しい構造の PDF は登録受付 200 の後の変換 status で「エラー」になる)。
  return doc.save({ useObjectStreams: false });
}
