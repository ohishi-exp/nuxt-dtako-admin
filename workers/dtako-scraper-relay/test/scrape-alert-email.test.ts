import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_REASON_FOLD_FAILED,
  buildDtakoCronAlertBody,
  buildScrapeAlertEmail,
  buildScrapeAlertSubject,
  dtakoCronAlertReason,
  parseScrapeAlertEmailConfig,
  recalcPendingAlertReason,
  SCRAPE_ALERT_EMAIL_SENDER_NAME,
  sendScrapeAlertEmail,
  splitFailedAlertReason,
} from "../src/scrape-alert-email";
import { DTAKO_ACCOUNTS_EMPTY_DETAIL, type CronRunResult } from "../src/cron";

/** 架空のアドレス (実物ではない。この repo は public)。 */
const FROM = "relay@example.com";
const TO = "alert@example.com";
const CONFIG_RAW = JSON.stringify({ from: FROM, to: TO });

/** MIME の本文 (ヘッダの後の空行より後ろ)。8bit なのでそのまま読める。 */
function mimeBody(raw: string): string {
  return raw.slice(raw.search(/\r?\n\r?\n/)).trim();
}

/** ヘッダ `name` の encoded-word (`=?utf-8?B?…?=`) を復号する。 */
function encodedWord(raw: string, name: string): string {
  const b64 = new RegExp(`^${name}: =\\?utf-8\\?B\\?([^?]+)\\?=`, "im").exec(raw)?.[1] ?? "";
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function captureConsoleError() {
  const lines: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    lines.push(JSON.parse(String(line)) as Record<string, unknown>);
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseScrapeAlertEmailConfig", () => {
  it("from / to が揃えば ok (前後の空白は落とす)", () => {
    expect(parseScrapeAlertEmailConfig(JSON.stringify({ from: ` ${FROM} `, to: TO }))).toEqual({
      ok: true,
      config: { from: FROM, to: TO },
    });
  });

  it.each([
    ["null", null],
    ["空文字", ""],
    ["空白だけ", "   "],
  ])("設定なし (%s) は未設定として fail-closed", (_label, raw) => {
    const r = parseScrapeAlertEmailConfig(raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("未設定");
  });

  it("JSON でなければ理由つきで失敗", () => {
    const r = parseScrapeAlertEmailConfig("{from:");
    expect(!r.ok && r.reason).toContain("パースできません");
  });

  it.each([
    ["null", "null"],
    ["配列", JSON.stringify([CONFIG_RAW])],
    ["文字列", JSON.stringify("x@example.com")],
  ])("オブジェクトでない (%s) は失敗", (_label, raw) => {
    const r = parseScrapeAlertEmailConfig(raw);
    expect(!r.ok && r.reason).toContain("JSON オブジェクト");
  });

  it.each([
    ["from 欠け", { to: TO }, "from"],
    ["from が空", { from: " ", to: TO }, "from"],
    ["from に @ が無い", { from: "relay", to: TO }, "from"],
    ["from が数値", { from: 1, to: TO }, "from"],
    ["to 欠け", { from: FROM }, "to"],
    ["to に @ が無い", { from: FROM, to: "alert" }, "to"],
  ])("%s は失敗し、どちらが悪いかを名指しする (値は載せない)", (_label, value, field) => {
    const r = parseScrapeAlertEmailConfig(JSON.stringify(value));
    expect(r.ok).toBe(false);
    const reason = !r.ok ? r.reason : "";
    expect(reason).toContain(` ${field} `);
    expect(reason).not.toContain("example.com");
  });
});

describe("buildScrapeAlertEmail", () => {
  it("text/plain の MIME を組む (差出人名・宛先・件名・本文)", () => {
    const subject = buildScrapeAlertSubject("2026-10-05", "2026-10-05");
    const mail = buildScrapeAlertEmail({ from: FROM, to: TO }, subject, "本文 1 行目\n2 行目");
    expect(mail.from).toBe(FROM);
    expect(mail.to).toBe(TO);
    // 差出人名・件名は encoded-word (`=?utf-8?B?…?=`)。復号して確かめる。
    expect(encodedWord(mail.raw, "From")).toBe(SCRAPE_ALERT_EMAIL_SENDER_NAME);
    expect(mail.raw).toMatch(new RegExp(`^From: \\S+ <${FROM}>`, "m"));
    expect(mail.raw).toContain(`To: <${TO}>`);
    expect(encodedWord(mail.raw, "Subject")).toBe("[dtako] 取り込み失敗 2026/10/05");
    expect(mail.raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(mail.raw).toContain("Content-Transfer-Encoding: 8bit");
    expect(mimeBody(mail.raw)).toContain("本文 1 行目\n2 行目");
  });

  it("件名は読取日の範囲 (日次は 1 日だけ)", () => {
    expect(buildScrapeAlertSubject("2026-10-05", "2026-10-06")).toBe(
      "[dtako] 取り込み失敗 2026/10/05〜2026/10/06",
    );
  });
});

describe("sendScrapeAlertEmail", () => {
  it("設定と binding が揃えば 1 通送る", async () => {
    const send = vi.fn(async () => {});
    await sendScrapeAlertEmail({ readConfig: async () => CONFIG_RAW, send }, "件名", "本文");
    expect(send).toHaveBeenCalledTimes(1);
    const [from, to, raw] = send.mock.calls[0] as unknown as [string, string, string];
    expect([from, to]).toEqual([FROM, TO]);
    expect(mimeBody(raw)).toContain("本文");
  });

  it("send が null なら送らず、not_sent を出す (KV は読まない)", async () => {
    const errs = captureConsoleError();
    const readConfig = vi.fn(async () => CONFIG_RAW);
    await sendScrapeAlertEmail({ readConfig, send: null }, "件名", "本文", { comp_id: "c1" });
    expect(readConfig).not.toHaveBeenCalled();
    expect(errs.lines).toEqual([
      { comp_id: "c1", status: "scrape_alert_email_not_sent", reason: expect.stringContaining("ALERT_EMAIL") },
    ]);
  });

  it("設定なしなら送らず、not_sent を出す", async () => {
    const errs = captureConsoleError();
    const send = vi.fn(async () => {});
    await sendScrapeAlertEmail({ readConfig: async () => null, send }, "件名", "本文");
    expect(send).not.toHaveBeenCalled();
    expect(errs.lines[0]).toMatchObject({
      status: "scrape_alert_email_not_sent",
      reason: expect.stringContaining("未設定"),
    });
  });

  it("JSON 不正なら送らず、not_sent を出す", async () => {
    const errs = captureConsoleError();
    const send = vi.fn(async () => {});
    await sendScrapeAlertEmail({ readConfig: async () => "not json", send }, "件名", "本文");
    expect(send).not.toHaveBeenCalled();
    expect(errs.lines[0]).toMatchObject({ status: "scrape_alert_email_not_sent" });
  });

  it("KV の読み取りが throw しても外へ出さない (種別だけ残す)", async () => {
    const errs = captureConsoleError();
    const send = vi.fn(async () => {});
    await expect(
      sendScrapeAlertEmail(
        {
          readConfig: async () => {
            throw new TypeError("kv down secret-ish detail");
          },
          send,
        },
        "件名",
        "本文",
      ),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(errs.lines[0]).toMatchObject({
      status: "scrape_alert_email_not_sent",
      reason: expect.stringContaining("TypeError"),
    });
    expect(JSON.stringify(errs.lines)).not.toContain("secret-ish");
  });

  it("送信が throw しても外へ出さず send_failed を出す (Error 以外も)", async () => {
    const errs = captureConsoleError();
    await sendScrapeAlertEmail(
      {
        readConfig: async () => CONFIG_RAW,
        send: async () => {
          throw new Error(`destination ${TO} not verified`);
        },
      },
      "件名",
      "本文",
    );
    await sendScrapeAlertEmail(
      {
        readConfig: async () => CONFIG_RAW,
        send: async () => {
          throw "boom";
        },
      },
      "件名",
      "本文",
    );
    expect(errs.lines).toEqual([
      { status: "scrape_alert_email_send_failed", reason: "Error" },
      { status: "scrape_alert_email_send_failed", reason: "string" },
    ]);
  });
});

describe("理由の固定文言", () => {
  it("分割の失敗は件数だけ", () => {
    expect(splitFailedAlertReason(3)).toBe("CSV の分割が 3 件失敗");
  });

  it("要再計算: error / failed > 0 は鳴らす", () => {
    expect(
      recalcPendingAlertReason({ processed: 0, failed: 0, remaining: 0, rounds: 1, error: { kind: "http", status: 502 } }),
    ).toBe("要再計算の呼び出しが失敗 (http HTTP 502)");
    expect(
      recalcPendingAlertReason({ processed: 0, failed: 0, remaining: 0, rounds: 1, error: { kind: "network", status: null } }),
    ).toBe("要再計算の呼び出しが失敗 (network)");
    expect(recalcPendingAlertReason({ processed: 5, failed: 2, remaining: 0, rounds: 1, error: null })).toBe(
      "要再計算が 2 件失敗",
    );
  });

  it("要再計算: remaining > 0 だけ (続きがある) と成功は鳴らさない", () => {
    expect(recalcPendingAlertReason({ processed: 100, failed: 0, remaining: 40, rounds: 5, error: null })).toBeNull();
    expect(recalcPendingAlertReason({ processed: 3, failed: 0, remaining: 0, rounds: 1, error: null })).toBeNull();
  });

  it("畳み直しの失敗は固定の語", () => {
    expect(ALERT_REASON_FOLD_FAILED).toBe("勤怠の畳み直しが失敗");
  });
});

describe("dtakoCronAlertReason", () => {
  const ok = (target: string): CronRunResult => ({ kind: "dtako", target, ok: true, detail: "HTTP 202" });
  const ng = (target: string): CronRunResult => ({ kind: "dtako", target, ok: false, detail: "HTTP 500" });

  it("全社 ok なら null", () => {
    expect(dtakoCronAlertReason([ok("a"), ok("b")])).toBeNull();
  });

  it("ok: false の会社の数を出す (会社 ID は出さない)", () => {
    expect(dtakoCronAlertReason([ok("a"), ng("b"), ng("c")])).toBe("2 社ぶんの取り込みを積めませんでした");
  });

  it("DTAKO_ACCOUNTS が空で skip したら鳴らす", () => {
    expect(
      dtakoCronAlertReason([{ kind: "dtako", target: "*", ok: true, detail: DTAKO_ACCOUNTS_EMPTY_DETAIL }]),
    ).toContain("DTAKO_ACCOUNTS が空");
  });

  it("SCRAPER_MODE の意図した skip と、dtako 以外の失敗は鳴らさない", () => {
    expect(
      dtakoCronAlertReason([
        { kind: "dtako", target: "*", ok: true, detail: "SCRAPER_MODE=(unset) のため skip" },
        { kind: "etc", target: "x", ok: false, detail: "HTTP 500" },
        { kind: "restraint", target: "*", ok: true, detail: DTAKO_ACCOUNTS_EMPTY_DETAIL },
      ]),
    ).toBeNull();
  });

  it("本文は読取日と理由", () => {
    expect(buildDtakoCronAlertBody("2026-10-05", "理由")).toBe(
      "【dtako スクレイプ】2026/10/05分の日次取り込み: 理由",
    );
  });
});
