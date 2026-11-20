import { describe, it, expect, vi } from "vitest";
import { bytesToBase64, getMinWageAnnualReportTool } from "../src/mcp/tools";
import { McpContentResult } from "../src/mcp/registry";
import type { Env } from "../src/env";

/** get_min_wage_annual_report (#p414)。relay の PDF を embedded resource で返すだけ。会社コード・乗務員CD は架空。 */
const SECRET = "internal-shared-secret";
const PDF = new TextEncoder().encode("%PDF-1.7 fake");
const ARGS = { comp_id: "27324455", driver_cd: "912", from_year: 2024, to_year: 2025 };
const CALLER = { bindingJwt: "mcp-jwt" };

function env(res: () => Response = () => new Response(PDF, { headers: { "content-type": "application/pdf" } })) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => res()) },
    INTERNAL_SHARED_SECRET: SECRET,
  } as unknown as Env;
}
const relayFetch = (e: Env) => (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch;

describe("get_min_wage_annual_report (#p414)", () => {
  it("★ relay の PDF を application/pdf の embedded resource (base64 blob) で返す", async () => {
    const out = await getMinWageAnnualReportTool.execute(env(), ARGS, CALLER);
    expect(out).toBeInstanceOf(McpContentResult);
    const [text, resource] = out.content;
    expect(text).toEqual({
      type: "text",
      text: `最低賃金 年間レポート (乗務員CD 912、2024-2025 年、${PDF.length} バイト): min-wage-annual_912_2024-2025.pdf`,
    });
    expect(resource).toEqual({
      type: "resource",
      resource: {
        uri: "kyuyo-mcp://min-wage-annual-report/min-wage-annual_912_2024-2025.pdf",
        mimeType: "application/pdf",
        blob: btoa("%PDF-1.7 fake"), // PDF の中身は ASCII なので文字列のまま base64 にできる
      },
    });
  });

  it("★ 呼び手の binding_jwt を Authorization で、共有 secret と一緒に relay の GET へ転送する", async () => {
    const e = env();
    await getMinWageAnnualReportTool.execute(e, { ...ARGS, to_year: 2024 }, CALLER);
    const [url, init] = relayFetch(e).mock.calls[0]!;
    expect(url).toBe("https://relay.internal/kintai-relay/min-wage-annual-report?comp_id=27324455&driver=912&from_year=2024&to_year=2024");
    expect(init).toEqual({ method: "GET", headers: { Authorization: "Bearer mcp-jwt", "X-Alc-Proxy-Secret": SECRET } });
  });

  it("binding_jwt が無い・from_year > to_year は relay を叩かない", async () => {
    const e = env();
    await expect(getMinWageAnnualReportTool.execute(e, ARGS, { bindingJwt: "" })).rejects.toThrow("binding_jwt がありません");
    await expect(getMinWageAnnualReportTool.execute(e, { ...ARGS, from_year: 2026 }, CALLER)).rejects.toThrow("from_year が to_year より後");
    expect(relayFetch(e)).not.toHaveBeenCalled();
  });

  it("relay の 401 / 403 は本文つきで落とす (PDF を返さない)", async () => {
    const e = env(() => Response.json({ error: "給与の閲覧許可リストに無いアカウントです" }, { status: 403 }));
    await expect(getMinWageAnnualReportTool.execute(e, ARGS, CALLER)).rejects.toThrow(
      'relay: status 403: {"error":"給与の閲覧許可リストに無いアカウントです"}',
    );
  });

  it("2xx でも PDF でなければ落とす (content-type 無しも)", async () => {
    await expect(getMinWageAnnualReportTool.execute(env(() => Response.json({ years: [] })), ARGS, CALLER)).rejects.toThrow(
      "PDF ではない応答 (content-type: application/json)",
    );
    const bare = () => {
      const r = new Response("x");
      r.headers.delete("content-type");
      return r;
    };
    await expect(getMinWageAnnualReportTool.execute(env(bare), ARGS, CALLER)).rejects.toThrow("(content-type: なし)");
  });

  it("引数: comp_id は 8 桁、driver_cd は数字、年は整数。余計な引数は拒否", () => {
    const parse = (a: unknown) => getMinWageAnnualReportTool.inputSchema.safeParse(a).success;
    expect(parse(ARGS)).toBe(true);
    expect(parse({ ...ARGS, comp_id: "2732445" })).toBe(false);
    expect(parse({ ...ARGS, driver_cd: "9a" })).toBe(false);
    expect(parse({ ...ARGS, from_year: 2024.5 })).toBe(false);
    expect(parse({ ...ARGS, format: "json" })).toBe(false);
  });

  it("bytesToBase64 は 32KB を超えても atob で元のバイト列に戻る", () => {
    const big = new Uint8Array(70_000).map((_, i) => i % 251);
    const decoded = atob(bytesToBase64(big));
    expect(Uint8Array.from(decoded, (c) => c.charCodeAt(0))).toEqual(big);
    // 32KB の切れ目で余計な padding が入らない (1 本の base64 になっている)
    expect(bytesToBase64(big)).toHaveLength(Math.ceil(70_000 / 3) * 4);
    expect(bytesToBase64(big).slice(0, -2)).not.toContain("=");
  });
});
