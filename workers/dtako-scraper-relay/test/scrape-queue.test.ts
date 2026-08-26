import { describe, expect, it, vi } from "vitest";
import {
  annotateFoldStaleness,
  clearRunningPointer,
  MAX_SCRAPE_JOB_RECORDS,
  MAX_SCRAPE_QUEUE_LENGTH,
  migrateLegacyScrapeJobsOnce,
  popNextScrapeQueueItem,
  pushScrapeQueueItem,
  decideFoldRecord,
  recordFoldProgress,
  recordScrapeJob,
  recoverOrphan,
  SCRAPE_JOB_KEY_PREFIX,
  SCRAPE_JOB_ORDER_KEY,
  SCRAPE_QUEUE_KEY,
  SCRAPE_RUNNING_KEY,
  setRunningPointer,
  STALE_FOLD_THRESHOLD_MS,
  touchScrapeJobOrder,
  type QueuedScrapeItem,
  type QueueStorage,
  type ScrapeJobRecord,
} from "../src/scrape-queue";

/** `DurableObjectStorage` の最小 fake。純粋な in-memory Map で、`ctx.storage` の
 * 構造的部分型を満たす。`poisonPutOnce` で 1 回だけ `put` を失敗させられる
 * (recordScrapeJob の catch 分岐を検証するため)。 */
class FakeStorage implements QueueStorage {
  private map = new Map<string, unknown>();
  private alarmTime: number | null = null;
  private poison: unknown | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    if (this.poison !== null) {
      const err = this.poison;
      this.poison = null;
      throw err;
    }
    this.map.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [k, v] of this.map) {
      if (!options?.prefix || k.startsWith(options.prefix)) out.set(k, v as T);
    }
    return out;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }
  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmTime = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
  }

  /** 次の 1 回だけ `put` を throw させる。 */
  poisonPutOnce(err: unknown): void {
    this.poison = err;
  }

  hasKey(key: string): boolean {
    return this.map.has(key);
  }
}

const item = (jobKey: string, overrides: Partial<QueuedScrapeItem> = {}): QueuedScrapeItem => ({
  jobKey,
  compId: "0100",
  startDate: jobKey.split("..")[0]!,
  endDate: jobKey.split("..")[1] ?? jobKey.split("..")[0]!,
  ...overrides,
});

describe("recordScrapeJob", () => {
  it("state=pending は既存レコードを spread せず accepted_at を引き直す (issue #595)", async () => {
    const storage = new FakeStorage();
    await recordScrapeJob(storage, "2026-06-01", { state: "running", error: "old error", phase: "post_upload" });
    await recordScrapeJob(storage, "2026-06-01", { state: "pending" });
    const after = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + "2026-06-01");
    expect(after?.state).toBe("pending");
    expect(after?.error).toBeUndefined();
    expect(after?.phase).toBeUndefined();
    expect(after?.accepted_at).toBeTruthy();
  });

  it("state=running (既存レコード無し) はフォールバック base を使う", async () => {
    const storage = new FakeStorage();
    await recordScrapeJob(storage, "2026-06-02", { state: "running", started_at: "2026-06-02T00:00:00.000Z" });
    const record = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + "2026-06-02");
    expect(record?.state).toBe("running");
    expect(record?.started_at).toBe("2026-06-02T00:00:00.000Z");
    expect(record?.accepted_at).toBeTruthy();
  });

  it("state=running (既存レコード有り) は既存フィールドを spread する", async () => {
    const storage = new FakeStorage();
    await recordScrapeJob(storage, "2026-06-03", { state: "pending" });
    await recordScrapeJob(storage, "2026-06-03", { state: "running", phase: "pre_upload" });
    await recordScrapeJob(storage, "2026-06-03", { state: "done", split_failed: 0 });
    const record = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + "2026-06-03");
    expect(record?.state).toBe("done");
    expect(record?.phase).toBe("pre_upload");
    expect(record?.split_failed).toBe(0);
  });

  it("put が失敗しても投げず console.error だけ残す (Error インスタンス)", async () => {
    const storage = new FakeStorage();
    storage.poisonPutOnce(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordScrapeJob(storage, "2026-06-04", { state: "pending" })).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
    } finally {
      errSpy.mockRestore();
    }
  });

  it("put が Error 以外を throw しても String() で握る", async () => {
    const storage = new FakeStorage();
    storage.poisonPutOnce("not-an-error");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await recordScrapeJob(storage, "2026-06-05", { state: "pending" });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("not-an-error"));
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("touchScrapeJobOrder", () => {
  it("同じ jobKey は末尾に移動する (重複しない)", async () => {
    const storage = new FakeStorage();
    await touchScrapeJobOrder(storage, "a");
    await touchScrapeJobOrder(storage, "b");
    await touchScrapeJobOrder(storage, "a");
    const order = await storage.get<string[]>(SCRAPE_JOB_ORDER_KEY);
    expect(order).toEqual(["b", "a"]);
  });

  it(`MAX_SCRAPE_JOB_RECORDS (${MAX_SCRAPE_JOB_RECORDS}) を超えたら古い方から scrape-job: ごと捨てる`, async () => {
    const storage = new FakeStorage();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < MAX_SCRAPE_JOB_RECORDS + 3; i += 1) {
        const jobKey = `2026-01-${String(i).padStart(3, "0")}`;
        await recordScrapeJob(storage, jobKey, { state: "done" });
      }
      const order = await storage.get<string[]>(SCRAPE_JOB_ORDER_KEY);
      expect(order).toHaveLength(MAX_SCRAPE_JOB_RECORDS);
      // 一番古い 3 件は order からも storage からも消えている
      expect(order).not.toContain("2026-01-000");
      expect(storage.hasKey(SCRAPE_JOB_KEY_PREFIX + "2026-01-000")).toBe(false);
      // 最新は残っている
      expect(order).toContain(`2026-01-${MAX_SCRAPE_JOB_RECORDS + 2}`);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("evicted"));
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("pushScrapeQueueItem / popNextScrapeQueueItem", () => {
  it("push すると drain を急がせるため alarm を now に上書きする", async () => {
    const storage = new FakeStorage();
    await pushScrapeQueueItem(storage, item("2026-06-10"));
    const alarm = await storage.getAlarm();
    expect(alarm).not.toBeNull();
    const queue = await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY);
    expect(queue).toEqual([item("2026-06-10")]);
  });

  it("pop は FIFO で先頭から取り出す", async () => {
    const storage = new FakeStorage();
    await pushScrapeQueueItem(storage, item("2026-06-11"));
    await pushScrapeQueueItem(storage, item("2026-06-12"));
    const first = await popNextScrapeQueueItem(storage);
    expect(first?.jobKey).toBe("2026-06-11");
    const remaining = await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY);
    expect(remaining).toEqual([item("2026-06-12")]);
  });

  it("空のキューを pop すると null", async () => {
    const storage = new FakeStorage();
    expect(await popNextScrapeQueueItem(storage)).toBeNull();
  });

  it(`MAX_SCRAPE_QUEUE_LENGTH (${MAX_SCRAPE_QUEUE_LENGTH}) を超えたら黙って切らず古い方を捨てて大声でログする`, async () => {
    const storage = new FakeStorage();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < MAX_SCRAPE_QUEUE_LENGTH + 2; i += 1) {
        await pushScrapeQueueItem(storage, item(`2026-02-${String(i).padStart(3, "0")}`));
      }
      const queue = await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY);
      expect(queue).toHaveLength(MAX_SCRAPE_QUEUE_LENGTH);
      expect(queue?.[0]?.jobKey).toBe("2026-02-002");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("overflow_dropped"));
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("setRunningPointer / clearRunningPointer", () => {
  it("set → get → clear の往復", async () => {
    const storage = new FakeStorage();
    await setRunningPointer(storage, item("2026-06-13"));
    expect(await storage.get<QueuedScrapeItem>(SCRAPE_RUNNING_KEY)).toEqual(item("2026-06-13"));
    await clearRunningPointer(storage);
    expect(await storage.get<QueuedScrapeItem>(SCRAPE_RUNNING_KEY)).toBeUndefined();
  });
});

describe("recoverOrphan — DO 再起動を跨いだ孤児回収 (受け入れ条件4/6)", () => {
  it("running pointer が無ければ何もしない", async () => {
    const storage = new FakeStorage();
    const result = await recoverOrphan(storage);
    expect(result).toEqual({ recovered: null, failed: null });
  });

  it("★ DO 再作成を模す: 壊す前 (pre_upload) に死んだ孤児はキュー先頭に積み直して pending に戻す", async () => {
    const storage = new FakeStorage();

    // --- instance A: job を pop して実行を始めるが、pre_upload のまま死ぬ ---
    await pushScrapeQueueItem(storage, item("2026-06-14"));
    const popped = await popNextScrapeQueueItem(storage);
    expect(popped).not.toBeNull();
    await setRunningPointer(storage, popped!);
    await recordScrapeJob(storage, popped!.jobKey, {
      state: "running",
      started_at: "2026-06-14T00:00:00.000Z",
      phase: "pre_upload",
    });
    // ここで DO が死んだと想定 — clearRunningPointer は呼ばれない。
    // scrapeQueue (メモリ) は失われるが、storage (FakeStorage) はそのまま残る。

    // --- instance B: 同じ storage に対して新しく作られた「DO」が alarm() で気づく ---
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof recoverOrphan>>;
    try {
      result = await recoverOrphan(storage);
    } finally {
      errSpy.mockRestore();
    }

    expect(result).toEqual({ recovered: "2026-06-14", failed: null });
    expect(await storage.get(SCRAPE_RUNNING_KEY)).toBeUndefined();
    const queue = await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY);
    expect(queue).toEqual([item("2026-06-14")]);
    const record = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + "2026-06-14");
    expect(record?.state).toBe("pending");
  });

  it("★ DO 再作成を模す: 壊した後 (post_upload) に死んだ孤児は自動リトライせず failed にする", async () => {
    const storage = new FakeStorage();

    // --- instance A: アップロード fetch 発火直前まで進んで死ぬ ---
    await pushScrapeQueueItem(storage, item("2026-06-15"));
    const popped = await popNextScrapeQueueItem(storage);
    await setRunningPointer(storage, popped!);
    await recordScrapeJob(storage, popped!.jobKey, {
      state: "running",
      started_at: "2026-06-15T00:00:00.000Z",
      phase: "pre_upload",
    });
    // 破壊的操作の直前で phase を post_upload へ倒す (dtako-scraper-relay-do.ts と同じ手順)
    await recordScrapeJob(storage, popped!.jobKey, { state: "running", phase: "post_upload" });
    // ここで DO が死ぬ — has_kudgivt がリセットされたかどうかは storage からは分からない。

    // --- instance B ---
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof recoverOrphan>>;
    try {
      result = await recoverOrphan(storage);
    } finally {
      errSpy.mockRestore();
    }

    expect(result).toEqual({ recovered: null, failed: "2026-06-15" });
    expect(await storage.get(SCRAPE_RUNNING_KEY)).toBeUndefined();
    // **絶対にキューへ積み直さない** (二重取り込みの危険、受け入れ条件4)
    const queue = await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY);
    expect(queue ?? []).toEqual([]);
    const record = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + "2026-06-15");
    expect(record?.state).toBe("failed");
    expect(record?.error).toContain("自動リトライしません");
  });

  it("scrape-queue キーが一度も作られていない状態でも pre_upload 孤児を積める (?? [] 分岐)", async () => {
    const storage = new FakeStorage();
    await setRunningPointer(storage, item("2026-06-20"));
    await recordScrapeJob(storage, "2026-06-20", { state: "running", phase: "pre_upload" });
    expect(await storage.get(SCRAPE_QUEUE_KEY)).toBeUndefined();

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof recoverOrphan>>;
    try {
      result = await recoverOrphan(storage);
    } finally {
      errSpy.mockRestore();
    }

    expect(result).toEqual({ recovered: "2026-06-20", failed: null });
    expect(await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY)).toEqual([item("2026-06-20")]);
  });

  it("running pointer はあるが対応する record が無い (evict 済み等) → fail-closed", async () => {
    const storage = new FakeStorage();
    await setRunningPointer(storage, item("2026-06-16"));
    const result = await recoverOrphan(storage);
    expect(result).toEqual({ recovered: null, failed: "2026-06-16" });
  });

  it("running pointer はあるが record に phase フィールドが無い (旧レコード) → fail-closed", async () => {
    const storage = new FakeStorage();
    await setRunningPointer(storage, item("2026-06-17"));
    await recordScrapeJob(storage, "2026-06-17", { state: "running" });
    const result = await recoverOrphan(storage);
    expect(result).toEqual({ recovered: null, failed: "2026-06-17" });
  });
});

describe("migrateLegacyScrapeJobsOnce — 既存孤児の一度きり移送 (受け入れ条件10)", () => {
  it("scrape-queue が既に存在するなら二度と実行しない (冪等)", async () => {
    const storage = new FakeStorage();
    await storage.put(SCRAPE_QUEUE_KEY, []);
    await touchScrapeJobOrder(storage, "2026-06-01");
    await storage.put(SCRAPE_JOB_KEY_PREFIX + "2026-06-01", { date: "2026-06-01", state: "pending", accepted_at: "x" });
    const result = await migrateLegacyScrapeJobsOnce(storage, "0100");
    expect(result).toEqual({ ran: false, requeued: [], failedClosed: [] });
    expect(await storage.get(SCRAPE_QUEUE_KEY)).toEqual([]);
  });

  it("pending は queue へ積む (1 日ぶん・範囲ぶん両方)、running は phase 欠落で fail-closed、done/failed はそのまま、record が消えている order エントリは skip", async () => {
    const storage = new FakeStorage();
    // 1 日ぶん (旧レコード、pending)
    await storage.put(SCRAPE_JOB_KEY_PREFIX + "2026-06-01", {
      date: "2026-06-01",
      state: "pending",
      accepted_at: "2026-06-01T00:00:00.000Z",
    });
    // 範囲ぶん (旧レコード、pending)
    await storage.put(SCRAPE_JOB_KEY_PREFIX + "2026-06-02..2026-06-03", {
      date: "2026-06-02..2026-06-03",
      state: "pending",
      accepted_at: "2026-06-02T00:00:00.000Z",
    });
    // running、phase 無し (2026-08-01 の実測がこの形)
    await storage.put(SCRAPE_JOB_KEY_PREFIX + "2026-06-11", {
      date: "2026-06-11",
      state: "running",
      accepted_at: "2026-06-11T00:00:00.000Z",
    });
    // done (対象外)
    await storage.put(SCRAPE_JOB_KEY_PREFIX + "2026-06-04", {
      date: "2026-06-04",
      state: "done",
      accepted_at: "2026-06-04T00:00:00.000Z",
    });
    await storage.put(SCRAPE_JOB_ORDER_KEY, [
      "2026-06-01",
      "2026-06-02..2026-06-03",
      "2026-06-11",
      "2026-06-04",
      "2026-06-99", // record が既に evict 済み (=無い) 想定
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof migrateLegacyScrapeJobsOnce>>;
    try {
      result = await migrateLegacyScrapeJobsOnce(storage, "0100");
    } finally {
      errSpy.mockRestore();
    }

    expect(result.ran).toBe(true);
    expect(result.requeued).toEqual(["2026-06-01", "2026-06-02..2026-06-03"]);
    expect(result.failedClosed).toEqual(["2026-06-11"]);

    const queue = await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY);
    expect(queue).toEqual([
      { jobKey: "2026-06-01", compId: "0100", startDate: "2026-06-01", endDate: "2026-06-01" },
      { jobKey: "2026-06-02..2026-06-03", compId: "0100", startDate: "2026-06-02", endDate: "2026-06-03" },
    ]);

    const runningRecord = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + "2026-06-11");
    expect(runningRecord?.state).toBe("failed");
    expect(runningRecord?.error).toContain("自動リトライしません");

    const doneRecord = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + "2026-06-04");
    expect(doneRecord?.state).toBe("done");

    // drain を急がせるため alarm が立つ (queue が非空)
    expect(await storage.getAlarm()).not.toBeNull();
  });

  it("移送対象が 0 件 (pending/running が無い) なら queue は空のまま、ログもアラームも立てない", async () => {
    const storage = new FakeStorage();
    await storage.put(SCRAPE_JOB_KEY_PREFIX + "2026-06-05", {
      date: "2026-06-05",
      state: "done",
      accepted_at: "2026-06-05T00:00:00.000Z",
    });
    await storage.put(SCRAPE_JOB_ORDER_KEY, ["2026-06-05"]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof migrateLegacyScrapeJobsOnce>>;
    try {
      result = await migrateLegacyScrapeJobsOnce(storage, "0100");
    } finally {
      errSpy.mockRestore();
    }

    expect(result).toEqual({ ran: true, requeued: [], failedClosed: [] });
    expect(errSpy).not.toHaveBeenCalled();
    expect(await storage.get(SCRAPE_QUEUE_KEY)).toEqual([]);
    expect(await storage.getAlarm()).toBeNull();
  });

  it("order 自体が無い (scrape-job-order 未作成) なら空移送で終わる", async () => {
    const storage = new FakeStorage();
    const result = await migrateLegacyScrapeJobsOnce(storage, "0100");
    expect(result).toEqual({ ran: true, requeued: [], failedClosed: [] });
  });
});

describe("annotateFoldStaleness", () => {
  const NOW = Date.parse("2026-08-04T00:00:00.000Z");

  it("fold_state が running でないレコードは素通しされる (undefined / 他の状態値の両方)", () => {
    const noFold: ScrapeJobRecord = {
      date: "2026-06-01",
      state: "done",
      accepted_at: "2026-08-01T00:00:00.000Z",
    };
    expect(annotateFoldStaleness(noFold, NOW)).toBe(noFold);

    const doneFold: ScrapeJobRecord = {
      date: "2026-06-02",
      state: "done",
      accepted_at: "2026-08-01T00:00:00.000Z",
      fold_state: "done",
    };
    expect(annotateFoldStaleness(doneFold, NOW)).toBe(doneFold);
  });

  it("fold_started_at が無く accepted_at だけのレコードでも経過が出る (accepted_at で代用)", () => {
    const record: ScrapeJobRecord = {
      date: "2026-03-03",
      state: "done",
      accepted_at: "2026-08-03T20:00:00.000Z",
      fold_state: "running",
    };
    const result = annotateFoldStaleness(record, NOW);
    expect(result.fold_running_for_ms).toBe(NOW - Date.parse("2026-08-03T20:00:00.000Z"));
    expect(result.fold_stale).toBe(true);
  });

  it("fold_started_at がある場合はそちらを優先する", () => {
    const record: ScrapeJobRecord = {
      date: "2026-03-03",
      state: "done",
      accepted_at: "2026-08-01T00:00:00.000Z",
      fold_state: "running",
      fold_started_at: "2026-08-03T23:59:00.000Z",
    };
    const result = annotateFoldStaleness(record, NOW);
    expect(result.fold_running_for_ms).toBe(60_000);
    expect(result.fold_stale).toBe(false);
  });

  it("閾値ちょうどは stale ではない (超えて初めて stale)", () => {
    const startedAt = NOW - STALE_FOLD_THRESHOLD_MS;
    const record: ScrapeJobRecord = {
      date: "2026-06-04",
      state: "done",
      accepted_at: new Date(startedAt).toISOString(),
      fold_state: "running",
    };
    const result = annotateFoldStaleness(record, NOW);
    expect(result.fold_running_for_ms).toBe(STALE_FOLD_THRESHOLD_MS);
    expect(result.fold_stale).toBe(false);
  });

  it("閾値未満は stale ではない", () => {
    const startedAt = NOW - (STALE_FOLD_THRESHOLD_MS - 1);
    const record: ScrapeJobRecord = {
      date: "2026-06-05",
      state: "done",
      accepted_at: new Date(startedAt).toISOString(),
      fold_state: "running",
    };
    const result = annotateFoldStaleness(record, NOW);
    expect(result.fold_stale).toBe(false);
  });

  it("閾値超えは stale", () => {
    const startedAt = NOW - (STALE_FOLD_THRESHOLD_MS + 1);
    const record: ScrapeJobRecord = {
      date: "2026-06-06",
      state: "done",
      accepted_at: new Date(startedAt).toISOString(),
      fold_state: "running",
    };
    const result = annotateFoldStaleness(record, NOW);
    expect(result.fold_stale).toBe(true);
  });

  it("accepted_at / fold_started_at のどちらも不正な日付なら素通しする (fail-closed で例外を投げない)", () => {
    const record: ScrapeJobRecord = {
      date: "2026-06-07",
      state: "done",
      accepted_at: "not-a-date",
      fold_state: "running",
    };
    expect(annotateFoldStaleness(record, NOW)).toBe(record);
  });
});

// ---------------------------------------------------------------------------
// fold の進捗 (Refs #595) — **state を動かさない / 無ければ作らない**
// ---------------------------------------------------------------------------

describe("decideFoldRecord", () => {
  it("既存レコードが無ければ書かない (画面 WS 経路が架空の done を生やしていた穴)", () => {
    expect(decideFoldRecord(undefined, "2026-06-06", { fold_state: "skipped_no_upload" })).toEqual({
      write: false,
      reason: "no_record",
    });
  });

  it("既存の state を保ったまま fold_* だけ重ねる (failed は failed のまま)", () => {
    const existing: ScrapeJobRecord = {
      date: "2026-06-06",
      state: "failed",
      accepted_at: "2026-08-01T04:07:27.550Z",
      error: "CSV ダウンロードの2段階目ボタンが見つかりません",
      upload_id: "c3164192-77c1-4575-8b8a-0405a8eab8f0",
      split_failed: 0,
    };
    const decision = decideFoldRecord(existing, "2026-06-06", {
      fold_state: "skipped_no_upload",
    });
    expect(decision.write).toBe(true);
    // 型を絞ってから中身を見る (write: false 側には record が無い)
    if (!decision.write) throw new Error("unreachable");
    expect(decision.record.state).toBe("failed");
    expect(decision.record.error).toBe("CSV ダウンロードの2段階目ボタンが見つかりません");
    expect(decision.record.accepted_at).toBe("2026-08-01T04:07:27.550Z");
    expect(decision.record.fold_state).toBe("skipped_no_upload");
    // 元のレコードを壊さない (新しいオブジェクトを返す)
    expect(existing.fold_state).toBeUndefined();
  });

  it("date は jobKey で引き直す (壊れたレコードを持ち回らない)", () => {
    const existing: ScrapeJobRecord = {
      date: "ずれた値",
      state: "done",
      accepted_at: "2026-08-01T00:00:00.000Z",
    };
    const decision = decideFoldRecord(existing, "2026-06-03", { fold_state: "done" });
    if (!decision.write) throw new Error("unreachable");
    expect(decision.record.date).toBe("2026-06-03");
  });
});

describe("recordFoldProgress", () => {
  it("既存レコードがあれば fold_* を重ねて written を返し、order も触る", async () => {
    const storage = new FakeStorage();
    await recordScrapeJob(storage, "2026-06-03", { state: "done", split_failed: 1 });
    const outcome = await recordFoldProgress(storage, "2026-06-03", {
      fold_state: "skipped_split_failed",
    });
    expect(outcome).toBe("written");
    const record = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + "2026-06-03");
    expect(record?.state).toBe("done");
    expect(record?.split_failed).toBe(1);
    expect(record?.fold_state).toBe("skipped_split_failed");
    expect(await storage.get<string[]>(SCRAPE_JOB_ORDER_KEY)).toEqual(["2026-06-03"]);
  });

  it("**レコードが無ければ 1 バイトも書かない** (skipped_no_record)", async () => {
    const storage = new FakeStorage();
    const outcome = await recordFoldProgress(storage, "2026-06-06", { fold_state: "done" });
    expect(outcome).toBe("skipped_no_record");
    expect(await storage.get(SCRAPE_JOB_KEY_PREFIX + "2026-06-06")).toBeUndefined();
    // order にも足さない (空レコードの幽霊を作らない)
    expect(await storage.get<string[]>(SCRAPE_JOB_ORDER_KEY)).toBeUndefined();
  });

  it("storage が失敗しても投げず error を返す", async () => {
    const storage = new FakeStorage();
    await recordScrapeJob(storage, "2026-06-07", { state: "done" });
    storage.poisonPutOnce(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        recordFoldProgress(storage, "2026-06-07", { fold_state: "failed", fold_error: "x" }),
      ).resolves.toBe("error");
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
    } finally {
      errSpy.mockRestore();
    }
  });
});
