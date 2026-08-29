import { describe, it, expect, vi } from "vitest";
import { getScrapeErrorTool, listScrapeErrorsTool } from "../src/mcp/tools";
import {
  SCRAPE_ERROR_LIST_DEFAULT_LIMIT,
  SCRAPE_ERROR_LIST_MAX_LIMIT,
} from "../../dtako-scraper-relay/src/scrape-error-reader";
import { EVIDENCE_BODY_PREFIX_MAX } from "../../dtako-scraper-relay/src/theearth-client";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";
const KEY = "dtako-scrape-errors/75700192/2026-08-01/1754000000000.bin";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };

describe("list_scrape_errors / get_scrape_error (Refs #1052)", () => {
  it("**read tool** — scope を要求しない (書き込みの口が無い)", () => {
    expect((listScrapeErrorsTool as { requiresScope?: string }).requiresScope).toBeUndefined();
    expect((getScrapeErrorTool as { requiresScope?: string }).requiresScope).toBeUndefined();
  });

  /**
   * ★ 説明を読んだだけで「読むだけ」「既定では本文が切られる」が分かること。
   * ここが読めないと、モデルが `full: true` を既定のように付けて全文を持ち出す。
   */
  it("**説明で「読むだけ」「切り詰め」「full」が読める**", () => {
    expect(listScrapeErrorsTool.description).toContain("読むだけ");
    expect(listScrapeErrorsTool.description).toContain("put / delete はしない");
    expect(listScrapeErrorsTool.description).toContain(String(SCRAPE_ERROR_LIST_DEFAULT_LIMIT));
    // 空 ZIP を保存しない (#633-22) ことを言っておかないと「失敗 16 件なのに原本が
    // 少ない = 保存が壊れている」と読まれる
    expect(listScrapeErrorsTool.description).toContain("空 ZIP は保存されない");
    expect(getScrapeErrorTool.description).toContain("読むだけ");
    expect(getScrapeErrorTool.description).toContain("put / delete はしない");
    expect(getScrapeErrorTool.description).toContain(String(EVIDENCE_BODY_PREFIX_MAX));
    expect(getScrapeErrorTool.description).toContain("full: true");
    expect(getScrapeErrorTool.description).toContain("title");
  });

  /**
   * ★ 全文を取ったときの注意 (親指示 2026-08-29)。**tool 説明と引数説明の両方**に要る —
   * モデルが実際に読んで `full` を埋めるのは引数側の `.describe()` なので、説明文だけに
   * 書くと素通りする。この repo は public で、貼った時点で戻せない。
   */
  it("**全文フラグの注意が tool 説明と引数説明の両方にある**", () => {
    const argDesc = JSON.stringify(getScrapeErrorTool.inputSchema.shape.full.description ?? "");
    for (const text of [getScrapeErrorTool.description, argDesc]) {
      expect(text).toContain("issue / PR / commit に貼らない");
      expect(text).toContain("public");
    }
    // 「必要なときだけ = まず既定で読む」も両方に書いてある
    expect(getScrapeErrorTool.description).toContain("必要なときだけ");
    expect(argDesc).toContain("まず false");
  });

  /**
   * ★ `comp_id` を省略すると本番の既定 (`KINTAI_COMP_ID`) を読む。実測では
   * **省略 9 件 / 明示 14 件**で、**どちらも「原本がちゃんとある」ようにしか見えなかった**
   * (#1052)。「一致するとは限らない」だけだと読み手は「違ったら分かるだろう」と思うので、
   * **気づけない**ことまで書いてあるかを固定する。`full` と同じく **tool 説明と引数説明の
   * 両方**に要る (モデルが読んで埋めるのは引数側)。
   */
  it("**comp_id 省略の罠が list 側の tool 説明と引数説明の両方にある**", () => {
    const argDesc = String(listScrapeErrorsTool.inputSchema.shape.comp_id.description ?? "");
    for (const text of [listScrapeErrorsTool.description, argDesc]) {
      expect(text).toContain("KINTAI_COMP_ID");
      expect(text).toContain("取り違えても気づけない");
      expect(text).toContain("明示");
      expect(text).toContain("prefix");
    }
  });

  /**
   * ★ **get 側には同じ警告を貼らない。** こちらの `comp_id` は DO instance を選ぶだけで、
   * 何を読むかは `key` が決める (`handleCronDtakoScrapeErrorObject` は bucket も prefix も
   * env から取り `bucket.get(key)` しかしない)。**危険が無いところに危険だと書くと、
   * 注記の側が嘘になる** — この repo で一番多い欠陥の型なので、逆向きも固定する。
   */
  it("**get 側は「comp_id で結果は変わらない」と書いてあり、list 側の警告を貼っていない**", () => {
    const argDesc = String(getScrapeErrorTool.inputSchema.shape.comp_id.description ?? "");
    for (const text of [getScrapeErrorTool.description, argDesc]) {
      expect(text).toContain("`key` が決める");
      expect(text).toContain("list_scrape_errors");
      // ★ 逆向きの固定: list 側の強い警告が get 側に紛れ込んでいない
      expect(text).not.toContain("取り違えても気づけない");
    }
  });

  it("job_key は読取日の形式のみ通す", () => {
    expect(listScrapeErrorsTool.inputSchema.safeParse({ job_key: "2026-08-01" }).success).toBe(true);
    expect(
      listScrapeErrorsTool.inputSchema.safeParse({ job_key: "2026-08-01..2026-08-03" }).success,
    ).toBe(true);
    expect(listScrapeErrorsTool.inputSchema.safeParse({ job_key: "2026-8-1" }).success).toBe(false);
    expect(listScrapeErrorsTool.inputSchema.safeParse({ job_key: "../" }).success).toBe(false);
  });

  it("limit は 1..MAX の整数のみ通す (上限は schema でも弾く)", () => {
    expect(listScrapeErrorsTool.inputSchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(
      listScrapeErrorsTool.inputSchema.safeParse({ limit: SCRAPE_ERROR_LIST_MAX_LIMIT }).success,
    ).toBe(true);
    expect(
      listScrapeErrorsTool.inputSchema.safeParse({ limit: SCRAPE_ERROR_LIST_MAX_LIMIT + 1 }).success,
    ).toBe(false);
    expect(listScrapeErrorsTool.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listScrapeErrorsTool.inputSchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });

  it("get 側は key 必須、余計なフィールドは弾く", () => {
    expect(getScrapeErrorTool.inputSchema.safeParse({}).success).toBe(false);
    expect(getScrapeErrorTool.inputSchema.safeParse({ key: "" }).success).toBe(false);
    expect(getScrapeErrorTool.inputSchema.safeParse({ key: KEY }).success).toBe(true);
    expect(getScrapeErrorTool.inputSchema.safeParse({ key: KEY, full: true }).success).toBe(true);
    expect(getScrapeErrorTool.inputSchema.safeParse({ key: KEY, delete: true }).success).toBe(false);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      listScrapeErrorsTool.execute(env({ SCRAPER_RELAY: undefined }), {}),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      listScrapeErrorsTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), {}),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
    await expect(
      getScrapeErrorTool.execute(env({ SCRAPER_RELAY: undefined }), { key: KEY }),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      getScrapeErrorTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), { key: KEY }),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("一覧は proof を付けて /kintai-relay/scrape-errors を叩き、応答をそのまま返す", async () => {
    const payload = {
      prefix: "dtako-scrape-errors/75700192/",
      items: [
        {
          key: KEY,
          size: 10_546,
          comp_id: "75700192",
          job_key: "2026-08-01",
          saved_at: "2025-07-31T22:13:20.000Z",
          saved_at_source: "key",
          ext: "bin",
        },
      ],
      total: 1,
      limit: SCRAPE_ERROR_LIST_DEFAULT_LIMIT,
      truncated: false,
      counts_by_job_key: { "2026-08-01": 1 },
      unparsed: 0,
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await listScrapeErrorsTool.execute(e, {
      comp_id: "75700192",
      job_key: "2026-08-01",
      limit: 10,
    });
    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/scrape-errors");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({
      comp_id: "75700192",
      job_key: "2026-08-01",
      limit: 10,
    });
  });

  it("comp_id / job_key / limit を省略すると relay の既定に委ねる (こちらで埋めない)", async () => {
    const e = env();
    await listScrapeErrorsTool.execute(e, {});
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.comp_id).toBeUndefined();
    expect(body.job_key).toBeUndefined();
    expect(body.limit).toBeUndefined();
  });

  it("取得は /kintai-relay/scrape-error-object を叩き、応答をそのまま返す", async () => {
    const payload = {
      key: KEY,
      bytes: 10_546,
      content_type: "text/html; charset=Shift_JIS",
      comp_id: "75700192",
      job_key: "2026-08-01",
      saved_at: "2025-07-31T22:13:20.000Z",
      saved_at_source: "key",
      ext: "bin",
      charset: "shift_jis",
      charset_fallback: false,
      title: "ただいま混み合っています",
      body_prefix: "<html>...",
      body_truncated: true,
      body_chars: 9_800,
      full: false,
      json_meta: null,
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await getScrapeErrorTool.execute(e, { key: KEY });
    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/scrape-error-object");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ key: KEY });
  });

  it("full を省略すると relay へ送らない (既定 false は relay 側の契約)", async () => {
    const e = env();
    await getScrapeErrorTool.execute(e, { key: KEY });
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.full).toBeUndefined();
  });

  it("full: true は body にそのまま乗る", async () => {
    const e = env();
    await getScrapeErrorTool.execute(e, { key: KEY, full: true, comp_id: "75700192" });
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ key: KEY, full: true, comp_id: "75700192" });
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const denied = env({
      SCRAPER_RELAY: {
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "key は dtako-scrape-errors/ 配下だけです" }), {
              status: 400,
            }),
        ),
      },
    });
    await expect(getScrapeErrorTool.execute(denied, { key: "etc/x.csv" })).rejects.toThrow(
      /relay: status 400/,
    );
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(getScrapeErrorTool.execute(html, { key: KEY })).rejects.toThrow(/parse failed/);
    await expect(listScrapeErrorsTool.execute(html, {})).rejects.toThrow(/parse failed/);
  });
});
