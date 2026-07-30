/**
 * 打刻 (タイムカード) をオンプレから GCP へ運ぶ (Refs ohishi-exp/rust-ichibanboshi#205 の 04b)。
 *
 * オンプレの rust-ichibanboshi は社内 MariaDB から打刻を読めるが、GCP 側の同じ
 * バイナリは読めない。**畳むのは GCP 側**にしたので、打刻を運ぶ必要がある。
 *
 * ## 往復するのは relay。オンプレは外へ出ない
 *
 * relay が起動する側なので、オンプレから折り返させない。オンプレは
 * request / response だけで、送り先 URL も GCP の資格情報も持たない:
 *
 *   1. オンプレ `GET  /api/kintai/timecard/drivers`    対象月の乗務員を 1 ページ
 *   2. GCP     `GET  /api/kintai/timecard/signatures`  その乗務員ぶんの署名
 *   3. オンプレ `POST /api/kintai/timecard/diff`        署名を渡し、差分を受け取る
 *   4. GCP     `POST /api/kintai/timecard`             差分を渡す
 *
 * ## 署名はここで計算しない
 *
 * 2 で引いた署名を 3 へ**そのまま渡す**だけで、突き合わせは Rust 側
 * (`kintai_push::plan_batch`) が持つ。ここで `day_signature` を実装すると 2 実装に
 * なり、式が少しでもずれた瞬間に「中身は同じなのに毎回全日が違う」と判定して静かに
 * 全件を書き直し続ける (#205 の決定 3 で `kosoku.rs` を写さないのと同じ理由)。
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
 * ## 1 回の呼び出しを乗務員数で区切る
 *
 * オンプレは Cloudflare Tunnel (30 秒上限) の内側にいる。`drivers` が `max_drivers`
 * で区切って `next_after_driver_cd` を返すので、`null` になるまで呼び直す。
 * **1 呼び出し = 1 ページ**にして、続きの判断は呼び出し側に残す。
 */

/** service binding の最小形 (`cloudflare:workers` の型に依存しないための構造的型)。 */
export interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** auth-worker 側の route prefix (`handlers/ichibanboshi-proxy.ts`)。 */
const PROXY_PREFIX = "/ichibanboshi-proxy";

/** service binding fetch 用の絶対 URL base。host は binding が無視するが path は必要。 */
const PROXY_BASE = "https://auth-worker.internal";

const DRIVERS_PATH = "/api/kintai/timecard/drivers";
const SIGNATURES_PATH = "/api/kintai/timecard/signatures";
const DIFF_PATH = "/api/kintai/timecard/diff";
const TIMECARD_PATH = "/api/kintai/timecard";

export class KintaiRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KintaiRelayError";
  }
}

/** 1 ページぶんの結果。 */
export interface KintaiRelayReport {
  month: string;
  /** 見た乗務員数。 */
  drivers: number;
  /** GCP へ渡した batch 数。 */
  batchesSent: number;
  daysWritten: number;
  daysDeleted: number;
  /** 相手が「日/乗務員/月が食い違う」として弾いた行数。**0 でないと運び方が壊れている**。 */
  misplaced: number;
  /** DDL の CHECK に無かった `state` の実値 (両側ぶん)。 */
  unknownStates: string[];
  /** 続きの位置。`null` なら回りきった。 */
  nextAfterDriverCd: number | null;
}

export interface KintaiRelayInput {
  month: string;
  afterDriverCd?: number | null;
  maxDrivers?: number;
  /** **`false` なら GCP へ 1 件も渡さない** (既定)。差分の件数だけ数える。 */
  apply?: boolean;
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

/**
 * 1 ページぶん運ぶ。**続きは呼び出し側が `nextAfterDriverCd` を見て呼び直す。**
 *
 * 途中で落ちたら例外。冪等 (差分だけを運び、結果が相手の署名に反映される) なので、
 * 呼び直せば同じ状態に収束する。
 */
export async function relayKintaiPage(
  deps: KintaiRelayDeps,
  input: KintaiRelayInput,
): Promise<KintaiRelayReport> {
  if (!MONTH_RE.test(input.month)) {
    throw new KintaiRelayError(`month は YYYY-MM で指定してください: ${input.month}`);
  }
  const apply = input.apply === true;

  // ── 1. オンプレ: 対象月の乗務員を 1 ページ ────────────────────────────────
  const q = new URLSearchParams({ month: input.month });
  if (input.afterDriverCd != null) q.set("after_driver_cd", String(input.afterDriverCd));
  if (input.maxDrivers != null) q.set("max_drivers", String(input.maxDrivers));
  const page = await readJson<{ drivers?: number[]; next_after_driver_cd?: number | null }>(
    await deps.onprem(`${DRIVERS_PATH}?${q}`),
    "onprem drivers",
  );
  const drivers = Array.isArray(page.drivers) ? page.drivers : [];

  const report: KintaiRelayReport = {
    month: input.month,
    drivers: drivers.length,
    batchesSent: 0,
    daysWritten: 0,
    daysDeleted: 0,
    misplaced: 0,
    unknownStates: [],
    nextAfterDriverCd: page.next_after_driver_cd ?? null,
  };
  if (drivers.length === 0) return report;

  // ── 2. GCP: その乗務員ぶんの署名 ──────────────────────────────────────────
  // **ここでは中身を見ない。** 3 へそのまま渡し、突き合わせは Rust 側に任せる
  const remote: Record<string, Record<string, string>> = {};
  for (const driver of drivers) {
    const sq = new URLSearchParams({ month: input.month, driver_cd: String(driver) });
    const got = await readJson<{ signatures?: Record<string, string> }>(
      await deps.gcp(`${SIGNATURES_PATH}?${sq}`),
      `gcp signatures (driver ${driver})`,
    );
    remote[String(driver)] = got.signatures ?? {};
  }

  // ── 3. オンプレ: 署名を渡して差分を受け取る ───────────────────────────────
  const diff = await readJson<{
    batches?: unknown[];
    unknown_states?: string[];
  }>(
    await deps.onprem(DIFF_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ month: input.month, remote }),
    }),
    "onprem diff",
  );
  const batches = Array.isArray(diff.batches) ? diff.batches : [];
  const unknown = new Set<string>(diff.unknown_states ?? []);

  // ── 4. GCP: 差分を渡す ────────────────────────────────────────────────────
  for (const batch of batches) {
    if (!apply) {
      report.batchesSent += 1; // 数えるだけ (計画の可視化)
      continue;
    }
    const applied = await readJson<{
      days_written?: number;
      days_deleted?: number;
      misplaced?: number;
      unknown_states?: string[];
    }>(
      await deps.gcp(TIMECARD_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
      }),
      "gcp timecard",
    );
    report.batchesSent += 1;
    report.daysWritten += applied.days_written ?? 0;
    report.daysDeleted += applied.days_deleted ?? 0;
    report.misplaced += applied.misplaced ?? 0;
    for (const s of applied.unknown_states ?? []) unknown.add(s);
  }

  report.unknownStates = [...unknown].sort();
  return report;
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

/** [`relayKintaiPage`] に渡す実体を組む。 */
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
