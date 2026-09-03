import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// do-driver-master-sync.test.ts と同じ手。`cloudflare:workers` は Workers ランタイム
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

import { DtakoScraperRelayDO, type DvrCronLastRun } from "../src/dtako-scraper-relay-do";
import { DVR_MAX_FILES_PER_RUN } from "../src/dvr-ingest";

/**
 * DVR 取り込み cron (`/cron/dvr`) の**配線**に対する対照 (Refs #1094)。
 *
 * pure 側 (`dvr-ingest.test.ts`) が測るのは変換・応答パース・件数の割り振りまで。
 * ここで測るのは DO にしか無い 4 つ:
 *
 * 1. **`X-Tenant-ID` が DTAKO_ACCOUNTS の `tenant_id`** であること (body 由来にすると
 *    comp_id を知っている呼び出し元が任意テナントへ書ける、Refs ippoan/rust-alc-api#434)
 * 2. **`.vdf` を DO が `arrayBuffer()` に読み切らない**こと、および**1 ファイル 1
 *    リクエストで逐次**送ること (forward 先の auth-worker が forward 前に
 *    `arrayBuffer()` でバッファするので、並列にすると同時に持つバッファが件数ぶんになる。
 *    **end-to-end のストリーミングではない** — 2026-09-03 に auth-worker の
 *    origin/main を実読して確認)
 * 3. **転送要求が `Request_DvrFileTransfer_MultiTarget` 1 回**にまとまること
 *    (1 件ずつ N 回叩かない)
 * 4. **上限を超えた分が次回に回る**こと、および `last_success_at` の持ち回り
 *
 * `dtako-scraper-relay-do.ts` は 100% gate の対象外なので、**カバレッジが緑であることは
 * この 4 点が守られている根拠にならない。**
 */

// DO の constructor が使う Workers ランタイムのグローバル (node には無い)。
(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

const COMP_ID = "27324455";
const TENANT_ID = "tenant-of-27324455"; // 架空の値 (実物ではない)
const OTHER_TENANT = "tenant-of-99999999"; // 陰性対照用の別テナント

const ACCOUNT = { comp_id: COMP_ID, tenant_id: TENANT_ID, user_name: "u", user_pass: "p" };
const ACCOUNTS = [ACCOUNT, { comp_id: "99999999", tenant_id: OTHER_TENANT, user_name: "u2", user_pass: "p2" }];

/** theearth のログインページ (login() の GET が読む hidden field を持つ)。 */
const LOGIN_PAGE = `<html><body><form>
  <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="VS1" />
  <input name="txtPass" type="password" id="txtPass" />
</form></body></html>`;

/** ログイン成功後に着地する一般ページ (txtPass も重複プロンプトも無い 200)。 */
const MENU_PAGE = `<html><body><div id="menu">メニュー</div></body></html>`;

/** `.vdf` (NET780 独自コンテナ) のマジックバイト + 中身。 */
const VDF_BYTES = new Uint8Array([0x4e, 0x45, 0x54, 0x37, 0x38, 0x30, 0x01, 0x02]);

interface Row {
  serialNo: string;
  fileName: string;
  receive: string;
}

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function venus(d: unknown): Response {
  return new Response(JSON.stringify({ d }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function vdfResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(VDF_BYTES);
        controller.close();
      },
    }),
    { status: 200 },
  );
}

/** theearth 側 (login → VenusBridge → /dvrData) を URL で振り分けて答える。 */
function stubTheearth(rows: Row[]): { venusCalls: Array<{ method: string; body: string }> } {
  const venusCalls: Array<{ method: string; body: string }> = [];
  let loginPageServed = false;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/dvrData/")) return vdfResponse();
    const venusMethod = /\/([A-Za-z_0-9]+)$/.exec(url)?.[1] ?? "";
    if (url.includes("VenusBridgeService")) {
      venusCalls.push({ method: venusMethod, body: String(init?.body ?? "") });
      if (venusMethod === "Monitoring_DvrNotification2") {
        return venus(
          rows.map((r) => ({
            SerialNo: r.serialNo,
            FileName: r.fileName,
            FilePath: `notify/${r.fileName}`,
            VehicleCD: "2131",
            VehicleName: "大型1号",
            DriverName: "運転 太郎",
            EventType: "急ブレーキ",
            DvrDatetime: "2026/07/03 18:32:26",
            FileReceive: `fa fa-prcs-${r.receive}`,
          })),
        );
      }
      if (venusMethod === "Request_DvrFileTransfer_MultiTarget") return venus([1]);
      if (venusMethod === "Request_DvrFileDownload") {
        // 実物はサーバー生成の相対パスを Windows 区切りで返す。
        return venus([1, "gen\\out.vdf", "out.vdf"]);
      }
      throw new Error(`unexpected VenusBridge method: ${venusMethod}`);
    }
    // login の GET (ページ取得) → POST (認証) の 2 往復。
    if (!loginPageServed) {
      loginPageServed = true;
      return html(LOGIN_PAGE);
    }
    return html(MENU_PAGE);
  });
  return { venusCalls };
}

interface AlcCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeDO(
  ingestResponses: Response[],
  seedLastRun?: DvrCronLastRun,
): {
  alcCalls: AlcCall[];
  run: (account: typeof ACCOUNT, sharedSecret: string) => Promise<Response>;
  stored: Map<string, unknown>;
  /** alc へ同時に飛んでいたリクエストの最大数。**逐次なら 1**。 */
  peakConcurrency: () => number;
} {
  const alcCalls: AlcCall[] = [];
  const queue = [...ingestResponses];
  let inFlight = 0;
  let peak = 0;
  const env = {
    DTAKO_CONFIG_KV: {
      get: async (key: string) => (key === "dtako_accounts" ? JSON.stringify(ACCOUNTS) : null),
    },
    AUTH_WORKER: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        alcCalls.push({
          url: String(input),
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: init?.body,
        });
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // 実際の forward は非同期。1 tick 譲って「重なるなら重なる」状態を作る
        // (即 resolve すると並列実装でも peak 1 に見えてしまい、対照にならない)。
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        const res = queue.shift();
        if (!res) throw new Error(`unexpected extra alc call (#${alcCalls.length})`);
        return res;
      },
    },
  };
  const stored = new Map<string, unknown>();
  if (seedLastRun) stored.set("dvr_last_run", seedLastRun);
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
      runDvrCron(account: typeof ACCOUNT, sharedSecret: string): Promise<Response>;
    }
  ).runDvrCron.bind(relay);
  return { alcCalls, run, stored, peakConcurrency: () => peak };
}

function ingestResponse(pending: Array<{ id: string; serial_no: string; file_name: string }>): Response {
  return new Response(
    JSON.stringify({ inserted: pending.length, skipped: 0, pending }),
    { status: 200 },
  );
}

function storedResponse(id: string): Response {
  return new Response(
    JSON.stringify({ id, file_status: "stored", size: VDF_BYTES.length, r2_key: `dvr/${id}.vdf` }),
    { status: 200 },
  );
}

/** 通知の時刻窓 (直近 48h) が絡むので **Date だけ**固定する。timer は触らない
 * (stream の await が止まる)。`2026/07/03 18:32:26 JST` = 27 分前。 */
const NOW = new Date("2026-07-03T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DtakoScraperRelayDO#runDvrCron", () => {
  it("★ 書き先 tenant は DTAKO_ACCOUNTS の tenant_id で、.vdf は DO で読み切らずに渡す", async () => {
    stubTheearth([{ serialNo: "SER-1", fileName: "F1.vdf", receive: "3-0" }]); // 3-0 = ready
    const { alcCalls, run, stored } = makeDO([
      ingestResponse([{ id: "u1", serial_no: "SER-1", file_name: "F1.vdf" }]),
      storedResponse("u1"),
    ]);

    const res = await run(ACCOUNT, "shared-1");

    expect(res.status).toBe(200);
    expect(alcCalls).toHaveLength(2);

    // 1 本目 = 通知メタデータの batch ingest
    expect(alcCalls[0]!.url).toContain("/alc-internal-proxy/api/dvr/notifications");
    expect(alcCalls[0]!.headers["X-Alc-Proxy-Secret"]).toBe("shared-1");
    // ★ 対照 — body 由来の tenant を読むようにすると、ここが別テナントに変えられる
    expect(alcCalls[0]!.headers["X-Tenant-ID"]).toBe(TENANT_ID);
    expect(alcCalls[0]!.headers["X-Tenant-ID"]).not.toBe(OTHER_TENANT);
    const sent = JSON.parse(String(alcCalls[0]!.body)) as { items: Array<Record<string, string>> };
    expect(sent.items).toEqual([
      {
        serial_no: "SER-1",
        file_name: "F1.vdf",
        vehicle_cd: "2131",
        vehicle_name: "大型1号",
        driver_name: "運転 太郎",
        event_type: "急ブレーキ",
        // ★ 生の theearth 表記ではなく RFC3339 (UTC)。生だと rust が 422 を返す。
        dvr_datetime: "2026-07-03T09:32:26Z",
        source_url: "notify/F1.vdf",
      },
    ]);
    // tenant を body に混ぜない (上流はヘッダで受け取る)
    expect(String(alcCalls[0]!.body)).not.toContain("tenant");

    // 2 本目 = `.vdf` 本体
    expect(alcCalls[1]!.url).toContain("/alc-internal-proxy/api/dvr/files/u1");
    expect(alcCalls[1]!.headers["Content-Type"]).toBe("application/octet-stream");
    expect(alcCalls[1]!.headers["X-Tenant-ID"]).toBe(TENANT_ID);
    // ★ DO 側でバイト列に読み切っていない (この先の auth-worker で 1 度バッファされるが、
    // それは relay の外)。1 ファイル 1 リクエスト = body に複数を詰めていない。
    expect(alcCalls[1]!.body).toBeInstanceOf(ReadableStream);

    expect(await res.json()).toMatchObject({
      ok: true,
      comp_id: COMP_ID,
      notifications: 1,
      in_window: 1,
      inserted: 1,
      pending: 1,
      requested: 0,
      stored: [{ id: "u1", file_status: "stored", r2_key: "dvr/u1.vdf" }],
    });

    const last = stored.get("dvr_last_run") as DvrCronLastRun;
    expect(last.ok).toBe(true);
    expect(last.last_success_at).toBe(last.finished_at);
    expect(last.stored).toBe(1);
  });

  it("★ まだ車両にしか無い分は Request_DvrFileTransfer_MultiTarget 1 回にまとめる", async () => {
    const { venusCalls } = stubTheearth([
      { serialNo: "S1", fileName: "A.vdf", receive: "0-0" }, // 0-0 = requestable
      { serialNo: "S2", fileName: "B.vdf", receive: "0-0" },
    ]);
    const { alcCalls, run } = makeDO([
      ingestResponse([
        { id: "a", serial_no: "S1", file_name: "A.vdf" },
        { id: "b", serial_no: "S2", file_name: "B.vdf" },
      ]),
    ]);

    const res = await run(ACCOUNT, "shared-1");

    expect(res.status).toBe(200);
    // ★ 1 件ずつ Request_DvrFileTransfer_target を 2 回ではなく、Multi を 1 回
    const transfers = venusCalls.filter((c) => c.method.startsWith("Request_DvrFileTransfer"));
    expect(transfers).toHaveLength(1);
    expect(transfers[0]!.method).toBe("Request_DvrFileTransfer_MultiTarget");
    expect(JSON.parse(transfers[0]!.body)).toEqual({ key1: "S1,S2", key2: "A.vdf,B.vdf" });
    // まだサーバーに映像が無いので `.vdf` の投入は 1 本も走らない
    expect(alcCalls).toHaveLength(1);
    expect(await res.json()).toMatchObject({ requested: 2, stored: [], waiting: 0 });
  });

  it("★ 上限を超えた分は次回に回す (pending は rust が持っているので取りこぼさない)", async () => {
    const overflow = DVR_MAX_FILES_PER_RUN + 2;
    const rows: Row[] = Array.from({ length: overflow }, (_, i) => ({
      serialNo: `S${i}`,
      fileName: `F${i}.vdf`,
      receive: "3-0",
    }));
    stubTheearth(rows);
    const { alcCalls, run, peakConcurrency } = makeDO([
      ingestResponse(rows.map((r, i) => ({ id: `u${i}`, serial_no: r.serialNo, file_name: r.fileName }))),
      ...Array.from({ length: DVR_MAX_FILES_PER_RUN }, (_, i) => storedResponse(`u${i}`)),
    ]);

    const res = await run(ACCOUNT, "shared-1");

    // 通知 ingest 1 本 + 上限ぶんのファイル投入だけ
    expect(alcCalls).toHaveLength(1 + DVR_MAX_FILES_PER_RUN);
    // ★ **逐次**。auth-worker は forward 前に body を arrayBuffer() でバッファするので、
    // 並列にすると同時に持つバッファが件数ぶん (最悪 32MB × 10) になる。
    expect(peakConcurrency()).toBe(1);
    expect(await res.json()).toMatchObject({
      ok: true,
      pending: overflow,
      waiting: overflow - DVR_MAX_FILES_PER_RUN,
    });
  });

  it("★ 1 件のダウンロード失敗で残りを止めず、ok=false で last_success_at を進めない", async () => {
    stubTheearth([
      { serialNo: "S1", fileName: "A.vdf", receive: "3-0" },
      { serialNo: "S2", fileName: "B.vdf", receive: "3-0" },
    ]);
    const { alcCalls, run, stored } = makeDO(
      [
        ingestResponse([
          { id: "a", serial_no: "S1", file_name: "A.vdf" },
          { id: "b", serial_no: "S2", file_name: "B.vdf" },
        ]),
        new Response("file too large", { status: 413 }),
        storedResponse("b"),
      ],
      {
        comp_id: COMP_ID,
        started_at: "2026-07-03T09:00:00.000Z",
        finished_at: "2026-07-03T09:00:01.000Z",
        ok: true,
        last_success_at: "2026-07-03T09:00:01.000Z",
        hours_since_last_success: 0,
        notifications: 0,
        in_window: 0,
        undated: 0,
        unusable: 0,
        inserted: 0,
        skipped: 0,
        pending: 0,
        requested: 0,
        stored: 0,
        failed: 0,
        error: null,
      },
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await run(ACCOUNT, "shared-1");

    // 1 件目が 413 でも 2 件目は投入されている
    expect(alcCalls).toHaveLength(3);
    const body = (await res.json()) as { ok: boolean; stored: unknown[]; failed: Array<{ id: string; error: string }> };
    expect(body.ok).toBe(false);
    expect(body.stored).toHaveLength(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]!.id).toBe("a");
    expect(body.failed[0]!.error).toContain("file too large");

    // ★ 最終成功時刻は据え置き — 進めると「映像が 1 本も保存されない」を閾値が拾えない
    const last = stored.get("dvr_last_run") as DvrCronLastRun;
    expect(last.ok).toBe(false);
    expect(last.last_success_at).toBe("2026-07-03T09:00:01.000Z");
    expect(last.failed).toBe(1);
  });

  it("★ 最終成功から閾値を超えたら console.error で無音故障を鳴らす (通知は出さない)", async () => {
    stubTheearth([]);
    const { run } = makeDO([ingestResponse([])], {
      comp_id: COMP_ID,
      started_at: "2020-01-01T00:00:00.000Z",
      finished_at: "2020-01-01T00:00:01.000Z",
      ok: true,
      // 遠い過去 = 閾値 (3h) を大きく超えている
      last_success_at: "2020-01-01T00:00:01.000Z",
      hours_since_last_success: 0,
      notifications: 0,
      in_window: 0,
      undated: 0,
      unusable: 0,
      inserted: 0,
      skipped: 0,
      pending: 0,
      requested: 0,
      stored: 0,
      failed: 0,
      error: null,
    });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });

    const res = await run(ACCOUNT, "shared-1");

    expect(res.status).toBe(200);
    const stale = errors.map((e) => JSON.parse(e) as Record<string, unknown>).filter((e) => e.dvr_cron === "stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.comp_id).toBe(COMP_ID);
    expect(Number(stale[0]!.hours_since_last_success)).toBeGreaterThan(3);
  });

  it("★ 窓に 1 件も無いときは alc を 1 度も叩かず、それでも成功として記録する", async () => {
    // rust は `items: []` を 400 で弾き、relay は非 2xx で throw する。素で POST すると
    // 「48h 窓に 1 件も無かった」だけで cron run 全体が失敗し、`last_success_at` が
    // 進まないまま無音故障まで鳴っていた。稼働の少ない comp では普通に起きる。
    stubTheearth([]);
    // ★ 応答を 1 本も積まない = alc を叩いた瞬間 "unexpected extra alc call" で落ちる。
    const { alcCalls, run, stored } = makeDO([]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await run(ACCOUNT, "shared-1");

    expect(res.status).toBe(200);
    expect(alcCalls).toEqual([]);
    expect(await res.json()).toMatchObject({
      ok: true,
      comp_id: COMP_ID,
      notifications: 0,
      in_window: 0,
      // ★ 件数は 0 で埋まる (null = 「そこまで到達していない」ではない)
      inserted: 0,
      skipped: 0,
      pending: 0,
    });
    // ★ ここが本体 — 成功として記録され、無音故障の時計が進む。
    const last = stored.get("dvr_last_run") as DvrCronLastRun;
    expect(last.ok).toBe(true);
    expect(last.last_success_at).not.toBeNull();
  });

  it("theearth が落ちたら 502 + どこまで進んだかを応答に残す (alc は 1 度も叩かない)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("theearth unreachable");
    });
    const { alcCalls, run, stored } = makeDO([]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await run(ACCOUNT, "shared-1");

    expect(res.status).toBe(502);
    expect(alcCalls).toEqual([]);
    expect(await res.json()).toMatchObject({
      ok: false,
      comp_id: COMP_ID,
      notifications: null,
      inserted: null,
    });
    const last = stored.get("dvr_last_run") as DvrCronLastRun;
    expect(last.ok).toBe(false);
    expect(last.last_success_at).toBeNull();
    expect(last.error).toContain("theearth unreachable");
  });
});
