import { describe, expect, it, vi } from "vitest";

// index.ts re-exports DtakoScraperRelayDO (`export { DtakoScraperRelayDO } from
// "./dtako-scraper-relay-do"`), which imports `DurableObject` from
// "cloudflare:workers" at module scope. That module is only resolvable inside
// the real Workers runtime — under plain node vitest we stub it with a bare
// class so the module can load (we never instantiate DtakoScraperRelayDO in
// this test; we only need the 3 kintai-relay proxy handlers below it).
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import { handleOperationZip, handleDtakoReimport, handleDtakoAlcUpload, type RelayWorkerEnv } from "../src/index";

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
