#!/usr/bin/env node
/**
 * ETC ブラウザレススクレイパーの CCoW 内検証 runner (Refs
 * ohishi-exp/dtako-scraper#22, ippoan/cdp-relay#69)。
 *
 * login (credential を使う部分) は手元ブラウザにやらせ、その cookie を借りて
 * CCoW 内で「検索→CSV 取得」だけを回す。credential は手元ブラウザ → etc-meisai
 * (手元 egress) だけを通り、CCoW / Anthropic egress gateway を一切通らない。
 *
 * 手順 (CCoW から):
 *   1. cdp-relay で手元ブラウザを pair し、手元で etc-meisai に login する
 *   2. browser_cookies(session, ["https://www2.etc-meisai.jp"]) → cookies_url
 *      (login/検索/CSV の実 host は www2、トップページのみ www。実機確認済み)
 *   3. browser_eval(session, "location.href") → login 後 URL (startUrl)
 *   4. npx tsx scripts/verify-etc.ts <cookies_url> <startUrl>
 *
 * この runner は cookie の value も CSV 明細 (個人情報) も出力しない。出すのは
 * cookie 名 / 件数 / ヘッダ行 (ASCII) / 成否だけ。
 *
 * **node/bun の組み込み fetch (undici) は www2.etc-meisai.jp との TLS
 * ハンドシェイクで一貫して失敗する** (CCoW egress gateway の TLS 再終端で
 * runtime が送る ClientHello fingerprint が向こう側の WAF に弾かれると見られる、
 * 実機確認済み: node fetch は 503 "TLS_error...HANDSHAKE_FAILURE"、curl は同一
 * ホストに安定して 200)。よって etc-meisai.jp 向けの fetch だけ `curl` を
 * サブプロセスで呼ぶアダプタ (`curlFetch`) に差し替える。cdp-relay 自体への
 * fetch (cookies_url 取得) は通常の fetch のままで問題ない。
 *
 * 検証範囲の限界: この経路は etcLogin (funccode/hidden POST) を通らないので、
 * login 実装自体は検証されない (login は本番 cron / devtools 観察で別途検証)。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EtcMeisaiClientError,
  EtcMeisaiNoUsageError,
  scrapeEtcFromCookies,
  type EtcCookie,
} from "../src/etc-meisai-client";
import type { FetchLike } from "../src/theearth-client";

/**
 * `curl -K <config>` で HTTP リクエストを実行し、結果を `Response` として返す
 * `FetchLike` 互換アダプタ。credential/cookie を含み得るヘッダ・body はコマンド
 * ライン引数ではなく **config ファイル (stdin 経由)** で渡すため、`ps` 等で
 * プロセス引数を見ても値は出ない。
 */
export const curlFetch: FetchLike = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);

  const dir = mkdtempSync(join(tmpdir(), "curlfetch-"));
  const headerOutFile = join(dir, "headers.out");
  const bodyOutFile = join(dir, "body.out");
  const configFile = join(dir, "curl.cfg");

  try {
    const configLines: string[] = [
      `url = "${url}"`,
      `request = "${method}"`,
      `dump-header = "${headerOutFile}"`,
      `output = "${bodyOutFile}"`,
      "silent",
      "show-error",
      // redirect:"manual" (呼び出し元の前提) に合わせ、curl 側でも自動フォローしない
      // (curl は --location を付けない限りデフォルトでフォローしないため既定で満たす)。
    ];
    headers.forEach((value, name) => {
      configLines.push(`header = "${name.replace(/"/g, '\\"')}: ${value.replace(/"/g, '\\"')}"`);
    });
    let stdinBody: string | undefined;
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string") {
        throw new Error("curlFetch: body は string のみ対応 (URLSearchParams.toString() を渡すこと)");
      }
      configLines.push('data-binary = "@-"');
      stdinBody = init.body;
    }
    writeFileSync(configFile, configLines.join("\n") + "\n", "utf-8");

    await new Promise<void>((resolve, reject) => {
      const child = spawn("curl", ["-K", configFile], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`curl exited with code ${code}: ${stderr}`));
      });
      if (stdinBody !== undefined) child.stdin.write(stdinBody);
      child.stdin.end();
    });

    const headerRaw = readFileSync(headerOutFile, "utf-8");
    const bodyBytes = readFileSync(bodyOutFile);
    // dump-header は redirect を手動フォローしないため 1 レスポンス分のみ。
    // 複数 "HTTP/x.x" 行 (100-continue 等) が出ることがあるので最後のブロックを使う。
    const blocks = headerRaw.split(/\r?\n\r?\n/).filter((b: string) => b.trim() !== "");
    const lastBlock = blocks[blocks.length - 1] ?? "";
    const headerLines = lastBlock.split(/\r?\n/);
    const statusLine = headerLines[0] ?? "HTTP/1.1 0 Unknown";
    const status = parseInt(statusLine.split(" ")[1] ?? "0", 10);
    const resHeaders = new Headers();
    for (const line of headerLines.slice(1)) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (name) resHeaders.append(name, value);
    }
    return new Response(bodyBytes, { status: status || 200, headers: resHeaders });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}) as FetchLike;

async function main() {
  const [cookiesUrl, startUrl] = process.argv.slice(2);
  if (!cookiesUrl || !startUrl) {
    console.error("usage: npx tsx scripts/verify-etc.ts <cookies_url> <startUrl>");
    console.error("  cookies_url: cdp-relay browser_cookies が返した URL (cookie JSON を回収)");
    console.error("  startUrl:    手元ブラウザの login 後 URL (browser_eval location.href)");
    process.exit(2);
  }

  const cookiesRes = await fetch(cookiesUrl);
  if (!cookiesRes.ok) {
    console.error(`cookies fetch failed: HTTP ${cookiesRes.status}`);
    process.exit(1);
  }
  const { cookies } = (await cookiesRes.json()) as { cookies: EtcCookie[] };
  // cookie の value は出さない (session capability)。name と件数だけ。
  console.error(
    `[verify-etc] fetched ${cookies.length} cookies (names: ${cookies.map((c) => c.name).join(", ")})`,
  );

  try {
    const result = await scrapeEtcFromCookies(
      cookies,
      startUrl,
      (step, msg) => console.error(`[step] ${step}${msg ? " " + msg : ""}`),
      curlFetch,
      undefined,
      new Date(),
    );
    // CSV 明細は個人情報なので出さない。件数とヘッダ行 (ASCII) だけ。
    const text = new TextDecoder("shift_jis").decode(result.bytes);
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    console.log(
      JSON.stringify(
        {
          ok: true,
          accountType: result.accountType,
          filename: result.filename,
          bytes: result.bytes.byteLength,
          rows: lines.length,
          header: lines[0]?.slice(0, 200) ?? null,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    if (e instanceof EtcMeisaiNoUsageError) {
      console.log(JSON.stringify({ ok: true, note: "当該月のご利用はありません (0件)" }));
      process.exit(0);
    }
    const msg = e instanceof EtcMeisaiClientError ? e.message : String(e);
    console.error(JSON.stringify({ ok: false, error: msg }, null, 2));
    process.exit(1);
  }
}

// import 時 (デバッグスクリプトから curlFetch を再利用する場合等) は実行しない。
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
