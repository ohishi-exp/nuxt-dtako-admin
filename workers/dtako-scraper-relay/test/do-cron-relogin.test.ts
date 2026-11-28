import { afterEach, describe, expect, it, vi } from "vitest";

// do-cron-kudgsir-warn.test.ts と同じ手 (cloudflare:workers を素のクラスに差し替えて DO を node で読む)。
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

const { scrapeViaHttp } = vi.hoisted(() => ({ scrapeViaHttp: vi.fn() }));
vi.mock("../src/theearth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/theearth-client")>()),
  scrapeViaHttp,
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { RECALC_PENDING_PATH } from "../src/alc-internal-upload";
import { VenusSessionExpiredError } from "../src/theearth-client";
import { SCRAPE_JOB_KEY_PREFIX } from "../src/scrape-queue";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/** 架空の値 (本番の tenant ではない)。この repo は public。 */
const ACCOUNT = { comp_id: "75700192", tenant_id: "tenant-of-75700192", user_name: "u", user_pass: "p" };
const RANGE = { startDate: "2026-11-27", endDate: "2026-11-27" };

/** stored の local file header 1 つだけの最小の zip。 */
function zipOf(name: string): ArrayBuffer {
  const nameBytes = new TextEncoder().encode(name);
  const data = new TextEncoder().encode("a,b\n");
  const out = new Uint8Array(30 + nameBytes.length + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  out.set(data, 30 + nameBytes.length);
  return out.buffer;
}

/** `upload` を差し替えられる DO。アップロードの呼び出し回数を数える。 */
function makeDO(upload: () => Response = () => new Response(JSON.stringify({ upload_id: "u1", split_failed: 0 }))) {
  const uploads: string[] = [];
  const env = {
    DTAKO_CONFIG_KV: { get: async () => null },
    INTERNAL_SHARED_SECRET: "shared-secret",
    AUTH_WORKER: {
      fetch: async (url: string) => {
        if (url.includes(RECALC_PENDING_PATH)) {
          return new Response(JSON.stringify({ processed: 0, failed: 0, remaining: 0 }));
        }
        uploads.push(url);
        return upload();
      },
    },
  };
  const stored = new Map<string, unknown>();
  const ctx = {
    setWebSocketAutoResponse: () => {},
    waitUntil: () => {},
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      delete: async () => {},
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const priv = relay as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  vi.spyOn(priv, "foldAfterIngest").mockResolvedValue({ alertReason: null, mailLine: null });
  const notify = vi.spyOn(priv, "notifyScrapeFailure").mockResolvedValue(undefined);
  vi.spyOn(priv, "recordCronScrapeHistory").mockResolvedValue(undefined);
  vi.spyOn(priv, "saveScrapeErrorArtifact").mockResolvedValue(null);
  vi.spyOn(priv, "confirmEtcRunsFromZip").mockResolvedValue(undefined);
  return { stored, priv, uploads, notify };
}

function quiet() {
  const warns: string[] = [];
  const spies = [
    vi.spyOn(console, "warn").mockImplementation((l: unknown) => void warns.push(String(l))),
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
  ];
  return { warns, restore: () => spies.forEach((s) => s.mockRestore()) };
}

const expired = () => new VenusSessionExpiredError("theearth のセッションが切れました (ログイン画面への 302)");

afterEach(() => {
  scrapeViaHttp.mockReset();
  vi.restoreAllMocks();
});

describe("日次 cron: アップロード前のセッション切れは 1 回だけログインし直して取り直す", () => {
  it("★ 1 回目がセッション切れ → 2 回目のログインで取れて done。ログインは 2 回 (scrapeViaHttp は呼ぶたびにログインする)", async () => {
    const { stored, priv, uploads, notify } = makeDO();
    scrapeViaHttp.mockRejectedValueOnce(expired()).mockResolvedValueOnce(zipOf("KUDGURI.csv"));
    const q = quiet();
    await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-1");
    q.restore();

    expect(scrapeViaHttp).toHaveBeenCalledTimes(2);
    expect(uploads).toHaveLength(1);
    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-1")).toMatchObject({ state: "done", upload_id: "u1" });
    expect(notify).not.toHaveBeenCalled();
    const relogin = q.warns.filter((l) => l.includes("session_expired_relogin"));
    expect(relogin).toHaveLength(1);
    expect(JSON.parse(relogin[0])).toMatchObject({ comp_id: ACCOUNT.comp_id, status: "session_expired_relogin" });
  });

  it("★ 2 回ともセッション切れ → 3 回目は打たず failed + 通知。アップロードは 0 回", async () => {
    const { stored, priv, uploads, notify } = makeDO();
    scrapeViaHttp.mockRejectedValue(expired());
    const q = quiet();
    await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-2");
    q.restore();

    expect(scrapeViaHttp).toHaveBeenCalledTimes(2);
    expect(uploads).toEqual([]);
    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-2")).toMatchObject({ state: "failed", phase: "pre_upload" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("★ セッション切れでない失敗は取り直さない (陰性対照: 1 回で failed)", async () => {
    const { stored, priv, uploads } = makeDO();
    scrapeViaHttp.mockRejectedValue(new Error("取得したデータが ZIP ではありません (10546 bytes)"));
    const q = quiet();
    await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-3");
    q.restore();

    expect(scrapeViaHttp).toHaveBeenCalledTimes(1);
    expect(uploads).toEqual([]);
    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-3")).toMatchObject({ state: "failed" });
    expect(q.warns.filter((l) => l.includes("session_expired_relogin"))).toEqual([]);
  });

  it("★ アップロードより後の失敗では取り直さない (theearth へのログインは 1 回のまま)", async () => {
    const { stored, priv, uploads } = makeDO(() => new Response(JSON.stringify({ error: "kudguri_invalid" }), { status: 400 }));
    scrapeViaHttp.mockResolvedValue(zipOf("KUDGURI.csv"));
    const q = quiet();
    await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-4");
    q.restore();

    expect(scrapeViaHttp).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-4")).toMatchObject({ state: "failed", phase: "post_upload" });
  });
});
