import { afterEach, describe, expect, it, vi } from "vitest";

// do-recalc-pending.test.ts と同じ手 (cloudflare:workers を素のクラスに差し替えて DO を node で読む)。
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
import { SCRAPE_JOB_KEY_PREFIX } from "../src/scrape-queue";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/** 架空の値 (本番の tenant ではない)。この repo は public。 */
const ACCOUNT = { comp_id: "27324455", tenant_id: "tenant-of-27324455", user_name: "u", user_pass: "p" };
const RANGE = { startDate: "2026-11-25", endDate: "2026-11-25" };

/** stored の local file header だけを並べた最小の zip (`listZipEntryNames` は local header を歩く)。 */
function zipOf(names: string[]): ArrayBuffer {
  const parts = names.map((name) => {
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
    return out;
  });
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return buf.buffer;
}

function makeDO() {
  const env = {
    DTAKO_CONFIG_KV: { get: async () => null },
    INTERNAL_SHARED_SECRET: "shared-secret",
    AUTH_WORKER: {
      fetch: async (url: string) =>
        url.includes(RECALC_PENDING_PATH)
          ? new Response(JSON.stringify({ processed: 0, failed: 0, remaining: 0 }))
          : new Response(JSON.stringify({ upload_id: "u1", split_failed: 0 })),
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
  const spyable = relay as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  vi.spyOn(spyable, "foldAfterIngest").mockResolvedValue(undefined);
  return { stored, priv: spyable };
}

function capture() {
  const warns: string[] = [];
  const others: string[] = [];
  const spies = [
    vi.spyOn(console, "warn").mockImplementation((l: unknown) => void warns.push(String(l))),
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void others.push(String(l))),
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void others.push(String(l))),
  ];
  return { warns, others, restore: () => spies.forEach((s) => s.mockRestore()) };
}

afterEach(() => {
  scrapeViaHttp.mockReset();
  vi.restoreAllMocks();
});

describe("日次 cron の zip に KUDGSIR.csv が無ければ warn を 1 行 (Refs #1287)", () => {
  it("★ 無い: 中身の一覧つきで warn 1 行。取り込みは done のまま (失敗にしない)", async () => {
    const { stored, priv } = makeDO();
    scrapeViaHttp.mockResolvedValue(zipOf(["KUDGFRY.csv", "KUDGIVT.csv", "KUDGURI.csv", "SokudoData.csv"]));
    const c = capture();
    await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-1");
    c.restore();

    const hits = c.warns.filter((l) => l.includes("cron_zip_without_kudgsir"));
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0])).toMatchObject({
      comp_id: ACCOUNT.comp_id,
      status: "cron_zip_without_kudgsir",
      entries: ["KUDGFRY.csv", "KUDGIVT.csv", "KUDGURI.csv", "SokudoData.csv"],
    });
    // 確認段の `no_kudgsir` とは別の語 (同じ語で出すと見分けられない)
    expect(hits[0]).not.toContain('"no_kudgsir"');
    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-1")).toMatchObject({ state: "done" });
  });

  it("★ 有る: warn は出ない (陽性対照 — 同じ経路で zip の中身だけ変える)", async () => {
    const { stored, priv } = makeDO();
    scrapeViaHttp.mockResolvedValue(zipOf(["KUDGIVT.csv", "KUDGSIR.csv", "KUDGURI.csv", "SokudoData.csv"]));
    const c = capture();
    await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-2");
    c.restore();

    expect(c.warns.filter((l) => l.includes("cron_zip_without_kudgsir"))).toEqual([]);
    expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-2")).toMatchObject({ state: "done" });
  });
});
