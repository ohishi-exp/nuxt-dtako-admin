import { describe, expect, it } from "vitest";

import {
  buildScrapeFailureNotification,
  formatReadingDateRange,
  resolveScrapeAlertTarget,
  sanitizeScrapeFailureDetail,
  SCRAPE_ALERT_DETAIL_MAX,
  SCRAPE_ALERT_TARGET_VAR,
} from "../src/scrape-alert";

/**
 * `SCRAPE_ALERT_TARGET` の宛先 (Refs #967)。
 *
 * **架空の Uuid を使う** — 実在の `lineworks_channels` / `notify_recipients` の
 * 行 id は本番の通知先そのもので、この repo は public。
 */
const CHANNEL_ID = "11111111-2222-3333-4444-555555555555";
const RECIPIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("resolveScrapeAlertTarget", () => {
  it("channel_id 1 件をトークルーム宛に解決する (前後の空白は落とす)", () => {
    expect(resolveScrapeAlertTarget(`{"channel_id":" ${CHANNEL_ID} "}`)).toEqual({
      ok: true,
      destination: { kind: "channel", id: CHANNEL_ID },
    });
  });

  it("recipient_id 1 件を個人宛に解決する", () => {
    expect(resolveScrapeAlertTarget(`{"recipient_id":"${RECIPIENT_ID}"}`)).toEqual({
      ok: true,
      destination: { kind: "recipient", id: RECIPIENT_ID },
    });
  });

  it("★ 未設定 (undefined) は fail-closed — 「送っていない」と入れ方を名指しする", () => {
    const resolved = resolveScrapeAlertTarget(undefined);
    expect(resolved.ok).toBe(false);
    // 「黙って何もしない」が一番危ないので、理由の文言そのものを対照に取る。
    expect(resolved.ok === false && resolved.error).toContain(SCRAPE_ALERT_TARGET_VAR);
    expect(resolved.ok === false && resolved.error).toContain("送っていません");
    expect(resolved.ok === false && resolved.error).toContain("plain 変数");
  });

  it("空文字 / 空白だけも未設定と同じ扱い (dashboard で消した形)", () => {
    const blank = resolveScrapeAlertTarget("   ");
    expect(blank.ok).toBe(false);
    expect(blank).toEqual(resolveScrapeAlertTarget(undefined));
  });

  it("JSON として読めなければ loud fail (未設定とは別の理由を出す)", () => {
    const resolved = resolveScrapeAlertTarget("{channel_id: x}");
    expect(resolved).toEqual({
      ok: false,
      error: `${SCRAPE_ALERT_TARGET_VAR} が JSON としてパースできません`,
    });
  });

  it("★ NETPRINT_TARGETS の形 (JSON 配列) を貼っても通さない", () => {
    const resolved = resolveScrapeAlertTarget(`[{"branch_cd":"1","channel_id":"${CHANNEL_ID}"}]`);
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error).toContain("JSON オブジェクト 1 件");
    expect(resolved.ok === false && resolved.error).toContain("NETPRINT_TARGETS");
  });

  it("null / スカラーの JSON もオブジェクトではないので弾く", () => {
    for (const raw of ["null", '"a-string"', "42"]) {
      const resolved = resolveScrapeAlertTarget(raw);
      expect(resolved.ok).toBe(false);
      expect(resolved.ok === false && resolved.error).toContain("JSON オブジェクト 1 件");
    }
  });

  it("両方指定 / 両方無しは宛先の規則 (netprint と同じ文言) で弾き、変数名を前に付ける", () => {
    expect(
      resolveScrapeAlertTarget(`{"channel_id":"${CHANNEL_ID}","recipient_id":"${RECIPIENT_ID}"}`),
    ).toEqual({
      ok: false,
      error: `${SCRAPE_ALERT_TARGET_VAR}: channel_id と recipient_id はどちらか一方だけ指定してください`,
    });
    expect(resolveScrapeAlertTarget("{}")).toEqual({
      ok: false,
      error: `${SCRAPE_ALERT_TARGET_VAR}: channel_id と recipient_id のどちらか一方を指定してください`,
    });
  });

  it("Uuid でない id は DB を引く前に弾く (どの表の行 id かまで書く)", () => {
    expect(resolveScrapeAlertTarget('{"channel_id":"ch-honsha"}')).toEqual({
      ok: false,
      error: `${SCRAPE_ALERT_TARGET_VAR}: channel_id が UUID 形式ではありません (lineworks_channels の行 id を指定してください)`,
    });
    expect(resolveScrapeAlertTarget('{"recipient_id":"honda"}')).toEqual({
      ok: false,
      error: `${SCRAPE_ALERT_TARGET_VAR}: recipient_id が UUID 形式ではありません (notify_recipients の行 id を指定してください)`,
    });
  });

  it("非文字列の id は「無い」に倒す (設定 JSON は素通しなので型が保証されない)", () => {
    expect(resolveScrapeAlertTarget('{"channel_id":42}').ok).toBe(false);
    expect(resolveScrapeAlertTarget('{"recipient_id":null}').ok).toBe(false);
  });
});

/**
 * ★ 通知に**原本 (theearth の HTML) の中身を 1 文字も載せない**ための対照。
 *
 * 失敗の原本には中間ファイルの UNC パスが入る。`describeScrapeFailure` の message は
 * `describePage()` (title + 本文先頭 160 字の生ページテキスト) を埋め込む経路を
 * 持つので、**そのまま流すと通知に原本が出る**。
 */
describe("sanitizeScrapeFailureDetail", () => {
  it("自前で書いた文だけの message はそのまま通す", () => {
    const message = "取得したデータが ZIP ではありません (1234 bytes) — ログイン切れの可能性があります";
    expect(sanitizeScrapeFailureDetail(message)).toBe(message);
  });

  it("★ 本文抜粋 (`本文先頭:` 以降) を落とす — 残るのは自前の文だけ", () => {
    // fixture は自作のダミー。実際の theearth の原本は 1 文字も使わない。
    const message =
      'ログイン POST が HTTP 500 を返しました (title="エラー" 本文先頭: 中間ファイルは別のプロセスが使用中です)';
    const detail = sanitizeScrapeFailureDetail(message);
    expect(detail).toContain("ログイン POST が HTTP 500 を返しました");
    expect(detail).toContain("(本文抜粋は省略)");
    expect(detail).not.toContain("中間ファイル");
    expect(detail).not.toContain("本文先頭");
  });

  it("★ marker を通らない UNC パスも伏せる (想定外例外の message 経由)", () => {
    const detail = sanitizeScrapeFailureDetail(
      "Error: 中間ファイル \\\\dummy-host\\dummy-share\\tmp\\a.csv を開けません",
    );
    expect(detail).toContain("(パス省略)");
    expect(detail).not.toContain("dummy-host");
    expect(detail).not.toContain("dummy-share");
  });

  it("★ ドライブレターのパスも伏せる", () => {
    const detail = sanitizeScrapeFailureDetail("Error: D:\\dummy\\work\\out.csv が使用中です");
    expect(detail).toContain("(パス省略)");
    expect(detail).not.toContain("dummy");
    expect(detail).toContain("が使用中です");
  });

  it("長い message は上限で切って … を付ける (原本の全文は R2 に在る)", () => {
    const detail = sanitizeScrapeFailureDetail("あ".repeat(SCRAPE_ALERT_DETAIL_MAX + 50));
    expect(detail).toHaveLength(SCRAPE_ALERT_DETAIL_MAX + 1);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("上限ちょうどは切らない (境界)", () => {
    const detail = sanitizeScrapeFailureDetail("あ".repeat(SCRAPE_ALERT_DETAIL_MAX));
    expect(detail).toHaveLength(SCRAPE_ALERT_DETAIL_MAX);
    expect(detail.endsWith("…")).toBe(false);
  });
});

describe("formatReadingDateRange", () => {
  it("同じ日なら 1 日だけ出す (日次 cron はこちら)", () => {
    expect(formatReadingDateRange("2026-08-28", "2026-08-28")).toBe("2026/08/28");
  });

  it("範囲なら 〜 で繋ぐ", () => {
    expect(formatReadingDateRange("2026-08-26", "2026-08-28")).toBe("2026/08/26〜2026/08/28");
  });
});

describe("buildScrapeFailureNotification", () => {
  it("会社 / 読取日 / 理由 / 原本の有無を 1 通にまとめる (netprint と同じ頭の形)", () => {
    const text = buildScrapeFailureNotification({
      compId: "27324455",
      startDate: "2026-08-28",
      endDate: "2026-08-28",
      message: "取得したデータが ZIP ではありません (512 bytes)",
      artifactSaved: true,
    });
    expect(text).toBe(
      [
        "【dtako スクレイプ】comp_id 27324455 の 2026/08/28分の自動取り込みに失敗しました: 取得したデータが ZIP ではありません (512 bytes)",
        "失敗した応答の原本は R2 に保存済みです (キーは通知に載せません)。",
      ].join("\n"),
    );
  });

  it("原本が残っていないときはそう書く (「在る」と嘘をつかない)", () => {
    const text = buildScrapeFailureNotification({
      compId: "75700192",
      startDate: "2026-08-26",
      endDate: "2026-08-28",
      message: "そのほかの失敗",
      artifactSaved: false,
    });
    expect(text).toContain("comp_id 75700192 の 2026/08/26〜2026/08/28分");
    expect(text).toContain("原本は保存されていません");
    expect(text).not.toContain("R2 に保存済み");
  });

  it("★ 呼び出し側が sanitize を通し忘れても原本は出ない (message は生で渡してよい)", () => {
    const text = buildScrapeFailureNotification({
      compId: "27324455",
      startDate: "2026-08-28",
      endDate: "2026-08-28",
      message:
        'ログイン POST が HTTP 500 を返しました (title="エラー" 本文先頭: \\\\dummy-host\\dummy-share が使用中)',
      artifactSaved: true,
    });
    expect(text).not.toContain("dummy-host");
    expect(text).not.toContain("本文先頭");
    expect(text).toContain("(本文抜粋は省略)");
  });
});
