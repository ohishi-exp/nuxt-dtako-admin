/**
 * 読取日を名指しでスクレイプし直す (Refs ohishi-exp/rust-ichibanboshi#205 の 42)。
 *
 * デジタコのイベント分類 (休憩⇄運転) を後から編集すると、alc の R2 に残っている
 * CSV が古いままになり、拘束・休憩の値がオンプレとずれる。**該当の読取日を
 * 取り直せば直る**ことが実測で確定している (乗務員 1107 / 2026-06、3 回とも同じ形)。
 *
 * 取り直す読取日は rust-ichibanboshi の `GET /api/kintai/reading-dates` が返す。
 * ここはその日付を受け取って `POST /cron/dtako` へ配るだけ。
 *
 * ## ★ これは本番にデータを書く経路。安全側に倒してある
 *
 * 取り込みは `has_kudgivt` を一旦 `DEFAULT FALSE` に戻すので、**失敗すると運行が
 * 読み取り側から消える** (2026-07-31 に実際に 1 件消えて手で復旧した)。だから:
 *
 * - **日付は必須。** 「月ぶん全部」「省略で今日」のような既定値を作らない
 * - **範囲に広げない。** 連続していない日を範囲で括ると、要らない日まで
 *   `has_kudgivt = FALSE` に落ちる。**1 日 1 回**で配る (日次 cron と同じ形、
 *   `cron.ts` の `start_date: date, end_date: date`)
 * - **上限を超えたら黙って切らず、切った日付を返す** ([`MAX_SCRAPE_DATES`])
 * - **`accepted` は「受理された」であって「終わった」ではない。** `/cron/dtako` は
 *   202 を返して非同期に走る。結果は [`fetchScrapeHistory`] で別に確認する
 *
 * ## 手順 (MCP tool から回すとき)
 *
 * ```text
 * 1. rust-ichibanboshi の GET /api/kintai/reading-dates?month=YYYY-MM
 *      → by_reading_date のキー = 取り直す読取日。**勤務日ではない**
 *        (長距離は運行終了の数日後に読取日が付く。実測 +11 日)
 *
 * 2. run_dtako_scrape  { dates: ["YYYY-MM-DD", ...] }        ← 書き込み
 *      → 202。accepted_dates / failed_dates / truncated_dates / invalid_dates
 *      **上限 10 日。11 日以上渡すと truncated_dates に返るので、そのまま次の呼びに渡す**
 *      **この応答は「受理した」まで。まだ何も終わっていない**
 *
 * 3. get_dtako_scrape_status { date_from, date_to }           ← 読むだけ
 *      → split_failed が 0 か / unsplit_total が 0 か を見る
 *      **split_failed は必要条件でしかない** (alc の update_has_kudgivt が
 *      当たらなくても Ok(0) を返す)。**unsplit_total が 0 で初めて取り込み完了**
 *      **unsplit_total が null は「残っていない」ではなく「見ていない」**
 *      (date_from / date_to を渡していないか、引けなかった = unsplit_error に出る)
 *
 * 4. run_kintai_recalc { month, apply: true } で畳み直して値を測る
 * ```
 */

import {
  unwrapAlcTenantData,
  type AlcTenantDataForwarder,
} from "./alc-tenant-rpc";

/** 1 回で配れる読取日の上限。
 *
 * `/cron/dtako` は comp_id 単位 DO の `scrapeQueue` で**直列**に走る
 * (`dtako-scraper-relay-do.ts`)。日次 cron が 1 日 1 件しか投げていないのは
 * scheduled event の実行時間上限のためで (`cron.ts` の docs)、ここも同じ制約を
 * 受ける。**10 は未実測の安全側の値** — 超えたぶんは切って呼び出し側に返すので、
 * 足りなければ 2 回に分ければよい。 */
export const MAX_SCRAPE_DATES = 10;

/** 履歴を引く既定件数。1 回の配布 (最大 [`MAX_SCRAPE_DATES`] 件) × 数社ぶんを
 * 見渡せる程度。 */
export const DEFAULT_HISTORY_LIMIT = 50;


/** `YYYY-MM-DD` か。**実在する日付かまでは見る** (02-30 を弾く)。 */
export function isValidDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface ScrapePlan {
  /** これから配る日付 (昇順・重複無し)。 */
  dates: string[];
  /** 上限で**切った**日付 (昇順)。呼び出し側が 2 回目に回すためのもの。 */
  truncated: string[];
  /** `YYYY-MM-DD` として読めなかった入力 (原文のまま)。 */
  invalid: string[];
}

/**
 * 受け取った日付を配る計画に畳む。**黙って切らない** — 切ったものは
 * [`ScrapePlan.truncated`]、読めなかったものは [`ScrapePlan.invalid`] に残す。
 */
export function planScrapeDispatch(input: unknown[]): ScrapePlan {
  const invalid: string[] = [];
  const valid = new Set<string>();
  for (const raw of input) {
    if (isValidDate(raw)) valid.add(raw);
    else invalid.push(typeof raw === "string" ? raw : JSON.stringify(raw));
  }
  const sorted = [...valid].sort();
  return {
    dates: sorted.slice(0, MAX_SCRAPE_DATES),
    truncated: sorted.slice(MAX_SCRAPE_DATES),
    invalid,
  };
}

/** 1 日ぶんの配布結果。**`accepted` は受理であって完了ではない。** */
export interface DispatchedDate {
  date: string;
  accepted: boolean;
  status: number;
  detail: string;
}

export type DoCall = (
  doKey: string,
  path: string,
  body: unknown,
) => Promise<{ ok: boolean; status: number; text: string }>;

/**
 * 計画した日付を `/cron/dtako` へ 1 日ずつ配る。
 *
 * **日付ごとに独立**にする — 1 日が落ちても他は走る。同一 comp_id の直列化は
 * DO の queue が担保するので、ここで待つ必要はない (`cron.ts` と同じ判断)。
 */
export async function dispatchScrapeDates(
  compId: string,
  dates: string[],
  callDo: DoCall,
): Promise<DispatchedDate[]> {
  return Promise.all(
    dates.map(async (date): Promise<DispatchedDate> => {
      try {
        const res = await callDo(`scraper-comp-${compId}`, "/cron/dtako", {
          comp_id: compId,
          start_date: date,
          end_date: date,
        });
        return {
          date,
          accepted: res.ok,
          status: res.status,
          detail: res.text.slice(0, 200),
        };
      } catch (err) {
        return {
          date,
          accepted: false,
          status: 0,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/**
 * alc の `GET /api/scraper/history` を **`device-data-proxy` 越し**に引く。
 *
 * **配布そのものは結果を持たない** (`/cron/dtako` は 202 を返して非同期に走る)
 * ので、`status` / `message` はここでしか読めない。`status` が `split_failed` の
 * 行は CSV 分割が落ちた回で、その読取日の運行は `has_kudgivt = FALSE` のまま
 * 残っている可能性がある。
 *
 * ## ★ 経路の変遷 (Refs #933 → #950)
 *
 * `/api/scraper/history` は rust 側で `tenant_router()` = `require_tenant_header` の
 * data 経路。`alc-internal-proxy` は data 経路を**意図的に allowlist から外している**
 * (shared secret だけで `X-Tenant-ID` を詐称できると #434 の再現になるため) ので、
 * **かつては GET / POST とも 403** で上流へ forward もされなかった (#933)。
 * **テストが注入なので、緑のまま口だけが死んでいた。**
 *
 * いまは auth-worker の **RPC entrypoint** 越し (#950)。**名前付きメソッドは
 * service binding からしか呼べない**ので、device credential も pairing も要らない。
 * `tenantId` は relay が `DTAKO_ACCOUNTS` で既に持っている値。
 */
export async function fetchScrapeHistory(
  input: { tenantId: string; limit: number },
  rpc: AlcTenantDataForwarder,
): Promise<unknown> {
  const text = unwrapAlcTenantData(
    "alc scraper history",
    await rpc.forwardAlcTenantData({
      tenantId: input.tenantId,
      path: "/api/scraper/history",
      method: "GET",
      search: `?limit=${input.limit}`,
    }),
  );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`alc scraper history parse failed: ${text.slice(0, 300)}`);
  }
}

/**
 * 履歴を 1 行書く (`POST /api/scraper/history`)。**無人実行を履歴に載せるための口**
 * (Refs #931)。行の組み立ては `scrape-history-record.ts` の責務。
 *
 * ## ★ `tenantId` を正しく選ぶ責任は**呼び出し側**にある
 *
 * この関数は渡された `tenantId` へ書くだけで、**それが読み手の見る tenant かを
 * 検証しない。**以前ここには「読み (上の GET) と**同じ tenant** を通る」と書いて
 * あったが、**cron 経路では同じ tenant を通っていなかった** — スクレイプ対象の
 * comp ごとの tenant へ書いており、`KINTAI_COMP_ID` 以外の会社の行は
 * **どの読み手からも見えなかった** (2026-08-26 の実測。`saved` は出ているのに
 * 履歴に現れない)。**この doc の嘘が欠陥そのものだった。**
 *
 * ⇒ 呼び出し側は **読み手と同じ tenant を渡す責任**を持つ。cron 経路は
 * `resolveHistoryTenantId` がそれを 1 か所で決める。
 *
 * alc は成功時 `204 No Content` を返すので**本文は読まない**
 * (`unwrapAlcTenantData` が 2xx を通すだけ)。
 */
export async function postScrapeHistory(
  entry: unknown,
  tenantId: string,
  rpc: AlcTenantDataForwarder,
): Promise<void> {
  unwrapAlcTenantData(
    "alc scraper history save",
    await rpc.forwardAlcTenantData({
      tenantId,
      path: "/api/scraper/history",
      method: "POST",
      body: JSON.stringify(entry),
      contentType: "application/json",
    }),
  );
}

/**
 * 履歴から `split_failed` の行を数える。
 *
 * **`split_failed === 0` は「分割済み」の十分条件ではない** — alc 側の
 * `update_has_kudgivt` が当たらなくても `Ok(0)` を返すため
 * (`alc-internal-upload.ts` の docs / `dtako_upload.rs:1040-1046`)。
 * **必要条件でしかない**ことを呼び出し側に伝えるための数字。
 */
export function countSplitFailed(history: unknown): number {
  if (!Array.isArray(history)) return 0;
  return history.filter(
    (r) => typeof r === "object" && r !== null && (r as { status?: unknown }).status === "split_failed",
  ).length;
}

/**
 * alc の `GET /api/dtako/events/etags` から **`unsplit` / `unsplit_total` だけ**
 * を引く (Refs ohishi-exp/rust-ichibanboshi#205 の 42)。
 *
 * **`split_failed` では足りないから居る。** alc の `update_has_kudgivt` が当たらなくても
 * `Ok(0)` を返すので、`split_failed === 0` でも `has_kudgivt = FALSE` の運行が残りうる
 * (`alc-internal-upload.ts` の docs)。**残っているかを直接数えるのがこちら。**
 *
 * **`items` は返さない。** 月ぶんで 1,100 件超あり (実測 2026-06 = 1,130)、
 * ここでは 1 つも使わない。`unsplit` は alc 側で 500 件に切られるが `unsplit_total` は
 * 実数なので、切られても「残っているか」は答えが出る。
 *
 * 期間の上限は alc 側で 40 日 (`MAX_RANGE_DAYS_ETAGS`)。超えたら上流の 4xx が
 * そのまま本文つきで上がる (握り潰さない)。
 */
export async function fetchUnsplit(
  input: { tenantId: string; dateFrom: string; dateTo: string },
  rpc: AlcTenantDataForwarder,
): Promise<{ unsplit: unknown[]; unsplit_total: number }> {
  const text = unwrapAlcTenantData(
    "alc etags",
    await rpc.forwardAlcTenantData({
      tenantId: input.tenantId,
      path: "/api/dtako/events/etags",
      method: "GET",
      search: `?date_from=${input.dateFrom}&date_to=${input.dateTo}`,
    }),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`alc etags parse failed: ${text.slice(0, 300)}`);
  }
  const obj = (parsed ?? {}) as { unsplit?: unknown; unsplit_total?: unknown };
  return {
    unsplit: Array.isArray(obj.unsplit) ? obj.unsplit : [],
    unsplit_total:
      typeof obj.unsplit_total === "number" && Number.isFinite(obj.unsplit_total)
        ? obj.unsplit_total
        : 0,
  };
}

/** 日付の並びから `[最小, 最大]` を返す。空なら `null`。 */
export function dateRangeOf(dates: string[]): { from: string; to: string } | null {
  const valid = dates.filter(isValidDate).sort();
  const first = valid[0];
  const last = valid[valid.length - 1];
  if (first === undefined || last === undefined) return null;
  return { from: first, to: last };
}

/**
 * `/cron/dtako` の進捗を DO storage に記録する時のキー (Refs #205-43)。
 *
 * `dispatchScrapeDates` は 1 日 1 回で配る規約 (`start_date === end_date`) だが、
 * `/cron/dtako` 自体は範囲を受け付ける契約なので、範囲で呼ばれた場合も潰さずに
 * 区別できるキーを返す。
 */
export function scrapeJobKey(startDate: string, endDate: string): string {
  return startDate === endDate ? startDate : `${startDate}..${endDate}`;
}
