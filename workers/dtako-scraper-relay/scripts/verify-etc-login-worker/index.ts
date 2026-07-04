/**
 * 実ログイン検証 (Refs ohishi-exp/nuxt-dtako-admin#134) の
 * `wrangler deploy --temporary` 検証用 Worker。
 *
 * `scrapeEtcFromCookies` (cookie 委譲) はこのサイト特有のステートフルな
 * ページ遷移仕様により検証手法として信頼できないことが判明した (#134)。
 * 本番と同じ経路 (`scrapeEtcCsv` = `etcLogin()` の実 POST チェーン) をその場で
 * 動かして検証するため、この worker 自身が HTML ログインフォームを返し、
 * ユーザーがブラウザ上で直接 ID/パスワードを入力して top-level navigation で
 * POST する。credential はブラウザ → この worker (Cloudflare Workers 実行環境)
 * だけを通り、CCoW / Claude のツール呼び出しには一切載らない。
 *
 * デプロイ (credential 不要、--var も無し):
 *   cd workers/dtako-scraper-relay
 *   npx wrangler deploy --temporary --config scripts/verify-etc-login-worker/wrangler.toml \
 *     --name verify-etc-login-<好きな名前>
 *
 * 実行:
 *   1. 表示された worker URL をブラウザで開く (cdp-relay 経由で navigate)
 *   2. フォームに実際の ETC 利用照会サービスの ID/パスワードを直接入力して送信
 *   3. この worker が `scrapeEtcCsv` を実行し、steps・行数・ヘッダ行だけを JSON で返す
 *      (CSV 本体・credential は log にも response にも出さない)
 */
import {
  etcLogin,
  navigateToSearchPage,
  submitSearch,
  downloadMeisaiCsv,
  followToPage,
  parseForms,
  pickMainForm,
  EtcMeisaiClientError,
  EtcMeisaiNoUsageError,
  EtcMeisaiNotCsvError,
  ETC_REQUEST_TIMEOUT_MS,
  ETC_EXPORT_TIMEOUT_MS,
  type EtcPage,
} from "../../src/etc-meisai-client";
import { createCookieJar, type CookieJar } from "../../src/theearth-client";

/** `<input type=button onClick="submitPage('frm','/etc/R?...');">` 形式
 * (フォーム名 + 完全遷移先 URL) の「共通 -確認してください-」中間ページを
 * 1 段階だけ POST で進める。navigateToSearchPage の `javascript:submitPage('a','b')`
 * (funccode, nextfunc 想定) とは引数の意味が異なる、別の submitPage 呼び出し形。
 * 見つからなければ null (呼び出し側で従来のエラーに fall back させる)。 */
async function tryAdvanceConfirmationPage(
  jar: CookieJar,
  page: EtcPage,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<EtcPage | null> {
  const m = page.html.match(/onClick=["']submitPage\('[^']*','([^']+)'\)/i);
  if (!m) return null;
  const targetUrl = new URL(m[1], page.url).toString();
  const mainForm = pickMainForm(parseForms(page.html));
  if (!mainForm) return null;
  const body = new URLSearchParams();
  for (const [name, value] of mainForm.fields) body.set(name, value);
  return followToPage(
    jar,
    targetUrl,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() },
    fetchImpl,
    timeoutMs,
  );
}

/** resultPage の実データ (個人の利用明細) を一切含めず、構造 (field 名 / button
 * ラベル / キーワード有無) だけを診断用に抜き出す。#134 の続きで download 段が
 * 失敗した時、原因を loud に切り分けるための一時ヘルパー。 */
function pageDiagnostics(page: EtcPage) {
  const forms = parseForms(page.html);
  const h2 = page.html.match(/<H2[^>]*>([^<]*)<\/H2>/i)?.[1] ?? null;
  const buttonLabels = Array.from(
    page.html.matchAll(/<INPUT[^>]*type=["']?(?:submit|button)["']?[^>]*>/gi),
  )
    .map((m) => m[0].match(/value=["']([^"']*)["']/i)?.[1])
    .filter((v): v is string => typeof v === "string");
  const keywords = ["検索結果", "利用明細", "CSV", "出力", "ダウンロード", "ご利用はありません", "エラー"];
  const keywordHits = keywords.filter((k) => page.html.includes(k));
  return {
    url: page.url,
    h2,
    formCount: forms.length,
    formFieldNames: forms.map((f) => [...f.fields.keys()]),
    buttonLabels,
    keywordHits,
    htmlLength: page.html.length,
  };
}

const FORM_HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>ETC login verify (temporary)</title></head>
<body>
<h1>ETC ログイン検証 (一時 worker、60分で失効)</h1>
<p>入力した credential はこの worker 内でのみ使用され、log や response には出ません。</p>
<form method="POST" action="/run">
  <p><label>ユーザーID: <input type="text" name="userId" autocomplete="off"></label></p>
  <p><label>パスワード: <input type="password" name="password" autocomplete="off"></label></p>
  <p><button type="submit">実行</button></p>
</form>
</body></html>`;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(FORM_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname !== "/run" || request.method !== "POST") {
      return json({ error: "not_found (GET / でフォームを開くこと)" }, 404);
    }

    const form = await request.formData();
    const userId = form.get("userId");
    const password = form.get("password");
    if (typeof userId !== "string" || typeof password !== "string" || !userId || !password) {
      return json({ ok: false, error: "userId / password が空です" }, 400);
    }

    const steps: string[] = [];
    const jar = createCookieJar();
    try {
      steps.push("login");
      const session = await etcLogin(jar, { userId, password }, fetch, ETC_REQUEST_TIMEOUT_MS);

      steps.push("search");
      let searchPage: EtcPage;
      try {
        searchPage = await navigateToSearchPage(jar, session, fetch, ETC_REQUEST_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof EtcMeisaiClientError) {
          // ログイン直後ページの構造だけ診断情報として返す (#134 続報: アカウントに
          // よって navigateToSearchPage 自体が失敗するケースがあることが判明)。
          return json(
            {
              ok: false,
              steps,
              error: e.message,
              diagnostics: {
                loginPage: pageDiagnostics(session.page),
                links: Array.from(session.page.html.matchAll(/<A\b[^>]*>([\s\S]*?)<\/A>/gi))
                  .map((m) => ({
                    onclick: m[0].match(/onclick=["']([^"']*)["']/i)?.[1] ?? null,
                    href: m[0].match(/href=["']([^"']*)["']/i)?.[1] ?? null,
                    text: m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
                  }))
                  .filter((l) => l.text !== ""),
              },
            },
            502,
          );
        }
        throw e;
      }
      let resultPage = await submitSearch(jar, searchPage, fetch, ETC_REQUEST_TIMEOUT_MS);

      // 「共通 -確認してください-」等の中間確認ページを検出したら最大2回まで
      // 自動で1段階 POST で進める (#134 続報: submitSearch の直後にこの中間ページが
      // 挟まることが実機診断で判明した)。
      for (let hop = 0; hop < 2; hop += 1) {
        const mainFieldCount = pickMainForm(parseForms(resultPage.html))?.fields.size ?? 0;
        if (mainFieldCount > 1) break; // 実データを含むフォーム相当まで来たとみなす
        const advanced = await tryAdvanceConfirmationPage(jar, resultPage, fetch, ETC_REQUEST_TIMEOUT_MS);
        if (!advanced) break;
        steps.push(`confirm-hop-${hop + 1}`);
        resultPage = advanced;
      }

      steps.push("download");
      let result;
      try {
        result = await downloadMeisaiCsv(jar, resultPage, fetch, ETC_EXPORT_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof EtcMeisaiNotCsvError) {
          // 個人の利用明細本体は含めず、構造だけ診断情報として返す (#134 続報)。
          return json(
            {
              ok: false,
              steps,
              error: e.message,
              diagnostics: {
                resultPage: pageDiagnostics(resultPage),
                pickedForm: (() => {
                  const f = pickMainForm(parseForms(resultPage.html));
                  return f ? { action: f.action, fieldNames: [...f.fields.keys()] } : null;
                })(),
              },
            },
            502,
          );
        }
        throw e;
      }

      steps.push("done");
      const text = new TextDecoder("shift_jis").decode(result.bytes);
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
      return json({
        ok: true,
        steps,
        accountType: session.accountType,
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
