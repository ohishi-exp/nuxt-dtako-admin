import { describe, expect, it, vi } from "vitest";
import { recalculateBeforeFetch } from "../src/theearth-recalculate";
import { VenusSessionExpiredError } from "../src/theearth-client";

describe("recalculateBeforeFetch", () => {
  it("成功時は { ok: true } を返す (再集計が走ったことを呼び出し側が追える)", async () => {
    const recalculateWork = vi.fn(async () => {});
    await expect(recalculateBeforeFetch(recalculateWork)).resolves.toEqual({ ok: true });
    expect(recalculateWork).toHaveBeenCalledTimes(1);
  });

  it("Error を投げたら { ok: false, error } に畳んで返す (握り潰さない)", async () => {
    const recalculateWork = vi.fn(async () => {
      throw new Error("btnScore が見つかりません");
    });
    await expect(recalculateBeforeFetch(recalculateWork)).resolves.toEqual({
      ok: false,
      error: "btnScore が見つかりません",
    });
  });

  it("Error でない値を throw しても文字列化して畳む", async () => {
    const recalculateWork = vi.fn(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "boom";
    });
    await expect(recalculateBeforeFetch(recalculateWork)).resolves.toEqual({ ok: false, error: "boom" });
  });

  it("VenusSessionExpiredError は畳まずそのまま伝播させる (直後の zip 取得も同じ理由で失敗するため)", async () => {
    const recalculateWork = vi.fn(async () => {
      throw new VenusSessionExpiredError("theearth セッションが切れています");
    });
    await expect(recalculateBeforeFetch(recalculateWork)).rejects.toThrow(VenusSessionExpiredError);
  });
});
