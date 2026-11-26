import { afterEach, describe, expect, it, vi } from "vitest";

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

const scrape = vi.hoisted(() => ({ impl: (): Promise<unknown> => Promise.reject(new Error("unset")) }));
vi.mock("../src/etc-meisai-client", async (orig) => ({
  ...(await orig<typeof import("../src/etc-meisai-client")>()),
  scrapeEtcCsv: () => scrape.impl(),
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { EtcMeisaiClientError, EtcMeisaiNoUsageError, EtcMeisaiNotCsvError } from "../src/etc-meisai-client";

/**
 * `performEtcScrape` の記録 (Refs #1287): 出口 (成功・0 件・エラー) のどれでも `etc_last_scrape` に
 * 時刻と成否だけを置き、ログインできた回は種別・ログイン後パス・機能コードも置く。user_id は架空値。
 */
type Priv = {
  ctx: { storage: { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void> } };
  env: Record<string, unknown>;
  performEtcScrape: (account: unknown, onStep: () => void, now?: Date) => Promise<{ status: string }>;
};

function makeDo(r2Put: () => Promise<void> = async () => {}) {
  const d = Object.create(DtakoScraperRelayDO.prototype) as Priv;
  const store = new Map<string, unknown>();
  d.ctx = { storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v) } };
  d.env = { DTAKO_R2: { put: r2Put } };
  return { d, store };
}

const ACCOUNT = { user_id: "etc-user-0001", password: "pw" };
const CODES = ["1032000000", "1034000000"];

afterEach(() => vi.restoreAllMocks());

describe("performEtcScrape の記録", () => {
  it("成功: 種別・パス・機能コードと last_scrape(success) を置き、ログに menu_funccodes を出す", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    scrape.impl = async () => ({
      bytes: new Uint8Array([1, 2]).buffer,
      filename: "m.csv",
      accountType: "corporate",
      loginPath: "/etc/R",
      menuFuncCodes: CODES,
    });
    const { d, store } = makeDo();
    const out = await d.performEtcScrape(ACCOUNT, () => {}, new Date("2026-11-26T00:00:00Z"));
    expect(out.status).toBe("success");
    expect(store.get("etc_account_type")).toBe("corporate");
    expect(store.get("etc_login_path")).toBe("/etc/R");
    expect(store.get("etc_menu_funccodes")).toEqual(CODES);
    expect(store.get("etc_last_scrape")).toEqual({ at: expect.any(String), status: "success" });
    const line = log.mock.calls.flat().join("\n");
    expect(line).toContain('"menu_funccodes":["1032000000","1034000000"]');
    expect(line).not.toContain("etc-user-0001");
  });

  it("明細 0 件: 種別等と last_scrape(skipped)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    scrape.impl = async () => {
      const e = new EtcMeisaiNoUsageError();
      e.accountType = "personal";
      e.loginPath = "/etc/R";
      e.menuFuncCodes = ["1032000000"];
      throw e;
    };
    const { d, store } = makeDo();
    expect((await d.performEtcScrape(ACCOUNT, () => {})).status).toBe("skipped");
    expect(store.get("etc_menu_funccodes")).toEqual(["1032000000"]);
    expect(store.get("etc_last_scrape")).toMatchObject({ status: "skipped" });
  });

  it.each([
    ["ログイン失敗", () => new EtcMeisaiClientError("ログインに失敗しました")],
    ["CSV でない応答", () => new EtcMeisaiNotCsvError("not csv", new ArrayBuffer(1), "text/html")],
  ])("%s: last_scrape(error) だけ置く (エラー本文は置かない)", async (_l, make) => {
    scrape.impl = async () => {
      throw make();
    };
    const { d, store } = makeDo();
    expect((await d.performEtcScrape(ACCOUNT, () => {})).status).toBe("error");
    expect(store.get("etc_last_scrape")).toEqual({ at: expect.any(String), status: "error" });
    expect(store.has("etc_account_type")).toBe(false);
    expect(JSON.stringify([...store.values()])).not.toContain("失敗");
  });
});
