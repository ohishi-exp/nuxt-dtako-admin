import { describe, expect, it, vi } from "vitest";

// wage-master-route-allowance-rate.test.ts / index-kintai-relay-proxy.test.ts と同じ手。
// `cloudflare:workers` は Workers ランタイムでしか解決できないので、DurableObject を
// 素のクラスで差し替えて dtako-scraper-relay-do.ts を node vitest から読み込む。
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
import type { AlcTenantDataInput } from "../src/alc-tenant-rpc";

/**
 * ★ #931 の**配線**に対する陰性対照。
 *
 * `scrape-history-record.test.ts` 側の対照は `resolveHistoryTenantId` の**実装**を
 * 壊すと落ちるが、**DO の呼び出し 1 行**を
 *
 * ```diff
 * -        (entry) => postScrapeHistory(entry, historyTenantId, rpc),
 * +        (entry) => postScrapeHistory(entry, account.tenant_id, rpc),
 * ```
 *
 * と戻しても落ちない (`historyTenantId` が算出されたまま捨てられる形で、**本番の欠陥が
 * そっくり復活しても緑**になる)。**元の欠陥を捕まえるのはこのファイル。**
 *
 * `dtako-scraper-relay-do.ts` は 100% gate の対象外なので、**カバレッジが緑であることは
 * この穴が塞がっている根拠にならない。**
 *
 * `recordCronScrapeHistory` は `runCronDtakoScrape` の内側にあり、そこまで fetch() で
 * 到達させると theearth の HTTP・zip 取得・alc アップロードまで stub する必要があって
 * **スクレイプ機構のテストになってしまう**。ここで測りたいのは**書き先 tenant の選び方**
 * だけなので、DO を実体化してそのメソッドを直接呼ぶ。
 */

// DO の constructor が使う Workers ランタイムのグローバル (WebSocket 自動応答の登録)。
// node には無いので空クラスを置く — この経路 (履歴の書き込み) では使われない
// (wage-master-route-allowance-rate.test.ts と同じ手)。
(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/** スクレイプ対象 (別会社) と、読み手が見る会社。**tenant は別々**にする —
 * 同じにすると直す前のコードでも素通りして対照にならない。 */
const SCRAPED_COMP = "75700192";
const KINTAI_COMP = "27324455";
const SCRAPED_TENANT = "tenant-of-75700192"; // 架空の値 (実物ではない)
const KINTAI_TENANT = "tenant-of-27324455";

const ACCOUNTS = [
  { comp_id: KINTAI_COMP, tenant_id: KINTAI_TENANT, user_name: "u", user_pass: "p" },
  { comp_id: SCRAPED_COMP, tenant_id: SCRAPED_TENANT, user_name: "u", user_pass: "p" },
];

function makeDO(opts: { kintaiCompId?: string } = {}) {
  const calls: AlcTenantDataInput[] = [];
  const env = {
    DTAKO_CONFIG_KV: {
      get: async (key: string) => (key === "dtako_accounts" ? JSON.stringify(ACCOUNTS) : null),
    },
    KINTAI_COMP_ID: "kintaiCompId" in opts ? opts.kintaiCompId : KINTAI_COMP,
    AUTH_WORKER_RPC: {
      forwardAlcTenantData: async (input: AlcTenantDataInput) => {
        calls.push(input);
        return { status: 204, body: "", contentType: null };
      },
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  // `recordCronScrapeHistory` は private (TypeScript のコンパイル時のみの制約)。
  const record = (
    relay as unknown as {
      recordCronScrapeHistory(
        account: { comp_id: string; tenant_id: string },
        range: { startDate: string; endDate: string },
        outcome: { kind: "success" },
      ): Promise<void>;
    }
  ).recordCronScrapeHistory.bind(relay);
  return { calls, record };
}

const SCRAPED_ACCOUNT = { comp_id: SCRAPED_COMP, tenant_id: SCRAPED_TENANT };
const RANGE = { startDate: "2026-08-26", endDate: "2026-08-26" };

describe("DtakoScraperRelayDO#recordCronScrapeHistory の書き先 tenant (Refs #931)", () => {
  it("★ 別会社をスクレイプしても、履歴は KINTAI_COMP_ID の tenant へ送られる", async () => {
    const { calls, record } = makeDO();

    await record(SCRAPED_ACCOUNT, RANGE, { kind: "success" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/scraper/history");
    expect(calls[0]!.method).toBe("POST");
    // ★ ここが対照 — 直す前は SCRAPED_TENANT が渡り、読み手 (KINTAI 固定) からは
    //   永久に見えなかった。2026-08-26 の本番で実際にそうなっていた。
    expect(calls[0]!.tenantId).toBe(KINTAI_TENANT);
    expect(calls[0]!.tenantId).not.toBe(SCRAPED_TENANT);
    // 会社の区別は行の comp_id 列が持つ (情報は失われない)
    const row = JSON.parse(calls[0]!.body!) as { comp_id: string; message: string };
    expect(row.comp_id).toBe(SCRAPED_COMP);
    expect(row.message).toBe("[無人] 取り込み成功");
  });

  it("★ KINTAI_COMP_ID が無ければ書かず、no_tenant で名指しする (staging の形)", async () => {
    const { calls, record } = makeDO({ kintaiCompId: undefined });
    const errs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errs.push(String(line));
    });

    await record(SCRAPED_ACCOUNT, RANGE, { kind: "success" });
    spy.mockRestore();

    // 黙って落とさない。かつ「書かなかった」を専用の理由で出す。
    expect(calls).toHaveLength(0);
    const line = errs.map((e) => JSON.parse(e) as { scrape_history?: string }).find((o) => o.scrape_history);
    expect(line?.scrape_history).toBe("no_tenant");
    // ★ スクレイプ対象の tenant へ落とし込まない (fail-closed であって fallback しない)
    expect(errs.join("\n")).not.toContain(SCRAPED_TENANT);
  });
});
