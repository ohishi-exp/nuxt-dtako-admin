#!/usr/bin/env bun
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
 *   2. browser_cookies(session, ["https://www.etc-meisai.jp"]) → cookies_url
 *   3. browser_eval(session, "location.href") → login 後 URL (startUrl)
 *   4. bun run scripts/verify-etc.ts <cookies_url> <startUrl>
 *
 * この runner は cookie の value も CSV 明細 (個人情報) も出力しない。出すのは
 * cookie 名 / 件数 / ヘッダ行 (ASCII) / 成否だけ。
 *
 * 検証範囲の限界: この経路は etcLogin (funccode/hidden POST) を通らないので、
 * login 実装自体は検証されない (login は本番 cron / devtools 観察で別途検証)。
 */
import {
  EtcMeisaiClientError,
  EtcMeisaiNoUsageError,
  scrapeEtcFromCookies,
  type EtcCookie,
} from "../src/etc-meisai-client";

const [cookiesUrl, startUrl] = process.argv.slice(2);
if (!cookiesUrl || !startUrl) {
  console.error("usage: bun run scripts/verify-etc.ts <cookies_url> <startUrl>");
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
  const result = await scrapeEtcFromCookies(cookies, startUrl, (step, msg) =>
    console.error(`[step] ${step}${msg ? " " + msg : ""}`),
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
