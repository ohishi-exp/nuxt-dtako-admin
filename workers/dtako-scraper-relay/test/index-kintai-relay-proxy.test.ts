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
      branch_name: "テスト用",
      date: "2026-08-20",
    });
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
