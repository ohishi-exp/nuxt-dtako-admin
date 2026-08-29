/**
 * `scrape-error-artifact.ts` が R2 へ残したスクレイプ失敗の**原本を読むだけ**の
 * pure ロジック (Refs #1052)。
 *
 * ## なぜ要るか — 保存側だけあって読む側が 0 件だった
 *
 * `scrape-error-artifact.ts` (#633-22) は失敗時の原本を
 * `{DTAKO_SCRAPE_R2_PREFIX}-errors/{comp_id}/{読取日}/{時刻}.{bin|json}` へ put して
 * いるが、**それを読む route も MCP tool も 1 件も無かった**。`wrangler r2 object` に
 * `list` が無く、key に `Date.now()` が入るので、**一覧できないと get もできない** —
 * つまり「次に再現した時に答えを出せるようにする」という保存側の目的が、読み出し側が
 * 無いために達成できていなかった。
 *
 * ## この module が持たないもの
 *
 * **書き込みは 1 行も無い。** `put` / `delete` を呼ばないのは当然として、R2 に触る
 * コード自体をここには置かない (R2 を触るのは `dtako-scraper-relay-do.ts` の薄い
 * ハンドラだけ)。ここにあるのは key の組み立て / 解釈、一覧の整形、本文の切り詰めと
 * `<title>` 抽出という **cloudflare 非依存の純ロジック**だけで、素の vitest で
 * 100% カバレッジを取る (`vitest.config.ts` の include は allowlist — このファイルも
 * 足してある)。
 *
 * ## 本文をそのまま全部返さない (親指示 2026-08-29)
 *
 * 原本は theearth の HTML で、**セッション ID 等が埋まっている可能性がある**。既定で
 * 返すのは **先頭 [`EVIDENCE_BODY_PREFIX_MAX`] 文字と `<title>`** まで。全文は
 * 「key 指定 + 明示の `full` フラグ」でのみ返す。
 *
 * 切り詰めの粒度に `theearth-client.ts` の [`EVIDENCE_BODY_PREFIX_MAX`] を**そのまま
 * 使い回している**のは、`.json` 側 (`TheearthPageMismatchError` → `body_prefix`) が
 * 既にその粒度で保存済みだから — `.bin` 側だけ別の上限にすると「同じ原本なのに
 * 経路で見える量が違う」が作れてしまう。**片方だけ動かせないように定数を共有する。**
 *
 * ## prefix は env から取る
 *
 * `DTAKO_R2` (`dtako-uploads`) は**本番と staging と preview で同じ bucket** を見て
 * いて、分かれているのは `DTAKO_SCRAPE_R2_PREFIX` だけ (`wrangler.toml`)。ここで
 * prefix を決め打ちすると staging から本番の原本が見える (逆も同じ) ので、**呼び出し
 * 側が env の値を渡す**形にして、この module には既定値を置かない。
 */

import { EVIDENCE_BODY_PREFIX_MAX, type TheearthEvidence } from "./theearth-client";

/** 一覧の既定件数 (新しい順)。**黙って全部返さない** — 呼び出し元 (MCP) の文脈を
 * 溢れさせないため。`total` と `truncated` を必ず併せて返すので「絞った」ことは
 * 応答から分かる。 */
export const SCRAPE_ERROR_LIST_DEFAULT_LIMIT = 50;
/** 一覧件数の上限。これを超える `limit` は**この値に丸めて `limit` として返す**
 * (黙って捨てない)。 */
export const SCRAPE_ERROR_LIST_MAX_LIMIT = 500;
/** `<title>` の上限 (文字)。タイトルは短いのが前提だが、壊れた HTML で
 * `</title>` が遥か後ろに居ると本文をまるごと返してしまうため上限を置く。 */
export const SCRAPE_ERROR_TITLE_MAX = 200;
/** 1 件取得で読む原本の上限 (bytes)。実測の原本は 7〜11KB (#1052) なので 2 桁の余裕が
 * ある。超えるものは「原本ではない何か」— 黙って途中まで返さず、サイズを名指しして
 * 断る (`operation-zip.ts` の `omitted` と同じ流儀で、壊れた本文を返さない)。 */
export const SCRAPE_ERROR_MAX_OBJECT_BYTES = 1_000_000;
/** charset 判定のために先頭から読むバイト数 (`<meta charset>` は head の先頭に居る)。 */
const CHARSET_SNIFF_BYTES = 1024;
/** `Date` が表現できる最大の絶対値 (ms)。これを超える key は時刻として解釈しない。 */
const MAX_TIME_MS = 8.64e15;

/** `{prefix}-errors/` — この口が触れてよい唯一の名前空間。 */
export function scrapeErrorRootPrefix(prefix: string): string {
  return `${prefix}-errors/`;
}

/** `scrapeJobKey` と同じ形 (`YYYY-MM-DD` か `YYYY-MM-DD..YYYY-MM-DD`)。
 * 一覧の絞り込みに使う `job_key` をこの形に限るのは、`../` や空文字を渡して
 * `{prefix}-errors/` の外を list させないため。 */
const JOB_KEY_RE = /^\d{4}-\d{2}-\d{2}(?:\.\.\d{4}-\d{2}-\d{2})?$/;
/** comp_id は数字のみ (`DTAKO_ACCOUNTS` の key と同じ形)。 */
const COMP_ID_RE = /^\d+$/;

export interface ScrapeErrorListRequest {
  compId: string;
  /** 省略時は comp 配下の全読取日。 */
  jobKey: string | null;
  limit: number;
}

/**
 * `POST /cron/dtako/scrape-errors` の body を解釈する。**`comp_id` は呼び出し元
 * (index.ts) が `KINTAI_COMP_ID` で埋めた後の値**が渡ってくる (`operation-zip` と
 * 同じ流儀)。
 */
export function parseScrapeErrorListRequest(body: {
  comp_id?: unknown;
  job_key?: unknown;
  limit?: unknown;
}): ScrapeErrorListRequest | { error: string } {
  const compId = typeof body.comp_id === "string" ? body.comp_id : "";
  if (!COMP_ID_RE.test(compId)) return { error: "comp_id が必要です (数字のみ)" };
  let jobKey: string | null = null;
  if (body.job_key !== undefined && body.job_key !== null) {
    if (typeof body.job_key !== "string" || !JOB_KEY_RE.test(body.job_key)) {
      return { error: "job_key は YYYY-MM-DD か YYYY-MM-DD..YYYY-MM-DD です" };
    }
    jobKey = body.job_key;
  }
  let limit = SCRAPE_ERROR_LIST_DEFAULT_LIMIT;
  if (body.limit !== undefined && body.limit !== null) {
    if (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1) {
      return { error: "limit は 1 以上の整数です" };
    }
    limit = Math.min(body.limit, SCRAPE_ERROR_LIST_MAX_LIMIT);
  }
  return { compId, jobKey, limit };
}

/** list する prefix。`job_key` があればその読取日だけに絞る。 */
export function scrapeErrorListPrefix(
  prefix: string,
  compId: string,
  jobKey: string | null,
): string {
  const base = `${scrapeErrorRootPrefix(prefix)}${compId}/`;
  return jobKey === null ? base : `${base}${jobKey}/`;
}

export interface ParsedScrapeErrorKey {
  compId: string;
  jobKey: string;
  /** key に埋まっている `Date.now()`。 */
  savedAtMs: number;
  ext: string;
}

/**
 * key (`{prefix}-errors/{comp}/{jobKey}/{ms}.{ext}`) を解く。**解けなければ `null`** —
 * 一覧側は `null` を捨てずに「解釈できなかった key」として残す (黙って落とすと
 * 「一覧に出ない = 原本が無い」と読み違える)。
 */
export function parseScrapeErrorKey(key: string, prefix: string): ParsedScrapeErrorKey | null {
  const root = scrapeErrorRootPrefix(prefix);
  if (!key.startsWith(root)) return null;
  const parts = key.slice(root.length).split("/");
  if (parts.length !== 3) return null;
  const [compId, jobKey, file] = parts;
  const matched = /^(\d+)\.([A-Za-z0-9]+)$/.exec(file);
  if (!matched) return null;
  const savedAtMs = Number(matched[1]);
  if (!Number.isSafeInteger(savedAtMs) || Math.abs(savedAtMs) > MAX_TIME_MS) return null;
  return { compId, jobKey, savedAtMs, ext: matched[2] };
}

/** R2 の `list` が返す object のうち、この module が見る分だけ。 */
export interface ScrapeErrorObjectLike {
  key: string;
  size: number;
  /** R2 の `uploaded`。key が解けなかった時の時刻の代わりに使う。 */
  uploaded?: Date | null;
}

export interface ScrapeErrorListItem {
  key: string;
  size: number;
  /** key から復元した会社 (解けなければ null)。 */
  comp_id: string | null;
  /** key から復元した読取日 (解けなければ null)。 */
  job_key: string | null;
  /** 保存時刻 (ISO 8601 UTC)。key が解けなければ R2 の `uploaded`、それも無ければ null。 */
  saved_at: string | null;
  /** 保存時刻の出どころ。`"key"` / `"uploaded"` / `"unknown"` を**明示する** —
   * 「key が読めなかった」と「本当に時刻が無い」を同じ見た目にしない。 */
  saved_at_source: "key" | "uploaded" | "unknown";
  ext: string | null;
}

export interface ScrapeErrorListing {
  items: ScrapeErrorListItem[];
  /** prefix 配下の総件数 (`limit` で切る前)。 */
  total: number;
  /** 実際に適用した件数上限。 */
  limit: number;
  /** `total > limit` なら true (切ったことを黙らない)。 */
  truncated: boolean;
  /** 読取日ごとの件数 (`total` ベース、切る前)。**どの読取日が繰り返し落ちているか**が
   * 調査の入口なので、`limit` で切られても分布だけは全件から出す。 */
  counts_by_job_key: Record<string, number>;
  /** key が解釈できなかった件数 (`total` の内数)。0 でない = key の形が変わった信号。 */
  unparsed: number;
}

/** 並べ替えの鍵だけを持つ行。 */
export interface ScrapeErrorSortRow {
  /** 並べ替えに使う保存時刻 (key 由来 → R2 の `uploaded` の順)。どちらも無ければ null。 */
  sortMs: number | null;
  key: string;
}

/**
 * 一覧の並び順 — **新しい順**。時刻が分からない行は必ず後ろに回し、時刻が同じなら
 * key の降順で安定させる (同じ ms に 2 件保存されることはあり、順序が実行ごとに
 * 揺れると「一覧が変わった = 原本が増えた」に読める)。
 *
 * `buildScrapeErrorListing` から切り出して export してあるのは、`Array.prototype.sort`
 * が比較関数をどの引数順で呼ぶかが実装依存で、**両側の分岐をテストから直接確かめる
 * 手段が他に無い**ため (分岐が「通ったことにされる」のを避ける)。
 */
export function compareScrapeErrorRows(a: ScrapeErrorSortRow, b: ScrapeErrorSortRow): number {
  if (a.sortMs === null && b.sortMs === null) return a.key < b.key ? 1 : -1;
  if (a.sortMs === null) return 1;
  if (b.sortMs === null) return -1;
  if (a.sortMs !== b.sortMs) return b.sortMs - a.sortMs;
  return a.key < b.key ? 1 : -1;
}

function toEpochMs(uploaded: Date | null | undefined): number | null {
  if (!uploaded) return null;
  const ms = uploaded.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * `list` の結果を**新しい順**に並べて `limit` 件で切る。並べ替えの鍵は key に埋まって
 * いる `Date.now()` (無ければ R2 の `uploaded`) で、どちらも無い object は最後に回す。
 *
 * **`total` / `truncated` / `counts_by_job_key` は切る前の全件から出す** — 一覧が
 * 50 件で止まっていても「全部で何件あって、どの読取日に偏っているか」は分かるように
 * する (件数と読取日の分布が今回の調査の目的そのもの)。
 */
export function buildScrapeErrorListing(
  objects: readonly ScrapeErrorObjectLike[],
  prefix: string,
  limit: number,
): ScrapeErrorListing {
  const counts: Record<string, number> = {};
  let unparsed = 0;
  const rows = objects.map((obj) => {
    const parsed = parseScrapeErrorKey(obj.key, prefix);
    const uploadedMs = toEpochMs(obj.uploaded);
    let sortMs: number | null;
    let item: ScrapeErrorListItem;
    if (parsed) {
      counts[parsed.jobKey] = (counts[parsed.jobKey] ?? 0) + 1;
      sortMs = parsed.savedAtMs;
      item = {
        key: obj.key,
        size: obj.size,
        comp_id: parsed.compId,
        job_key: parsed.jobKey,
        saved_at: toIso(parsed.savedAtMs),
        saved_at_source: "key",
        ext: parsed.ext,
      };
    } else {
      unparsed += 1;
      sortMs = uploadedMs;
      item = {
        key: obj.key,
        size: obj.size,
        comp_id: null,
        job_key: null,
        saved_at: uploadedMs === null ? null : toIso(uploadedMs),
        saved_at_source: uploadedMs === null ? "unknown" : "uploaded",
        ext: null,
      };
    }
    return { sortMs, key: obj.key, item };
  });
  rows.sort(compareScrapeErrorRows);
  return {
    items: rows.slice(0, limit).map((row) => row.item),
    total: rows.length,
    limit,
    truncated: rows.length > limit,
    counts_by_job_key: counts,
    unparsed,
  };
}

export interface ScrapeErrorObjectRequest {
  key: string;
  full: boolean;
}

/**
 * `POST /cron/dtako/scrape-error-object` の body を解釈する。
 *
 * **`key` は `{prefix}-errors/` 配下しか受け付けない。** `DTAKO_R2` は ETC 明細 CSV /
 * 拘束サマリ / 賃金マスタ / NET780 生データと**同じ bucket** なので、ここを開けると
 * 「スクレイプ失敗の原本を読む口」が bucket 全体の read 口になる。prefix は env から
 * 来た値をそのまま前方一致で当てる (決め打ちしない)。
 */
export function parseScrapeErrorObjectRequest(
  body: { key?: unknown; full?: unknown },
  prefix: string,
): ScrapeErrorObjectRequest | { error: string } {
  const key = typeof body.key === "string" ? body.key : "";
  if (!key) return { error: "key が必要です" };
  const root = scrapeErrorRootPrefix(prefix);
  if (!key.startsWith(root)) return { error: `key は ${root} 配下だけです` };
  return { key, full: body.full === true };
}

/** contentType (`text/html; charset=Shift_JIS`) から charset を拾う。 */
function charsetFromContentType(contentType: string): string | null {
  const matched = /charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/.exec(contentType);
  return matched ? matched[1] : null;
}

/** HTML の `<meta charset=...>` / `<meta http-equiv ... content="...charset=...">` を
 * 先頭 [`CHARSET_SNIFF_BYTES`] バイトから拾う。charset 宣言は ASCII なので、
 * utf-8 で仮に解いても宣言だけは読める。 */
function charsetFromMeta(bytes: Uint8Array): string | null {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, CHARSET_SNIFF_BYTES));
  const matched = /<meta[^>]*charset\s*=\s*"?'?([A-Za-z0-9_.:-]+)/i.exec(head);
  return matched ? matched[1] : null;
}

export interface DecodedScrapeErrorBody {
  text: string;
  /** 実際に使った charset。**要求した charset が使えず utf-8 に落ちた時も
   * その事実がここに出る** (「読めた」と「読めたつもり」を分ける)。 */
  charset: string;
  /** contentType / meta が指した charset が使えず utf-8 に落ちたなら true。 */
  charsetFallback: boolean;
}

/**
 * 原本のバイト列を文字列に解く。theearth のページは Shift_JIS のことがあるので
 * (etc-meisai と同じ)、**contentType → `<meta charset>` → utf-8** の順で charset を
 * 決める。ランタイムが知らない charset を渡すと `TextDecoder` は throw するので、
 * その時は utf-8 に落として `charsetFallback: true` を立てる。
 */
export function decodeScrapeErrorBody(
  bytes: Uint8Array,
  contentType: string,
): DecodedScrapeErrorBody {
  const declared = charsetFromContentType(contentType) ?? charsetFromMeta(bytes);
  if (declared !== null) {
    try {
      const decoder = new TextDecoder(declared);
      return { text: decoder.decode(bytes), charset: decoder.encoding, charsetFallback: false };
    } catch {
      return {
        text: new TextDecoder("utf-8").decode(bytes),
        charset: "utf-8",
        charsetFallback: true,
      };
    }
  }
  return { text: new TextDecoder("utf-8").decode(bytes), charset: "utf-8", charsetFallback: false };
}

/**
 * `<title>` を抜く (無ければ `null`)。**本文全体から探す** — 4KB で切った後から探すと
 * 「title が 4KB より後ろに在っただけ」を「title が無い」と報告してしまう。タイトル
 * 自体は短いので、[`SCRAPE_ERROR_TITLE_MAX`] で切って返す。
 */
export function extractHtmlTitle(text: string): string | null {
  const matched = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  if (!matched) return null;
  const title = matched[1].replace(/\s+/g, " ").trim();
  return title === "" ? null : title.slice(0, SCRAPE_ERROR_TITLE_MAX);
}

/** `.json` 原本 (`PageMismatchArtifactBody`) のうち、**生ページを含まない**部分だけ。
 * `body_prefix` (theearth の生 HTML) は**わざと入れない** — 生本文は `.bin` と同じ
 * 切り詰め / `full` フラグの規則に従わせる。 */
export interface ScrapeErrorJsonMeta {
  kind: string;
  message: string;
  comp_id: string;
  job_key: string;
  evidence: TheearthEvidence;
}

/**
 * `.json` 原本から構造化されたメタだけを取り出す (壊れていれば `null`)。
 * 一覧から 1 件開いた時に「どのページ違いで落ちたか」が本文を読まずに分かる。
 */
export function parseScrapeErrorJsonMeta(text: string): ScrapeErrorJsonMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.kind !== "string" || typeof record.message !== "string") return null;
  return {
    kind: record.kind,
    message: record.message,
    comp_id: typeof record.comp_id === "string" ? record.comp_id : "",
    job_key: typeof record.job_key === "string" ? record.job_key : "",
    evidence: (record.evidence ?? null) as TheearthEvidence,
  };
}

export interface ScrapeErrorObjectPayloadInput {
  key: string;
  prefix: string;
  bytes: Uint8Array;
  contentType: string | null | undefined;
  /** true なら本文を切らずに全部返す (キー指定 + 明示のフラグでのみ)。 */
  full: boolean;
  uploaded?: Date | null;
}

export interface ScrapeErrorObjectPayload {
  key: string;
  /** 原本の生バイト数 (切る前)。 */
  bytes: number;
  content_type: string | null;
  comp_id: string | null;
  job_key: string | null;
  saved_at: string | null;
  saved_at_source: "key" | "uploaded" | "unknown";
  ext: string | null;
  charset: string;
  charset_fallback: boolean;
  /** `<title>` (HTML でなければ null)。**本文全体から探している。** */
  title: string | null;
  /** 本文。既定では先頭 [`EVIDENCE_BODY_PREFIX_MAX`] 文字 (`.json` 側の
   * `body_prefix` と同じ粒度)。`full: true` なら全文。 */
  body_prefix: string;
  /** 切り詰めたなら true。 */
  body_truncated: boolean;
  /** 本文全体の文字数 (切る前)。`body_prefix.length` と比べれば何を見ていないか分かる。 */
  body_chars: number;
  /** `full: true` で呼ばれたか (返っているのが全文かどうかを応答自身に言わせる)。 */
  full: boolean;
  /** `.json` 原本の構造化メタ (生ページは含まない)。それ以外は null。 */
  json_meta: ScrapeErrorJsonMeta | null;
}

/**
 * 原本 1 件を応答の形にする。**既定では本文を [`EVIDENCE_BODY_PREFIX_MAX`] 文字で
 * 切る** — 原本は theearth の HTML で、セッション ID 等が埋まっている可能性がある
 * ため (親指示 2026-08-29)。切ったことは `body_truncated` / `body_chars` で明示する
 * (黙って切らない)。
 */
export function buildScrapeErrorObjectPayload(
  input: ScrapeErrorObjectPayloadInput,
): ScrapeErrorObjectPayload {
  const contentType = input.contentType ?? null;
  const decoded = decodeScrapeErrorBody(input.bytes, contentType ?? "");
  const parsedKey = parseScrapeErrorKey(input.key, input.prefix);
  const uploadedMs = toEpochMs(input.uploaded);
  const body = input.full ? decoded.text : decoded.text.slice(0, EVIDENCE_BODY_PREFIX_MAX);
  return {
    key: input.key,
    bytes: input.bytes.byteLength,
    content_type: contentType,
    comp_id: parsedKey ? parsedKey.compId : null,
    job_key: parsedKey ? parsedKey.jobKey : null,
    saved_at: parsedKey
      ? toIso(parsedKey.savedAtMs)
      : uploadedMs === null
        ? null
        : toIso(uploadedMs),
    saved_at_source: parsedKey ? "key" : uploadedMs === null ? "unknown" : "uploaded",
    ext: parsedKey ? parsedKey.ext : null,
    charset: decoded.charset,
    charset_fallback: decoded.charsetFallback,
    title: extractHtmlTitle(decoded.text),
    body_prefix: body,
    body_truncated: body.length < decoded.text.length,
    body_chars: decoded.text.length,
    full: input.full,
    json_meta: parseScrapeErrorJsonMeta(decoded.text),
  };
}
