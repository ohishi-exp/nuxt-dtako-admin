/**
 * 打刻 (タイムカード) をオンプレから GCP へ運ぶ (Refs ohishi-exp/rust-ichibanboshi#205 の 04b)。
 *
 * オンプレの rust-ichibanboshi は社内 MariaDB から打刻を読めるが、GCP 側の同じ
 * バイナリは読めない。**畳むのは GCP 側**にあるので、打刻を運ぶ必要がある。
 *
 * ## 窓ぶんをまるごと、1 往復ずつ
 *
 *   1. オンプレ `GET  /api/kintai/timecard/events?months=`  窓ぶんを全乗務員まとめて
 *   2. GCP     `POST /api/kintai/timecard/window`          まるごと渡す
 *
 * 以前は乗務員ごとに署名を引いてから差分を運んでいた。2026-07-31 の実測 (94 名) で
 * **署名引きだけが 33.6 秒 / 全体の 94%** を占め、一方その月の全打刻の転送は
 * **1.3 秒**で済んでいた — 費用は往復の回数であって転送量ではない。しかも apply 時は
 * 反映も 1 batch ずつで、GCP へ 2N 往復していた (rust-ichibanboshi#228 で畳んだ)。
 *
 * ## 窓を毎回まるごと送り直す
 *
 * **始業 / 終業 は後から直る。** 積み増しだけにすると、直された打刻が永久に
 * 反映されない。よって窓 (既定は当月 + 前月) を毎回送る。書き込みが無駄にならない
 * のは受け側の日単位署名が守るから — **変わった日しか書かない**。
 *
 * 突き合わせも受け側 (`kintai_push::plan_window`)。ここで署名を計算すると
 * `day_signature` が 2 実装になり、式が少しでもずれると「中身は同じなのに毎回全日が
 * 違う」と判定して静かに全件を書き直し続ける (#205 の決定 3 と同じ理由)。
 *
 * ## tenant は KV から引く
 *
 * `DTAKO_ACCOUNTS` (KV `dtako-relay-config` の `dtako_accounts`) の
 * `comp_id → tenant_id`。**呼び出し元に名乗らせない** — `alc-internal-upload.ts` が
 * `alc-proxy` (browser JWT の tenant 逆引き) を不採用にしたのと同じで、この経路は
 * 無人で走り、comp_id は複数 tenant にまたがりうる。
 *
 * ## 経路と資格情報
 *
 * - オンプレ: CF Tunnel の手前で CF Access Service Token
 * - GCP: auth-worker の `/ichibanboshi-proxy/*` が OIDC を mint する
 *   (`--no-allow-unauthenticated` の Cloud Run)。SA key は auth-worker 1 箇所に集約
 *   されているので relay は持たない。relay が出すのは `X-Alc-Proxy-Secret` と
 *   `X-Tenant-ID` の 2 つだけ
 *
 * ## 冪等なので呼び直しは安全
 *
 * 読むだけの 1 と、変わった日しか書かない 2 の組なので、途中で落ちても
 * やり直せば同じ状態に収束する。
 */

/** service binding の最小形 (`cloudflare:workers` の型に依存しないための構造的型)。 */
export interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** auth-worker 側の route prefix (`handlers/ichibanboshi-proxy.ts`)。 */
const PROXY_PREFIX = "/ichibanboshi-proxy";

/** service binding fetch 用の絶対 URL base。host は binding が無視するが path は必要。 */
const PROXY_BASE = "https://auth-worker.internal";

const EVENTS_PATH = "/api/kintai/timecard/events";
const WINDOW_PATH = "/api/kintai/timecard/window";
/** 全量再計算の口 (rust-ichibanboshi `src/routes/kintai_recalc.rs`)。 */
const RECALC_PATH = "/api/kintai/recalc";
/** 畳んだ結果の読み出し口 (rust-ichibanboshi `src/routes/kintai_day_summaries.rs`)。 */
const DAY_SUMMARIES_PATH = "/api/kintai/day-summaries";

/** 窓の既定の月数 — **当月 + 前月**。始業 / 終業 の後追い修正を拾う幅。 */
export const DEFAULT_MONTH_COUNT = 2;

/** 窓の上限。広げるほど転送が増えるので、遡りたいときだけ明示させる。 */
export const MAX_MONTH_COUNT = 12;

export class KintaiRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KintaiRelayError";
  }
}

/**
 * 各レグの所要時間 (ms)。**見積もりで上限を決めないための実測値。**
 *
 * かつて `max_drivers` の既定は「1 乗務員あたり 0.2 秒」という見積もりで置かれて
 * いて、本番では 10 人で Cloudflare の 524 (100 秒) を超えていた
 * (rust-ichibanboshi#225)。どのレグが遅いかを応答に出しておけば、次に遅くなった
 * ときにコードを読み直さずに切り分けられる。
 *
 * オンプレ自己申告 (`onprem*Ms`) との差が **Tunnel の往復ぶん**。DB が遅いのか
 * 経路が遅いのかを、この 2 つの差で分ける。
 */
export interface KintaiWindowTimings {
  totalMs: number;
  /** 1. オンプレ: 窓ぶんの読み出し。 */
  eventsMs: number;
  /** 2. GCP: 反映 (dry-run でも突き合わせは走る)。 */
  applyMs: number;
  /** 相手が自己申告した所要時間。古い版が相手だと `null`。 */
  onpremEventsMs: number | null;
  gcpApplyMs: number | null;
}

/** 1 回ぶんの結果。**窓は 1 回で運びきる** — 続きの位置は無い。 */
export interface KintaiWindowReport {
  /** 実際に運んだ月。 */
  months: string[];
  /** 送り主が見つけた乗務員数。 */
  drivers: number;
  /** 運んだ生行数。 */
  events: number;
  /** 書き換えた乗務員数。**大半は 0 のはず** (打刻はほとんど戻らない)。 */
  driversWritten: number;
  daysWritten: number;
  daysDeleted: number;
  /** 受け側が「窓の外 / 名乗っていない乗務員」として弾いた行数。**0 でないと壊れている**。 */
  misplaced: number;
  /** DDL の CHECK に無かった `state` の実値。 */
  unknownStates: string[];
  /** **`true` なら件数は計画であって実績ではない** (1 行も書いていない)。 */
  dryRun: boolean;
  timings: KintaiWindowTimings;
}

export interface KintaiWindowInput {
  /** 窓の**最後の**月 (`YYYY-MM`)。省略時は JST の当月。 */
  month?: string;
  /** 窓の月数 (既定 [`DEFAULT_MONTH_COUNT`])。 */
  monthCount?: number;
  /** **`false` なら受け側に 1 行も書かせない** (既定)。件数だけ返る。 */
  apply?: boolean;
  /** 当月の判定に使う時刻 (ms)。**テスト用** — 省略時は `Date.now()`。 */
  now?: number;
}

export interface KintaiRelayDeps {
  /** オンプレ (CF Tunnel 越し) を叩く。path は `/api/...`、CF Access は実装側で付ける。 */
  onprem(path: string, init?: RequestInit): Promise<Response>;
  /** auth-worker 経由で GCP を叩く。`X-Tenant-ID` は実装側で付ける。 */
  gcp(path: string, init?: RequestInit): Promise<Response>;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

/** 相手の応答を読む。**失敗は本文の先頭を添えて返す** — どちら側が落ちたかログで分かるように。 */
async function readJson<T>(res: Response, who: string): Promise<T> {
  const body = await res.text();
  if (!res.ok) {
    const excerpt = body.slice(0, 200);
    throw new KintaiRelayError(`${who}: status ${res.status}: ${excerpt}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new KintaiRelayError(`${who}: parse failed: ${body.slice(0, 200)}`);
  }
}

/** JST の当月 (`YYYY-MM`)。**UTC のまま切ると月初/月末が 1 日ずれる。** */
export function jstMonth(now: number): string {
  const d = new Date(now + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `last` を最後尾とする `count` か月ぶんを昇順で。年をまたいでも `Date.UTC` が畳む。 */
export function windowMonths(last: string, count: number): string[] {
  const [y, m] = last.split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y!, m! - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

/**
 * 窓ぶんを 1 回で運ぶ。**続きは無い** — 乗務員でも日でも刻まない。
 *
 * `apply` を付けない限り受け側は 1 行も書かない (`dry_run` を立てて渡す)。
 * 冪等なので、途中で落ちてもやり直せば同じ状態に収束する。
 */
export async function relayKintaiWindow(
  deps: KintaiRelayDeps,
  input: KintaiWindowInput,
): Promise<KintaiWindowReport> {
  const last = input.month ?? jstMonth(input.now ?? Date.now());
  if (!MONTH_RE.test(last)) {
    throw new KintaiRelayError(`month は YYYY-MM で指定してください: ${last}`);
  }
  const count = input.monthCount ?? DEFAULT_MONTH_COUNT;
  if (!Number.isInteger(count) || count < 1 || count > MAX_MONTH_COUNT) {
    throw new KintaiRelayError(`month_count は 1〜${MAX_MONTH_COUNT} です: ${count}`);
  }
  const months = windowMonths(last, count);
  const apply = input.apply === true;

  // Workers の `Date.now()` は I/O をまたぐと進む。各レグは fetch を含むので測れる
  const startedAt = Date.now();
  const reported = (v: unknown) => (typeof v === "number" ? v : null);

  // ── 1. オンプレ: 窓ぶんを全乗務員まとめて ─────────────────────────────────
  const q = new URLSearchParams({ months: months.join(",") });
  const at1 = Date.now();
  const got = await readJson<{
    drivers?: number[];
    events?: unknown[];
    elapsed_ms?: unknown;
  }>(await deps.onprem(`${EVENTS_PATH}?${q}`), "onprem events");
  const eventsMs = Date.now() - at1;
  const drivers = Array.isArray(got.drivers) ? got.drivers : [];
  const events = Array.isArray(got.events) ? got.events : [];

  // ── 2. GCP: まるごと渡す ──────────────────────────────────────────────────
  // **突き合わせは向こう。** ここで署名を計算しない (2 実装にしない)
  const at2 = Date.now();
  const applied = await readJson<{
    drivers_written?: number;
    days_written?: number;
    days_deleted?: number;
    misplaced?: number;
    unknown_states?: string[];
    dry_run?: unknown;
    elapsed_ms?: unknown;
  }>(
    await deps.gcp(WINDOW_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ months, drivers, events, dry_run: !apply }),
    }),
    "gcp timecard window",
  );
  const applyMs = Date.now() - at2;

  return {
    months,
    drivers: drivers.length,
    events: events.length,
    driversWritten: applied.drivers_written ?? 0,
    daysWritten: applied.days_written ?? 0,
    daysDeleted: applied.days_deleted ?? 0,
    misplaced: applied.misplaced ?? 0,
    unknownStates: [...(applied.unknown_states ?? [])].sort(),
    // **受け側の自己申告を正とする。** こちらの意図と食い違ったら向こうが正しい
    dryRun: applied.dry_run === true,
    timings: {
      totalMs: Date.now() - startedAt,
      eventsMs,
      applyMs,
      onpremEventsMs: reported(got.elapsed_ms),
      gcpApplyMs: reported(applied.elapsed_ms),
    },
  };
}

/**
 * `dtako_accounts` から `comp_id` の tenant を引く。**`user_pass` には触れない。**
 *
 * **空の `compId` は引かない。** `comp_id` を持たない行 (KV の手編集で起こりうる) を
 * `String(undefined ?? "")` で拾ってしまい、名乗っていない呼び出しが**たまたま先頭の
 * 壊れた行の tenant** で通る。書き先が静かにずれる形なので、両側で塞ぐ。
 */
export function tenantForCompId(accounts: unknown, compId: string): string | null {
  if (!Array.isArray(accounts) || !compId) return null;
  for (const a of accounts) {
    if (typeof a !== "object" || a === null) continue;
    const e = a as { comp_id?: unknown; tenant_id?: unknown };
    if (typeof e.comp_id !== "string" && typeof e.comp_id !== "number") continue;
    if (String(e.comp_id) !== compId) continue;
    const tenant = typeof e.tenant_id === "string" ? e.tenant_id.trim() : "";
    return tenant || null;
  }
  return null;
}

/** [`relayKintaiWindow`] に渡す実体を組む。 */
export function buildDeps(opts: {
  ichibanOrigin: string;
  cfAccessClientId: string;
  cfAccessClientSecret: string;
  authWorker: FetcherLike;
  proxySecret: string;
  tenantId: string;
}): KintaiRelayDeps {
  const base = opts.ichibanOrigin.replace(/\/$/, "");
  return {
    onprem(path, init) {
      return fetch(`${base}${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          "CF-Access-Client-Id": opts.cfAccessClientId,
          "CF-Access-Client-Secret": opts.cfAccessClientSecret,
          Accept: "application/json",
        },
      });
    },
    gcp(path, init) {
      return opts.authWorker.fetch(`${PROXY_BASE}${PROXY_PREFIX}${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          "X-Alc-Proxy-Secret": opts.proxySecret,
          "X-Tenant-ID": opts.tenantId,
          Accept: "application/json",
        },
      });
    },
  };
}

export interface KintaiRecalcInput {
  /** 対象月 (`YYYY-MM`)。省略時は JST の当月。 */
  month?: string;
  /** 続きから回す位置。前回の応答の `next_after_driver_cd` をそのまま渡す。 */
  afterDriverCd?: number;
  /**
   * 1 ページで畳む乗務員数 (受け側の既定 100、上限 150 =
   * `kintai_recalc::MAX_MAX_FOLD_DRIVERS`)。
   *
   * **月ゲートに指紋を書かせたいなら母集団を 1 ページに収めること** — gate を書く
   * 条件に「1 ページで回りきる」が含まれる。逆に `logic_version` 変更直後の全量
   * apply は 50 程度に落とす (Cloudflare の 100 秒上限を超えて 524 になる実測)。
   */
  maxDrivers?: number;
  /** 現行の `logic_version` を 1 つも持たない乗務員だけに絞る。既定 `false`。 */
  staleOnly?: boolean;
  /** **`true` で初めて書く。** 既定は 1 行も書かない (受け側の `GET` と同じ意味)。 */
  apply?: boolean;
  /** 当月の判定に使う時刻 (ms)。**テスト用** — 省略時は `Date.now()`。 */
  now?: number;
}

/**
 * 全量再計算を 1 ページぶん進める (Refs ohishi-exp/rust-ichibanboshi#205 の 10)。
 *
 * 窓の中継 ([`relayKintaiWindow`]) と違って**続きがある** — `after_driver_cd` で
 * 呼び出し側がページングする。応答 (`fold` / `stale` / `next_after_driver_cd`) は
 * 受け側の形をそのまま返す。ここで reshape すると、受け側がフィールドを足したときに
 * 中継だけ直し忘れて情報が欠ける (`.gcp()` は auth-worker `/ichibanboshi-proxy`
 * 経由、`buildDeps` と同じ資格情報)。
 *
 * `apply` が無ければ `GET` (受け側は絶対に書かない口)、`apply: true` なら `POST`。
 */
export async function relayKintaiRecalc(
  deps: Pick<KintaiRelayDeps, "gcp">,
  input: KintaiRecalcInput,
): Promise<unknown> {
  const month = input.month ?? jstMonth(input.now ?? Date.now());
  if (!MONTH_RE.test(month)) {
    throw new KintaiRelayError(`month は YYYY-MM で指定してください: ${month}`);
  }
  const apply = input.apply === true;

  if (apply) {
    return readJson<unknown>(
      await deps.gcp(RECALC_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          month,
          after_driver_cd: input.afterDriverCd,
          max_drivers: input.maxDrivers,
          stale_only: input.staleOnly === true,
          apply: true,
        }),
      }),
      "gcp kintai recalc",
    );
  }

  // **GET は書かない口。** apply を持たせない (受け側の型と同じ塞ぎ方)
  const q = new URLSearchParams({ month });
  if (input.afterDriverCd !== undefined) q.set("after_driver_cd", String(input.afterDriverCd));
  if (input.maxDrivers !== undefined) q.set("max_drivers", String(input.maxDrivers));
  if (input.staleOnly === true) q.set("stale_only", "true");
  return readJson<unknown>(await deps.gcp(`${RECALC_PATH}?${q}`), "gcp kintai recalc");
}

export interface KintaiDaySummariesInput {
  /** 対象月 (`YYYY-MM`)。**必須扱い** — 省略時は JST の当月。 */
  month?: string;
  /** 乗務員CD で 1 人に絞る。省略時は全乗務員。 */
  driver?: string;
  /** 当月の判定に使う時刻 (ms)。**テスト用** — 省略時は `Date.now()`。 */
  now?: number;
}

/**
 * 畳んだ結果 (`kintai.day_summaries`) を読む (Refs ohishi-exp/rust-ichibanboshi#205 の 23)。
 *
 * **読むだけ。** 受け側に `POST` は無い ([`relayKintaiRecalc`] と違い `apply` 相当が
 * 存在しない口)。ここにも書き込み側を足さないこと。
 *
 * 応答は**そのまま返す**。用途はオンプレ基準 JSON との突合で、キー
 * (`乗務員CD|暦日|開始時刻`) も列名も受け側が基準ファイルに合わせてある —
 * ここで件数の要約や整形を挟むと、突合スクリプトがそのまま比較できなくなる。
 * (`relayKintaiRecalc` を reshape しない理由と同じで、受け側が列を足したときに
 * 中継だけ直し忘れて情報が欠ける形も避ける。)
 */
export async function relayKintaiDaySummaries(
  deps: Pick<KintaiRelayDeps, "gcp">,
  input: KintaiDaySummariesInput,
): Promise<unknown> {
  const month = input.month ?? jstMonth(input.now ?? Date.now());
  if (!MONTH_RE.test(month)) {
    throw new KintaiRelayError(`month は YYYY-MM で指定してください: ${month}`);
  }
  const q = new URLSearchParams({ month });
  // 空文字は「絞らない」— `driver=` を送ると受け側の `parse_driver` が 400 にする
  if (input.driver) q.set("driver", input.driver);
  return readJson<unknown>(
    await deps.gcp(`${DAY_SUMMARIES_PATH}?${q}`),
    "gcp kintai day-summaries",
  );
}
