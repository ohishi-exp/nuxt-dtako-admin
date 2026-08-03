/**
 * Cron Triggers の dispatch ロジック (VPS cron の Worker 移行、Refs
 * ohishi-exp/dtako-scraper#22 / ohishi-exp/browser-render-rust#14)。
 *
 * 移行元:
 * - dtako (csvdata.zip): Kagoya VPS の cron `dtako-scraper-daily`
 *   (`0 1 * * *` Asia/Tokyo = `0 16 * * *` UTC)。日付範囲は VPS 実装の
 *   default と同じ「昨日 (JST) 1 日分」。
 * - ETC (明細 CSV): GCE の cron `etc-scrape-batch-env`
 *   (`0 21,22,23,0 * * *` UTC = JST 6,7,8,9 時)。
 *
 * 拘束サマリ同期 (`0 19 * * *` UTC = JST 4:00) は移行元を持たない新規追加
 * (Refs #606-6)。画面の「取り込み」ボタンだけが叩けていた
 * `POST /restraint-api/kintai/fetch` 相当の処理を、前月+当月ぶん無人で押し直す。
 *
 * この module は pure に保つ (fetch / DO namespace を直接触らず、DO 呼び出しは
 * `CronDoCall` として注入する) — node vitest で 100% gate に載せるため。
 * 実際の配線 (RELAY.idFromName → DO.fetch) は index.ts の scheduled handler。
 */

/** dtako 日次スクレイプの cron 式 (UTC)。VPS cron `0 1 * * *` JST と同時刻。 */
export const DTAKO_CRON = "0 16 * * *";
/** ETC 明細スクレイプの cron 式 (UTC)。GCE cron と同じ JST 6,7,8,9 時。 */
export const ETC_CRON = "0 21,22,23,0 * * *";
/** 拘束サマリ (R2 `kintai/` prefix) の日次同期 cron 式 (UTC)。JST 4:00 —
 * dtako 日次 (JST 1:00) の後で ETC (JST 6,7,8,9 時) の前、既存 2 本と重ならない
 * 時間帯 (Refs #606-6)。 */
export const RESTRAINT_SYNC_CRON = "0 19 * * *";

export interface DtakoAccountEntry {
  comp_id: string;
  user_name: string;
  user_pass: string;
  tenant_id: string;
}

export interface EtcAccountEntry {
  user_id: string;
  password: string;
}

export class CronConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronConfigError";
  }
}

/** DTAKO_ACCOUNTS (dtako-scraper Rust 版と同一 JSON shape) をパースする。
 * 未設定は [] (= cron skip)、JSON 不正は loud fail。 */
export function parseDtakoAccounts(raw: string | undefined): DtakoAccountEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CronConfigError("DTAKO_ACCOUNTS が JSON としてパースできません");
  }
  if (!Array.isArray(parsed)) {
    throw new CronConfigError("DTAKO_ACCOUNTS は JSON 配列である必要があります");
  }
  return parsed as DtakoAccountEntry[];
}

/** ETC_ACCOUNTS (browser-render-rust の `ETC_ACCOUNTS` env と同一 JSON shape:
 * `[{user_id, password}, ...]`) をパースする。 */
export function parseEtcAccounts(raw: string | undefined): EtcAccountEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CronConfigError("ETC_ACCOUNTS が JSON としてパースできません");
  }
  if (!Array.isArray(parsed)) {
    throw new CronConfigError("ETC_ACCOUNTS は JSON 配列である必要があります");
  }
  return parsed as EtcAccountEntry[];
}

/** 昨日 (JST) を YYYY-MM-DD で返す (dtako-scraper `spawn_scrape_job` の default
 * date range と同じ)。 */
export function yesterdayJst(now: Date): string {
  const jstMs = now.getTime() + 9 * 3600 * 1000 - 24 * 3600 * 1000;
  return new Date(jstMs).toISOString().slice(0, 10);
}

/** 当月 (JST) を YYYY-MM で返す (拘束サマリ同期 cron の対象月計算に使う)。 */
export function currentYmJst(now: Date): string {
  const jstMs = now.getTime() + 9 * 3600 * 1000;
  return new Date(jstMs).toISOString().slice(0, 7);
}

/** `YYYY-MM` の前月を `YYYY-MM` で返す。 */
export function prevYm(ym: string): string {
  const [year, month] = ym.split("-").map(Number) as [number, number];
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

/** ETC 明細 CSV の R2 保存キー。JST タイムスタンプでユニーク化する
 * (cron は 1 日 4 回走るため、日付だけだと同日分が上書きされる)。 */
export function etcCsvKey(prefix: string, userId: string, now: Date): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const iso = jst.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ (すでに JST 加算済み)
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, "");
  return `${prefix}/${userId}/${date}/${time}.csv`;
}

/** SecretsStoreSecret (`.get()`) / 文字列 (dashboard の plain env var) の
 * どちらの binding でも値を取り出す (DTAKO_ACCOUNTS / ETC_ACCOUNTS 共用)。 */
export async function resolveSecretBinding(binding: unknown): Promise<string> {
  if (typeof binding === "string") return binding;
  if (binding && typeof (binding as { get?: unknown }).get === "function") {
    return (await (binding as { get(): Promise<string> }).get()) ?? "";
  }
  return "";
}

/** KV binding の最小形 (cloudflare:workers の型に依存しないための構造的型)。 */
export interface DtakoConfigKvBinding {
  get(key: string): Promise<string | null>;
}

/** `DTAKO_ACCOUNTS` を置く KV のキー名。 */
export const DTAKO_ACCOUNTS_KV_KEY = "dtako_accounts";

/**
 * `DTAKO_ACCOUNTS` (comp_id → tenant_id / theearth 認証情報) の解決。
 *
 * **KV (`DTAKO_CONFIG_KV` の `dtako_accounts`) が正**で、無ければ従来の binding
 * (dashboard の plain 環境変数 / Secrets Store) にフォールバックする。
 *
 * KV へ移した理由 (2026-07-25 実害): dashboard の plain 環境変数は deploy で
 * 消えることがあり (`keep_vars` があっても本番から消えていた)、消えると viewer
 * 認可 (`viewerCompIdsForTenant`) が fail-closed で**全会社 401** になり、
 * 拘束×賃金の全タブが「セッションが無効か期限切れです」で閲覧不能になる。
 * **KV の値が唯一の正で、投入は最初の 1 回だけ** — CI もデプロイも書き換えない
 * (毎回書き直すなら「消える変数」と同じで、値の持ち主がパイプラインになって
 * しまう)。CI は `dtako-scraper-relay-deploy.yml` で**存在を検証して落とす**だけ。
 * 空だった時に黙って全社 401 になるのが今回の事故なので、呼び出し側は
 * loud fail (console.error) すること。
 */
export async function resolveDtakoAccountsRaw(kv: unknown, binding: unknown): Promise<string> {
  if (kv && typeof (kv as DtakoConfigKvBinding).get === "function") {
    const value = await (kv as DtakoConfigKvBinding).get(DTAKO_ACCOUNTS_KV_KEY);
    if (value) return value;
  }
  return resolveSecretBinding(binding);
}

/** scheduled handler から注入される DO 呼び出し。doKey は `idFromName` に渡す
 * キー、path は DO 内部 route (`/cron/dtako` 等)、body は JSON。 */
export type CronDoCall = (
  doKey: string,
  path: string,
  body: Record<string, string>,
) => Promise<{ ok: boolean; status: number; text: string }>;

export interface CronEnvValues {
  /** `http` 以外の間は dtako cron を skip する (vpc-relay = VPS 側 cron が現役)。 */
  scraperMode?: string;
  dtakoAccountsRaw?: string;
  etcAccountsRaw?: string;
}

export interface CronRunResult {
  kind: "dtako" | "etc" | "restraint" | "none";
  target: string;
  ok: boolean;
  detail: string;
}

/**
 * cron 式で dispatch し、対象アカウントごとに DO を叩いた結果を返す。
 *
 * DO 側の `/cron/*` は job を受理して即 202 を返し、実処理は DO 内で
 * 直列化して走る (結果は DO 側の console log = Workers Observability で追う)。
 * ここで完了まで await しないのは、アカウント数 × スクレイプ数分 (login +
 * export で数分/社) が scheduled event の実行時間上限に収まらなくなるのを
 * 避けるため。アカウント間は並列に kick して良い (同一アカウント内の直列化は
 * DO の queue が担保する)。
 */
export async function runScheduledCron(
  cron: string,
  env: CronEnvValues,
  callDo: CronDoCall,
  now: Date,
): Promise<CronRunResult[]> {
  if (cron === DTAKO_CRON) {
    if (env.scraperMode !== "http") {
      return [
        {
          kind: "dtako",
          target: "*",
          ok: true,
          detail: `SCRAPER_MODE=${env.scraperMode ?? "(unset)"} のため skip (vpc-relay 中は VPS 側 cron が担当)`,
        },
      ];
    }
    const accounts = parseDtakoAccounts(env.dtakoAccountsRaw);
    if (accounts.length === 0) {
      return [{ kind: "dtako", target: "*", ok: true, detail: "DTAKO_ACCOUNTS 未設定のため skip" }];
    }
    const date = yesterdayJst(now);
    return Promise.all(
      accounts.map(async (account): Promise<CronRunResult> => {
        try {
          const res = await callDo(`scraper-comp-${account.comp_id}`, "/cron/dtako", {
            comp_id: account.comp_id,
            start_date: date,
            end_date: date,
          });
          return {
            kind: "dtako",
            target: account.comp_id,
            ok: res.ok,
            detail: `HTTP ${res.status}: ${res.text.slice(0, 200)}`,
          };
        } catch (err) {
          return {
            kind: "dtako",
            target: account.comp_id,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  if (cron === ETC_CRON) {
    const accounts = parseEtcAccounts(env.etcAccountsRaw);
    if (accounts.length === 0) {
      return [{ kind: "etc", target: "*", ok: true, detail: "ETC_ACCOUNTS 未設定のため skip" }];
    }
    return Promise.all(
      accounts.map(async (account): Promise<CronRunResult> => {
        try {
          const res = await callDo(`etc-${account.user_id}`, "/cron/etc", {
            user_id: account.user_id,
          });
          return {
            kind: "etc",
            target: account.user_id,
            ok: res.ok,
            detail: `HTTP ${res.status}: ${res.text.slice(0, 200)}`,
          };
        } catch (err) {
          return {
            kind: "etc",
            target: account.user_id,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  if (cron === RESTRAINT_SYNC_CRON) {
    // 拘束サマリの写しを更新できる経路は画面の「取り込み」ボタン
    // (`POST /restraint-api/kintai/fetch`) だけで、無人で押し直す経路が無かった
    // ため写しが化石化していた (実測 2026-08-03、Refs #606-6)。account は dtako
    // スクレイプと同じ theearth 会社単位 (comp_id) の一覧を使う — 拘束サマリも
    // 会社ごとの theearth データなので、対象は dtako と同じ母集団でよい。
    const accounts = parseDtakoAccounts(env.dtakoAccountsRaw);
    if (accounts.length === 0) {
      return [{ kind: "restraint", target: "*", ok: true, detail: "DTAKO_ACCOUNTS 未設定のため skip" }];
    }
    // 前月 + 当月をそれぞれ同期する。月初は前月の打刻が後から確定するため、
    // 当月だけだと締め後に化石化する (Refs #606-6)。
    const curYm = currentYmJst(now);
    const months = [curYm, prevYm(curYm)];
    const jobs = accounts.flatMap((account) => months.map((month) => ({ account, month })));
    return Promise.all(
      jobs.map(async ({ account, month }): Promise<CronRunResult> => {
        try {
          const res = await callDo(`scraper-comp-${account.comp_id}`, "/cron/restraint-sync", {
            comp_id: account.comp_id,
            month,
          });
          return {
            kind: "restraint",
            target: `${account.comp_id}|${month}`,
            ok: res.ok,
            detail: `HTTP ${res.status}: ${res.text.slice(0, 200)}`,
          };
        } catch (err) {
          return {
            kind: "restraint",
            target: `${account.comp_id}|${month}`,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  return [{ kind: "none", target: cron, ok: false, detail: "未知の cron 式です (wrangler.toml の triggers と cron.ts の定数がズレています)" }];
}
