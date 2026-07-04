/**
 * cookie 委譲 (Refs ohishi-exp/dtako-scraper#22, ippoan/cdp-relay#69) の
 * `wrangler deploy --temporary` 検証用 Worker。
 *
 * login (credential を使う部分) は手元ブラウザにやらせ、cdp-relay `browser_cookies`
 * で取得した cookie をこの temp worker に POST する。**credential はどこにも渡らない
 * — この worker が受け取るのは login 後の cookie だけ**。
 *
 * 動機: CCoW コンテナ内の node/curl から直接 `scrapeEtcFromCookies` を試したところ、
 * サーバー側がセッションを認識せず (IP バインディングと推測)、しかも手元ブラウザの
 * 元セッションまで無効化される実害が起きた (CLAUDE.md 参照)。CCoW の egress
 * (Anthropic gateway、datacenter IP) と Cloudflare Workers の egress (Workers 固有
 * IP レンジ) は別物なので、**実際に cookie を使う fetch は Workers 実行環境 (この
 * temp worker) 側で行い、CCoW は cookie を右から左に渡すだけ**にする。
 *
 * デプロイ (credential 不要、--var も無し):
 *   cd workers/dtako-scraper-relay
 *   npx wrangler deploy --temporary --config scripts/verify-etc-worker/wrangler.toml \
 *     --name verify-etc-<好きな名前>
 *
 * 実行:
 *   1. cdp-relay で手元ブラウザを login させ、
 *      browser_cookies(session, ["https://www2.etc-meisai.jp"]) → cookies_url
 *   2. browser_eval(session, "location.href") → startUrl
 *   3. cookies_url の中身 (`{ cookies: [...] }`) と startUrl を、この worker の
 *      POST /verify に送る。**workers.dev は Cloudflare の JS challenge に守られており、
 *      curl / fetch (XHR) は POST でも 403 challenge page を返す (実機確認済み)。
 *      実ブラウザの top-level navigation (通常の GET / form POST) だけが challenge を
 *      自動突破できる** (cf_clearance cookie が発行され、以後の同オリジンアクセスに
 *      効く)。よって cookies_url を開いたページ上で <form method=POST> を組み立てて
 *      submit (= navigation) する方式を使うこと (fetch() での POST は 403 になる)。
 *   4. この worker が `scrapeEtcFromCookies` を **Workers 自身の egress** で実行し、
 *      結果 (件数・ヘッダ・成否) だけを JSON で返す。CSV 明細本体は返さない。
 *
 *   GET  /        … health
 *   POST /verify  … body (JSON) { cookies: EtcCookie[], startUrl: string }
 *                    or (form-urlencoded, navigation 用) payload=<同 JSON を文字列化したもの>
 */
import { scrapeEtcFromCookies, EtcMeisaiClientError, EtcMeisaiNoUsageError, type EtcCookie } from "../../src/etc-meisai-client";

// この temp worker の POST /verify は、手元ブラウザの browser_eval が現在ページ
// (www2.etc-meisai.jp 等の別オリジン) から直接 fetch する。CORS を許可しないと
// ブラウザの fetch がブロックされるため、検証専用 (60分失効・claim しない前提) の
// 一時 worker として * を許可する。
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return json({ ok: true, worker: "verify-etc-temporary (cookie 委譲)" });
    }

    if (url.pathname !== "/verify" || request.method !== "POST") {
      return json({ error: "not_found (POST /verify を叩くこと)" }, 404);
    }

    const contentType = request.headers.get("content-type") ?? "";
    let body: { cookies?: unknown; startUrl?: unknown };
    try {
      if (contentType.includes("application/json")) {
        body = (await request.json()) as typeof body;
      } else {
        // form navigation 経路 (JS challenge 突破用)。hidden field "payload" に
        // { cookies, startUrl } を JSON.stringify したものを積んで POST する想定。
        const form = await request.formData();
        const payload = form.get("payload");
        body = typeof payload === "string" ? (JSON.parse(payload) as typeof body) : {};
      }
    } catch {
      return json({ ok: false, error: "JSON body か payload (form) が必要です" }, 400);
    }
    const cookies = Array.isArray(body.cookies) ? (body.cookies as EtcCookie[]) : [];
    const startUrl = typeof body.startUrl === "string" ? body.startUrl : "";
    if (cookies.length === 0 || !startUrl) {
      return json({ ok: false, error: "cookies (非空配列) と startUrl (string) が必要です" }, 400);
    }

    const steps: string[] = [];
    try {
      const result = await scrapeEtcFromCookies(
        cookies,
        startUrl,
        (step, msg) => steps.push(`${step}${msg ? " " + msg : ""}`),
        undefined,
        undefined,
        new Date(),
      );
      // CSV 明細 (個人情報) は返さない。件数・ヘッダ行・成否だけ。
      const text = new TextDecoder("shift_jis").decode(result.bytes);
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
      return json({
        ok: true,
        steps,
        accountType: result.accountType,
        filename: result.filename,
        bytes: result.bytes.byteLength,
        rows: lines.length,
        header: lines[0]?.slice(0, 200) ?? null,
      });
    } catch (e) {
      if (e instanceof EtcMeisaiNoUsageError) {
        return json({ ok: true, steps, note: "当該月のご利用はありません (0件)" });
      }
      const message = e instanceof EtcMeisaiClientError ? e.message : String(e);
      return json({ ok: false, steps, error: message }, 502);
    }
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}
