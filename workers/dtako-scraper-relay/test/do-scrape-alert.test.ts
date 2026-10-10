import { afterEach, describe, expect, it, vi } from "vitest";

// do-cron-history-tenant.test.ts と同じ手。`cloudflare:workers` は Workers ランタイム
// でしか解決できないので、DurableObject を素のクラスで差し替えて
// dtako-scraper-relay-do.ts を node vitest から読み込む。
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

/** theearth への HTTP は 1 回も出さない。**スクレイプ本体を失敗させるためだけ**に
 * `scrapeViaHttp` を差し替える (他の export は原本のまま — `scrape-alert.ts` が
 * `PAGE_EXCERPT_MARKER` を、DO が `TheearthClientError` を読む)。 */
const { scrapeViaHttp } = vi.hoisted(() => ({ scrapeViaHttp: vi.fn() }));
vi.mock("../src/theearth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/theearth-client")>()),
  scrapeViaHttp,
}));

/** 勤怠の畳み直し 1 か月ぶん。畳み先 (ichiban / alc) へは繋がず、失敗だけを作る。 */
const { foldMonth } = vi.hoisted(() => ({ foldMonth: vi.fn() }));
vi.mock("../src/kintai-relay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/kintai-relay")>()),
  foldMonth,
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { LINEWORKS_SEND_PATH } from "../src/lineworks-notify";
import { SCRAPE_JOB_KEY_PREFIX } from "../src/scrape-queue";
import { RECALC_PENDING_PATH } from "../src/alc-internal-upload";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/** 架空の値 (本番の宛先・tenant ではない)。この repo は public。 */
const CHANNEL_ID = "11111111-2222-3333-4444-555555555555";
const ACCOUNT = { comp_id: "27324455", tenant_id: "tenant-of-27324455", user_name: "u", user_pass: "p" };
const RANGE = { startDate: "2026-08-28", endDate: "2026-08-28" };

interface SentRequest {
  url: string;
  secret: string | null;
  body: { channel_id?: string; recipient_id?: string; text: string };
}

/** `sent` に積むのは **LINE WORKS の send だけ**。alc へのアップロードも同じ
 * `AUTH_WORKER` binding を通るが、body が ZIP のバイト列なので混ぜると読めない。 */
function isLineworksSend(url: string): boolean {
  return url.includes(LINEWORKS_SEND_PATH);
}

/** 架空のアドレス (実物ではない)。 */
const EMAIL_CONFIG = JSON.stringify({ from: "relay@example.com", to: "alert@example.com" });

function makeDO(
  opts: {
    scrapeAlertTarget?: string;
    sharedSecret?: string;
    sendOk?: boolean;
    /** Secrets Store binding が reject する形 (`.get()` が落ちる)。 */
    secretRejects?: boolean;
    /** KV `scrape_alert_email` の値。null で未設定。 */
    emailConfig?: string | null;
    /** `ALERT_EMAIL` binding を置かない。 */
    noEmailBinding?: boolean;
    /** アップロード応答の `split_failed`。 */
    splitFailed?: number;
    /** `POST /api/recalculate-pending` の応答本文。 */
    pendingBody?: unknown;
    /** fold を回す (`KINTAI_COMP_ID` を対象会社にする)。`configured` で畳み先の設定も置く。 */
    fold?: "not_configured" | "configured";
  } = {},
) {
  const sent: SentRequest[] = [];
  const mails: Array<{ from: string; to: string; raw: string }> = [];
  const env = {
    DTAKO_CONFIG_KV: {
      get: async (key: string) =>
        key === "scrape_alert_email" ? ("emailConfig" in opts ? opts.emailConfig : EMAIL_CONFIG) : null,
    },
    ALERT_EMAIL: opts.noEmailBinding
      ? undefined
      : {
          send: async (message: { from: string; to: string; raw: string }) => {
            mails.push({ from: message.from, to: message.to, raw: message.raw });
          },
        },
    ...(opts.fold ? { KINTAI_COMP_ID: ACCOUNT.comp_id } : {}),
    ...(opts.fold === "configured"
      ? {
          NUXT_ICHIBAN_API_URL: "https://ichiban.example.com",
          NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "client-id",
          ICHIBAN_CF_ACCESS_CLIENT_SECRET: "client-secret",
        }
      : {}),
    INTERNAL_SHARED_SECRET: opts.secretRejects
      ? { get: async () => { throw new Error("secrets store unavailable"); } }
      : "sharedSecret" in opts
        ? opts.sharedSecret
        : "shared-secret",
    SCRAPE_ALERT_TARGET:
      "scrapeAlertTarget" in opts ? opts.scrapeAlertTarget : `{"channel_id":"${CHANNEL_ID}"}`,
    AUTH_WORKER: {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.includes(RECALC_PENDING_PATH)) {
          return new Response(
            JSON.stringify(opts.pendingBody ?? { processed: 0, failed: 0, remaining: 0 }),
            { status: 200 },
          );
        }
        if (!isLineworksSend(url)) {
          // alc へのアップロード (`/api/upload`)。中身は見ない。
          return new Response(
            JSON.stringify({ upload_id: 1, split_failed: opts.splitFailed ?? 0 }),
            { status: 200 },
          );
        }
        sent.push({
          url,
          secret: new Headers(init?.headers).get("X-Alc-Proxy-Secret"),
          body: JSON.parse(String(init?.body)) as SentRequest["body"],
        });
        return opts.sendOk === false
          ? new Response("recipient_not_found", { status: 404 })
          : new Response("", { status: 204 });
      },
    },
    // KINTAI_COMP_ID / AUTH_WORKER_RPC は置かない — alc 履歴は書けずに
    // `scrape_history: "no_tenant"` で落ちるが、それは通知経路とは独立
    // (「durable な記録が書けなくても通知は出る」の確認も兼ねる)。
  };
  const stored = new Map<string, unknown>();
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      delete: async () => {},
    },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const run = (
    relay as unknown as {
      runCronDtakoScrape(
        account: typeof ACCOUNT,
        range: typeof RANGE,
        jobKey: string,
      ): Promise<void>;
    }
  ).runCronDtakoScrape.bind(relay);
  return { sent, mails, stored, run };
}

function captureConsoleError() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return {
    lines,
    restore: () => spy.mockRestore(),
    /** JSON 1 行のうち `status` が一致するものを 1 件返す。 */
    find(status: string) {
      return lines
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return {};
          }
        })
        .find((o) => o.status === status);
    },
  };
}

afterEach(() => {
  vi.mocked(scrapeViaHttp).mockReset();
});

/**
 * ★ #967 の**配線**に対する対照。
 *
 * `scrape-alert.ts` 側は 100% gate に載っているが、**gate が緑でも
 * 「catch から呼んでいない」は捕まらない** (`dtako-scraper-relay-do.ts` は
 * `vitest.config.ts` の allowlist に無く、node vitest では計測できない)。
 * ここで測るのは「失敗したときに実際に 1 通出るか」だけ。
 *
 * theearth へは 1 回も繋がない — `scrapeViaHttp` を throw させるだけで catch に入る。
 * 通知の送り先は `AUTH_WORKER` service binding なので、**上流 theearth への往復は
 * この経路で 1 回も増えない** (ユーザー判断 2026-08-29)。
 */
describe("runCronDtakoScrape の失敗を人へ届ける (Refs #967)", () => {
  it("★ 失敗すると LINE WORKS へ 1 通出る (会社 / 読取日 / 理由が載る)", async () => {
    const { sent, stored, run } = makeDO();
    scrapeViaHttp.mockRejectedValue(new Error("csvdata.zip が取れません"));
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-1");
    errs.restore();

    // theearth は 1 回だけ (= 従来どおり)。通知でも再試行でも増えていない。
    expect(scrapeViaHttp).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain(LINEWORKS_SEND_PATH);
    expect(sent[0]!.secret).toBe("shared-secret");
    expect(sent[0]!.body.channel_id).toBe(CHANNEL_ID);
    expect(sent[0]!.body.text).toContain("comp_id 27324455");
    expect(sent[0]!.body.text).toContain("2026/08/28分");
    expect(sent[0]!.body.text).toContain("csvdata.zip が取れません");
    // 従来の記録は 1 つも失われていない。
    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-1")).toMatchObject({ state: "failed" });
    expect(errs.find("error")).toMatchObject({ comp_id: "27324455" });
  });

  it("★ 原本 (theearth の HTML) の中身は通知に出ない — R2 に在るという事実だけ", async () => {
    const { sent, run } = makeDO();
    // fixture は自作のダミー。実際の原本は 1 文字も使わない。
    const { TheearthClientError } = await import("../src/theearth-client");
    scrapeViaHttp.mockRejectedValue(
      new TheearthClientError(
        'ログイン POST が HTTP 500 を返しました (title="エラー" 本文先頭: \\\\dummy-host\\dummy-share は使用中)',
      ),
    );
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-2");
    errs.restore();

    const text = sent[0]!.body.text;
    expect(text).toContain("ログイン POST が HTTP 500 を返しました");
    expect(text).not.toContain("dummy-host");
    expect(text).not.toContain("dummy-share");
    expect(text).not.toContain("本文先頭");
    // R2 binding を置いていないので原本は残っていない。そう書く (嘘をつかない)。
    expect(text).toContain("原本は保存されていません");
  });

  it("★ 宛先が未設定なら送らず、送っていないことを console.error に出す (fail-closed)", async () => {
    const { sent, run } = makeDO({ scrapeAlertTarget: undefined });
    scrapeViaHttp.mockRejectedValue(new Error("失敗"));
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-3");
    errs.restore();

    expect(sent).toHaveLength(0);
    // 黙って何もしないのが一番危ない。理由が必ずログに残る。
    expect(errs.find("scrape_alert_not_sent")).toMatchObject({
      reason: expect.stringContaining("SCRAPE_ALERT_TARGET"),
    });
  });

  it("★ INTERNAL_SHARED_SECRET が無ければ送らず、そちらを名指しする", async () => {
    const { sent, run } = makeDO({ sharedSecret: undefined });
    scrapeViaHttp.mockRejectedValue(new Error("失敗"));
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-4");
    errs.restore();

    expect(sent).toHaveLength(0);
    expect(errs.find("scrape_alert_not_sent")).toMatchObject({
      reason: expect.stringContaining("INTERNAL_SHARED_SECRET"),
    });
  });

  it("★ 通知の送信が落ちても取り込みの失敗記録は残る (best-effort・再送しない)", async () => {
    const { sent, stored, run } = makeDO({ sendOk: false });
    scrapeViaHttp.mockRejectedValue(new Error("失敗"));
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-5");
    errs.restore();

    // 1 回だけ試して諦める (リトライを入れないというユーザー判断の対照)。
    expect(sent).toHaveLength(1);
    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-5")).toMatchObject({ state: "failed" });
    expect(errs.find("scrape_alert_send_failed")).toMatchObject({
      reason: expect.stringContaining("LINE WORKS 送信失敗"),
    });
  });

  it("★ Secrets Store の .get() が落ちても runCronDtakoScrape ごと抜けない", async () => {
    // #967 で `resolveSecret` を try の外へ持ち上げた副作用の対照。持ち上げただけ
    // (`.catch()` 無し) だと reject が `alarm()` まで飛び、job は `running` のまま
    // 失敗記録も残らない — **通知を足す前より悪くなる**。
    const { sent, stored, run } = makeDO({ secretRejects: true });
    scrapeViaHttp.mockRejectedValue(new Error("失敗"));
    const errs = captureConsoleError();

    // ここで reject すると「抜けている」= 回帰。
    await expect(run(ACCOUNT, RANGE, "job-7")).resolves.toBeUndefined();
    errs.restore();

    // 従来どおり失敗として記録される。
    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-7")).toMatchObject({ state: "failed" });
    // 秘密が取れないので通知は送れない。送っていないことは名指しで残す。
    expect(sent).toHaveLength(0);
    expect(errs.find("scrape_alert_not_sent")).toMatchObject({
      reason: expect.stringContaining("INTERNAL_SHARED_SECRET"),
    });
  });

  it("★ 成功したときは 1 通も送らない (陰性対照)", async () => {
    const { sent, mails, run } = makeDO();
    // ZIP マジック (`PK\x03\x04`) だけを持つ最小の応答。alc へのアップロードは
    // 上の stub が 200 を返すので、catch には 1 度も入らない。
    scrapeViaHttp.mockResolvedValue(ZIP);
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-6");
    errs.restore();

    // アップロード先 (alc-internal-proxy) は叩くが、LINE WORKS へもメールへも 1 通も出さない。
    expect(sent).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });
});

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;

/** MIME の本文 (ヘッダの後の空行より後ろ)。本文は 8bit なのでそのまま読める。 */
function mailBody(raw: string): string {
  return raw.slice(raw.search(/\r?\n\r?\n/)).trim();
}

/**
 * ★ #1206 の**配線**。メールは LINE WORKS と独立に送られ、通知が拾う範囲が
 * 取り込み本体の失敗の外 (分割・secret 欠け・畳み直し・要再計算) にも広がったこと。
 * 判定と文面は `scrape-alert-email.ts` (100% gate) 側、ここは「呼んでいるか」だけ。
 */
describe("取り込みの失敗をメールでも届ける (Refs #1206)", () => {
  afterEach(() => {
    foldMonth.mockReset();
  });

  it("★ 取り込み本体の失敗で、LINE WORKS と同じ文面のメールが 1 通出る", async () => {
    const { sent, mails, run } = makeDO();
    scrapeViaHttp.mockRejectedValue(new Error("csvdata.zip が取れません"));
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-m1");
    errs.restore();

    expect(sent).toHaveLength(1);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.from).toBe("relay@example.com");
    expect(mails[0]!.to).toBe("alert@example.com");
    expect(mailBody(mails[0]!.raw)).toBe(sent[0]!.body.text);
  });

  it("★ LINE WORKS の送信が落ちてもメールは出る", async () => {
    const { mails, run } = makeDO({ sendOk: false });
    scrapeViaHttp.mockRejectedValue(new Error("失敗"));
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-m2");
    errs.restore();

    expect(errs.find("scrape_alert_send_failed")).toBeDefined();
    expect(mails).toHaveLength(1);
  });

  it("★ LINE WORKS の宛先が未設定でもメールは出る", async () => {
    const { sent, mails, run } = makeDO({ scrapeAlertTarget: undefined });
    scrapeViaHttp.mockRejectedValue(new Error("失敗"));
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-m3");
    errs.restore();

    expect(sent).toHaveLength(0);
    expect(mails).toHaveLength(1);
  });

  it("★ メールの binding / 設定が無くても LINE WORKS は出て、送らなかったことを名指しする", async () => {
    for (const opts of [{ noEmailBinding: true }, { emailConfig: null }] as const) {
      const { sent, mails, run } = makeDO(opts);
      scrapeViaHttp.mockRejectedValue(new Error("失敗"));
      const errs = captureConsoleError();

      await run(ACCOUNT, RANGE, "job-m4");
      errs.restore();

      expect(sent).toHaveLength(1);
      expect(mails).toHaveLength(0);
      expect(errs.find("scrape_alert_email_not_sent")).toMatchObject({ comp_id: ACCOUNT.comp_id });
    }
  });

  it("★ D1: CSV の分割が落ちたら (state は done のまま) 件数を載せて 1 通", async () => {
    const { sent, mails, stored, run } = makeDO({ splitFailed: 3 });
    scrapeViaHttp.mockResolvedValue(ZIP);
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-d1");
    errs.restore();

    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-d1")).toMatchObject({ state: "done", split_failed: 3 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.text).toContain("CSV の分割が 3 件失敗");
    expect(mails).toHaveLength(1);
    expect(mailBody(mails[0]!.raw)).toContain("CSV の分割が 3 件失敗");
  });

  it("★ D2: INTERNAL_SHARED_SECRET 未設定の早期 return でもメールは出る (LINE WORKS は送れない)", async () => {
    const { sent, mails, stored, run } = makeDO({ sharedSecret: undefined });
    scrapeViaHttp.mockResolvedValue(ZIP);
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-d2");
    errs.restore();

    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-d2")).toMatchObject({ state: "failed" });
    expect(sent).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(mailBody(mails[0]!.raw)).toContain("INTERNAL_SHARED_SECRET 未設定のためアップロード不能");
  });

  it("★ D3: 畳み直しの設定が欠けていたら (not_configured) 1 通", async () => {
    const { mails, run } = makeDO({ fold: "not_configured" });
    scrapeViaHttp.mockResolvedValue(ZIP);
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-d3a");
    errs.restore();

    expect(foldMonth).not.toHaveBeenCalled();
    expect(mails).toHaveLength(1);
    expect(mailBody(mails[0]!.raw)).toContain("勤怠の畳み直しに要る設定が未設定");
  });

  it("★ D3: 畳み直しが落ちたら (fold_state: failed) 1 通 — 生のエラー文は載せない", async () => {
    const { mails, sent, run } = makeDO({ fold: "configured" });
    scrapeViaHttp.mockResolvedValue(ZIP);
    foldMonth.mockRejectedValue(new Error("ichiban 503 dummy-raw-detail"));
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-d3b");
    errs.restore();

    expect(foldMonth).toHaveBeenCalledTimes(1);
    expect(mails).toHaveLength(1);
    const body = mailBody(mails[0]!.raw);
    expect(body).toContain("勤怠の畳み直しが失敗");
    expect(body).not.toContain("dummy-raw-detail");
    expect(sent[0]!.body.text).not.toContain("dummy-raw-detail");
  });

  it("★ D3 陰性対照: 畳み直しが通れば 1 通も出ない", async () => {
    const { mails, sent, run } = makeDO({ fold: "configured" });
    scrapeViaHttp.mockResolvedValue(ZIP);
    foldMonth.mockResolvedValue({ pages: 1, attemptedGateClose: false, driversWritten: 2, capped: false });
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-d3c");
    errs.restore();

    expect(foldMonth).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  it("★ D4: 要再計算が failed > 0 を返したら 1 通", async () => {
    const { mails, run } = makeDO({ pendingBody: { processed: 5, failed: 2, remaining: 0 } });
    scrapeViaHttp.mockResolvedValue(ZIP);
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-d4a");
    errs.restore();

    expect(mails).toHaveLength(1);
    expect(mailBody(mails[0]!.raw)).toContain("要再計算が 2 件失敗");
  });

  it("★ D4: 要再計算の応答が読めなければ (error) 1 通", async () => {
    const { mails, run } = makeDO({ pendingBody: { unexpected: true } });
    scrapeViaHttp.mockResolvedValue(ZIP);
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-d4b");
    errs.restore();

    expect(mails).toHaveLength(1);
    expect(mailBody(mails[0]!.raw)).toContain("要再計算の呼び出しが失敗 (parse)");
  });

  it("★ D4: remaining > 0 だけ (続きがある) は鳴らさない", async () => {
    // 上限回数まで毎回 remaining を返す = 打ち切り。失敗ではない。
    const { mails, sent, run } = makeDO({ pendingBody: { processed: 10, failed: 0, remaining: 5 } });
    scrapeViaHttp.mockResolvedValue(ZIP);
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-d4c");
    errs.restore();

    expect(sent).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  it("★ 同じ取り込みで複数起きたら理由を並べて 1 通 (1 回の取り込みにつき最大 1 通)", async () => {
    const { mails, sent, run } = makeDO({
      splitFailed: 4,
      pendingBody: { processed: 5, failed: 1, remaining: 0 },
    });
    scrapeViaHttp.mockResolvedValue(ZIP);
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-multi");
    errs.restore();

    expect(sent).toHaveLength(1);
    expect(mails).toHaveLength(1);
    const body = mailBody(mails[0]!.raw);
    expect(body).toContain("CSV の分割が 4 件失敗 / 要再計算が 1 件失敗");
  });
});
