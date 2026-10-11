import { afterEach, describe, expect, it, vi } from "vitest";

// do-kintai-comp-scope.test.ts と同じ手。`cloudflare:workers` は Workers
// ランタイムでしか解決できないので、DurableObject を素のクラスで差し替える。
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

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import type { RestraintPushBody } from "../src/restraint-push";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/**
 * 拘束サマリの写しを勤怠 Worker だけへ PUT する (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * - 本番設定 (`KINTAI` binding + `KINTAI_WRITE_TOKEN`) では Worker へ PUT が `X-Kintai-Write-Token`
 *   付きで飛び、素の `fetch` (旧オンプレ版の宛先) は 1 回も呼ばない
 * - best-effort — 失敗 (403・503・例外) は結果に載せて throw しない
 * - binding / token が無い (staging・preview の形) と skip
 * - resummarize の応答に Worker の結果が載る
 */
const COMP = "27324455";
const TENANT = "tenant-1";
const WRITE_TOKEN = "kintai-write-token-value";
const ACCOUNTS = [{ comp_id: COMP, user_name: "u1", user_pass: "p", tenant_id: TENANT }];

/** Shift_JIS の符号化 (resummarize は R2 の CSV を shift_jis で読むため)。TextDecoder の逆引き表で作る。 */
function encodeShiftJis(text: string): Uint8Array {
  const table = new Map<string, number[]>();
  const dec = new TextDecoder("shift_jis");
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    if (hi >= 0xa0 && hi <= 0xdf) continue;
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      const ch = dec.decode(new Uint8Array([hi, lo]));
      if (ch.length === 1 && ch !== "�" && !table.has(ch)) table.set(ch, [hi, lo]);
    }
  }
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) out.push(code);
    else {
      const bytes = table.get(ch);
      if (!bytes) throw new Error(`shift_jis に無い文字: ${ch}`);
      out.push(...bytes);
    }
  }
  return new Uint8Array(out);
}

const HEADER_LINE =
  "日付,始業時刻,終業時刻,運転時間,重複運転時間,荷役時間,重複荷役時間,休憩時間,重複休憩時間,時間,重複時間,拘束時間小計,重複拘束時間小計,拘束時間合計,拘束時間累計,前運転平均,後運転平均,休息時間,実働時間,時間外時間,深夜時間,時間外深夜時間,摘要1,摘要2";

/** theearth-restraint-client.test.ts の SAMPLE_CSV と同じ構造の架空データ (乗務員 2 名)。 */
const SAMPLE_CSV = [
  "拘束時間管理表 (2026年 6月分)",
  "※当月の最大拘束時間 : 275 時間（労使協定により時間を記入する）",
  "",
  "事業所,テスト運輸　第一営業所,乗務員分類1,テスト1班",
  "氏名,試験　太郎,乗務員コード,9901",
  HEADER_LINE,
  "6月1日,8:00,21:30,5:00,1:00,3:00,0:30,1:00,,,,12:30,1:00,13:30,13:30,,4:00,10:30,9:00,,0:30,0:10,,",
  "合計,,,5:00,,3:00,,1:00,,,,12:30,,,,,,10:30,9:00,,0:30,0:10,,",
  "",
  "事業所,テスト運輸　第二営業所,乗務員分類1,テスト2班",
  "氏名,試験　次郎,乗務員コード,9902",
  HEADER_LINE,
  "6月3日,9:00,17:00,4:00,,2:00,,1:00,,,,8:00,,8:00,8:00,,4:00,16:00,7:00,,,,,",
  "合計,,,4:00,,2:00,,1:00,,,,8:00,,,,,,16:00,7:00,,,,,",
  "",
].join("\r\n");

/** DO が使う R2 の面だけ (`get` は `arrayBuffer` も返す)。 */
function memoryR2(seed: Record<string, Uint8Array>) {
  const store = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();
  for (const [k, v] of Object.entries(seed)) store.set(k, { bytes: v });
  return {
    put: async (key: string, body: ArrayBuffer | Uint8Array | string, opts?: { customMetadata?: Record<string, string> }) => {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
      store.set(key, { bytes, customMetadata: opts?.customMetadata });
    },
    get: async (key: string) => {
      const obj = store.get(key);
      if (!obj) return null;
      return {
        customMetadata: obj.customMetadata,
        arrayBuffer: async () => obj.bytes.slice().buffer,
        text: async () => new TextDecoder().decode(obj.bytes),
      };
    },
    head: async (key: string) => {
      const obj = store.get(key);
      return obj ? { customMetadata: obj.customMetadata } : null;
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      truncated: false as const,
    }),
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
}


interface PutCall {
  url: string;
  headers: Record<string, string>;
  body: RestraintPushBody;
}

type Reply = () => Promise<Response>;
const ok: Reply = async () => Response.json({ saved: 1, synced_at: "x" });

interface Setup {
  /** 勤怠 Worker の binding を置くか (既定 true = 本番の形)。 */
  kintaiBinding?: boolean;
  /** `KINTAI_WRITE_TOKEN` の binding (既定 = Secrets Store 形で WRITE_TOKEN)。 */
  writeToken?: unknown;
  kintai?: Reply;
}

function makeDO(opts: Setup = {}) {
  /** 素の `fetch` (旧オンプレ版の宛先)。**1 回も呼ばれないこと**を見る。 */
  const globalFetchCalls: string[] = [];
  const kintaiCalls: PutCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      globalFetchCalls.push(String(input));
      return ok();
    }),
  );
  const csvKey = `restraint/${COMP}/2026-06/csv/all/latest.csv`;
  const env = {
    DTAKO_R2: memoryR2({ [csvKey]: encodeShiftJis(SAMPLE_CSV) }),
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
    ...(opts.kintaiBinding === false
      ? {}
      : {
          KINTAI: {
            fetch: vi.fn(async (input: string, init?: RequestInit) => {
              kintaiCalls.push({
                url: input,
                headers: { ...(init?.headers as Record<string, string>) },
                body: JSON.parse(String(init?.body)) as RestraintPushBody,
              });
              return (opts.kintai ?? ok)();
            }),
          },
        }),
    KINTAI_WRITE_TOKEN: "writeToken" in opts ? opts.writeToken : { get: async () => WRITE_TOKEN },
    AUTH_WORKER: {
      fetch: vi.fn(async () => Response.json({ active: true, tenant_id: TENANT, email: "viewer@example.com" })),
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const resummarize = () =>
    relay.fetch(
      new Request(`https://relay.example/restraint-api/archive/resummarize?month=2026-06`, {
        method: "POST",
        headers: {
          Authorization: "Bearer dummy-jwt",
          "X-Theearth-Comp-Id": COMP,
          "X-Theearth-User-B64": "dmlld2Vy",
        },
      }) as never,
    );
  /** 機械経路 (Refs ohishi-exp/rust-ichibanboshi#322)。viewer の認証ヘッダーは付けない。 */
  const cron = (path: string, body: unknown) =>
    relay.fetch(
      new Request(`https://relay.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }) as never,
    );
  /** private の送り手を直に呼ぶ (取り込み 4 経路はどれもこの 1 か所を呼ぶ)。 */
  const push = (entries: unknown[]) =>
    (relay as unknown as {
      pushRestraintSummariesToIchiban(c: string, s: string, ym: string, e: unknown[]): Promise<unknown>;
    }).pushRestraintSummariesToIchiban(COMP, "theearth", "2026-06", entries);
  return { resummarize, cron, push, globalFetchCalls, kintaiCalls, env };
}

const META = { sha256: "a".repeat(64), fetchedAt: "f", lastVerifiedAt: "l" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resummarize の拘束サマリ push (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  it("★ 本番設定では Worker へ X-Kintai-Write-Token 付きで PUT し、素の fetch (オンプレ) は 0 回。応答に Worker の結果だけを載せる", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { resummarize, globalFetchCalls, kintaiCalls } = makeDO();
    const res = await resummarize();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summaries_written: number; restraint_push: unknown };
    expect(body.summaries_written).toBe(2);
    expect(body.restraint_push).toEqual({ kintai: { outcome: "done", puts: 1 } });

    expect(globalFetchCalls).toEqual([]);
    expect(kintaiCalls).toHaveLength(1);
    const [kintai] = kintaiCalls;
    expect(new URL(kintai!.url).pathname).toBe("/api/restraint/summaries");
    // 乗務員 2 名・theearth・2026-06
    expect(kintai!.body.entries.map((e) => e.driver_cd)).toEqual(["9901", "9902"]);
    expect(kintai!.body).toMatchObject({ comp_id: COMP, source: "theearth", month: "2026-06" });
    expect(kintai!.headers).toEqual({ "content-type": "application/json", "X-Kintai-Write-Token": WRITE_TOKEN });
  });

  it("★ binding が無い (staging・preview の形) と push は skip (素の fetch も 0 回)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { resummarize, globalFetchCalls, kintaiCalls } = makeDO({ kintaiBinding: false });
    const res = await resummarize();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restraint_push: unknown };
    expect(body.restraint_push).toEqual({ kintai: { outcome: "skipped-not-configured" } });
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls).toHaveLength(0);
  });
});

describe("/cron/restraint-resummarize (機械経路、Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  it("★ viewer 認証なしで resummarize の本体を走らせ、応答に restraint_push が載る", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { cron, globalFetchCalls, kintaiCalls, env } = makeDO();
    const res = await cron("/cron/restraint-resummarize", { comp_id: COMP, month: "2026-06" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ month: "2026-06", csv_processed: 1, summaries_written: 2, errors: [] });
    expect(body.restraint_push).toEqual({ kintai: { outcome: "done", puts: 1 } });
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls[0]!.body).toMatchObject({ comp_id: COMP, source: "theearth", month: "2026-06" });
    // viewer の認証 (auth-worker introspect) は経由しない
    expect(env.AUTH_WORKER.fetch).not.toHaveBeenCalled();
  });

  it("month が YYYY-MM でなければ 400 (本体の parseMonthParam)", async () => {
    const { cron, kintaiCalls } = makeDO();
    const res = await cron("/cron/restraint-resummarize", { comp_id: COMP, month: "2026-6" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "month は YYYY-MM で指定してください" });
    expect(kintaiCalls).toHaveLength(0);
  });

  it.each([
    ["/cron/restraint-resummarize", "JSON でない", "not json", "body must be JSON"],
    ["/cron/restraint-resummarize", "comp_id 無し", { month: "2026-06" }, "comp_id / month は必須です"],
    ["/cron/restraint-resummarize", "month 無し", { comp_id: COMP }, "comp_id / month は必須です"],
    ["/cron/restraint-sync", "JSON でない", "not json", "body must be JSON"],
    ["/cron/restraint-sync", "comp_id が空白だけ", { comp_id: "  ", month: "2026-06" }, "comp_id / month は必須です"],
  ])("%s: body が%sなら 400 (restraint-sync と同じ helper)", async (path, _l, body, error) => {
    const { cron } = makeDO();
    const res = await cron(path, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });
});

describe("pushRestraintSummariesToIchiban の結果", () => {
  const entries = [{ kind: "no-data", driverCd: "9901", meta: META }];

  it.each([
    ["403", async () => new Response("forbidden", { status: 403 }), { outcome: "upstream-error", status: 403 }],
    ["503", async () => new Response("no binding", { status: 503 }), { outcome: "upstream-error", status: 503 }],
    [
      "例外",
      async () => {
        throw new Error("boom");
      },
      { outcome: "error", error: "Error: boom" },
    ],
  ] as Array<[string, Reply, unknown]>)("★ Worker の失敗 (%s) は結果に載り、throw しない", async (_l, kintai, expected) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { push, globalFetchCalls, kintaiCalls } = makeDO({ kintai });
    expect(await push(entries)).toEqual({ kintai: expected });
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls).toHaveLength(1);
    // ログに token を出さない
    expect(JSON.stringify(err.mock.calls)).not.toContain(WRITE_TOKEN);
  });

  it("no-data の entry は no_data の行として送る", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { push, globalFetchCalls, kintaiCalls } = makeDO();
    expect(await push(entries)).toEqual({ kintai: { outcome: "done", puts: 1 } });
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls).toHaveLength(1);
    expect(kintaiCalls[0]!.body.entries).toEqual([
      { driver_cd: "9901", no_data: true, fetched_at: "f", last_verified_at: "l" },
    ]);
  });

  it.each([
    ["未設定", undefined],
    ["空", ""],
  ])("★ token が%sなら skip (binding はあっても叩かない)", async (_l, writeToken) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { push, globalFetchCalls, kintaiCalls } = makeDO({ writeToken });
    expect(await push(entries)).toEqual({ kintai: { outcome: "skipped-not-configured" } });
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls).toHaveLength(0);
  });

  it("token の読み出しが throw しても skip するだけ (log は残す)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { push, globalFetchCalls, kintaiCalls } = makeDO({
      writeToken: {
        get: async () => {
          throw new Error("store unavailable");
        },
      },
    });
    expect(await push(entries)).toEqual({ kintai: { outcome: "skipped-not-configured" } });
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls).toHaveLength(0);
    expect(err.mock.calls.map((c) => JSON.parse(String(c[0])))).toContainEqual({
      restraint_push: "secret-error",
      target: "kintai",
      error: "Error: store unavailable",
    });
  });

  it("entries が空なら何も叩かない", async () => {
    const { push, globalFetchCalls, kintaiCalls } = makeDO();
    expect(await push([])).toEqual({ kintai: { outcome: "skipped-empty" } });
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls).toHaveLength(0);
  });
});
