/**
 * 実ログイン検証 (Refs ohishi-exp/nuxt-dtako-admin#134) の
 * `wrangler deploy --temporary` 検証用 Worker (探索 UI 版)。
 *
 * `scrapeEtcFromCookies` (cookie 委譲) はこのサイト特有のステートフルな
 * ページ遷移仕様により検証手法として信頼できないことが判明した (#134)。
 * 本番と同じ経路 (`etcLogin()` の実 POST チェーン) を使うが、アカウントごとに
 * ログイン後の画面構造が大きく異なる (`navigateToSearchPage` が通る場合と
 * 通らない場合がある) ことが判明したため、**ログインは 1 回だけ**行い、以降は
 * cookie state をブラウザの hidden field に往復させることで、redeploy や
 * ログイン再入力なしにページ遷移を 1 手ずつ探索できるようにする。
 *
 * credential はブラウザ → この worker (Cloudflare Workers 実行環境) だけを
 * 通り、CCoW / Claude のツール呼び出しには一切載らない。cookie state (JSON を
 * base64 化したもの) は hidden field に載るが、これは etc-meisai.jp のセッション
 * cookie そのものであり、他の credential 同様この worker の外には出さない
 * (log にも response 本文にも生の cookie 値を直接出力しない設計は維持)。
 *
 * デプロイ:
 *   cd workers/dtako-scraper-relay
 *   npx wrangler deploy --temporary --config scripts/verify-etc-login-worker/wrangler.toml \
 *     --name verify-etc-login-<好きな名前>
 *
 * 使い方:
 *   1. worker URL をブラウザで開き ID/パスワードを直接入力して送信 (最初の1回だけ)
 *   2. 以降は表示された「次の一手」候補ボタンをクリックして遷移を進める
 *      (ページ内の <a>/<input type=button> の onclick から抽出した submitPage/
 *      goOutput 遷移先を POST する。CSV っぽい応答が返れば行数・ヘッダを表示して停止)
 */
import {
  etcLogin,
  parseForms,
  pickMainForm,
  findFormWithField,
  decodeHtml,
  EtcMeisaiClientError,
  ETC_REQUEST_TIMEOUT_MS,
  ETC_EXPORT_TIMEOUT_MS,
  type EtcPage,
} from "../../src/etc-meisai-client";
import { createCookieJar, cookieHeader, ingestSetCookie, type CookieJar } from "../../src/theearth-client";

// ---------------------------------------------------------------------------
// cookie state の往復 (hidden field 1個、base64(JSON))
// ---------------------------------------------------------------------------

interface StateBlob {
  cookies: [string, string][];
  url: string;
  html: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeState(jar: CookieJar, page: EtcPage): string {
  const blob: StateBlob = { cookies: [...jar.cookies.entries()], url: page.url, html: page.html };
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(blob)));
}

function decodeState(token: string): { jar: CookieJar; page: EtcPage } {
  const blob = JSON.parse(new TextDecoder("utf-8").decode(base64ToBytes(token))) as StateBlob;
  return { jar: { cookies: new Map(blob.cookies) }, page: { url: blob.url, html: blob.html } };
}

// ---------------------------------------------------------------------------
// cookie jar 付き手動 fetch (redirect 手動追跡、charset sniff は呼び出し側で行う)
// ---------------------------------------------------------------------------

async function rawRequest(
  jar: CookieJar,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ url: string; res: Response }> {
  const doFetch = async (u: string, i: RequestInit): Promise<Response> => {
    const headers = new Headers(i.headers);
    const cookie = cookieHeader(jar);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(u, { ...i, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    ingestSetCookie(jar, res.headers);
    return res;
  };
  let currentUrl = url;
  let res = await doFetch(currentUrl, init);
  for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400; hop += 1) {
    const location = res.headers.get("location");
    if (!location) break;
    currentUrl = new URL(location, currentUrl).toString();
    res = await doFetch(currentUrl, { method: "GET" });
  }
  return { url: currentUrl, res };
}

// ---------------------------------------------------------------------------
// ページ診断 (個人情報を含まない構造だけ)
// ---------------------------------------------------------------------------

function pageDiagnostics(page: EtcPage) {
  const forms = parseForms(page.html);
  const h2 = page.html.match(/<H2[^>]*>([^<]*)<\/H2>/i)?.[1] ?? null;
  const keywords = ["検索結果", "利用明細", "CSV", "ＣＳＶ", "出力", "ダウンロード", "ご利用はありません", "エラー", "確認してください"];
  const keywordHits = keywords.filter((k) => page.html.includes(k));
  return {
    url: page.url,
    h2,
    formCount: forms.length,
    formFieldNames: forms.map((f) => [...f.fields.keys()]),
    keywordHits,
    htmlLength: page.html.length,
  };
}

interface Action {
  label: string;
  target: string;
  /** true なら sokoKbn=0 (全て) を強制 override して POST する。 */
  sokoKbnAll?: boolean;
}

/** ページ内の submitPage(...) / goOutput(...) 遷移先をボタン・リンクの両方から
 * 抽出する。すべて POST (mainForm の現フィールドを body に載せる) として扱う
 * — このサイトの遷移は全て form POST の JS ラッパーなので GET は使わない。 */
function extractActions(page: EtcPage): Action[] {
  const actions: Action[] = [];
  const seen = new Set<string>();
  const push = (label: string, target: string, sokoKbnAll?: boolean) => {
    const key = `${target}::${sokoKbnAll ? 1 : 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push({ label, target, sokoKbnAll });
  };
  const extractUrl = (onclick: string): string | null => {
    const sp = onclick.match(/submitPage\('[^']*',\s*'([^']+)'\)/i);
    if (sp) return sp[1];
    const go = onclick.match(/goOutput\([^,]*,[^,]*,[^,]*,\s*'([^']+)'/i);
    if (go) return go[1];
    return null;
  };
  for (const m of page.html.matchAll(/<INPUT\b[^>]*type=["']?(?:submit|button)["']?[^>]*>/gi)) {
    const tag = m[0];
    const value = tag.match(/value=["']([^"']*)["']/i)?.[1] ?? "(無題ボタン)";
    const onclick = tag.match(/onclick="([^"]*)"/i)?.[1] ?? tag.match(/onclick='([^']*)'/i)?.[1] ?? "";
    const url = extractUrl(onclick);
    if (url) push(value, new URL(url, page.url).toString());
  }
  for (const m of page.html.matchAll(/<A\b[^>]*>([\s\S]*?)<\/A>/gi)) {
    const tag = m[0];
    const text = m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const onclick = tag.match(/onclick="([^"]*)"/i)?.[1] ?? tag.match(/onclick='([^']*)'/i)?.[1] ?? "";
    const url = extractUrl(onclick);
    if (url) push(text, new URL(url, page.url).toString());
  }
  if (findFormWithField(parseForms(page.html), "sokoKbn")) {
    push("[検索実行 (sokoKbn=0 全て で現フォーム POST)]", page.url, true);
  }
  return actions;
}

function looksLikeFile(contentType: string, bytes: Uint8Array): boolean {
  const firstChar = bytes.byteLength > 0 ? String.fromCharCode(bytes[0]) : "";
  const looksBinary = contentType.includes("application/octet-stream") || contentType.includes("csv");
  return looksBinary && bytes.byteLength > 0 && firstChar !== "<";
}

// ---------------------------------------------------------------------------
// HTML レンダリング
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderExplorer(steps: string[], page: EtcPage, jar: CookieJar): string {
  const diag = pageDiagnostics(page);
  const actions = extractActions(page);
  const stateToken = encodeState(jar, page);
  const actionButtons = actions
    .map(
      (a, i) => `
    <form method="POST" action="/continue" style="display:inline">
      <input type="hidden" name="state" value="${stateToken}">
      <input type="hidden" name="target" value="${esc(a.target)}">
      <input type="hidden" name="sokoKbnAll" value="${a.sokoKbnAll ? "1" : "0"}">
      <button type="submit">[${i}] ${esc(a.label)}</button>
    </form>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>ETC explorer (temporary)</title></head>
<body>
<h1>ETC ページ探索 (一時 worker、60分で失効)</h1>
<p>steps: ${esc(steps.join(" -> "))}</p>
<pre>${esc(JSON.stringify(diag, null, 2))}</pre>
<h2>次の一手候補 (${actions.length}件、個人情報は含みません)</h2>
${actionButtons || "<p>(候補なし — 手詰まりの可能性)</p>"}
</body></html>`;
}

function renderDone(steps: string[], accountType: string, filename: string, bytes: number, rows: number, header: string | null): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>ETC done (temporary)</title></head>
<body>
<h1>CSV 取得成功</h1>
<pre>${esc(JSON.stringify({ steps, accountType, filename, bytes, rows, header }, null, 2))}</pre>
</body></html>`;
}

const FORM_HTML = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><title>ETC login verify (temporary)</title></head>
<body>
<h1>ETC ログイン検証 (一時 worker、60分で失効)</h1>
<p>入力した credential はこの worker 内でのみ使用され、log や response には出ません。ログインは1回だけで OK です (以降は cookie state をページ内で往復させます)。</p>
<form method="POST" action="/run">
  <p><label>ユーザーID: <input type="text" name="userId" autocomplete="off"></label></p>
  <p><label>パスワード: <input type="password" name="password" autocomplete="off"></label></p>
  <p><button type="submit">ログインして探索開始</button></p>
</form>
</body></html>`;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return html(FORM_HTML);
    }

    if (url.pathname === "/run" && request.method === "POST") {
      const form = await request.formData();
      const userId = form.get("userId");
      const password = form.get("password");
      if (typeof userId !== "string" || typeof password !== "string" || !userId || !password) {
        return json({ ok: false, error: "userId / password が空です" }, 400);
      }
      const jar = createCookieJar();
      try {
        const session = await etcLogin(jar, { userId, password }, fetch, ETC_REQUEST_TIMEOUT_MS);
        return html(renderExplorer(["login"], session.page, jar));
      } catch (e) {
        const message = e instanceof EtcMeisaiClientError ? e.message : String(e);
        return json({ ok: false, steps: ["login"], error: message }, 502);
      }
    }

    if (url.pathname === "/continue" && request.method === "POST") {
      const form = await request.formData();
      const stateToken = form.get("state");
      const target = form.get("target");
      const sokoKbnAll = form.get("sokoKbnAll") === "1";
      if (typeof stateToken !== "string" || typeof target !== "string") {
        return json({ ok: false, error: "state / target が不正です" }, 400);
      }
      const { jar, page } = decodeState(stateToken);
      const mainForm = pickMainForm(parseForms(page.html));
      const body = new URLSearchParams();
      if (mainForm) {
        for (const [name, value] of mainForm.fields) body.set(name, value);
        if (sokoKbnAll) {
          body.set("sokoKbn", "0");
          for (const cb of mainForm.checkboxes) body.set(cb.name, cb.value);
        }
      }
      try {
        const { url: finalUrl, res } = await rawRequest(
          jar,
          target,
          { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() },
          ETC_EXPORT_TIMEOUT_MS,
        );
        const contentType = res.headers.get("content-type") ?? "";
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (looksLikeFile(contentType, bytes)) {
          const text = new TextDecoder("shift_jis").decode(bytes);
          const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
          return html(
            renderDone(["...", "download"], "(unknown)", "meisai.csv", bytes.byteLength, lines.length, lines[0]?.slice(0, 200) ?? null),
          );
        }
        const nextPage: EtcPage = { url: finalUrl, html: decodeHtml(bytes.buffer as ArrayBuffer, contentType) };
        return html(renderExplorer(["...", "continue"], nextPage, jar));
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
      }
    }

    return json({ error: "not_found" }, 404);
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
