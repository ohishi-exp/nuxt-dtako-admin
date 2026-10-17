import { describe, it, expect } from "vitest";
import { getRestraintDaysTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

/** relay が R2 に置く拘束時間管理表 CSV (Shift_JIS) の最小再現。乗務員 6 の 6/17 の 1 行。 */
const CSV_SJIS_B64 = "jVORqY6eitSKx5edlVwgKDIwMjaUTiA2jI6VqikNCoGmk5aMjoLMjcWR5Y1TkamOnorUIDogMjc1II6eitSBaZhKjmeLppLogsmC5oLojp6K1ILwi0yT/IK3gumBag0KDQqOlovGj4oslnuO0CyP5paxiPWVqpfeMSwNCo6Blrwsjo6MsYFAkb6YWSyP5paxiPWDUoFbg2gsNg0Kk/qVdCyObovGjp6NjyyPSYvGjp6NjyyJXpNdjp6K1CyPZJWhiV6TXY6eitQsideW8I6eitQsj2SVoYnXlvCOnorULIt4jGWOnorULI9klaGLeIxljp6K1CyOnorULI9klaGOnorULI1TkamOnorUj6yMdiyPZJWhjVORqY6eitSPrIx2LI1TkamOnorUjYeMdiyNU5Gpjp6K1JfdjHYskU+JXpNdlb2LzyyM44lek12VvYvPLIt4kaeOnorULI7Ak62OnorULI6eitSKT46eitQskFuW6Y6eitQsjp6K1IpPkFuW6Y6eitQsk0WXdjEsk0WXdjINCjaMjjE3k/osMTE6MjYsMTk6NTMsNjowMCwsMTowOCwsMToyMCwsLCw4OjI3LDI6MzEsMTA6NTgsMTAwOjAwLCwsOTozMiw3OjA3LCwsLCwNCo2HjHYsLCw2OjAwLCwxOjA4LCwxOjIwLCwsLDg6MjcsLCwsLCw5OjMyLDc6MDcsLCwsLA0KNIyOgWA1jI4gl92Mdo1TkamOnorULDEwMI6eitQgMzCVqiwNCjIwMjaUTpN4gUCNU5Gpjp6K1CwzMzAwjp6K1A0K";
const KEY = "restraint/75700192/2026-06/csv/all/latest.csv";

function env(
  entries: Record<string, string> = { [KEY]: CSV_SJIS_B64 },
  customMetadata: Record<string, string> | null = { fetchedAt: "20261016T110418" },
): Env {
  const bucket = {
    get: async (key: string) => {
      const b64 = entries[key];
      if (b64 === undefined) return null;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return {
        key,
        customMetadata,
        arrayBuffer: async () => bytes.buffer,
      };
    },
  };
  return { DTAKO_R2: bucket } as unknown as Env;
}

describe("get_restraint_days", () => {
  it("**read tool。** scope を要求しない", () => {
    expect((getRestraintDaysTool as { requiresScope?: string }).requiresScope).toBeUndefined();
  });

  it("R2 の CSV (Shift_JIS) を relay と同じパーサで読み、1 人ぶんの日別の行 (始業・終業つき) を返す", async () => {
    const got = await getRestraintDaysTool.execute(env(), { company: "75700192", month: "2026-06", driver: "6" });
    expect(got.driver).toBe("6");
    expect(got.driver_name).toBe("試験　太郎");
    expect(got.fetched_at).toBe("20261016T110418");
    expect(got.days).toHaveLength(1);
    expect(got.days[0]).toMatchObject({
      day: 17,
      startTime: "11:26",
      endTime: "19:53",
      restraintMinutes: 658,
      restMinutes: 572,
      workingMinutes: 427,
    });
    expect(got.header[1]).toBe("始業時刻");
  });

  it("取り込み時刻が無ければ fetched_at は null", async () => {
    const got = await getRestraintDaysTool.execute(env(undefined, null), {
      company: "75700192",
      month: "2026-06",
      driver: "6",
    });
    expect(got.fetched_at).toBeNull();
  });

  it("CSV が無い月・CSV にいない乗務員は理由を添えて落とす", async () => {
    await expect(
      getRestraintDaysTool.execute(env({}), { company: "75700192", month: "2026-06", driver: "6" }),
    ).rejects.toThrow(/run_theearth_restraint_fetch/);
    await expect(
      getRestraintDaysTool.execute(env(), { company: "75700192", month: "2026-06", driver: "99" }),
    ).rejects.toThrow(/乗務員 99 がいません/);
  });

  it("引数の形が違えば受けない", () => {
    expect(getRestraintDaysTool.inputSchema.safeParse({ company: "75700192", month: "2026-6", driver: "6" }).success).toBe(false);
    expect(getRestraintDaysTool.inputSchema.safeParse({ company: "75700192", month: "2026-06", driver: "x" }).success).toBe(false);
  });
});
