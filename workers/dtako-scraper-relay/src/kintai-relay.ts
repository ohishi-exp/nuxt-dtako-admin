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
/**
 * 月ごとの stale (畳み直しが要るか) だけを返す軽い口 (rust-ichibanboshi
 * `src/routes/stale_months.rs`、Refs #620)。`unko_diff` (alc の etags 掃引、約50秒) を
 * 含まない Postgres 1 往復だけの応答 — 月タブの丸のためだけに `/api/kintai/recalc`
 * (フル突合) を叩かないための専用口。
 */
const STALE_MONTHS_PATH = "/api/kintai/stale-months";
/**
 * 取り込み漏れ候補の運行NO一覧を読む口 (rust-ichibanboshi、Refs #623-2)。
 * `logic_version` を動かさない場所 (`src/routes/unko_gaps.rs` 想定) に置かれている。
 * **★ alc への etags 往復を含み遅い** — 受け側 docs に明記あり、ページ描画で
 * 叩いてはいけない。呼び出しタイミングの制御は呼び出し元 (画面) の責務。
 */
const UNKO_GAPS_PATH = "/api/kintai/unko-gaps";

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

/**
 * 取り込み (スクレイプ → アップロード → CSV 分割) 成功後に fold (勤怠の畳み直し)
 * を回すべきか決める (Refs ohishi-exp/rust-ichibanboshi#205 の 10)。
 *
 * **`splitFailed > 0` の間は回さない。** rust-alc-api の `has_kudgivt = TRUE`
 * フィルタにより、split が終わっていない運行は fold の入力 (`GET
 * /api/dtako/events`) からそもそも見えない (rust-alc-api
 * `crates/alc-dtako/src/dtako_events.rs` で確認済み)。ここで畳むと**不完全な
 * データで上書きし、しかも成功したように見える** — 古い値のまま残る方が
 * まだマシ、という判断 (Refs #205 監督)。`splitFailed` が `null` (旧 alc /
 * 応答に無い = 不明) は「失敗が確認できない」なので回す。
 */
export type FoldTriggerDecision =
  | { run: true }
  | { run: false; reason: FoldSkipReason; detail: string };

/** fold を回さなかった理由。**`not_configured` だけが「設定の穴」**で、他の 3 つは
 * 意図して回さなかった状態 (Refs #944)。`FOLD_SKIP_STATE`
 * (`dtako-scraper-relay-do.ts`) がこれを `fold_state` へ写す。 */
export type FoldSkipReason = "no_upload" | "split_failed" | "out_of_scope" | "not_configured";

/** fold の対象会社かどうか。判定の**引数**を `KINTAI_COMP_ID` の宣言 (env) にする。 */
export interface FoldScope {
  /** 取り込みが終わった会社。 */
  compId: string;
  /** `wrangler.toml` の `KINTAI_COMP_ID` の値をそのまま渡す (未設定なら undefined)。 */
  kintaiCompId: string | undefined;
}

/**
 * **この会社の勤怠を畳んでよいか。**
 *
 * 畳み先 (rust-ichibanboshi) は `[kintai_events] tenant_id` で**単一テナントに
 * pin** されており、別テナントを名乗ると 403 で弾く
 * (`src/routes/kintai_timecard.rs` の `assert_same_tenant`)。relay は comp ごとの
 * `tenant_id` を KV `dtako_accounts` から引いてそのまま名乗るので、**対象外の会社は
 * 何を送っても通らない。**
 *
 * 実害 (Refs #633-22): fold の自動起動が入った 2026-08-01 以降、comp 75700192 の
 * 取り込みは毎回成功しているのに fold だけが
 * `X-Tenant-ID が [kintai_events] tenant_id と一致しません (畳めません)` で
 * **1 度も成功していない**。恒久的な `fold_state: "failed"` が常態化して、
 * **本物の fold 失敗が埋もれる。**
 *
 * ## 方針を焼き込まない
 *
 * 「どの会社が勤怠の対象か」は `wrangler.toml` の `KINTAI_COMP_ID` が既に宣言して
 * いる (「打刻を持つのは大石運輸倉庫だけ」)。**値をコピーせず宣言を参照する** —
 * 将来 対象が変わったら `KINTAI_COMP_ID` 側が変わり、この判定も自動で追随する。
 *
 * ## 未設定は「対象外」ではない (Refs #944)
 *
 * `KINTAI_COMP_ID` は staging に**意図的に置いていない** (書き先は tenant で決まり、
 * staging も本番も同じ KV / 同じ tenant を見るため、置くと staging から本番の
 * `kintai.*` に書ける)。`/kintai-relay/run` が未設定で 503 に倒れるのと同じく、
 * ここも未設定なら**誰も対象にしない** — fail-closed の向き自体は正しい。
 *
 * **★ ただし「宣言が無い」と「宣言はあるが一致しない」を同じ答えにしてはいけない。**
 * 旧実装は両方 `false` を返し、呼び出し元が両方を `skipped_out_of_scope`
 * (=「対象外だから飛ばした」) として記録していた。すると **本番で
 * `KINTAI_COMP_ID` を落とした時、対象会社 (27324455) まで含めた全社が
 * 「意図的に対象外」に見えたまま勤怠が畳まれなくなり、失敗としても数えられない。**
 * top-level `[vars]` は named environment に継承されない (CLAUDE.md) ので、
 * env を増やす時に普通に踏む穴。**同じ worker の netprint cron は同じ条件を
 * 「黙って skip せず loud fail」にしている** (`cron.ts` の `NETPRINT_CRON` 分岐) —
 * fold だけが逆を向いていた。
 *
 * ⇒ **`not_configured` (設定の穴) と `out_of_scope` (本当に対象外) を別の答えにし、
 * どちらも人が読める理由 (`detail`) を持たせる。**
 */
export type FoldScopeVerdict =
  | { inScope: true }
  | { inScope: false; reason: "not_configured" | "out_of_scope"; detail: string };

export function judgeFoldScope(scope: FoldScope): FoldScopeVerdict {
  const target = (scope.kintaiCompId ?? "").trim();
  if (!target) {
    return {
      inScope: false,
      reason: "not_configured",
      detail:
        "KINTAI_COMP_ID が未設定です — fold の対象会社が 1 社も宣言されていません。" +
        "「この会社は対象外」ではなく設定の穴です (staging は意図的に未設定)。",
    };
  }
  const compId = scope.compId.trim();
  if (compId !== target) {
    return {
      inScope: false,
      reason: "out_of_scope",
      detail:
        `comp_id ${compId} は KINTAI_COMP_ID の宣言 (${target}) と一致しません — ` +
        "wrangler.toml [vars] が勤怠の対象会社を 1 社に絞っています (打刻を持つのがその 1 社だけのため)。",
    };
  }
  return { inScope: true };
}

export function decideFoldTrigger(
  uploadOutcome: { splitFailed: number | null } | null,
  scope: FoldScope,
): FoldTriggerDecision {
  // **範囲の判定を先に置く。** 対象外の会社では「取り込みが成功したか」も
  // 「split が落ちたか」も fold の可否と無関係で、どちらを理由に記録しても
  // 「直せば畳める」と読めてしまう (実際には何をしても畳めない)。
  const verdict = judgeFoldScope(scope);
  if (!verdict.inScope) return { run: false, reason: verdict.reason, detail: verdict.detail };
  if (!uploadOutcome) {
    return {
      run: false,
      reason: "no_upload",
      detail: "取り込み (アップロード) が成功していないため、fold に渡す入力がありません。",
    };
  }
  if (uploadOutcome.splitFailed !== null && uploadOutcome.splitFailed > 0) {
    return {
      run: false,
      reason: "split_failed",
      detail:
        `CSV 分割が ${uploadOutcome.splitFailed} 件失敗しています — ` +
        "分割前の運行は fold の入力 (GET /api/dtako/events) から見えないため、" +
        "不完全なデータで上書きしないよう見送りました。",
    };
  }
  return { run: true };
}

/**
 * `startDate`..`endDate` (`YYYY-MM-DD`) が属する月 (`YYYY-MM`) を昇順・重複無しで
 * 返す。cron 経路は常に 1 日分 = 1 か月だが、WS (手動) 経路は月境界をまたぐ範囲を
 * 選べるため複数月になりうる。壊れた日付は空配列 (fold を回さない側に倒す)。
 */
export function monthsCoveredByRange(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const months: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endCursor.getTime()) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/** 1 ページの乗務員数。**524 を避けるための安全値** — rust-ichibanboshi 側の
 * 実測 (`src/routes/kintai_recalc.rs` の docs: 100 名/ページで 109 秒、524 実測
 * あり) を踏まえ、収束フェーズは 50 に固定する。 */
export const FOLD_PAGE_MAX_DRIVERS = 50;

/** 1 回の fold 起動で許すページング呼び出しの上限 (収束フェーズのみ、封じる
 * 最後の 1 回は含まない)。**歯止め** — 届かなければ打ち切って `capped` を報告し、
 * 続きは次回の呼び出し (翌日の cron 等) に委ねる。 */
export const MAX_FOLD_PAGES = 10;

/** 収束後、月ゲートを封じる最後の 1 回に使うページサイズ。rust-ichibanboshi の
 * `MAX_MAX_FOLD_DRIVERS` と同じ値 — 母集団がこれ以下に収まる回だけ月ゲートの
 * 5 条件 (after_driver_cd 無し・次ページ無し等) を満たせる。 */
export const FOLD_CLOSE_MAX_DRIVERS = 150;

interface RecalcPageResult {
  driversWritten: number;
  /** `null` なら回りきった (次ページ無し)。 */
  nextAfterDriverCd: number | null;
}

/** `relayKintaiRecalc` の応答 (受け側の形をそのまま返す) から fold のページング
 * 判断に要る 2 値だけを読む。応答の他フィールドはここでは扱わない
 * ([`relayKintaiRecalc`] の docs と同じ理由で reshape しない)。 */
function parseRecalcPage(raw: unknown): RecalcPageResult {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const fold = typeof obj.fold === "object" && obj.fold !== null ? (obj.fold as Record<string, unknown>) : {};
  const driversWritten = typeof fold.drivers_written === "number" ? fold.drivers_written : 0;
  const next = obj.next_after_driver_cd;
  return {
    driversWritten,
    nextAfterDriverCd: typeof next === "number" ? next : null,
  };
}

export interface FoldMonthReport {
  month: string;
  /** ページング呼び出し (収束フェーズ) の回数。封じる 1 回は含まない。 */
  pages: number;
  driversWritten: number;
  /** 収束後、月ゲートを封じる呼び出しを試みたか (`capped` の間は `false`)。 */
  attemptedGateClose: boolean;
  /** ページ数上限に達して打ち切ったか。 */
  capped: boolean;
}

/**
 * 対象月を「収束させてから封じる」の 2 段で畳み直す (Refs
 * ohishi-exp/rust-ichibanboshi#205 の 10)。
 *
 * rust-ichibanboshi 側 (`src/routes/kintai_recalc.rs`) の月ゲートは「そのページで
 * 月まるごとを完結させた回だけ」digest を書く (`after_driver_cd` 無し・次ページ
 * 無し・`stale_only` でない・warnings 空の 5 条件)。[`FOLD_PAGE_MAX_DRIVERS`]
 * (50) でページングすると個々のページ単体はこの条件を満たさないため、月ゲートが
 * 一切書かれないままになる。よって:
 *
 * 1. `maxDrivers: 50` で `next_after_driver_cd` が `null` になるまでページング
 *    (実際の書き込みはここで完結する)
 * 2. 続けてページングなしの単発呼び出しをもう 1 回 (`maxDrivers: 150`)。1 で
 *    収束済みなら全員 unchanged で高速に終わり、5 条件を満たして月ゲートが
 *    書かれる (母集団が 150 を超えるテナントではこの最適化は成立しないが、
 *    正しさには影響しない — 次回また全量読みになるだけ)。
 *
 * ページ数が [`MAX_FOLD_PAGES`] を超えたら打ち切る (`capped: true`、無限ループの
 * 歯止め)。**打ち切った回は封じる呼び出しを試みない** — 収束していないのに
 * 封じると、未処理の乗務員が古い fingerprint のまま「最新」と刻まれる事故に
 * なる (rust-ichibanboshi 側の 5 条件がこの状況を弾く設計と同じ理由)。
 */
export async function foldMonth(
  deps: Pick<KintaiRelayDeps, "gcp">,
  input: { month: string; apply: boolean; now?: number },
): Promise<FoldMonthReport> {
  let afterDriverCd: number | undefined;
  let pages = 0;
  let driversWritten = 0;
  let capped = false;
  for (;;) {
    pages++;
    const page = parseRecalcPage(
      await relayKintaiRecalc(deps, {
        month: input.month,
        afterDriverCd,
        maxDrivers: FOLD_PAGE_MAX_DRIVERS,
        apply: input.apply,
        now: input.now,
      }),
    );
    driversWritten += page.driversWritten;
    if (page.nextAfterDriverCd === null) break;
    if (pages >= MAX_FOLD_PAGES) {
      capped = true;
      break;
    }
    afterDriverCd = page.nextAfterDriverCd;
  }

  if (capped) {
    return { month: input.month, pages, driversWritten, attemptedGateClose: false, capped: true };
  }

  const closing = parseRecalcPage(
    await relayKintaiRecalc(deps, {
      month: input.month,
      maxDrivers: FOLD_CLOSE_MAX_DRIVERS,
      apply: input.apply,
      now: input.now,
    }),
  );
  driversWritten += closing.driversWritten;
  return { month: input.month, pages, driversWritten, attemptedGateClose: true, capped: false };
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

export interface KintaiStaleMonthsInput {
  /** 窓の開始月 (`YYYY-MM`)。省略可 — 受け側の既定 (当月から12か月遡る) に任せる。 */
  from?: string;
  /** 窓の終了月 (`YYYY-MM`)。省略可 — 受け側の既定 (当月) に任せる。 */
  to?: string;
}

/**
 * 月ごとの stale (畳み直しが要るか) だけを読む (Refs #620)。
 *
 * **読むだけ。** 受け側に `POST` は無い ([`relayKintaiDaySummaries`] と同じ塞ぎ方)。
 * `from`/`to` は両方省略可で、省略時は受け側の既定 (当月から12か月遡る、上限36か月)
 * に任せる — ここで既定値や窓の計算を持たない (2重実装にしない、`relayKintaiWindow`
 * が窓計算をこちらで持つのとは違い、この口は「何を返すか」を受け側が決める設計)。
 *
 * 応答は**そのまま返す**。呼び出し側 (画面) が `total_drivers === 0` (データ無し) と
 * `stale_drivers > 0` (畳み直しが要る) を読み分ける — ここで丸めない。
 */
export async function relayKintaiStaleMonths(
  deps: Pick<KintaiRelayDeps, "gcp">,
  input: KintaiStaleMonthsInput,
): Promise<unknown> {
  if (input.from !== undefined && !MONTH_RE.test(input.from)) {
    throw new KintaiRelayError(`from は YYYY-MM で指定してください: ${input.from}`);
  }
  if (input.to !== undefined && !MONTH_RE.test(input.to)) {
    throw new KintaiRelayError(`to は YYYY-MM で指定してください: ${input.to}`);
  }
  const q = new URLSearchParams();
  if (input.from) q.set("from", input.from);
  if (input.to) q.set("to", input.to);
  const qs = q.toString();
  return readJson<unknown>(
    await deps.gcp(qs ? `${STALE_MONTHS_PATH}?${qs}` : STALE_MONTHS_PATH),
    "gcp kintai stale-months",
  );
}

export interface KintaiUnkoGapsInput {
  /** 対象月 (`YYYY-MM`)。必須。 */
  month: string;
  /** 絞り込む乗務員コード。省略可 — 省略時は受け側が対象月の全乗務員ぶんを返す。 */
  driverCd?: string;
}

/**
 * 取り込み漏れ候補 (`also_in_month`) の運行NO一覧を読む (Refs #623-2)。
 *
 * **★ 遅い。** alc への etags 往復を含み、所要時間の保証は無い (受け側 docs に
 * 「ページ表示で叩く口ではない」と明記)。**呼び出しタイミングはここで制御しない** —
 * 呼ぶかどうか・いつ呼ぶかは呼び出し元 (画面、ユーザー操作) の責務。ここでは
 * 単に中継するだけ。
 *
 * 読むだけ。受け側に `POST` は無い ([`relayKintaiStaleMonths`] と同じ塞ぎ方)。
 *
 * 応答は**そのまま返す**。`gcp_etags_available` / `driver_cds_available` が
 * `false` のときに「候補なし」と丸めるのは呼び出し側 (画面) の責務 — ここで
 * 丸めない (#620/#615-7 と同型の「無い」と「引けていない」の混同を避ける作法)。
 */
export async function relayKintaiUnkoGaps(
  deps: Pick<KintaiRelayDeps, "gcp">,
  input: KintaiUnkoGapsInput,
): Promise<unknown> {
  if (!MONTH_RE.test(input.month)) {
    throw new KintaiRelayError(`month は YYYY-MM で指定してください: ${input.month}`);
  }
  const q = new URLSearchParams({ month: input.month });
  if (input.driverCd) q.set("driver_cd", input.driverCd);
  return readJson<unknown>(await deps.gcp(`${UNKO_GAPS_PATH}?${q}`), "gcp kintai unko-gaps");
}

// ---------------------------------------------------------------------------
// 賃金確定値の月次スナップショット (Refs ohishi-exp/nuxt-dtako-admin#677)
// ---------------------------------------------------------------------------
// 読み書きする `kintai.wage_snapshot` は Supabase にあり、そこへ繋がるのは GCP の
// インスタンスだけ。**Supabase の接続情報をオンプレ側 (`onprem()` の宛先) には置かない**方針
// (資格情報は auth-worker 1 箇所に集約) なので、画面 → relay → `/ichibanboshi-proxy`
// → GCP という経路になる。`relayKintaiDaySummaries` とまったく同じ道。

/**
 * 「この人は給与データを見てよいか」を上流に聞く口
 * (rust-ichibanboshi `src/routes/kyuyo.rs` の `access`、Refs #951)。
 *
 * ## ★ この口は **`onprem()` で叩く。`gcp()` ではない**
 *
 * 同じファイルの `WAGE_SNAPSHOT_PATH` / `WAGE_RANGE_PATH` が `gcp()` なので
 * **「揃えよう」と `gcp()` に変えたくなるが、変えると全員 503 になる。**
 * 上流は同じバイナリでも**インスタンスごとに設定が違う**:
 *
 * | | Supabase 接続 | `/kyuyo/*` の allowlist |
 * | --- | --- | --- |
 * | **オンプレ側** (`onprem()` の宛先) | **無い** | **ある** |
 * | **GCP Cloud Run** (`gcp()` の宛先) | **ある** | **無い** |
 *
 * `kintai.wage_snapshot` は Supabase にあるので wage-* は `gcp()` でしか届かず、
 * allowlist はオンプレ側 (`onprem()` の宛先) にしか無いので判定は `onprem()` でしか取れない。
 * **経路が分かれているのは意図で、揃えるのが誤り。**
 * (上流 `routes::wage_snapshot` の module docs に同じ表がある。)
 */
const KYUYO_ACCESS_PATH = "/api/kyuyo/access";

/** 保存の口 (rust-ichibanboshi `src/routes/wage_snapshot.rs`)。 */
const WAGE_SNAPSHOT_PATH = "/api/kintai/wage-snapshot";
/** 期間集計の口 (同上)。 */
const WAGE_RANGE_PATH = "/api/kintai/wage-range";

/**
 * 給与 allowlist に通らなかったときに relay が返すもの。**null = 通った。**
 *
 * status は**上流のものをそのまま持つ** (401 だけ写し替える。下の
 * [`checkKyuyoAccess`] 参照) — 画面側は `describeApiError` で本文をそのまま
 * 出すので、502 等へ丸めると 403 / 503 の撃ち分けがこの経路だけ効かなくなる。
 */
export interface KyuyoAccessDenial {
  status: number;
  message: string;
}

/**
 * 上流 401 を写す先。
 *
 * **401 のまま返してはいけない** — 画面では「ログインし直せ」の意味になり、
 * 原因と処方が食い違う。ここへ 401 が返るのは
 *
 * - relay が Bearer を持たずに叩いた (theearth セッション経路など。あちらの
 *   Bearer は theearth のランダム token でブラウザ JWT ではない)
 * - 上流の introspect が `active:false` を返した (app_origin の ACL 違い等)
 *
 * のどちらかで、**どちらも利用者の権限の話ではない**。⇒ 403 (権限) ではなく
 * **503 (設定・経路の話)** に倒す。画面の `classifyKyuyoAccess` でも 503 は
 * 「権限の問題ではありません」と読まれるので、意味が一致する。
 */
export const KYUYO_ACCESS_UNIDENTIFIED_STATUS = 503;

/** 上流 401 を 503 に写したときに出す文 (上流の「token が無効です」は
 * ログインの話に読めるので、こちらで言い換える)。 */
export const KYUYO_ACCESS_UNIDENTIFIED_MESSAGE =
  "給与データの閲覧可否を判定できませんでした (閲覧者を上流に識別させられていません)。権限の問題ではありません";

/** 上流の `{error: "..."}` から文を取り出す。JSON でなければ本文の頭を返す。 */
function kyuyoAccessMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    // JSON でない応答 (CF Access のログイン HTML 等) はそのまま頭だけ見せる
  }
  return body.trim() ? body.trim().slice(0, 200) : `上流が status ${status} を返しました`;
}

/**
 * 給与 allowlist を上流に問い合わせる (Refs #951)。**通れば null。**
 *
 * ## なぜ relay が聞くのか
 *
 * `paid` (実支給額) を読み書きする `wage-range` / `wage-snapshot` の認可は
 * **tenant 単位**で、`/api/kyuyo/payroll` に掛かっている **email allowlist を
 * 通っていない**。⇒ allowlist に載っている 1 名が保存した瞬間、実支給額が
 * tenant 全員の読める場所へ移る。tenant 判定を**通した後**にこれを AND する。
 *
 * ## ★ 転送するのは**リクエスト自身の Bearer**
 *
 * `record.token` を使ってはいけない — viewer 経路では `token ?? "viewer"` が
 * 入り、theearth セッションを持つ record では **theearth のセッショントークン**
 * (ランダム hex) が入っていて、どちらもブラウザ JWT ではない。上流で
 * `active:false` になって**静かに 401** になる。
 *
 * ## allowlist はここに持たない
 *
 * 正は上流の `KYUYO_ALLOWED_EMAILS` 1 か所。relay 側に写しを持つと二重管理に
 * なり、片方だけ更新されて食い違う。
 */
export async function checkKyuyoAccess(
  deps: Pick<KintaiRelayDeps, "onprem">,
  bearer: string | null,
): Promise<KyuyoAccessDenial | null> {
  // Bearer が無いなら上流に聞くまでもない (必ず 401 が返る)。往復を省くだけで、
  // 結論は上流に聞いた場合と同じ 503。
  if (!bearer) {
    return {
      status: KYUYO_ACCESS_UNIDENTIFIED_STATUS,
      message: KYUYO_ACCESS_UNIDENTIFIED_MESSAGE,
    };
  }

  let res: Response;
  try {
    // ★★ **`onprem()` である。`gcp()` に「揃えて」はいけない。**
    // このすぐ下の `relayWageSnapshotPut` / `relayWageRangeGet` は `gcp()` なので
    // 揃えたくなるが、**allowlist を持っているのはオンプレ側 (= `onprem()`) だけ**で、
    // GCP 側の `KyuyoAuthState` は未設定。`gcp()` に変えると**全員 503** になり、
    // 許可されている 1 名まで画面が死ぬ。理由の表は [`KYUYO_ACCESS_PATH`] の docs。
    res = await deps.onprem(KYUYO_ACCESS_PATH, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
  } catch (err) {
    // **fail-closed。** 判定が取れないなら通さない
    return {
      status: 503,
      // `String(err)` で足りる (`Error` は "TypeError: fetch failed" になる)。
      // `err instanceof Error ? ... : ...` にすると分岐が 2 本増えるだけで、
      // 出る文はほぼ同じ
      message: `給与データの閲覧可否を上流に問い合わせられませんでした: ${String(err)}`,
    };
  }

  if (res.ok) return null;

  const body = await res.text();
  if (res.status === 401) {
    return {
      status: KYUYO_ACCESS_UNIDENTIFIED_STATUS,
      message: KYUYO_ACCESS_UNIDENTIFIED_MESSAGE,
    };
  }
  if (res.status === 404) {
    // ★ **デプロイ順序**。この口はまだ上流に無い (relay が先に出た)。fail-closed の
    // ままでよいが、404 を素通しすると画面には「期間集計の口が無い」と読める文が
    // 出て**原因を取り違える**。設定・順序の話なので 503 に倒す
    return {
      status: 503,
      message:
        "上流に給与アクセス判定の口 (/api/kyuyo/access) がありません。上流のデプロイが先に必要です",
    };
  }
  // 403 / 503 はそのまま passthrough — 画面が理由をそのまま出せる
  return { status: res.status, message: kyuyoAccessMessage(body, res.status) };
}

/**
 * 画面が確定させた 1 か月ぶんを保存する。
 *
 * **`comp_id` は呼び出し元に名乗らせない** — 呼び出し元 (ブラウザ) が body に
 * 入れてきた値は捨て、relay が認可済みの `compId` で上書きする。名乗らせると
 * JWT の通る利用者が他社のスナップショットを書き換えられる (`kintai-relay` の
 * 「tenant は KV から引く / 呼び出し元に名乗らせない」と同じ理由)。
 */
export async function relayWageSnapshotPut(
  deps: Pick<KintaiRelayDeps, "gcp">,
  compId: string,
  body: unknown,
): Promise<unknown> {
  const payload = { ...(body as Record<string, unknown>), comp_id: compId };
  return readJson<unknown>(
    await deps.gcp(WAGE_SNAPSHOT_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    "gcp wage-snapshot",
  );
}

/**
 * 期間集計を読む。`comp` は保存と同じ理由で relay が上書きする。
 * `from` / `to` / `source` / 現行版 (鮮度判定用) はそのまま渡す — 何を返すかは
 * 受け側が決める設計 (`relayKintaiStaleMonths` と同じ)。
 */
export async function relayWageRangeGet(
  deps: Pick<KintaiRelayDeps, "gcp">,
  compId: string,
  query: URLSearchParams,
): Promise<unknown> {
  const q = new URLSearchParams(query);
  q.set("comp", compId);
  return readJson<unknown>(await deps.gcp(`${WAGE_RANGE_PATH}?${q}`), "gcp wage-range");
}
