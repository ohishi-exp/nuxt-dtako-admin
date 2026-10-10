import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (index-etc-run.test.ts と同じ手当て)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { type RelayWorkerEnv } from "../src/index";
import { DTAKO_CRON, ETC_CRON } from "../src/cron";
import { ALERT_REASON_CRON_THREW } from "../src/scrape-alert-email";

/** 架空の値 (実物ではない。この repo は public)。 */
const ACCOUNTS = JSON.stringify([
  { comp_id: "1001", tenant_id: "t1", user_name: "u1", user_pass: "p1" },
  { comp_id: "1002", tenant_id: "t2", user_name: "u2", user_pass: "p2" },
]);
const EMAIL_CONFIG = JSON.stringify({ from: "relay@example.com", to: "alert@example.com" });

function mailBody(raw: string): string {
  return raw.slice(raw.search(/\r?\n\r?\n/)).trim();
}

function setup(
  opts: {
    accounts?: string | null;
    /** KV の `dtako_accounts` 読み取りを throw させる (dispatch 前に落ちる経路)。 */
    accountsKvThrows?: boolean;
    /** この comp_id の DO を 500 にする。 */
    failComp?: string;
    scraperMode?: string;
  } = {},
) {
  const mails: Array<{ from: string; to: string; raw: string }> = [];
  const doCalls: string[] = [];
  const env = {
    SCRAPER_MODE: "scraperMode" in opts ? opts.scraperMode : "http",
    DTAKO_CONFIG_KV: {
      get: async (key: string) => {
        if (key === "dtako_accounts") {
          if (opts.accountsKvThrows) throw new Error("kv unavailable");
          return "accounts" in opts ? opts.accounts : ACCOUNTS;
        }
        if (key === "scrape_alert_email") return EMAIL_CONFIG;
        return null;
      },
    },
    ALERT_EMAIL: {
      send: async (m: { from: string; to: string; raw: string }) => {
        mails.push({ from: m.from, to: m.to, raw: m.raw });
      },
    },
    RELAY: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: async () => {
          doCalls.push(name);
          return name === `scraper-comp-${opts.failComp}`
            ? new Response("account missing", { status: 500 })
            : new Response(JSON.stringify({ accepted: true }), { status: 202 });
        },
      }),
    },
  } as unknown as RelayWorkerEnv;
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
  const fire = async (cron: string) => {
    await worker.scheduled({ cron } as ScheduledController, env, ctx);
    await Promise.all(waits);
  };
  return { mails, doCalls, fire };
}

function quiet() {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return () => {
    err.mockRestore();
    log.mockRestore();
  };
}

describe("scheduled — 日次 cron が取り込みを積めなかったらメール (Refs #1206)", () => {
  it("★ DO が 1 社ぶん失敗したら 1 通 (会社 ID は載せない)", async () => {
    const { mails, doCalls, fire } = setup({ failComp: "1002" });
    const restore = quiet();
    await fire(DTAKO_CRON);
    restore();

    expect(doCalls).toHaveLength(2);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("alert@example.com");
    const body = mailBody(mails[0]!.raw);
    expect(body).toContain("1 社ぶんの取り込みを積めませんでした");
    expect(body).not.toContain("1002");
  });

  it("★ DTAKO_ACCOUNTS が空で skip したら 1 通", async () => {
    const { mails, doCalls, fire } = setup({ accounts: null });
    const restore = quiet();
    await fire(DTAKO_CRON);
    restore();

    expect(doCalls).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(mailBody(mails[0]!.raw)).toContain("DTAKO_ACCOUNTS が空");
  });

  it("★ dispatch の前 (KV の読み取り) で落ちたら 1 通送り、例外は従来どおり投げ直す", async () => {
    const { mails, doCalls, fire } = setup({ accountsKvThrows: true });
    const restore = quiet();
    await expect(fire(DTAKO_CRON)).rejects.toThrow("kv unavailable");
    restore();

    expect(doCalls).toHaveLength(0);
    expect(mails).toHaveLength(1);
    expect(mailBody(mails[0]!.raw)).toContain(ALERT_REASON_CRON_THREW);
  });

  it("陰性対照: 全社を積めたら 1 通も出ない", async () => {
    const { mails, doCalls, fire } = setup();
    const restore = quiet();
    await fire(DTAKO_CRON);
    restore();

    expect(doCalls).toHaveLength(2);
    expect(mails).toHaveLength(0);
  });

  it("陰性対照: SCRAPER_MODE が http でない意図した skip は鳴らさない", async () => {
    const { mails, fire } = setup({ scraperMode: "vpc-relay" });
    const restore = quiet();
    await fire(DTAKO_CRON);
    restore();

    expect(mails).toHaveLength(0);
  });

  it("陰性対照: 日次取り込み以外の cron は同じ落ち方でもメールを出さない (挙動は従来どおり投げる)", async () => {
    const { mails, fire } = setup({ accountsKvThrows: true });
    const restore = quiet();
    await expect(fire(ETC_CRON)).rejects.toThrow("kv unavailable");
    restore();

    expect(mails).toHaveLength(0);
  });
});
