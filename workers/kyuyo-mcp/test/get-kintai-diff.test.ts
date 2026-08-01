import { describe, it, expect, vi, afterEach } from "vitest";
import { getKintaiDiffTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";

/** GCP `day_summaries` の応答形。 */
function gcpBody(summaries: Record<string, unknown>) {
  return { month: "2026-06", rows: Object.keys(summaries).length, summaries };
}

/** オンプレ `kosoku-daily` (view 省略 = Full) の応答形。punches/parts も混ぜて捨てられることを確認する。 */
function onpremBody(drivers: Array<{ driver: number; days: unknown[] }>) {
  return { month: "2026-06", drivers };
}

function day(over: Partial<Record<string, unknown>> = {}) {
  return {
    date: "2026-06-01",
    start: "2026-06-01 08:00:00",
    end: "2026-06-01 20:00:00",
    source: "timecard",
    restraint_minutes: 720,
    working_minutes: 600,
    break_minutes: 120,
    rest_minus_minutes: 0,
    statutory_minutes: 480,
    within_statutory_overtime_minutes: 0,
    overtime_minutes: 120,
    legal_holiday_minutes: 0,
    night_minutes: 0,
    overtime_night_minutes: 0,
    legal_holiday_night_minutes: 0,
    punches: [{ at: "2026-06-01 08:00:00", state: "始業" }],
    parts: [],
    ...over,
  };
}

function env(over: Partial<Record<string, unknown>> = {}): Env {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(gcpBody({})))) },
    INTERNAL_SHARED_SECRET: SECRET,
    NUXT_ICHIBAN_API_URL: "https://rust-ichiban.example.com",
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid.access",
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: { get: async () => "csecret" },
    ...over,
  } as unknown as Env;
}

const relayFetch = (e: Env) => (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch;

describe("get_kintai_diff (ohishi-exp/rust-ichibanboshi#205 の 50)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("**read tool。** scope を要求しない", () => {
    expect((getKintaiDiffTool as { requiresScope?: string }).requiresScope).toBeUndefined();
  });

  it("**書き込みの引数を持たない**", () => {
    const keys = Object.keys(getKintaiDiffTool.inputSchema.shape);
    expect(keys.sort()).toEqual(["driver", "month"]);
  });

  it("month が YYYY-MM でなければ何も叩かない", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const e = env();
    await expect(getKintaiDiffTool.execute(e, { month: "2026-7" })).rejects.toThrow(/YYYY-MM/);
    expect(relayFetch(e)).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("SCRAPER_RELAY が無ければ fail-closed (オンプレも叩かない)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      getKintaiDiffTool.execute(env({ SCRAPER_RELAY: undefined }), { month: "2026-06" }),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("INTERNAL_SHARED_SECRET が無ければ fail-closed", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      getKintaiDiffTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), { month: "2026-06" }),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("relay (GCP) の失敗は本文の先頭を添えて上げる", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(onpremBody([])), { status: 200 }));
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(getKintaiDiffTool.execute(e, { month: "2026-06" })).rejects.toThrow(
      /relay: status 401: nope/,
    );
  });

  it("relay (GCP) が JSON でなければ parse failed で落とす", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(onpremBody([])), { status: 200 }));
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(getKintaiDiffTool.execute(e, { month: "2026-06" })).rejects.toThrow(/parse failed/);
  });

  it("オンプレ側の接続不能はそのまま上げる (fetchIchibanJson の握り潰さない挙動)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const e = env();
    await expect(getKintaiDiffTool.execute(e, { month: "2026-06" })).rejects.toThrow(
      /rust-ichibanboshi へ接続できません/,
    );
  });

  it("driver を指定すると両方の query に載せる。省略すると両方載せない", async () => {
    const onpremCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      onpremCalls.push(url);
      return new Response(JSON.stringify(onpremBody([])), { status: 200 });
    });
    const e = env();
    await getKintaiDiffTool.execute(e, { month: "2026-06", driver: "1051" });
    expect(onpremCalls[0]).toBe(
      "https://rust-ichiban.example.com/api/kintai/kosoku-daily?month=2026-06&driver=1051",
    );
    const gcpUrl = new URL(relayFetch(e).mock.calls[0]![0] as string);
    expect(gcpUrl.searchParams.get("driver")).toBe("1051");

    const e2 = env();
    await getKintaiDiffTool.execute(e2, { month: "2026-06" });
    expect(onpremCalls[1]).toBe(
      "https://rust-ichiban.example.com/api/kintai/kosoku-daily?month=2026-06",
    );
    const gcpUrl2 = new URL(relayFetch(e2).mock.calls[0]![0] as string);
    expect(gcpUrl2.searchParams.has("driver")).toBe(false);
  });

  it("5 分類 (only_gcp / only_onprem_driver0 / only_onprem_other / restraint一致 / restraint不一致) に振り分け、値が完全一致する行は落とす", async () => {
    const KEY_ONLY_GCP = "2001|2026-06-01|2026-06-01 08:00:00";
    const KEY_ONLY_ONPREM_0 = "0|2026-06-02|2026-06-02 09:00:00";
    const KEY_ONLY_ONPREM_OTHER = "2002|2026-06-03|2026-06-03 09:00:00";
    const KEY_RESTRAINT_MATCH = "2003|2026-06-04|2026-06-04 09:00:00";
    const KEY_RESTRAINT_MISMATCH = "2004|2026-06-05|2026-06-05 09:00:00";
    const KEY_IDENTICAL = "2005|2026-06-06|2026-06-06 09:00:00";

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify(
            onpremBody([
              { driver: 0, days: [day({ date: "2026-06-02", start: "2026-06-02 09:00:00" })] },
              {
                driver: 2002,
                days: [day({ date: "2026-06-03", start: "2026-06-03 09:00:00" })],
              },
              {
                driver: 2003,
                days: [
                  day({
                    date: "2026-06-04",
                    start: "2026-06-04 09:00:00",
                    break_minutes: 100,
                    working_minutes: 620,
                  }),
                ],
              },
              {
                driver: 2004,
                days: [
                  day({
                    date: "2026-06-05",
                    start: "2026-06-05 09:00:00",
                    restraint_minutes: 700,
                  }),
                ],
              },
              { driver: 2005, days: [day({ date: "2026-06-06", start: "2026-06-06 09:00:00" })] },
            ]),
          ),
          { status: 200 },
        ),
    );

    const e = env({
      SCRAPER_RELAY: {
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify(
                gcpBody({
                  [KEY_ONLY_GCP]: {
                    shift_source: "timecard",
                    restraint_minutes: 720,
                    working_minutes: 600,
                    break_minutes: 120,
                    rest_minus_minutes: 0,
                    statutory_minutes: 480,
                    within_statutory_overtime_minutes: 0,
                    overtime_minutes: 120,
                    legal_holiday_minutes: 0,
                    night_minutes: 0,
                    overtime_night_minutes: 0,
                    legal_holiday_night_minutes: 0,
                  },
                  [KEY_RESTRAINT_MATCH]: {
                    shift_source: "timecard",
                    restraint_minutes: 720,
                    working_minutes: 600,
                    break_minutes: 120,
                    rest_minus_minutes: 0,
                    statutory_minutes: 480,
                    within_statutory_overtime_minutes: 0,
                    overtime_minutes: 120,
                    legal_holiday_minutes: 0,
                    night_minutes: 0,
                    overtime_night_minutes: 0,
                    legal_holiday_night_minutes: 0,
                  },
                  [KEY_RESTRAINT_MISMATCH]: {
                    shift_source: "timecard",
                    restraint_minutes: 720,
                    working_minutes: 600,
                    break_minutes: 120,
                    rest_minus_minutes: 0,
                    statutory_minutes: 480,
                    within_statutory_overtime_minutes: 0,
                    overtime_minutes: 120,
                    legal_holiday_minutes: 0,
                    night_minutes: 0,
                    overtime_night_minutes: 0,
                    legal_holiday_night_minutes: 0,
                  },
                  [KEY_IDENTICAL]: {
                    shift_source: "timecard",
                    restraint_minutes: 720,
                    working_minutes: 600,
                    break_minutes: 120,
                    rest_minus_minutes: 0,
                    statutory_minutes: 480,
                    within_statutory_overtime_minutes: 0,
                    overtime_minutes: 120,
                    legal_holiday_minutes: 0,
                    night_minutes: 0,
                    overtime_night_minutes: 0,
                    legal_holiday_night_minutes: 0,
                  },
                }),
              ),
              { status: 200 },
            ),
        ),
      },
    });

    const res = (await getKintaiDiffTool.execute(e, { month: "2026-06" })) as any;

    expect(res.gcp_rows).toBe(4);
    expect(res.onprem_rows).toBe(5);

    expect(res.only_gcp.total).toBe(1);
    expect(res.only_gcp.items[0]).toMatchObject({
      driver_cd: "2001",
      date: "2026-06-01",
      start: "2026-06-01 08:00:00",
    });

    expect(res.only_onprem_driver0.total).toBe(1);
    expect(res.only_onprem_driver0.items[0]).toMatchObject({ driver_cd: "0", date: "2026-06-02" });

    expect(res.only_onprem_other.total).toBe(1);
    expect(res.only_onprem_other.items[0]).toMatchObject({ driver_cd: "2002", date: "2026-06-03" });

    expect(res.value_diff_restraint_match.total).toBe(1);
    const matchRow = res.value_diff_restraint_match.items[0];
    expect(matchRow.driver_cd).toBe("2003");
    expect(matchRow.gcp.restraint_minutes).toBe(matchRow.onprem.restraint_minutes);
    expect(matchRow.diff_fields.sort()).toEqual(["break_minutes", "working_minutes"]);

    expect(res.value_diff_restraint_mismatch.total).toBe(1);
    const mismatchRow = res.value_diff_restraint_mismatch.items[0];
    expect(mismatchRow.driver_cd).toBe("2004");
    expect(mismatchRow.gcp.restraint_minutes).not.toBe(mismatchRow.onprem.restraint_minutes);
    expect(mismatchRow.diff_fields).toEqual(["restraint_minutes"]);

    // 完全一致行 (KEY_IDENTICAL) はどのカテゴリにも出ない
    const allKeys = [
      ...res.only_gcp.items,
      ...res.only_onprem_driver0.items,
      ...res.only_onprem_other.items,
      ...res.value_diff_restraint_match.items,
      ...res.value_diff_restraint_mismatch.items,
    ].map((r: { driver_cd: string; date: string }) => `${r.driver_cd}|${r.date}`);
    expect(allKeys).not.toContain("2005|2026-06-06");

    // どちらが古いかは出さない — note は判定しない旨だけ
    expect(res.note).toMatch(/判定しない/);

    // punches/parts は突合結果に含めない (捨てている)
    expect(JSON.stringify(res)).not.toMatch(/punches/);
    expect(JSON.stringify(res)).not.toMatch(/"parts"/);
  });

  it("カテゴリごとに上限 (500) で切り、total と capped で分かる形にする", async () => {
    const summaries: Record<string, unknown> = {};
    const gcpValue = {
      shift_source: "timecard",
      restraint_minutes: 720,
      working_minutes: 600,
      break_minutes: 120,
      rest_minus_minutes: 0,
      statutory_minutes: 480,
      within_statutory_overtime_minutes: 0,
      overtime_minutes: 120,
      legal_holiday_minutes: 0,
      night_minutes: 0,
      overtime_night_minutes: 0,
      legal_holiday_night_minutes: 0,
    };
    for (let i = 0; i < 501; i++) {
      summaries[`${3000 + i}|2026-06-01|2026-06-01 08:00:00`] = gcpValue;
    }
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(onpremBody([])), { status: 200 }));
    const e = env({
      SCRAPER_RELAY: {
        fetch: vi.fn(async () => new Response(JSON.stringify(gcpBody(summaries)), { status: 200 })),
      },
    });
    const res = (await getKintaiDiffTool.execute(e, { month: "2026-06" })) as any;
    expect(res.only_gcp.total).toBe(501);
    expect(res.only_gcp.items).toHaveLength(500);
    expect(res.only_gcp.capped).toBe(true);
    // 切れていないカテゴリは capped: false
    expect(res.only_onprem_other.capped).toBe(false);
  });

  it("GCP `summaries` が欠けている / 形が違う応答は空扱いにする", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(onpremBody([])), { status: 200 }));
    const e = env({
      SCRAPER_RELAY: {
        fetch: vi.fn(async () => new Response(JSON.stringify({ month: "2026-06", rows: 0 }), { status: 200 })),
      },
    });
    const res = (await getKintaiDiffTool.execute(e, { month: "2026-06" })) as any;
    expect(res.gcp_rows).toBe(0);
  });

  it("オンプレ `drivers` が配列でない / `days` が配列でない / date・start が文字列でない行は無視する", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            month: "2026-06",
            drivers: [
              { driver: 1, days: "not-an-array" },
              { driver: 2, days: [{ ...day(), date: undefined }] },
              { driver: 3, days: [{ ...day(), start: undefined }] },
            ],
          }),
          { status: 200 },
        ),
    );
    const e = env();
    const res = (await getKintaiDiffTool.execute(e, { month: "2026-06" })) as any;
    expect(res.onprem_rows).toBe(0);
  });

  it("分数が number でも非有限 (NaN 等) なら 0 扱いにする", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify(
            onpremBody([
              {
                driver: 5001,
                days: [day({ date: "2026-06-07", start: "2026-06-07 09:00:00", night_minutes: NaN })],
              },
            ]),
          ),
          { status: 200 },
        ),
    );
    const e = env();
    const res = (await getKintaiDiffTool.execute(e, { month: "2026-06" })) as any;
    // GCP 側に無いので only_onprem_other に落ちる。NaN が 0 に丸められて JSON に出ること自体を確認する
    expect(res.only_onprem_other.items[0].onprem.night_minutes).toBe(0);
  });

  it("オンプレ `drivers` そのものが配列でない応答は空扱いにする", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ month: "2026-06" }), { status: 200 }),
    );
    const e = env();
    const res = (await getKintaiDiffTool.execute(e, { month: "2026-06" })) as any;
    expect(res.onprem_rows).toBe(0);
  });
});
