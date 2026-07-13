import { describe, expect, it } from "vitest";
import { PromiseQueue } from "../src/promise-queue";

/** 遅延付きで解決する Promise。実行順序の検証に使う。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PromiseQueue", () => {
  it("enqueue した job を投入順に直列実行する (先に積んだ遅い job が後の速い job をブロックする)", async () => {
    const queue = new PromiseQueue();
    const order: string[] = [];

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await delay(20);
      order.push("first:end");
      return "first";
    });
    const second = queue.enqueue(async () => {
      order.push("second:start");
      await delay(1);
      order.push("second:end");
      return "second";
    });

    const results = await Promise.all([first, second]);

    expect(results).toEqual(["first", "second"]);
    // second は first が完全に終わるまで start しない (並列発火なら
    // "first:start","second:start","second:end","first:end" の順になり得る)。
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("job が reject しても後続の job は実行される (キューが止まらない)", async () => {
    const queue = new PromiseQueue();
    const order: string[] = [];

    const failing = queue.enqueue(async () => {
      order.push("failing");
      throw new Error("boom");
    });
    const after = queue.enqueue(async () => {
      order.push("after");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
    expect(order).toEqual(["failing", "after"]);
  });

  it("複数 job の戻り値がそれぞれ正しい Promise に届く (取り違えない)", async () => {
    const queue = new PromiseQueue();
    const jobs = [3, 1, 2].map((ms, i) =>
      queue.enqueue(async () => {
        await delay(ms);
        return `job-${i}`;
      }),
    );

    await expect(Promise.all(jobs)).resolves.toEqual(["job-0", "job-1", "job-2"]);
  });
});
