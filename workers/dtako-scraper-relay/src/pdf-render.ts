/**
 * HTML → PDF (A4 横、背景色つき)。Browser Rendering の `[browser]` binding を使う
 * (前例は ippoan/auth-worker の `verify-shot.ts`。あちらは screenshot)。puppeteer は
 * PDF を作るときだけ読み込む (他の口と node の vitest に重さを持ち込まない)。
 *
 * 最低賃金 年間レポートの 2 つの口 (DO の画面用と index の MCP 用) が使う。ランタイム依存なので
 * coverage gate (pure ロジックだけ) には載せない — テストは呼び手に stub を渡して測る。
 */
export async function renderPdf(binding: Fetcher, html: string): Promise<Uint8Array> {
  const { default: puppeteer } = await import("@cloudflare/puppeteer");
  const browser = await puppeteer.launch(binding);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", landscape: true, printBackground: true });
  } finally {
    await browser.close();
  }
}
