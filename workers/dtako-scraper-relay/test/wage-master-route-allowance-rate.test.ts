import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// index-kintai-relay-proxy.test.ts と同じ手。`cloudflare:workers` は Workers
// ランタイムでしか解決できないので、DurableObject を素のクラスで差し替えて
// dtako-scraper-relay-do.ts を node vitest から読み込む。ここでは
// **DtakoScraperRelayDO を実体化して本物の fetch() を叩く** — 保存経路
// (handleWageMasterRoute) の分岐を実コードのまま固定したいため。
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

const COMP_ID = "1";
const USER_B64 = "dmlld2Vy"; // "viewer"
const VIEWER_EMAIL = "viewer@example.com";

type StoredObject = { body: Uint8Array; customMetadata?: Record<string, string> };

/** R2 の in-memory 実装 (この経路が使う get/put/head/list/delete だけ)。 */
class FakeR2 {
  readonly store = new Map<string, StoredObject>();

  async put(key: string, body: ArrayBuffer | Uint8Array | string, opts?: { customMetadata?: Record<string, string> }) {
    const bytes =
      typeof body === "string"
        ? new TextEncoder().encode(body)
        : body instanceof Uint8Array
          ? new Uint8Array(body)
          : new Uint8Array(body);
    this.store.set(key, { body: bytes, ...(opts?.customMetadata ? { customMetadata: { ...opts.customMetadata } } : {}) });
  }

  async get(key: string) {
    const obj = this.store.get(key);
    if (!obj) return null;
    return { customMetadata: obj.customMetadata, text: async () => new TextDecoder().decode(obj.body) };
  }

  async head(key: string) {
    const obj = this.store.get(key);
    return obj ? { customMetadata: obj.customMetadata } : null;
  }

  async delete(key: string) {
    this.store.delete(key);
  }

  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      truncated: false as const,
    };
  }

  versionKeys(name: string): string[] {
    return [...this.store.keys()].filter((k) => k.startsWith(`restraint/${COMP_ID}/${name}/v-`)).sort();
  }

  historyLines(name: string): Array<Record<string, unknown>> {
    const obj = this.store.get(`restraint/${COMP_ID}/${name}/history.jsonl`);
    if (!obj) return [];
    return new TextDecoder()
      .decode(obj.body)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

// DO の constructor が使う Workers ランタイムのグローバル (WebSocket 自動応答の
// 登録)。node には無いので空クラスを置く — この経路 (R2 のみ) では使われない。
(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

function makeDO(bucket: FakeR2) {
  // 認可は RESTRAINT_DEV_VIEWER_COMP の短絡を使う (viewer 経路そのもの)。
  // allowance-rate を allowlist に足していないことの裏返しでもある —
  // isR2OnlyRestraintPath は denylist なので、足さなくても viewer 経路に乗る。
  const env = {
    DTAKO_R2: bucket,
    RESTRAINT_DEV_VIEWER_COMP: COMP_ID,
    RESTRAINT_DEV_VIEWER_EMAIL: VIEWER_EMAIL,
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  return new DtakoScraperRelayDO(ctx as never, env as never);
}

function req(name: string, init: { method: string; body?: unknown }) {
  return new Request(`https://relay.internal/restraint-api/${name}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      "X-Theearth-Comp-Id": COMP_ID,
      "X-Theearth-User-B64": USER_B64,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** allowance-rate / wage-master それぞれの「中身が変わる」body を作る。 */
function bodyFor(name: string, n: number): unknown {
  if (name === "allowance-rate") {
    return {
      rows: [
        {
          shipper: "G社",
          customer: "得意先A",
          loader: "積地業者A",
          origin: "積地A",
          dest: "卸地A",
          brand: "銘柄A",
          farePerT: 2750,
          allowanceYen: 9000 + n,
          note: "",
        },
      ],
    };
  }
  return { drivers: { "1001": { rates: [{ effectiveFrom: "2026-04-01", hourlyRate: 1000 + n }] } } };
}

let bucket: FakeR2;
let relay: DtakoScraperRelayDO;

beforeEach(() => {
  // Date だけ固定する (timers は本物のまま — crypto.subtle.digest の await が止まる)。
  vi.useFakeTimers({ toFake: ["Date"] });
  bucket = new FakeR2();
  relay = makeDO(bucket);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET/PUT /restraint-api/allowance-rate (既存 4 マスタと同じ振る舞い)", () => {
  it("未投入なら exists:false (画面のフォールバック判定の材料)", async () => {
    const res = await relay.fetch(req("allowance-rate", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ exists: false, data: null, version: null });
  });

  it("PUT した内容が GET で読める (farePerT: null も往復する)", async () => {
    const master = {
      rows: [
        { shipper: "G社", customer: "得意先A", loader: "積地業者A", origin: "積地A", dest: "卸地A", brand: "", farePerT: null, allowanceYen: 4500, note: "中継" },
        { shipper: "G社", customer: "得意先A", loader: "積地業者A", origin: "積地A", dest: "卸地B", brand: "銘柄A", farePerT: 2750, allowanceYen: 9000, note: "" },
      ],
    };
    const put = await relay.fetch(req("allowance-rate", { method: "PUT", body: master }));
    expect(put.status).toBe(200);

    const got = (await (await relay.fetch(req("allowance-rate", { method: "GET" }))).json()) as {
      exists: boolean;
      data: typeof master;
      version: string;
    };
    expect(got.exists).toBe(true);
    // 順序込みで一致する (#805 の後続 PR が deepEqual で突き合わせる)
    expect(got.data).toEqual(master);
    expect(got.data.rows[0].farePerT).toBeNull();
    expect(got.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("壊れた JSON が入っていると GET は 502", async () => {
    await bucket.put(`restraint/${COMP_ID}/allowance-rate/latest.json`, JSON.stringify({ rows: "no" }));
    const res = await relay.fetch(req("allowance-rate", { method: "GET" }));
    expect(res.status).toBe(502);
  });

  it("壊れた body の PUT は 400 (保存しない)", async () => {
    const res = await relay.fetch(req("allowance-rate", { method: "PUT", body: { rows: [{ allowanceYen: -1 }] } }));
    expect(res.status).toBe(400);
    expect(bucket.store.has(`restraint/${COMP_ID}/allowance-rate/latest.json`)).toBe(false);
  });

  it("baseVersion が食い違うと 409 + サーバの現在値", async () => {
    await relay.fetch(req("allowance-rate", { method: "PUT", body: bodyFor("allowance-rate", 0) }));
    const res = await relay.fetch(
      req("allowance-rate", { method: "PUT", body: { ...(bodyFor("allowance-rate", 1) as object), baseVersion: "stale" } }),
    );
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string; current: { data: unknown } };
    expect(json.error).toBe("conflict");
    expect(json.current.data).toEqual(bodyFor("allowance-rate", 0));
  });
});

describe("★ 旧版の保持 — allowance-rate は prune しない / 既存 4 マスタは従来どおり prune する", () => {
  // prune は「後継版の出現から 7 日」で消すので、**同じ時刻に 2 回 PUT しても
  // どのマスタでも版は残る** (対照が落ちない = 空撃ち)。3 回の PUT を
  // T0 / T0+1日 / T0+9日 に置くと、3 本目の保存時点で 1 本目が
  // 「後継 (2 本目) の出現から 8 日」になり、prune のあるマスタでだけ消える。
  const T0 = "2026-08-01T00:00:00.000Z";
  const T1 = "2026-08-02T00:00:00.000Z"; // T0 + 1 日
  const T2 = "2026-08-10T00:00:00.000Z"; // T1 + 8 日 (> 保持期間 7 日)

  async function putThreeVersions(name: string) {
    for (const [i, at] of [T0, T1, T2].entries()) {
      vi.setSystemTime(new Date(at));
      const res = await relay.fetch(req(name, { method: "PUT", body: bodyFor(name, i) }));
      expect(await res.json()).toMatchObject({ saved: true, changed: true });
    }
  }

  it("allowance-rate: 3 回 PUT すると v-*.json が 3 本とも残る", async () => {
    await putThreeVersions("allowance-rate");
    expect(bucket.versionKeys("allowance-rate")).toEqual([
      `restraint/${COMP_ID}/allowance-rate/v-20260801T090000.json`,
      `restraint/${COMP_ID}/allowance-rate/v-20260802T090000.json`,
      `restraint/${COMP_ID}/allowance-rate/v-20260810T090000.json`,
    ]);
  });

  it("★ 陰性対照 — wage-master: 同じ 3 回で最古の版が消える (従来どおり prune が走る)", async () => {
    await putThreeVersions("wage-master");
    expect(bucket.versionKeys("wage-master")).toEqual([
      `restraint/${COMP_ID}/wage-master/v-20260802T090000.json`,
      `restraint/${COMP_ID}/wage-master/v-20260810T090000.json`,
    ]);
  });
});

describe("★ 保存履歴 (誰がいつ変えたか)", () => {
  it("allowance-rate の PUT は history.jsonl に 1 行追記する (by は viewerEmail)", async () => {
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    await relay.fetch(req("allowance-rate", { method: "PUT", body: bodyFor("allowance-rate", 0) }));
    const lines = bucket.historyLines("allowance-rate");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ts: "20260801T090000", result: "new-version", by: VIEWER_EMAIL });
    expect(lines[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[0].bytes).toBeTypeOf("number");
  });

  it("内容が同じ PUT も『確認した』として残る (result: unchanged)", async () => {
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    await relay.fetch(req("allowance-rate", { method: "PUT", body: bodyFor("allowance-rate", 0) }));
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
    await relay.fetch(req("allowance-rate", { method: "PUT", body: bodyFor("allowance-rate", 0) }));

    expect(bucket.historyLines("allowance-rate").map((l) => l.result)).toEqual(["new-version", "unchanged"]);
    // 内容が同じなので版は増えない (putVersionedR2 の sha256 判定)
    expect(bucket.versionKeys("allowance-rate")).toHaveLength(1);
  });

  it("★ 陰性対照 — 既存 4 マスタは history.jsonl を書かない (挙動を変えていない)", async () => {
    await relay.fetch(req("wage-master", { method: "PUT", body: bodyFor("wage-master", 0) }));
    expect(bucket.historyLines("wage-master")).toEqual([]);
  });
});
