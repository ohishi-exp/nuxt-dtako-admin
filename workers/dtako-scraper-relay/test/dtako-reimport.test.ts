import { describe, expect, it, vi } from "vitest";
import {
  assertZipReadyForPush,
  buildAutoloadPath,
  DtakoReimportError,
  DtakoReimportPushUncertainError,
  isUnkoNoAcceptable,
  runDtakoReimport,
  UNKO_NO_RE,
  type DtakoReimportDeps,
} from "../src/dtako-reimport";
import { VenusSessionExpiredError } from "../src/theearth-client";

const OPE_NO = "2606050753300000004286";
const START_OPE = "2026/07/07 7:53:30";
const UNKO_NO_23 = "26060507533000000042861";
const UNKO_NO_22 = UNKO_NO_23.slice(0, 22);

/** `PK\x03\x04` local file header 1 エントリぶんの最小 ZIP (operation-zip.test.ts
 * と同じ最小モック — central directory / EOCD は付けない)。 */
function minimalZip(name = "KUDGIVT.csv"): ArrayBuffer {
  const nameBytes = new TextEncoder().encode(name);
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(26, nameBytes.length, true);
  header.set(nameBytes, 30);
  return header.buffer;
}

describe("UNKO_NO_RE", () => {
  it("23桁の数字だけを通す", () => {
    expect(UNKO_NO_RE.test(UNKO_NO_23)).toBe(true);
    expect(UNKO_NO_RE.test(UNKO_NO_23.slice(1))).toBe(false); // 22桁
    expect(UNKO_NO_RE.test(`${UNKO_NO_23}1`)).toBe(false); // 24桁
    expect(UNKO_NO_RE.test(`${UNKO_NO_23.slice(0, 22)}a`)).toBe(false); // 非数字混じり
  });
});

describe("isUnkoNoAcceptable (Refs #625: ②のみなら22桁も受ける)", () => {
  it("reset_timecard=false (①②のみ) なら22桁・23桁どちらも通す", () => {
    expect(isUnkoNoAcceptable(UNKO_NO_22, false)).toBe(true);
    expect(isUnkoNoAcceptable(UNKO_NO_23, false)).toBe(true);
  });

  it("reset_timecard=true (③まで) なら23桁のみ通し、22桁は弾く (新しい歯止め)", () => {
    expect(isUnkoNoAcceptable(UNKO_NO_23, true)).toBe(true);
    expect(isUnkoNoAcceptable(UNKO_NO_22, true)).toBe(false);
  });

  it("桁数のどちらでも、空・非数字・21桁・24桁は引き続き弾く", () => {
    for (const resetTimecard of [false, true]) {
      expect(isUnkoNoAcceptable("", resetTimecard)).toBe(false);
      expect(isUnkoNoAcceptable("abcdefghijklmnopqrstuvw", resetTimecard)).toBe(false); // 23文字だが数字でない
      expect(isUnkoNoAcceptable(UNKO_NO_22.slice(1), resetTimecard)).toBe(false); // 21桁
      expect(isUnkoNoAcceptable(`${UNKO_NO_23}1`, resetTimecard)).toBe(false); // 24桁
    }
  });
});

describe("assertZipReadyForPush", () => {
  it("PK\\x03\\x04 で始まる zip は通す", () => {
    expect(() => assertZipReadyForPush(minimalZip())).not.toThrow();
  });

  it("4 バイト未満は拒否する", () => {
    expect(() => assertZipReadyForPush(new Uint8Array([0x50, 0x4b]).buffer)).toThrow(DtakoReimportError);
  });

  it("magic が違えば拒否する (壊れた zip を通さない)", () => {
    expect(() => assertZipReadyForPush(new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer)).toThrow(
      /PK\\x03\\x04 magic 不一致/,
    );
  });

  it("空の buffer は拒否する", () => {
    expect(() => assertZipReadyForPush(new ArrayBuffer(0))).toThrow(DtakoReimportError);
  });
});

describe("buildAutoloadPath", () => {
  it("reset_timecard=false を明示する (既定)", () => {
    expect(buildAutoloadPath(UNKO_NO_23, false)).toBe(
      `/api/dtako/autoload?unko_no=${UNKO_NO_23}&reset_timecard=false`,
    );
  });

  it("reset_timecard=true を明示する", () => {
    expect(buildAutoloadPath(UNKO_NO_23, true)).toBe(
      `/api/dtako/autoload?unko_no=${UNKO_NO_23}&reset_timecard=true`,
    );
  });
});

function depsOf(over: Partial<DtakoReimportDeps> = {}): DtakoReimportDeps {
  return {
    recalculateWork: vi.fn(async () => {}),
    fetchZip: vi.fn(async () => minimalZip()),
    onpremAutoload: vi.fn(async () => new Response(JSON.stringify({ http_status: 200, http_ok: true }))),
    ...over,
  };
}

describe("runDtakoReimport", () => {
  it("unko_no が22桁でも23桁でもなければ zip を取りにいかず拒否する (一括取り込み事故の歯止め)", async () => {
    const deps = depsOf();
    await expect(
      runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: "123" }),
    ).rejects.toThrow(DtakoReimportError);
    expect(deps.fetchZip).not.toHaveBeenCalled();
    expect(deps.recalculateWork).not.toHaveBeenCalled();
  });

  it("22桁 + reset_timecard省略 (①②のみ) は通す (Refs #625、取り込み漏れ候補は対象CDが作れない)", async () => {
    const onpremAutoload = vi.fn(async () => new Response(JSON.stringify({ http_status: 200 })));
    const deps = depsOf({ onpremAutoload });
    const report = await runDtakoReimport(deps, {
      opeNo: OPE_NO,
      startOpe: START_OPE,
      unkoNo: UNKO_NO_22,
    });
    expect(report.unko_no).toBe(UNKO_NO_22);
    expect(deps.fetchZip).toHaveBeenCalled();
    const call = (onpremAutoload as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe(`/api/dtako/autoload?unko_no=${UNKO_NO_22}&reset_timecard=false`);
  });

  it("22桁 + reset_timecard=true (③まで) は zip を取りにいかず拒否する (新しい歯止め)", async () => {
    const deps = depsOf();
    await expect(
      runDtakoReimport(deps, {
        opeNo: OPE_NO,
        startOpe: START_OPE,
        unkoNo: UNKO_NO_22,
        resetTimecard: true,
      }),
    ).rejects.toThrow(DtakoReimportError);
    expect(deps.fetchZip).not.toHaveBeenCalled();
  });

  it("① zip 取得 → ② push まで完結し、entries / bytes / autoload をまとめて返す", async () => {
    const onpremAutoload = vi.fn(async () =>
      new Response(
        JSON.stringify({
          http_status: 200,
          http_ok: true,
          location: null,
          response_excerpt: "ok",
          reset_timecard: false,
        }),
      ),
    );
    const deps = depsOf({ onpremAutoload });
    const report = await runDtakoReimport(deps, {
      opeNo: OPE_NO,
      startOpe: START_OPE,
      unkoNo: UNKO_NO_23,
    });
    expect(report.ope_no).toBe(OPE_NO);
    expect(report.start_ope).toBe(START_OPE);
    expect(report.unko_no).toBe(UNKO_NO_23);
    expect(report.entries).toEqual(["KUDGIVT.csv"]);
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.http_status).toBe(200);
    expect(report.autoload).toEqual({
      http_status: 200,
      http_ok: true,
      location: null,
      response_excerpt: "ok",
      reset_timecard: false,
    });

    // push は unko_no/reset_timecard 付きの相対パスへ、zip を body に POST する
    const call = (onpremAutoload as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe(`/api/dtako/autoload?unko_no=${UNKO_NO_23}&reset_timecard=false`);
    expect((call[1] as RequestInit).method).toBe("POST");
    expect((call[1] as RequestInit).body).toBeInstanceOf(ArrayBuffer);
  });

  it("reset_timecard=true を渡すと push の query にも反映する", async () => {
    const onpremAutoload = vi.fn(async () => new Response(JSON.stringify({ http_status: 200 })));
    const deps = depsOf({ onpremAutoload });
    await runDtakoReimport(deps, {
      opeNo: OPE_NO,
      startOpe: START_OPE,
      unkoNo: UNKO_NO_23,
      resetTimecard: true,
    });
    const call = (onpremAutoload as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe(`/api/dtako/autoload?unko_no=${UNKO_NO_23}&reset_timecard=true`);
  });

  it("resetTimecard 省略時は false 扱い (既定は破壊的操作を増やさない)", async () => {
    const onpremAutoload = vi.fn(async () => new Response(JSON.stringify({ http_status: 200 })));
    const deps = depsOf({ onpremAutoload });
    await runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 });
    const call = (onpremAutoload as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toContain("reset_timecard=false");
  });

  it("zip が壊れていれば push せずに拒否する (push 直前の健全性検証)", async () => {
    const onpremAutoload = vi.fn(async () => new Response("unused"));
    const deps = depsOf({
      fetchZip: vi.fn(async () => new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer),
      onpremAutoload,
    });
    await expect(
      runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 }),
    ).rejects.toThrow(DtakoReimportError);
    expect(onpremAutoload).not.toHaveBeenCalled();
  });

  it("オンプレの応答が JSON でなければ握り潰さず raw_excerpt に畳む", async () => {
    const deps = depsOf({
      onpremAutoload: vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    });
    const report = await runDtakoReimport(deps, {
      opeNo: OPE_NO,
      startOpe: START_OPE,
      unkoNo: UNKO_NO_23,
    });
    expect(report.http_status).toBe(502);
    expect(report.autoload).toEqual({ parse_error: true, raw_excerpt: "<html>502 Bad Gateway</html>" });
  });

  it("push (fetch) 自体が例外を投げたら DtakoReimportPushUncertainError で区別する (取り込み済みかもしれない)", async () => {
    const deps = depsOf({
      onpremAutoload: vi.fn(async () => {
        throw new Error("network reset");
      }),
    });
    await expect(
      runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 }),
    ).rejects.toThrow(DtakoReimportPushUncertainError);
    await expect(
      runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 }),
    ).rejects.toThrow(/再実行の前に dtako_events/);
  });

  it("push が Error でない値を throw しても文字列化して区別する", async () => {
    const deps = depsOf({
      onpremAutoload: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "boom";
      }),
    });
    await expect(
      runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 }),
    ).rejects.toThrow(/boom/);
  });

  it("push は成功したが応答本文の読み出しで例外が起きても同様に区別する", async () => {
    const badRes = new Response("body");
    vi.spyOn(badRes, "text").mockRejectedValue(new Error("stream error"));
    const deps = depsOf({ onpremAutoload: vi.fn(async () => badRes) });
    await expect(
      runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 }),
    ).rejects.toThrow(DtakoReimportPushUncertainError);
  });

  it("zip 取得自体の失敗 (自前ログイン失敗等、push 前) は通常の Error のまま伝播する (再実行して安全)", async () => {
    const deps = depsOf({
      fetchZip: vi.fn(async () => {
        throw new Error("theearth login failed");
      }),
    });
    await expect(
      runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 }),
    ).rejects.toThrow("theearth login failed");
  });

  it("zip 取得の前に再集計 (recalculateWork) を呼び、成功なら report.recalculate に含める (Refs #633-19)", async () => {
    const calls: string[] = [];
    const deps = depsOf({
      recalculateWork: vi.fn(async () => {
        calls.push("recalculate");
      }),
      fetchZip: vi.fn(async () => {
        calls.push("fetch");
        return minimalZip();
      }),
    });
    const report = await runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 });
    expect(calls).toEqual(["recalculate", "fetch"]);
    expect(report.recalculate).toEqual({ ok: true });
  });

  it("再集計が失敗しても zip 取得と push は続行し、report.recalculate に失敗を残す (握り潰さない)", async () => {
    const deps = depsOf({
      recalculateWork: vi.fn(async () => {
        throw new Error("btnScore が見つかりません");
      }),
    });
    const report = await runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 });
    expect(report.recalculate).toEqual({ ok: false, error: "btnScore が見つかりません" });
    expect(deps.fetchZip).toHaveBeenCalled();
    expect(deps.onpremAutoload).toHaveBeenCalled();
  });

  it("再集計が VenusSessionExpiredError を投げたら伝播し、zip 取得も push も行わない (受け入れ条件6)", async () => {
    const deps = depsOf({
      recalculateWork: vi.fn(async () => {
        throw new VenusSessionExpiredError("theearth セッションが切れています");
      }),
    });
    await expect(
      runDtakoReimport(deps, { opeNo: OPE_NO, startOpe: START_OPE, unkoNo: UNKO_NO_23 }),
    ).rejects.toThrow(VenusSessionExpiredError);
    expect(deps.fetchZip).not.toHaveBeenCalled();
    expect(deps.onpremAutoload).not.toHaveBeenCalled();
  });
});
