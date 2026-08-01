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
 */

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

/** service binding fetch 用の絶対 URL base (`alc-internal-upload.ts` と同じ規約)。 */
const INTERNAL_PROXY_BASE = "https://auth-worker.internal";

export type FetchLike = typeof fetch;

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
 * alc の `GET /api/scraper/history` を `alc-internal-proxy` 越しに引く。
 *
 * **配布そのものは結果を持たない** (`/cron/dtako` は 202 を返して非同期に走る)
 * ので、`status` / `message` はここでしか読めない。`status` が `split_failed` の
 * 行は CSV 分割が落ちた回で、その読取日の運行は `has_kudgivt = FALSE` のまま
 * 残っている可能性がある。
 */
export async function fetchScrapeHistory(
  input: { sharedSecret: string; tenantId: string; limit: number },
  fetchImpl: FetchLike,
): Promise<unknown> {
  const res = await fetchImpl(
    `${INTERNAL_PROXY_BASE}/alc-internal-proxy/api/scraper/history?limit=${input.limit}`,
    {
      method: "GET",
      headers: {
        "X-Alc-Proxy-Secret": input.sharedSecret,
        "X-Tenant-ID": input.tenantId,
      },
    },
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`alc scraper history failed (${res.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`alc scraper history parse failed: ${text.slice(0, 300)}`);
  }
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
