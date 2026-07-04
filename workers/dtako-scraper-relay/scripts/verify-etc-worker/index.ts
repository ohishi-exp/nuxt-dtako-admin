/**
 * ETC ブラウザレススクレイパーの `wrangler deploy --temporary` 検証用 Worker。
 *
 * `wrangler deploy --temporary` は Cloudflare アカウント未接続でも実 Workers edge に
 * 即デプロイでき、60分で自動失効する (`wrangler-deploy-temporary` skill 参照)。ETC
 * credential は **手元シェルの `--var` としてのみ**この worker に渡し、CCoW / Claude
 * の会話には一切乗せない (Refs ohishi-exp/dtako-scraper#22)。
 *
 * デプロイ:
 *   cd workers/dtako-scraper-relay
 *   npx wrangler deploy --temporary --config scripts/verify-etc-worker/wrangler.toml \
 *     --var ETC_USER:"<実ユーザーID>" --var ETC_PASS:"<実パスワード>"
 *
 * 実行 (デプロイ後に表示される workers.dev URL を GET するだけ。デプロイ URL 自体は
 * Cloudflare の JS challenge に守られ curl では読めないため、cdp-relay 等の実ブラウザ
 * 経由で読む):
 *   GET /            … health
 *   GET /verify       … ETC_USER/ETC_PASS で scrapeEtcCsv を実行し、結果 (件数・ヘッダ・
 *                        成否) だけを JSON で返す。CSV 明細本体・credential は返さない。
 */
import { scrapeEtcCsv, EtcMeisaiClientError, EtcMeisaiNoUsageError } from "../../src/etc-meisai-client";

export interface VerifyEnv {
  ETC_USER?: string;
  ETC_PASS?: string;
}

export default {
  async fetch(request: Request, env: VerifyEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return json({ ok: true, worker: "verify-etc-temporary" });
    }

    if (url.pathname !== "/verify") {
      return json({ error: "not_found" }, 404);
    }

    if (!env.ETC_USER || !env.ETC_PASS) {
      return json(
        { ok: false, error: "ETC_USER / ETC_PASS が未設定です (--var で渡してください)" },
        400,
      );
    }

    const steps: string[] = [];
    try {
      const result = await scrapeEtcCsv({ userId: env.ETC_USER, password: env.ETC_PASS }, (step, msg) =>
        steps.push(`${step}${msg ? " " + msg : ""}`),
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
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
