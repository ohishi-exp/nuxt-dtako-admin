import { describe, expect, it, vi } from "vitest";

import {
  driverMasterOverallStatus,
  ERROR_TEXT_MAX_CHARS,
  runDriverMasterForComps,
  type DriverMasterCompResult,
} from "../src/driver-master-run";

/** DO が 1 社ぶん成功したときに返す形 (`runDriverMasterSync` の Response.json)。 */
function okBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    ok: true,
    comp_id: "00000001",
    rows: 3,
    items: 3,
    created: 1,
    updated: 2,
    skipped: [],
    unreadable: null,
    ...over,
  });
}

describe("失敗本文の切り詰め", () => {
  it("★ 一覧の構造要約が切れない長さまで載せる (2026-09-02 は 200 文字で見出しが落ちた)", async () => {
    // 実機の要約は「見出し=… 見出し候補=[…] 引けない列=[…] データ行=… tr=… title=… bytes=…」で、
    // 200 文字だと `引けない列=[乗務員CD,乗` で切れて**原因を名指しする部分が落ちた**。
    const detail =
      "見出し=未検出 見出し候補=[編集 | 乗務員ＣＤ | 乗務員名 | 免許証番号 | 退職年月日 | 乗務員分類４ | 交付年月日 | 有効期限] " +
      "引けない列=[乗務員CD,乗務員名,退職年月日,乗務員分類4,交付年月日,有効期限] データ行=30 tr=68 " +
      'title="乗務員マスターメンテナンス" bytes=727933 行数select=true 行数ボタン=true';
    const body = JSON.stringify({ ok: false, comp_id: "1", rows: null, error: `TheearthClientError: 乗務員マスタ一覧から 1 行も読めませんでした (${detail})` });

    const results = await runDriverMasterForComps(["1"], async () => ({ status: 502, text: body }));

    expect(results[0]!.error).toContain("見出し候補=[");
    expect(results[0]!.error).toContain("有効期限]");
    expect(ERROR_TEXT_MAX_CHARS).toBeGreaterThan(200);
  });

  it("上限を超える本文は切る (暴走した本文で応答を膨らませない)", async () => {
    const body = JSON.stringify({ ok: false, error: "x".repeat(ERROR_TEXT_MAX_CHARS * 2) });

    const results = await runDriverMasterForComps(["1"], async () => ({ status: 502, text: body }));

    expect(results[0]!.error!.length).toBe(`HTTP 502: `.length + ERROR_TEXT_MAX_CHARS);
  });
});

describe("runDriverMasterForComps", () => {
  it("comp_id を 1 社ずつ順番に呼ぶ (並列にしない)", async () => {
    // 呼び出しの重なりを検出する: 実行中フラグが立っている間に次が始まったら false。
    const order: string[] = [];
    let inFlight = 0;
    let overlapped = false;
    const callDo = vi.fn(async (compId: string) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      order.push(`start:${compId}`);
      // マイクロタスクを跨がせる — 逐次でなければここで次が始まる。
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push(`end:${compId}`);
      inFlight -= 1;
      return { status: 200, text: okBody({ comp_id: compId }) };
    });

    const results = await runDriverMasterForComps(["00000001", "00000002", "00000003"], callDo);

    expect(overlapped).toBe(false);
    expect(order).toEqual([
      "start:00000001",
      "end:00000001",
      "start:00000002",
      "end:00000002",
      "start:00000003",
      "end:00000003",
    ]);
    expect(results.map((r) => r.comp_id)).toEqual(["00000001", "00000002", "00000003"]);
  });

  it("成功した社は created/updated/skipped を載せ、error キーを持たない", async () => {
    const skipped = [{ code: "1078", reason: "nfc_id_conflict" }];
    const results = await runDriverMasterForComps(["00000001"], async () => ({
      status: 200,
      text: okBody({ created: 4, updated: 5, skipped }),
    }));

    expect(results).toEqual([
      {
        comp_id: "00000001",
        status: 200,
        created: 4,
        updated: 5,
        skipped,
      },
    ]);
    expect("error" in results[0]).toBe(false);
  });

  it("1 社が非 2xx で落ちても残りを回し、その社だけ error を持つ", async () => {
    const callDo = vi.fn(async (compId: string) =>
      compId === "00000002"
        ? { status: 502, text: JSON.stringify({ ok: false, comp_id: compId, error: "theearth login failed" }) }
        : { status: 200, text: okBody({ comp_id: compId }) },
    );

    const results = await runDriverMasterForComps(["00000001", "00000002", "00000003"], callDo);

    expect(callDo).toHaveBeenCalledTimes(3);
    expect(results[0].error).toBeUndefined();
    expect(results[2].error).toBeUndefined();
    expect(results[1].status).toBe(502);
    // DO が返した本文をそのまま添える (cron 分岐の detail と同じ形)。
    expect(results[1].error).toBe(
      'HTTP 502: {"ok":false,"comp_id":"00000002","error":"theearth login failed"}',
    );
    expect(results[1].created).toBeNull();
    expect(results[1].skipped).toEqual([]);
  });

  it("DO 呼び出しが throw しても残りを回し、status は null になる", async () => {
    const callDo = vi.fn(async (compId: string) => {
      if (compId === "00000001") throw new Error("Network connection lost");
      return { status: 200, text: okBody({ comp_id: compId }) };
    });

    const results = await runDriverMasterForComps(["00000001", "00000002"], callDo);

    expect(results[0]).toEqual({
      comp_id: "00000001",
      status: null,
      created: null,
      updated: null,
      skipped: [],
      error: "Network connection lost",
    });
    expect(results[1].error).toBeUndefined();
  });

  it("Error でない値が throw されても文字列化して残す", async () => {
    const results = await runDriverMasterForComps(["00000001"], async () => {
      throw "boom";
    });

    expect(results[0].error).toBe("boom");
    expect(results[0].status).toBeNull();
  });

  it("2xx でも応答が読めなければ error にする (静かに 0 件扱いしない)", async () => {
    const results = await runDriverMasterForComps(["00000001"], async () => ({
      status: 200,
      text: "<html>gateway</html>",
    }));

    expect(results[0].status).toBe(200);
    expect(results[0].error).toContain("応答が JSON として読めません");
    expect(results[0].created).toBeNull();
  });

  it("comp_id が空配列なら DO を 1 度も呼ばず空配列を返す", async () => {
    const callDo = vi.fn();
    expect(await runDriverMasterForComps([], callDo)).toEqual([]);
    expect(callDo).not.toHaveBeenCalled();
  });
});

describe("driverMasterOverallStatus", () => {
  const ok = (compId: string): DriverMasterCompResult => ({
    comp_id: compId,
    status: 200,
    created: 0,
    updated: 0,
    skipped: [],
  });
  const ng = (compId: string): DriverMasterCompResult => ({
    ...ok(compId),
    status: 502,
    error: "boom",
  });

  it("全社成功なら 200", () => {
    expect(driverMasterOverallStatus([ok("1"), ok("2")])).toBe(200);
  });

  it("1 社でも成功していれば 200 (残りが失敗でも)", () => {
    expect(driverMasterOverallStatus([ng("1"), ok("2"), ng("3")])).toBe(200);
  });

  it("全社失敗なら 502", () => {
    expect(driverMasterOverallStatus([ng("1"), ng("2")])).toBe(502);
  });

  it("空配列は 200 (呼び出し元が先に 404 で弾く)", () => {
    expect(driverMasterOverallStatus([])).toBe(200);
  });
});
