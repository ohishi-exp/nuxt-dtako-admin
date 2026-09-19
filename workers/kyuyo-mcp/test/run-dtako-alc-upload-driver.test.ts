import { describe, it, expect, vi } from "vitest";
import { runDtakoAlcUploadDriverTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";
const baseArgs = { driver_cd: "1234", from: "2026-08-01", to: "2026-08-31" };

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };

describe("run_dtako_alc_upload_driver (乗務員 × 期間)", () => {
  it("**write tool として scope を要求する** — alc への書き込みを伴う", () => {
    expect(runDtakoAlcUploadDriverTool.requiresScope).toBe("mcp.write");
  });

  it("**説明に read 側から消えるのが『その乗務員の運行だけ』であることが読める**", () => {
    // run_dtako_scrape (読取日ベース) との違いはここ。取り違えると「他の乗務員が
    // 画面から消える」を許すことになる
    expect(runDtakoAlcUploadDriverTool.description).toContain("run_dtako_scrape");
    expect(runDtakoAlcUploadDriverTool.description).toContain("その乗務員の");
  });

  it("**説明に from/to が読取日であることが読める** (運行日と取り違えると空振りする)", () => {
    expect(runDtakoAlcUploadDriverTool.description).toContain("読取日");
    expect(runDtakoAlcUploadDriverTool.description).toContain("運行日ではない");
  });

  it("**説明に期間上限と、超過を切り詰めないことが読める**", () => {
    expect(runDtakoAlcUploadDriverTool.description).toContain("最大 31 日");
    expect(runDtakoAlcUploadDriverTool.description).toContain("切り詰めない");
  });

  it("inputSchema は driver_cd / from / to を検証し、余計なキーを弾く (strict)", () => {
    expect(runDtakoAlcUploadDriverTool.inputSchema.safeParse(baseArgs).success).toBe(true);
    // 乗務員CD は数字だけ (theearth の欄は 8 桁まで)
    expect(
      runDtakoAlcUploadDriverTool.inputSchema.safeParse({ ...baseArgs, driver_cd: "12a4" }).success,
    ).toBe(false);
    expect(
      runDtakoAlcUploadDriverTool.inputSchema.safeParse({ ...baseArgs, driver_cd: "123456789" }).success,
    ).toBe(false);
    // 日付は YYYY-MM-DD
    expect(
      runDtakoAlcUploadDriverTool.inputSchema.safeParse({ ...baseArgs, from: "2026/08/01" }).success,
    ).toBe(false);
    // ope_no_22 のような別 tool の引数は受け付けない
    expect(
      runDtakoAlcUploadDriverTool.inputSchema.safeParse({
        ...baseArgs,
        ope_no_22: "2606050753300000004286",
      }).success,
    ).toBe(false);
  });

  it("relay の /kintai-relay/dtako-alc-upload-driver を叩き、応答をそのまま返す", async () => {
    const payload = {
      ok: true,
      driver_cd: "1234",
      from: "2026-08-01",
      to: "2026-08-31",
      bytes: 7707,
      upload_id: "abc123",
      operations_count: 4,
      split_failed: 0,
      split_confirmed: false,
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await runDtakoAlcUploadDriverTool.execute(e, { ...baseArgs, comp_id: "0100" });
    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/dtako-alc-upload-driver");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    // **運行を列挙しない**ので、ope_no / items は body に出てこない
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ driver_cd: "1234", from: "2026-08-01", to: "2026-08-31", comp_id: "0100" });
    expect(body).not.toHaveProperty("ope_no");
    expect(body).not.toHaveProperty("items");
  });

  it("comp_id を省略すると relay の既定に委ねる (こちらで埋めない)", async () => {
    const e = env();
    await runDtakoAlcUploadDriverTool.execute(e, baseArgs);
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.comp_id).toBeUndefined();
  });
});
