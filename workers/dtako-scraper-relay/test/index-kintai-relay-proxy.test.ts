import { describe, expect, it, vi } from "vitest";

// index.ts re-exports DtakoScraperRelayDO (`export { DtakoScraperRelayDO } from
// "./dtako-scraper-relay-do"`), which imports `DurableObject` from
// "cloudflare:workers" at module scope. That module is only resolvable inside
// the real Workers runtime — under plain node vitest we stub it with a bare
// class so the module can load (we never instantiate DtakoScraperRelayDO in
// this test; we only need the 3 kintai-relay proxy handlers below it).
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import {
  handleOperationZip,
  handleDtakoReimport,
  handleDtakoAlcUpload,
  handleNet780Archive,
  handleNetprintRun,
  handleScrapeErrors,
  handleScrapeErrorObject,
  type RelayWorkerEnv,
} from "../src/index";

const SECRET = "internal-shared-secret";
const OPE_NO = "2606050753300000004286";
const START_OPE = "2026/07/07 7:53:30";
const UNKO_NO = "26060507533000000042861";

function fakeEnv(over: Partial<Record<string, unknown>> = {}) {
  const doFetch =
    (over.doFetch as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const relay = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({ fetch: doFetch })),
  };
  const env = {
    RELAY: relay,
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as RelayWorkerEnv;
  return { env, doFetch, relay };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET, ...headers },
    body: JSON.stringify(body),
  });
}

async function jsonOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

// これらのテストは3プロキシに共通の挙動 (認証/comp_id解決/DO routing) を1回
// handleOperationZip で代表させ、body 素通しについては3経路それぞれで確認する
// (Refs #633-24a)。
describe("kintai-relay proxy 共通の挙動 (handleOperationZip で代表)", () => {
  it("X-Alc-Proxy-Secret が無い/不一致だと401", async () => {
    const { env } = fakeEnv();
    const res = await handleOperationZip(
      post("https://relay.internal/kintai-relay/operation-zip", { comp_id: "1", ope_no: OPE_NO, start_ope: START_OPE }, {
        "X-Alc-Proxy-Secret": "wrong",
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("INTERNAL_SHARED_SECRET が未設定なら503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    const res = await handleOperationZip(
      post("https://relay.internal/kintai-relay/operation-zip", { comp_id: "1", ope_no: OPE_NO, start_ope: START_OPE }),
      env,
    );
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("body が JSON でなければ400 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const req = new Request("https://relay.internal/kintai-relay/operation-zip", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET },
      body: "not json",
    });
    const res = await handleOperationZip(req, env);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: "body must be JSON" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("comp_id は body 優先、無ければ KINTAI_COMP_ID にフォールバックする", async () => {
    const { env, doFetch, relay } = fakeEnv({ KINTAI_COMP_ID: "9999" });
    await handleOperationZip(
      post("https://relay.internal/kintai-relay/operation-zip", { ope_no: OPE_NO, start_ope: START_OPE }),
      env,
    );
    expect(relay.idFromName).toHaveBeenCalledWith("scraper-comp-9999");
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.comp_id).toBe("9999");
  });

  it("comp_id が body にも KINTAI_COMP_ID にも無ければ503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleOperationZip(
      post("https://relay.internal/kintai-relay/operation-zip", { ope_no: OPE_NO, start_ope: START_OPE }),
      env,
    );
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("DO の応答 (status/body) をそのまま透過する — 成功もエラーも", async () => {
    const errPayload = { error: "編集ロック中のためデータを表示できません" };
    const { env, doFetch } = fakeEnv({
      doFetch: vi.fn(async () => new Response(JSON.stringify(errPayload), { status: 502 })),
    });
    const res = await handleOperationZip(
      post("https://relay.internal/kintai-relay/operation-zip", { comp_id: "1", ope_no: OPE_NO, start_ope: START_OPE }),
      env,
    );
    expect(res.status).toBe(502);
    expect(await jsonOf(res)).toEqual(errPayload);
  });

  // ★ Refs #633-24a: 以前はここ (プロキシ) が ope_no/start_ope 必須チェックを
  // 自前でやり「ope_no / start_ope は必須です」を返していた。素通し化により、
  // この検証は DO 側 (parseOperationZipRequest) に完全に移った — プロキシは
  // 単に DO へ転送し、DO の応答 (エラー文言も含む) をそのまま返す。
  it("★変更点: ope_no/start_ope 欠落はプロキシでは弾かず、DO まで転送されるようになった", async () => {
    const doErr = { error: "comp_id / ope_no / start_ope が必要です" };
    const { env, doFetch } = fakeEnv({
      doFetch: vi.fn(async () => new Response(JSON.stringify(doErr), { status: 400 })),
    });
    const res = await handleOperationZip(
      post("https://relay.internal/kintai-relay/operation-zip", { comp_id: "1" }),
      env,
    );
    // DO まで転送されたこと (プロキシ単独では弾かれない) を呼び出しの有無で確認。
    expect(doFetch).toHaveBeenCalledTimes(1);
    // 応答は DO の文言のまま (プロキシ独自の「ope_no / start_ope は必須です」ではない)。
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual(doErr);
  });
});

describe("handleOperationZip body 素通し (Refs #633-24a)", () => {
  it("regression: 単体形式 {comp_id, ope_no, start_ope} は組み直さず1バイトも変えず転送する", async () => {
    const { env, doFetch } = fakeEnv();
    await handleOperationZip(
      post("https://relay.internal/kintai-relay/operation-zip", {
        comp_id: "0100",
        ope_no: OPE_NO,
        start_ope: START_OPE,
      }),
      env,
    );
    expect(doFetch.mock.calls[0][0]).toBe("https://relay.internal/cron/dtako/operation-zip");
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ comp_id: "0100", ope_no: OPE_NO, start_ope: START_OPE });
  });

  it("recalculate を含む body もそのまま転送する (以前は黙って消えていたフィールド)", async () => {
    const { env, doFetch } = fakeEnv();
    await handleOperationZip(
      post("https://relay.internal/kintai-relay/operation-zip", {
        comp_id: "0100",
        ope_no: OPE_NO,
        start_ope: START_OPE,
        recalculate: true,
      }),
      env,
    );
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.recalculate).toBe(true);
  });

  it("items 配列を含む body もそのまま転送する (以前は黙って消えていたフィールド)", async () => {
    const { env, doFetch } = fakeEnv();
    const items = [
      { ope_no: OPE_NO, start_ope: START_OPE },
      { ope_no: "2606050753300000004287", start_ope: "2026/07/08 8:00:00", recalculate: true },
    ];
    await handleOperationZip(
      post("https://relay.internal/kintai-relay/operation-zip", { comp_id: "0100", items }),
      env,
    );
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ comp_id: "0100", items });
  });
});

describe("handleDtakoReimport body 素通し (Refs #633-24a)", () => {
  it("regression: 単体形式 {comp_id, ope_no, start_ope, unko_no, reset_timecard} は1バイトも変えず転送する", async () => {
    const { env, doFetch } = fakeEnv();
    await handleDtakoReimport(
      post("https://relay.internal/kintai-relay/dtako-reimport", {
        comp_id: "0100",
        ope_no: OPE_NO,
        start_ope: START_OPE,
        unko_no: UNKO_NO,
        reset_timecard: true,
      }),
      env,
    );
    expect(doFetch.mock.calls[0][0]).toBe("https://relay.internal/cron/dtako/reimport");
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      comp_id: "0100",
      ope_no: OPE_NO,
      start_ope: START_OPE,
      unko_no: UNKO_NO,
      reset_timecard: true,
    });
  });

  it("reset_timecard 省略時もそのまま (undefined) 転送する — 正規化は DO 側の仕事になった", async () => {
    const { env, doFetch } = fakeEnv();
    await handleDtakoReimport(
      post("https://relay.internal/kintai-relay/dtako-reimport", {
        comp_id: "0100",
        ope_no: OPE_NO,
        start_ope: START_OPE,
        unko_no: UNKO_NO,
      }),
      env,
    );
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.reset_timecard).toBeUndefined();
  });

  it("items 配列を含む body もそのまま転送する", async () => {
    const { env, doFetch } = fakeEnv();
    const items = [{ ope_no: OPE_NO, start_ope: START_OPE, unko_no: UNKO_NO, reset_timecard: false }];
    await handleDtakoReimport(
      post("https://relay.internal/kintai-relay/dtako-reimport", { comp_id: "0100", items }),
      env,
    );
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ comp_id: "0100", items });
  });

  it("comp_id が無ければ503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDtakoReimport(
      post("https://relay.internal/kintai-relay/dtako-reimport", {
        ope_no: OPE_NO,
        start_ope: START_OPE,
        unko_no: UNKO_NO,
      }),
      env,
    );
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("X-Alc-Proxy-Secret 不一致は401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDtakoReimport(
      post(
        "https://relay.internal/kintai-relay/dtako-reimport",
        { comp_id: "1", ope_no: OPE_NO, start_ope: START_OPE, unko_no: UNKO_NO },
        { "X-Alc-Proxy-Secret": "wrong" },
      ),
      env,
    );
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("handleDtakoAlcUpload body 素通し (Refs #633-24a)", () => {
  it("regression: 単体形式 {comp_id, ope_no, start_ope} は1バイトも変えず転送する (unko_noは元々無い)", async () => {
    const { env, doFetch } = fakeEnv();
    await handleDtakoAlcUpload(
      post("https://relay.internal/kintai-relay/dtako-alc-upload", {
        comp_id: "0100",
        ope_no: OPE_NO,
        start_ope: START_OPE,
      }),
      env,
    );
    expect(doFetch.mock.calls[0][0]).toBe("https://relay.internal/cron/dtako/alc-upload");
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ comp_id: "0100", ope_no: OPE_NO, start_ope: START_OPE });
  });

  it("items 配列を含む body もそのまま転送する", async () => {
    const { env, doFetch } = fakeEnv();
    const items = [
      { ope_no: OPE_NO, start_ope: START_OPE },
      { ope_no: "2606050753300000004287", start_ope: "2026/07/08 8:00:00" },
    ];
    await handleDtakoAlcUpload(
      post("https://relay.internal/kintai-relay/dtako-alc-upload", { comp_id: "0100", items }),
      env,
    );
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ comp_id: "0100", items });
  });

  it("comp_id が無ければ503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDtakoAlcUpload(
      post("https://relay.internal/kintai-relay/dtako-alc-upload", { ope_no: OPE_NO, start_ope: START_OPE }),
      env,
    );
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("X-Alc-Proxy-Secret 不一致は401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleDtakoAlcUpload(
      post(
        "https://relay.internal/kintai-relay/dtako-alc-upload",
        { comp_id: "1", ope_no: OPE_NO, start_ope: START_OPE },
        { "X-Alc-Proxy-Secret": "wrong" },
      ),
      env,
    );
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("handleNet780Archive body 素通し (Refs #760 の 26)", () => {
  const items = [
    { ope_no: OPE_NO, start_ope: START_OPE },
    { ope_no: "2606050753300000004287", start_ope: "2026/07/08 8:00:00" },
  ];

  it("items 配列を含む body を 1 バイトも変えず DO の /cron/dtako/net780-archive へ転送する", async () => {
    const { env, doFetch, relay } = fakeEnv();
    const res = await handleNet780Archive(
      post("https://relay.internal/kintai-relay/net780-archive", { comp_id: "0100", items }),
      env,
    );
    expect(res.status).toBe(200);
    expect(relay.idFromName).toHaveBeenCalledWith("scraper-comp-0100");
    expect(doFetch.mock.calls[0][0]).toBe("https://relay.internal/cron/dtako/net780-archive");
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ comp_id: "0100", items });
  });

  it("comp_id 省略時は KINTAI_COMP_ID で補完する (それ以外のフィールドはそのまま)", async () => {
    const { env, doFetch } = fakeEnv({ KINTAI_COMP_ID: "0200" });
    await handleNet780Archive(post("https://relay.internal/kintai-relay/net780-archive", { items }), env);
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ comp_id: "0200", items });
  });

  it("DO の応答 (400 の文言も) をそのまま素通しする", async () => {
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ error: "items は最大 20 件までです" }), { status: 400 }));
    const { env } = fakeEnv({ doFetch });
    const res = await handleNet780Archive(
      post("https://relay.internal/kintai-relay/net780-archive", { comp_id: "0100", items }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: "items は最大 20 件までです" });
  });

  it("comp_id が無ければ503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleNet780Archive(post("https://relay.internal/kintai-relay/net780-archive", { items }), env);
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("X-Alc-Proxy-Secret 不一致は401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleNet780Archive(
      post("https://relay.internal/kintai-relay/net780-archive", { comp_id: "1", items }, { "X-Alc-Proxy-Secret": "wrong" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("INTERNAL_SHARED_SECRET 未設定は503", async () => {
    const { env, doFetch } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    const res = await handleNet780Archive(
      post("https://relay.internal/kintai-relay/net780-archive", { comp_id: "1", items }),
      env,
    );
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("JSON でない body は400", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleNet780Archive(
      new Request("https://relay.internal/kintai-relay/net780-archive", {
        method: "POST",
        headers: { "X-Alc-Proxy-Secret": SECRET },
        body: "not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

// 運転日報 netprint の手動実行 (Refs #874)。cron (JST 6:30) を待たずに 1 回
// 走らせる口で、実機確認はこの route 経由で行う (cron 経路と同じ DO route
// /cron/netprint を叩くので「cron でだけ通る道」を作らない)。
describe("handleNetprintRun (POST /kintai-relay/netprint-run)", () => {
  // `channel_id` は DB `lineworks_channels` の行 id (Uuid、Refs #874 の 8)。
  const CH_HONSHA = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const CH_TEST = "00000000-0000-4000-8000-000000000001";
  const TARGETS = JSON.stringify([{ branch_cd: "1", channel_id: CH_HONSHA }]);

  it("X-Alc-Proxy-Secret 不一致は401 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ NETPRINT_TARGETS: TARGETS, KINTAI_COMP_ID: "27324455" });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {}, { "X-Alc-Proxy-Secret": "wrong" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("INTERNAL_SHARED_SECRET 未設定は503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ INTERNAL_SHARED_SECRET: "", NETPRINT_TARGETS: TARGETS });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {}),
      env,
    );
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("JSON でない body は400 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ NETPRINT_TARGETS: TARGETS, KINTAI_COMP_ID: "27324455" });
    const res = await handleNetprintRun(
      new Request("https://relay.internal/kintai-relay/netprint-run", {
        method: "POST",
        headers: { "X-Alc-Proxy-Secret": SECRET },
        body: "not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("comp_id が body にも KINTAI_COMP_ID にも無ければ503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ NETPRINT_TARGETS: TARGETS });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {}),
      env,
    );
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("body 省略なら NETPRINT_TARGETS + 前日 (JST) で /cron/netprint を叩く", async () => {
    const { env, doFetch, relay } = fakeEnv({
      NETPRINT_TARGETS: TARGETS,
      KINTAI_COMP_ID: "27324455",
      doFetch: vi.fn(
        async () => new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 }),
      ),
    });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {}),
      env,
    );
    expect(res.status).toBe(200);
    expect(relay.idFromName).toHaveBeenCalledWith("scraper-comp-27324455");
    const [url, init] = doFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.internal/cron/netprint");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ comp_id: "27324455", branch_cd: "1", channel_id: CH_HONSHA });
    // 既定の対象日は前日 (JST) — 形式だけ固定し、値そのものは実行時刻に依存させない
    expect(sent.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await jsonOf(res)) as { date: string }).toMatchObject({ date: sent.date });
  });

  it("branch_cd + channel_id + date を渡すと NETPRINT_TARGETS を使わずその 1 件を叩く", async () => {
    const { env, doFetch } = fakeEnv({
      NETPRINT_TARGETS: TARGETS,
      KINTAI_COMP_ID: "27324455",
      doFetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {
        branch_cd: "2",
        channel_id: CH_TEST,
        branch_name: "テスト用",
        date: "2026-08-20",
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [, init] = doFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      comp_id: "27324455",
      branch_cd: "2",
      channel_id: CH_TEST,
      recipient_id: "",
      branch_name: "テスト用",
      operation_no: "",
      date: "2026-08-20",
    });
  });

  it("operation_no をそのまま DO へ渡す (通知先の解決は NETPRINT_TARGETS のまま、Refs #913)", async () => {
    const { env, doFetch } = fakeEnv({ NETPRINT_TARGETS: TARGETS, KINTAI_COMP_ID: "27324455" });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {
        date: "2026-08-24",
        operation_no: "2608240638160000003821",
      }),
      env,
    );
    expect(res.status).toBe(200);
    const [, init] = doFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      branch_cd: "1",
      channel_id: CH_HONSHA,
      operation_no: "2608240638160000003821",
      date: "2026-08-24",
    });
  });

  it("operation_no の形式違いは400 (DO を叩かない — 全運行の処理に化けさせない)", async () => {
    const { env, doFetch } = fakeEnv({ NETPRINT_TARGETS: TARGETS, KINTAI_COMP_ID: "27324455" });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", { operation_no: "3821" }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({
      error: "operation_no は 22 桁の数字 (theearth の運行No) で指定してください",
    });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("DO が 400 (指定の運行NO が無い) を返したら 400 のまま返す — 502 に丸めない", async () => {
    // 502 に丸めると「theearth か netprint がまた落ちた」と読まれ、実際に直す所
    // (呼んだ人の入力) から目が逸れる (Refs #913)。
    const doFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "運行NO 2608240000000000000000 は 2026/08/24 の 本社営業所 に見つかりません" }), {
          status: 400,
        }),
    );
    const { env } = fakeEnv({ NETPRINT_TARGETS: TARGETS, KINTAI_COMP_ID: "27324455", doFetch });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {
        date: "2026-08-24",
        operation_no: "2608240000000000000000",
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await jsonOf(res)) as {
      ok: boolean;
      results: { detail: string; skipped: boolean }[];
    };
    expect(body.ok).toBe(false);
    // 理由は target ごとの detail の**先頭**に出る (relay がここを 200 字で切る)。
    expect(body.results[0].detail).toContain("見つかりません");
    // 行は skip 印つき (画面が「失敗」と書かないため)。全部 skip なので全体は 400。
    expect(body.results[0].skipped).toBe(true);
  });

  it("営業所が 2 つあって片方だけ一致したら 200 — 無い方は skip、出せる日報は出す (Refs #913)", async () => {
    // 片方に無いのは当たり前 (どちらに属す運行かは呼ぶ人には分からない)。ここで
    // 全体を落とすと**もう一方で出せたはずの日報まで出なくなる**。
    const TWO = JSON.stringify([
      { branch_cd: "1", channel_id: CH_HONSHA },
      { branch_cd: "2", channel_id: CH_TEST },
    ]);
    const doFetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { branch_cd: string };
      return body.branch_cd === "1"
        ? new Response(JSON.stringify({ ok: true, results: [{ detail: "成功 1 / 失敗 0 (全 1 運行) 予約番号 GPPE4H6T" }] }), { status: 200 })
        : new Response(JSON.stringify({ error: "運行NO … は 2026/08/24 の 帯広営業所 に見つかりません" }), { status: 400 });
    });
    const { env } = fakeEnv({ NETPRINT_TARGETS: TWO, KINTAI_COMP_ID: "27324455", doFetch });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {
        date: "2026-08-24",
        operation_no: "2608241017180000003046",
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await jsonOf(res)) as { ok: boolean; results: { ok: boolean; skipped: boolean }[] };
    expect(body.ok).toBe(true);
    expect(body.results.map((r) => [r.ok, r.skipped])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("営業所が 2 つでどちらにも無ければ 400 (探した営業所ぶんの行を返す)", async () => {
    const TWO = JSON.stringify([
      { branch_cd: "1", channel_id: CH_HONSHA },
      { branch_cd: "2", channel_id: CH_TEST },
    ]);
    const doFetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "見つかりません" }), { status: 400 }),
    );
    const { env } = fakeEnv({ NETPRINT_TARGETS: TWO, KINTAI_COMP_ID: "27324455", doFetch });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {
        date: "2026-08-24",
        operation_no: "2608241017180000003046",
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await jsonOf(res)) as { ok: boolean; results: { skipped: boolean }[] };
    expect(body.ok).toBe(false);
    expect(body.results.map((r) => r.skipped)).toEqual([true, true]);
  });

  it("operation_no 無指定なら DO の 400 は skip にしない (従来どおり 502)", async () => {
    // skip 印を付ける条件は **operation_no を指定したとき**だけ。無指定の 400 は
    // 「その営業所にその運行が無い」ではないので、黙って飛ばすと欠陥が隠れる。
    const doFetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "comp_id … が必要です" }), { status: 400 }),
    );
    const { env } = fakeEnv({ NETPRINT_TARGETS: TARGETS, KINTAI_COMP_ID: "27324455", doFetch });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", { date: "2026-08-24" }),
      env,
    );
    expect(res.status).toBe(502);
    const body = (await jsonOf(res)) as { results: { skipped: boolean }[] };
    expect(body.results[0].skipped).toBe(false);
  });

  it("DO の失敗が 400 以外なら従来どおり 502", async () => {
    const doFetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "theearth login failed" }), { status: 502 }),
    );
    const { env } = fakeEnv({ NETPRINT_TARGETS: TARGETS, KINTAI_COMP_ID: "27324455", doFetch });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", { date: "2026-08-24" }),
      env,
    );
    expect(res.status).toBe(502);
  });

  it("片方だけの指定 / date 形式違いは400 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ NETPRINT_TARGETS: TARGETS, KINTAI_COMP_ID: "27324455" });
    for (const body of [{ branch_cd: "2" }, { date: "2026/08/20" }]) {
      const res = await handleNetprintRun(
        post("https://relay.internal/kintai-relay/netprint-run", body),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("NETPRINT_TARGETS が不正 JSON なら503 で理由を返す (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ NETPRINT_TARGETS: "not json", KINTAI_COMP_ID: "27324455" });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {}),
      env,
    );
    expect(res.status).toBe(503);
    expect((await jsonOf(res)) as { error: string }).toMatchObject({
      error: expect.stringContaining("NETPRINT_TARGETS"),
    });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("DO が非 2xx を返したら 502 で結果を返す (target 間は独立)", async () => {
    const { env } = fakeEnv({
      NETPRINT_TARGETS: TARGETS,
      KINTAI_COMP_ID: "27324455",
      doFetch: vi.fn(async () => new Response("INTERNAL_SHARED_SECRET 未設定のため LINE WORKS へ通知できません", { status: 503 })),
    });
    const res = await handleNetprintRun(
      post("https://relay.internal/kintai-relay/netprint-run", {}),
      env,
    );
    expect(res.status).toBe(502);
    const body = (await jsonOf(res)) as { ok: boolean; results: Array<{ ok: boolean; detail: string }> };
    expect(body.ok).toBe(false);
    expect(body.results[0].detail).toContain("HTTP 503");
  });
});

// ── スクレイプ失敗の原本を読む 2 口 (Refs #1052) ─────────────────────────────
// **読むだけ。** 認証・comp_id フォールバック・DO routing・body 素通しは
// handleOperationZip と同じ流儀に揃えてある (新しい認可の作法を作っていない)。
describe("handleScrapeErrors / handleScrapeErrorObject (read-only、Refs #1052)", () => {
  const ERR_KEY = "dtako-scrape-errors/75700192/2026-08-01/1754000000000.bin";

  it("X-Alc-Proxy-Secret が不一致だと401 (DO を叩かない) — 一覧も取得も", async () => {
    for (const handler of [handleScrapeErrors, handleScrapeErrorObject]) {
      const { env, doFetch } = fakeEnv();
      const res = await handler(
        post("https://relay.internal/kintai-relay/scrape-errors", { comp_id: "75700192" }, {
          "X-Alc-Proxy-Secret": "wrong",
        }),
        env,
      );
      expect(res.status).toBe(401);
      expect(doFetch).not.toHaveBeenCalled();
    }
  });

  it("INTERNAL_SHARED_SECRET が未設定なら503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv({ INTERNAL_SHARED_SECRET: undefined });
    const res = await handleScrapeErrors(
      post("https://relay.internal/kintai-relay/scrape-errors", { comp_id: "75700192" }),
      env,
    );
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("body が JSON でなければ400 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const req = new Request("https://relay.internal/kintai-relay/scrape-errors", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": SECRET },
      body: "not json",
    });
    const res = await handleScrapeErrors(req, env);
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual({ error: "body must be JSON" });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("comp_id は body 優先、無ければ KINTAI_COMP_ID にフォールバックする", async () => {
    const { env, doFetch, relay } = fakeEnv({ KINTAI_COMP_ID: "9999" });
    await handleScrapeErrors(
      post("https://relay.internal/kintai-relay/scrape-errors", { job_key: "2026-08-01" }),
      env,
    );
    expect(relay.idFromName).toHaveBeenCalledWith("scraper-comp-9999");
    const body = JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ job_key: "2026-08-01", comp_id: "9999" });
  });

  it("comp_id が body にも KINTAI_COMP_ID にも無ければ503 (DO を叩かない)", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await handleScrapeErrorObject(
      post("https://relay.internal/kintai-relay/scrape-error-object", { key: ERR_KEY }),
      env,
    );
    expect(res.status).toBe(503);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("一覧は /cron/dtako/scrape-errors へ、body を組み直さず転送する", async () => {
    const { env, doFetch } = fakeEnv();
    await handleScrapeErrors(
      post("https://relay.internal/kintai-relay/scrape-errors", {
        comp_id: "75700192",
        job_key: "2026-08-01",
        limit: 5,
      }),
      env,
    );
    expect(doFetch.mock.calls[0][0]).toBe("https://relay.internal/cron/dtako/scrape-errors");
    expect(JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      comp_id: "75700192",
      job_key: "2026-08-01",
      limit: 5,
    });
  });

  it("取得は /cron/dtako/scrape-error-object へ、key と full を落とさず転送する", async () => {
    const { env, doFetch } = fakeEnv();
    await handleScrapeErrorObject(
      post("https://relay.internal/kintai-relay/scrape-error-object", {
        comp_id: "75700192",
        key: ERR_KEY,
        full: true,
      }),
      env,
    );
    expect(doFetch.mock.calls[0][0]).toBe("https://relay.internal/cron/dtako/scrape-error-object");
    expect(JSON.parse((doFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      comp_id: "75700192",
      key: ERR_KEY,
      full: true,
    });
  });

  it("DO の応答 (status/body) をそのまま透過する", async () => {
    const payload = { error: "key は dtako-scrape-errors/ 配下だけです" };
    const { env } = fakeEnv({
      doFetch: vi.fn(async () => new Response(JSON.stringify(payload), { status: 400 })),
    });
    const res = await handleScrapeErrorObject(
      post("https://relay.internal/kintai-relay/scrape-error-object", { comp_id: "1", key: "etc/x" }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await jsonOf(res)).toEqual(payload);
  });
});
