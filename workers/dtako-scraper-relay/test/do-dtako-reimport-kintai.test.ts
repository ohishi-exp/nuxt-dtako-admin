import { afterEach, describe, expect, it, vi } from "vitest";

// do-wage-snapshot-kintai.test.ts と同じ手。`cloudflare:workers` は Workers
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

/** theearth へは 1 回も繋がない。ログイン・再集計・zip 取得だけを差し替える (他の export は原本のまま)。 */
const { login } = vi.hoisted(() => ({ login: vi.fn(async () => ({ kicked: false })) }));
vi.mock("../src/theearth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/theearth-client")>()),
  login,
}));
const { downloadOperationCsvZip, releaseLoadedOperation, recalculateWorkUnattended } = vi.hoisted(() => ({
  downloadOperationCsvZip: vi.fn(),
  releaseLoadedOperation: vi.fn(async () => {}),
  recalculateWorkUnattended: vi.fn(async () => ({ unlocked: false, selfUnlocked: false })),
}));
vi.mock("../src/theearth-report-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/theearth-report-client")>()),
  downloadOperationCsvZip,
  releaseLoadedOperation,
  recalculateWorkUnattended,
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/**
 * `POST /cron/dtako/reimport` (`run_dtako_reimport`) の ② 取り込みの送り先 (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * 振り分け (`kintaiAutoloader`) と 502 の扱い (`runDtakoReimport`) は 100% gate に載る pure ロジックだが、
 * DO が単体・バッチの両方でそれを使うか、CF Access の 503 判定を Worker 経路の前に置いていないかは
 * gate では捕まらない。ここで測るのは:
 *
 * - (a) 本番設定 (KINTAI・comp = KINTAI_COMP_ID・token あり) → 単体・バッチとも Worker へ token 付きで送り、
 *       オンプレを 0 回呼ぶ。CF Access が未設定でも通る
 * - (b) binding 無し・別会社・token が読めない → オンプレ版 (CF Access 付き)
 * - (c) binding あり・token が読めない・CF Access 無し → 503 と console.error
 * - (d) Worker の 502 → uncertain
 *
 * comp・tenant・URL は架空 (この repo は public)。
 */
const OWN_COMP = "27324455";
const OTHER_COMP = "75700192";
const WRITE_TOKEN = "dummy-write-token";
const UNKO_NO = "26060507533000000042861";
const ITEM = { ope_no: UNKO_NO.slice(0, 22), start_ope: "2026/06/05 7:53:30", unko_no: UNKO_NO };
const AUTOLOADED = { http_status: 200, http_ok: true };

const ACCOUNTS = [
  { comp_id: OWN_COMP, user_name: "u1", user_pass: "p", tenant_id: "tenant-a" },
  { comp_id: OTHER_COMP, user_name: "u2", user_pass: "p", tenant_id: "tenant-b" },
];

const CF_ACCESS = {
  NUXT_ICHIBAN_API_URL: "https://ichiban.invalid",
  NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid",
  ICHIBAN_CF_ACCESS_CLIENT_SECRET: "csecret",
};

/** `PK\x03\x04` + ファイル名だけの最小 ZIP (dtako-reimport.test.ts と同じ)。 */
function minimalZip(name = "KUDGIVT.csv"): ArrayBuffer {
  const nameBytes = new TextEncoder().encode(name);
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(26, nameBytes.length, true);
  header.set(nameBytes, 30);
  return header.buffer;
}

interface Setup {
  /** 勤怠 Worker の binding を置くか (既定 true)。 */
  kintai?: boolean;
  /** `KINTAI_WRITE_TOKEN` の binding (既定 = Secrets Store 形で WRITE_TOKEN)。 */
  writeToken?: unknown;
  /** オンプレ版の CF Access を置くか (既定 true)。 */
  cfAccess?: boolean;
  /** 勤怠 Worker の応答 (既定 AUTOLOADED)。 */
  kintaiResponse?: () => Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDO(opts: Setup = {}) {
  downloadOperationCsvZip.mockReset().mockImplementation(async () => minimalZip());
  const kintaiCalls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const onpremCalls: { url: string; headers: Record<string, string> }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    onpremCalls.push({ url: String(input), headers: init?.headers as Record<string, string> });
    return Response.json(AUTOLOADED);
  });
  const env = {
    ...(opts.kintai === false
      ? {}
      : {
          KINTAI: {
            fetch: vi.fn(async (url: string, init?: RequestInit) => {
              kintaiCalls.push({ url, headers: init?.headers as Record<string, string>, body: init?.body });
              return opts.kintaiResponse ? opts.kintaiResponse() : Response.json(AUTOLOADED);
            }),
          },
        }),
    KINTAI_WRITE_TOKEN: "writeToken" in opts ? opts.writeToken : { get: async () => WRITE_TOKEN },
    KINTAI_COMP_ID: OWN_COMP,
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    ...(opts.cfAccess === false ? {} : CF_ACCESS),
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const post = (body: unknown) =>
    relay.fetch(
      new Request("https://relay.internal/cron/dtako/reimport", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }) as never,
    );
  return { post, kintaiCalls, onpremCalls };
}

const AUTOLOAD_URL = `https://ichibanboshi-kintai/api/dtako/autoload?unko_no=${UNKO_NO}&reset_timecard=false`;

describe("POST /cron/dtako/reimport の ② の送り先 (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  it("(a) 単体: 本番設定なら勤怠 Worker へ token 付きで送り、オンプレは 0 回。CF Access 未設定でも通る", async () => {
    const { post, kintaiCalls, onpremCalls } = makeDO({ cfAccess: false });
    const res = await post({ comp_id: OWN_COMP, ...ITEM });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unko_no: UNKO_NO, http_status: 200, autoload: AUTOLOADED });
    expect(onpremCalls).toEqual([]);
    expect(kintaiCalls).toHaveLength(1);
    expect(kintaiCalls[0]!.url).toBe(AUTOLOAD_URL);
    expect(kintaiCalls[0]!.headers).toEqual({ "content-type": "application/zip", "X-Kintai-Write-Token": WRITE_TOKEN });
    expect(kintaiCalls[0]!.body).toBeInstanceOf(ArrayBuffer);
  });

  it("(a) バッチ: 全件を勤怠 Worker へ送り、オンプレは 0 回。CF Access 未設定でも通る", async () => {
    const { post, kintaiCalls, onpremCalls } = makeDO({ cfAccess: false });
    const second = { ...ITEM, unko_no: `${ITEM.ope_no}2` };
    const res = await post({ comp_id: OWN_COMP, items: [ITEM, second] });
    expect(res.status).toBe(200);
    expect(onpremCalls).toEqual([]);
    expect(kintaiCalls.map((c) => c.url)).toEqual([AUTOLOAD_URL, AUTOLOAD_URL.replace(UNKO_NO, second.unko_no)]);
    expect(kintaiCalls.every((c) => c.headers["X-Kintai-Write-Token"] === WRITE_TOKEN)).toBe(true);
  });

  it.each([
    ["KINTAI が無い", { kintai: false }, OWN_COMP, false],
    ["別の会社", {}, OTHER_COMP, false],
    ["token が読めない", { writeToken: { get: async () => Promise.reject(new Error("store down")) } }, OWN_COMP, true],
  ] as const)("(b) %s ときはオンプレ版へ CF Access 付きで送る", async (_label, setup, compId, logsSecretError) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { post, kintaiCalls, onpremCalls } = makeDO(setup);
    const res = await post({ comp_id: compId, ...ITEM });
    expect(res.status).toBe(200);
    expect(kintaiCalls).toEqual([]);
    expect(onpremCalls).toEqual([
      {
        url: `https://ichiban.invalid/api/dtako/autoload?unko_no=${UNKO_NO}&reset_timecard=false`,
        headers: { "content-type": "application/zip", "CF-Access-Client-Id": "cid", "CF-Access-Client-Secret": "csecret" },
      },
    ]);
    const secretErrors = errors.mock.calls.filter(([line]) => String(line).includes('"dtako_reimport":"secret-error"'));
    expect(secretErrors.length > 0).toBe(logsSecretError);
  });

  it("(c) binding あり・token が読めない・CF Access 無しなら 503。token が読めないことを console.error に出す", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { post, kintaiCalls, onpremCalls } = makeDO({ writeToken: undefined, cfAccess: false });
    const res = await post({ comp_id: OWN_COMP, ...ITEM });
    expect(res.status).toBe(503);
    expect(kintaiCalls).toEqual([]);
    expect(onpremCalls).toEqual([]);
    expect(downloadOperationCsvZip).not.toHaveBeenCalled();
    expect(errors.mock.calls.some(([line]) => String(line).includes("KINTAI_WRITE_TOKEN が読めない"))).toBe(true);
  });

  it("(d) 勤怠 Worker の 502 は uncertain (取り込み済みかもしれないので再実行させない)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { post } = makeDO({ kintaiResponse: () => Response.json({ error: "upstream timeout" }, { status: 502 }) });
    const res = await post({ comp_id: OWN_COMP, ...ITEM });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ uncertain: true });
  });
});
