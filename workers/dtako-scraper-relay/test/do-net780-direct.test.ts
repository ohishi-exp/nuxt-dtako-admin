import { afterEach, describe, expect, it, vi } from "vitest";

// do-theearth-restraint.test.ts と同じ手。DurableObject を素のクラスで差し替えて node vitest から読む。
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
// theearth への HTTP は対象外 (theearth-net780-client.test.ts)。ここは一覧に無いときの直接選択の配線だけ
vi.mock("../src/theearth-net780-client", async (orig) => ({
  ...(await orig<typeof import("../src/theearth-net780-client")>()),
  searchNet780: vi.fn(async () => []),
  downloadNet780Zip: vi.fn(async () => new ArrayBuffer(4)),
}));
vi.mock("../src/operation-zip", async (orig) => ({
  ...(await orig<typeof import("../src/operation-zip")>()),
  listZipEntryNames: vi.fn(),
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { listZipEntryNames } from "../src/operation-zip";
import { downloadNet780Zip } from "../src/theearth-net780-client";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair = class {
  constructor(_req: string, _res: string) {}
};

const COMP_ID = "75700192";
const ACCOUNTS = [{ comp_id: COMP_ID, tenant_id: "t", user_name: "u", user_pass: "p" }];
const OPE = "2606171125560000000237";

function makeDO() {
  const env = {
    DTAKO_CONFIG_KV: { get: async (key: string) => (key === "dtako_accounts" ? JSON.stringify(ACCOUNTS) : null) },
    DTAKO_R2: {},
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
    waitUntil: () => {},
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never) as unknown as Record<string, unknown>;
  const save = vi.fn(async () => ({ ok: true, zipKey: "k", dedup: false }));
  relay.withTheearthLoginSession = vi.fn(async (_a: unknown, jobState: { logins: unknown[] }, run: (jar: unknown) => Promise<unknown>) => {
    jobState.logins.push({ kicked: false, at: 0 });
    return run({ cookies: new Map() });
  });
  relay.isNet780Archived = vi.fn(async () => false);
  relay.saveNet780ToR2 = save;
  const fetch = (relay as unknown as { fetch(req: Request): Promise<Response> }).fetch.bind(relay);
  const call = () =>
    fetch(
      new Request("https://relay.internal/cron/dtako/net780-archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comp_id: COMP_ID, items: [{ ope_no: OPE, start_ope: "2026/06/17 11:25:56" }] }),
      }),
    );
  return { call, save };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("NET780 のアーカイブ — 一覧に無い運行は運行NO で直接選ぶ", () => {
  it("一覧が 0 件でも、直接選んで取れた zip がその運行のものなら保存する", async () => {
    vi.mocked(listZipEntryNames).mockReturnValue(["237/20260617_112556-0-0-237/a.spd"]);
    const { call, save } = makeDO();
    const body = (await (await call()).json()) as { results: { status: string }[] };
    expect(body.results[0]!.status).toBe("archived");
    expect(vi.mocked(downloadNet780Zip).mock.calls[0]![1]).toEqual([{ operationNo: OPE, startDateTime: "2026/06/17 11:25:56" }]);
    expect(save).toHaveBeenCalledWith(COMP_ID, [{ operationNo: OPE, startDateTime: "2026/06/17 11:25:56" }], expect.any(ArrayBuffer));
  });

  it("取れた zip が別の運行・ダウンロードが失敗なら not_found (保存しない)", async () => {
    vi.mocked(listZipEntryNames).mockReturnValue(["237/20260618_000000-0-0-237/a.spd"]);
    const { call, save } = makeDO();
    const body = (await (await call()).json()) as { results: { status: string; message: string }[] };
    expect(body.results[0]!.status).toBe("not_found");
    expect(body.results[0]!.message).toContain("運行NO で直接選んでも取れませんでした");
    expect(save).not.toHaveBeenCalled();

    vi.mocked(downloadNet780Zip).mockRejectedValue(new Error("HTTP 503"));
    const again = (await (await makeDO().call()).json()) as { results: { status: string }[] };
    expect(again.results[0]!.status).toBe("not_found");
  });
});
