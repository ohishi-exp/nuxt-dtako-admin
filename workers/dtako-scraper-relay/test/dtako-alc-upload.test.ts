import { describe, expect, it, vi } from "vitest";
import {
  assertZipReadyForAlcUpload,
  DtakoAlcUploadError,
  runDtakoAlcUpload,
  type DtakoAlcUploadDeps,
} from "../src/dtako-alc-upload";
import { VenusSessionExpiredError } from "../src/theearth-client";

const OPE_NO = "2606050753300000004286";
const START_OPE = "2026/07/07 7:53:30";

/** `PK\x03\x04` local file header 1 エントリぶんの最小 ZIP (dtako-reimport.test.ts
 * と同じ最小モック — central directory / EOCD は付けない)。 */
function minimalZip(name = "KUDGURI.csv"): ArrayBuffer {
  const nameBytes = new TextEncoder().encode(name);
  const header = new Uint8Array(30 + nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(26, nameBytes.length, true);
  header.set(nameBytes, 30);
  return header.buffer;
}

describe("assertZipReadyForAlcUpload", () => {
  it("PK\\x03\\x04 で始まる zip は通す", () => {
    expect(() => assertZipReadyForAlcUpload(minimalZip())).not.toThrow();
  });

  it("4 バイト未満は拒否する", () => {
    expect(() => assertZipReadyForAlcUpload(new Uint8Array([0x50, 0x4b]).buffer)).toThrow(
      DtakoAlcUploadError,
    );
  });

  it("magic が違えば拒否する (壊れた zip を通さない)", () => {
    expect(() =>
      assertZipReadyForAlcUpload(new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer),
    ).toThrow(/PK\\x03\\x04 magic 不一致/);
  });

  it("空の buffer は拒否する", () => {
    expect(() => assertZipReadyForAlcUpload(new ArrayBuffer(0))).toThrow(DtakoAlcUploadError);
  });
});

function depsOf(over: Partial<DtakoAlcUploadDeps> = {}): DtakoAlcUploadDeps {
  return {
    recalculateWork: vi.fn(async () => {}),
    fetchZip: vi.fn(async () => minimalZip()),
    uploadZip: vi.fn(async () => JSON.stringify({ upload_id: "u-1", operations_count: 1, status: "completed" })),
    ...over,
  };
}

describe("runDtakoAlcUpload", () => {
  it("① zip 取得 → ② alc 投入まで完結し、entries/bytes/upload_id/notes をまとめて返す", async () => {
    const uploadZip = vi.fn(async () =>
      JSON.stringify({ upload_id: "u-123", operations_count: 1, status: "completed", split_failed: 0 }),
    );
    const deps = depsOf({ uploadZip });
    const report = await runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE });

    expect(report.ope_no).toBe(OPE_NO);
    expect(report.start_ope).toBe(START_OPE);
    expect(report.entries).toEqual(["KUDGURI.csv"]);
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.upload_id).toBe("u-123");
    expect(report.operations_count).toBe(1);
    expect(report.split_failed).toBe(0);
    // split は非同期 — 0 が返っても確定扱いにしない (受け入れ条件3)
    expect(report.split_confirmed).toBe(false);
    expect(report.notes.split).toMatch(/確定では?ありません|確定できません/);
    expect(report.notes.has_kudgivt).toMatch(/has_kudgivt/);
    expect(report.notes.has_kudgivt).toMatch(/FALSE/);
    expect(report.notes.preview).toMatch(/operation-zip/);

    // uploadZip には filename と zip バイト列がそのまま渡る
    const call = (uploadZip as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe("csvdata.zip");
    expect(call[1]).toBeInstanceOf(ArrayBuffer);
  });

  it("alc の応答に split_failed が無ければ null (不明) のまま — 0 に丸めない", async () => {
    const deps = depsOf({
      uploadZip: vi.fn(async () => JSON.stringify({ upload_id: "u-1", operations_count: 1, status: "completed" })),
    });
    const report = await runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE });
    expect(report.split_failed).toBeNull();
    expect(report.notes.split).toMatch(/不明/);
  });

  it("split_failed > 0 でも例外にせず、値と注記をそのまま返す (取り込み自体は成功のため)", async () => {
    const deps = depsOf({
      uploadZip: vi.fn(async () =>
        JSON.stringify({ upload_id: "u-1", operations_count: 1, status: "completed", split_failed: 2 }),
      ),
    });
    const report = await runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE });
    expect(report.split_failed).toBe(2);
    expect(report.notes.split).toContain("split_failed=2");
  });

  it("zip が壊れていれば alc へ投入せずに拒否する (投入直前の健全性検証)", async () => {
    const uploadZip = vi.fn(async () => "unused");
    const deps = depsOf({
      fetchZip: vi.fn(async () => new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer),
      uploadZip,
    });
    await expect(runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE })).rejects.toThrow(
      DtakoAlcUploadError,
    );
    expect(uploadZip).not.toHaveBeenCalled();
  });

  it("zip 取得自体の失敗 (自前ログイン失敗等、投入前) は通常の Error のまま伝播する (呼び出し元が種類ごとに区別する)", async () => {
    const deps = depsOf({
      fetchZip: vi.fn(async () => {
        throw new Error("theearth login failed");
      }),
    });
    await expect(runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE })).rejects.toThrow(
      "theearth login failed",
    );
  });

  it("alc への投入が失敗したら DtakoAlcUploadError に包み直す (theearth 取得失敗と区別する)", async () => {
    const deps = depsOf({
      uploadZip: vi.fn(async () => {
        throw new Error("alc-internal-proxy upload failed (403): forbidden");
      }),
    });
    await expect(runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE })).rejects.toThrow(
      DtakoAlcUploadError,
    );
    await expect(runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE })).rejects.toThrow(
      /alc への投入に失敗しました/,
    );
  });

  it("alc への投入が Error でない値を throw しても文字列化して包む", async () => {
    const deps = depsOf({
      uploadZip: vi.fn(async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "boom";
      }),
    });
    await expect(runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE })).rejects.toThrow(/boom/);
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
    const report = await runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE });
    expect(calls).toEqual(["recalculate", "fetch"]);
    expect(report.recalculate).toEqual({ ok: true });
  });

  it("再集計が失敗しても zip 取得と alc 投入は続行し、report.recalculate に失敗を残す (握り潰さない)", async () => {
    const deps = depsOf({
      recalculateWork: vi.fn(async () => {
        throw new Error("btnScore が見つかりません");
      }),
    });
    const report = await runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE });
    expect(report.recalculate).toEqual({ ok: false, error: "btnScore が見つかりません" });
    expect(deps.fetchZip).toHaveBeenCalled();
    expect(deps.uploadZip).toHaveBeenCalled();
  });

  it("再集計が VenusSessionExpiredError を投げたら伝播し、zip 取得も alc 投入も行わない (受け入れ条件6)", async () => {
    const deps = depsOf({
      recalculateWork: vi.fn(async () => {
        throw new VenusSessionExpiredError("theearth セッションが切れています");
      }),
    });
    await expect(runDtakoAlcUpload(deps, { opeNo: OPE_NO, startOpe: START_OPE })).rejects.toThrow(
      VenusSessionExpiredError,
    );
    expect(deps.fetchZip).not.toHaveBeenCalled();
    expect(deps.uploadZip).not.toHaveBeenCalled();
  });
});
