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

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { LINEWORKS_SEND_PATH } from "../src/lineworks-notify";
import { SCRAPE_JOB_KEY_PREFIX } from "../src/scrape-queue";

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

function makeDO(opts: { scrapeAlertTarget?: string; sharedSecret?: string; sendOk?: boolean } = {}) {
  const sent: SentRequest[] = [];
  const env = {
    DTAKO_CONFIG_KV: { get: async () => null },
    INTERNAL_SHARED_SECRET: "sharedSecret" in opts ? opts.sharedSecret : "shared-secret",
    SCRAPE_ALERT_TARGET:
      "scrapeAlertTarget" in opts ? opts.scrapeAlertTarget : `{"channel_id":"${CHANNEL_ID}"}`,
    AUTH_WORKER: {
      fetch: async (url: string, init?: RequestInit) => {
        if (!isLineworksSend(url)) {
          // alc へのアップロード (`/api/upload`)。中身は見ない。
          return new Response(JSON.stringify({ upload_id: 1, split_failed: 0 }), { status: 200 });
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
  return { sent, stored, run };
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

  it("★ 成功したときは 1 通も送らない (陰性対照)", async () => {
    const { sent, run } = makeDO();
    // ZIP マジック (`PK\x03\x04`) だけを持つ最小の応答。alc へのアップロードは
    // 上の stub が 200 を返すので、catch には 1 度も入らない。
    scrapeViaHttp.mockResolvedValue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer);
    const errs = captureConsoleError();

    await run(ACCOUNT, RANGE, "job-6");
    errs.restore();

    // アップロード先 (alc-internal-proxy) は叩くが、LINE WORKS へは 1 通も出さない。
    expect(sent).toHaveLength(0);
  });
});
