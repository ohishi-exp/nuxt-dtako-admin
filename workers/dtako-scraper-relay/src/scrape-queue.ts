/**
 * `/cron/dtako` (無人実行) の待ち行列を DO storage に永続化し、`alarm()` から
 * drain するための pure ロジック (Refs ohishi-exp/rust-ichibanboshi#205 の 55、
 * issue #598)。
 *
 * ## なぜ pure module か
 *
 * `dtako-scraper-relay-do.ts` / `index.ts` は `vitest.config.ts` で明示的に
 * カバレッジ gate 対象外 (`cloudflare:workers` / `DurableObject` runtime 依存で
 * node vitest から計測不可、`@cloudflare/vitest-pool-workers` は本リポジトリに
 * 前例が無く新規導入しない判断、Refs #205-55 の子→親報告)。`scrape-dispatch.ts` /
 * `promise-queue.ts` と同じ流儀で、DO の `ctx.storage` が要求する最小
 * インターフェース ([`QueueStorage`]) だけに依存させ、素の node vitest + fake
 * in-memory storage でロジックを 100% 検証できるようにする。「DO が再作成され
 * メモリは空だが storage は残る」は、**同じ fake storage に対してこのモジュールの
 * 関数を 2 回連続で呼ぶ**ことで模せる (モジュール自体がメモリを持たない pure
 * 関数の集まりなので、「2 回目の呼び出し」が自然に「新しい DO インスタンス」に
 * 相当する)。
 *
 * ## 壊す前後の境界
 *
 * `phase: "pre_upload"` → `"post_upload"` の切り替えは、`alc-internal-proxy` への
 * アップロード **fetch を発火する直前**に置く (呼び出し元の `dtako-scraper-relay-do.ts`
 * 側の責務)。alc の `process_zip` はリクエストが届いた時点で `has_kudgivt` を
 * `DEFAULT FALSE` に戻すため (`alc-internal-upload.ts` の docs)、**応答を待たずに
 * DO が死んでも副作用だけ残りうる**。「応答を受け取った後」に境界を置くと、
 * 応答待ち中に死んだケースを誤って「壊す前」に分類してしまう。
 */

export type ScrapeJobState = "pending" | "running" | "done" | "failed";

/** 破壊的操作 (`has_kudgivt` を `FALSE` に戻すアップロード) の前か後か。
 * `state === "running"` の間だけ意味を持つ。 */
export type ScrapeJobPhase = "pre_upload" | "post_upload";

/** fold の状態。**`running` 以外はすべて終端** (Refs #945)。
 *
 * **配列を正にする** — [`countFoldStates`] がこれを回して「0 件の状態も 0 と書く」
 * ため、状態を足したら集計にも自動で載る。**union 型を直接書くと、集計に足し忘れた
 * 状態が黙って 0 件にすらならず消える**ので、単一の宣言から型を導く。 */
export const FOLD_STATES = [
  "running",
  "done",
  "capped",
  "stale",
  "skipped_split_failed",
  "skipped_no_upload",
  "skipped_out_of_scope",
  "not_configured",
  "failed",
] as const;

export type FoldState = (typeof FOLD_STATES)[number];

/** `/cron/dtako` 1 ジョブぶんの進捗。DO の `ctx.storage` に `scrape-job:{date}`
 * キーで持つ (`date` は [`QueuedScrapeItem.jobKey`] と同じ値)。 */
export interface ScrapeJobRecord {
  date: string;
  state: ScrapeJobState;
  accepted_at: string;
  error?: string;
  /** state === "running" の間に記録する着手時刻 (ISO)。孤児判定・観測用 (Refs #205-55 条件3)。 */
  started_at?: string;
  /** state === "running" の間だけ意味を持つ。旧レコード (このフィールド追加前) には無い —
   * 無い場合は fail-closed で「壊した後」扱いにする (孤児回収参照)。 */
  phase?: ScrapeJobPhase;
  /** state === "done" の時だけ載る。`0` でも `has_kudgivt = FALSE` が残ることが
   * ある (`alc-internal-upload.ts` の docs) — **必要条件であって十分条件ではない**。 */
  split_failed?: number | null;
  upload_id?: string | null;
  /** 取り込み成功後の勤怠 fold の進捗 (Refs ohishi-exp/rust-ichibanboshi#205 の
   * 10)。`skipped_split_failed` は「不完全データで上書きするより、古い値のまま
   * の方がマシ」という判断で意図的に回さなかった状態。
   *
   * `skipped_out_of_scope` は**勤怠の対象会社ではない**ため最初から回さなかった
   * 状態 (Refs #633-22、`kintai-relay.ts` の [`judgeFoldScope`])。**失敗ではない** —
   * これを `failed` として記録していた間、comp 75700192 は取り込み成功のたびに
   * 403 を出し続け、本物の fold 失敗と見分けが付かなかった。**なぜ対象外なのかは
   * `fold_skip_reason` が名指しする** (Refs #944)。
   *
   * `not_configured` は**設定の穴**。`KINTAI_COMP_ID` 未設定 (対象会社が 1 社も
   * 宣言されていない) と、畳み先の origin/secret 未設定の両方がここに入る。
   * **`skipped_*` と混ぜない** — あちらは意図して回さなかった状態で、こちらは
   * 「設定を直せば回る」状態 (Refs #944)。
   *
   * `stale` は **`running` のまま閾値を超えたので終端に倒した**状態
   * ([`reapStaleFolds`]、Refs #945)。**`failed` とは別**にしてある — DO の evict 等で
   * 記録が取り残されただけで、fold が失敗したと断定できたわけではない。倒す理由と
   * 経過時間は `fold_error` に書く。
   *
   * **★ `fold_*` は `state` を一切動かさない** ([`recordFoldProgress`]、Refs #595)。
   * `fold_state: "failed"` でも `state` は取り込みが決めた値 (`done`/`failed`) のまま。
   * **`fold_state` を見て取り込みの成否を判断しないこと**、そして逆に
   * **`state` を見て fold の成否を判断しないこと。** */
  fold_state?: FoldState;
  /** `skipped_*` / `not_configured` の**理由を人が読める形で**持つ (Refs #944)。
   * `skipped_out_of_scope` は「対象外だから飛ばした」としか読めず、**その直前まで
   * 同じ読取日が 403 で失敗していた場合に「壊れているのを黙らせた」と区別が付かない**
   * — どの宣言が対象外を決めたのかをここに書いて名指しさせる
   * (`kintai-relay.ts` の [`judgeFoldScope`] が文面を作る)。 */
  fold_skip_reason?: string;
  fold_error?: string;
  fold_months?: string[];
  fold_pages?: number;
  fold_drivers_written?: number;
  /** `fold_state: "running"` を書いた時刻 (ISO)。このフィールド追加前のレコードには
   * 無い — [`annotateFoldStaleness`] は無ければ `accepted_at` で代用する (精度は
   * 落ちるが、日単位の古さを見るには十分)。 */
  fold_started_at?: string;
}

/** storage に積む 1 件分。`account` (認証情報) は持たない — drain 時に
 * `compId` から都度解決させる (KV のローテーションを拾える・秘匿情報を
 * queue に長時間残さない、Refs #205-55 設計案)。 */
export interface QueuedScrapeItem {
  jobKey: string;
  compId: string;
  startDate: string;
  endDate: string;
}

/** DO の `ctx.storage` (`DurableObjectStorage`) が満たす最小インターフェース。
 * 実体は `this.ctx.storage` をそのまま渡せる (構造的部分型)。 */
export interface QueueStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
}

export const SCRAPE_JOB_KEY_PREFIX = "scrape-job:";
export const SCRAPE_JOB_ORDER_KEY = "scrape-job-order";
export const SCRAPE_QUEUE_KEY = "scrape-queue";
export const SCRAPE_RUNNING_KEY = "scrape-running";

/** 進捗を保持する上限。**増やし続けない** — 超えたぶんは一番古く触れられた
 * 日付から `scrape-job:` レコードごと `touchScrapeJobOrder` が捨てる (Refs
 * #205-43)。 */
export const MAX_SCRAPE_JOB_RECORDS = 200;

/** キューに積める上限。10 件/日の配布 (`MAX_SCRAPE_DATES`) を大きく超えて
 * 溜まることは想定していない — 超えたら黙って切らず、古い方から捨てて
 * 大声でログする (`touchScrapeJobOrder` と同じ流儀)。 */
export const MAX_SCRAPE_QUEUE_LENGTH = 200;

function describeUnknownError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** `/cron/dtako` (このスクレイプ job) の進捗を `ctx.storage` に記録する。
 * **観測のための書き込みなので、失敗してもスクレイプ本体は止めない** —
 * 例外を投げず console.error だけ残す (Refs #205-43 の条件3)。
 *
 * **`state: "pending"` (= 新規ディスパッチの入口) だけは `existing` を spread
 * しない。** 同じ jobKey (同じ日付) を再実行した時、以前の spread は
 * `error`/`fold_state`/`fold_error`/`phase` 等を patch に含めない限り引き継いで
 * しまう (issue #595 実測)。**新しい試行の入口では前回の残骸を全部捨てて
 * `accepted_at` も引き直す。** running/done/failed はこの試行の記録の上に
 * 重ねるだけなので、今まで通り spread する。
 *
 * **★ このリセットは「新規ディスパッチの入口を通った時」にしか効かない。** 入口を
 * 通らずに同じ `scrape-job:{date}` を触る経路があると素通りする — 実際、画面 (WS)
 * 経路の fold がそれだった (Refs #595)。fold 側は [`recordFoldProgress`] を使うこと。 */
export async function recordScrapeJob(
  storage: QueueStorage,
  jobKey: string,
  patch: Partial<Omit<ScrapeJobRecord, "date">> & { state: ScrapeJobState },
): Promise<void> {
  try {
    const key = SCRAPE_JOB_KEY_PREFIX + jobKey;
    const base: ScrapeJobRecord =
      patch.state === "pending"
        ? { date: jobKey, accepted_at: new Date().toISOString(), state: "pending" }
        : ((await storage.get<ScrapeJobRecord>(key)) ?? {
            date: jobKey,
            accepted_at: new Date().toISOString(),
            state: "pending",
          });
    const record: ScrapeJobRecord = { ...base, ...patch, date: jobKey };
    await storage.put(key, record);
    await touchScrapeJobOrder(storage, jobKey);
  } catch (err) {
    console.error(`recordScrapeJob failed (job=${jobKey}): ${describeUnknownError(err)}`);
  }
}

/** fold (取り込み後の畳み直し) の進捗だけを表す patch。**`state` を持たない** —
 * fold は取り込みの成否を語る立場に無いので、`state` に触れる手段そのものを型から
 * 外してある (Refs #595)。 */
export type ScrapeJobFoldPatch = Required<Pick<ScrapeJobRecord, "fold_state">> &
  Partial<
    Pick<
      ScrapeJobRecord,
      | "fold_error"
      | "fold_skip_reason"
      | "fold_months"
      | "fold_pages"
      | "fold_drivers_written"
      | "fold_started_at"
    >
  >;

/** [`decideFoldRecord`] の答え。`write: false` は「書かない」— **失敗ではない**。 */
export type FoldRecordDecision =
  | { write: false; reason: "no_record" }
  | { write: true; record: ScrapeJobRecord };

/**
 * fold の進捗を既存の `scrape-job:{jobKey}` に重ねた結果を決める pure 関数
 * (Refs #595)。**既存レコードが無ければ書かない。**
 *
 * ## なぜ「無ければ作らない」なのか
 *
 * `/cron/dtako/progress` は**無人実行 (`/cron/dtako`) の進捗板**で、そこに載る
 * レコードは `handleCronDtakoScrape` の `state: "pending"` が入口。ところが
 * **画面 (WS) 経路の `executeScrape` は `recordScrapeJob` を 1 度も呼ばず**、
 * `foldAfterIngest` 越しにだけ同じ `scrape-job:{読取日}` を触っていた。旧実装は
 * そこで `{ state: "done", ... }` を書いていたため、
 *
 * - **その読取日のレコードが無いと、取り込んでいないのに `done` が生える**
 *   (アップロードに失敗して `resultStatus: "error"` になった回でも、
 *   `decideFoldTrigger` が `no_upload` を返して `done` + `skipped_no_upload` を書く)
 * - **`failed` + `error` のレコードがあると `done` に化け、`error` / `accepted_at` /
 *   `upload_id` / `split_failed` が前回の失敗のまま残る** (issue #595 の症状1 と同じ形。
 *   「失敗を見た人が画面から取り直す」という正規の復旧手順で踏む)
 *
 * `recordScrapeJob` の `state: "pending"` リセットはこの経路を通らないので効かない。
 *
 * ⇒ **fold は「既にある試行の記録に fold の結果を足す」だけにする。** 記録が無い
 * ということは無人実行の試行が無いということで、fold が代わりに名乗る筋合いはない。
 */
export function decideFoldRecord(
  existing: ScrapeJobRecord | undefined,
  jobKey: string,
  patch: ScrapeJobFoldPatch,
): FoldRecordDecision {
  if (!existing) return { write: false, reason: "no_record" };
  const base = patch.fold_state === "running" ? clearPreviousFoldAttempt(existing) : existing;
  return { write: true, record: { ...base, ...patch, date: jobKey } };
}

/**
 * **新しい fold の入口 (`fold_state: "running"`) で、前回の試行の残骸を捨てる**
 * (Refs #945)。`recordScrapeJob` が `state: "pending"` で spread を止めている
 * (#596) のと同じ処置を fold 側にも当てる。
 *
 * ## なぜ要るか (本番で実測、2026-08-26)
 *
 * `fold_pages` / `fold_drivers_written` を書くのは **`runFoldMonths` の終端 1 か所
 * だけ**で、fold の途中では 1 度も書かない。ところが patch は部分 spread なので、
 * **同じ読取日を畳み直すと前回の終端値がそのまま残る**:
 *
 * ```
 * comp 27324455 / 読取日 2026-08-01
 *   fold_pages: 2, fold_drivers_written: 0   ← 2026-08-01 の fold の終端値
 *   fold_started_at: 2026-08-21T18:23:32Z    ← 20 日後に畳み直した
 *   fold_state: "running"
 * ```
 *
 * これは **「2 ページ書いたところで止まった」と読めてしまう**が、実際には別の試行の
 * 数字。ohishi-exp/nuxt-dtako-admin#945 の本文もそう誤読している。`fold_error` も
 * 同じで、前回 `failed` → 今回 `running` にすると古いエラーが残り続ける。
 *
 * ⇒ **入口で「この試行がまだ何も書いていない」状態に戻す。** `running` の patch が
 * 自分で書く `fold_started_at` / `fold_months` もここで一度落として、patch 側の値
 * だけが載るようにする (patch に無ければ載らないのが正しい)。
 */
function clearPreviousFoldAttempt(record: ScrapeJobRecord): ScrapeJobRecord {
  const {
    fold_error: _foldError,
    fold_skip_reason: _foldSkipReason,
    fold_months: _foldMonths,
    fold_pages: _foldPages,
    fold_drivers_written: _foldDriversWritten,
    fold_started_at: _foldStartedAt,
    ...rest
  } = record;
  return rest;
}

/** [`recordFoldProgress`] の結果。**呼び出し元は `written` 以外を黙って捨てないこと** —
 * 「書かなかった」と「書けなかった」を混ぜない (`unsplit_total` の null と同じ流儀)。 */
export type FoldProgressOutcome = "written" | "skipped_no_record" | "error";

/** [`decideFoldRecord`] の答えを storage に反映する。`recordScrapeJob` と同じく
 * **観測のための書き込みなので例外を投げない** (Refs #205-43 の条件3) が、
 * `recordScrapeJob` と違って**戻り値で結果を返す** — 「書かなかった」は正常な
 * 分岐なので、呼び出し元がログに残せるようにする。 */
export async function recordFoldProgress(
  storage: QueueStorage,
  jobKey: string,
  patch: ScrapeJobFoldPatch,
): Promise<FoldProgressOutcome> {
  try {
    const key = SCRAPE_JOB_KEY_PREFIX + jobKey;
    const decision = decideFoldRecord(await storage.get<ScrapeJobRecord>(key), jobKey, patch);
    if (!decision.write) return "skipped_no_record";
    await storage.put(key, decision.record);
    await touchScrapeJobOrder(storage, jobKey);
    return "written";
  } catch (err) {
    console.error(`recordFoldProgress failed (job=${jobKey}): ${describeUnknownError(err)}`);
    return "error";
  }
}

/** 挿入順 (実際には「最後に触れた順」) の index を更新し、
 * [`MAX_SCRAPE_JOB_RECORDS`] を超えたら古い方から `scrape-job:` レコードごと
 * 捨てる。**黙って消さない** — 捨てた日付を console.log に残す。 */
export async function touchScrapeJobOrder(storage: QueueStorage, jobKey: string): Promise<void> {
  const order = (await storage.get<string[]>(SCRAPE_JOB_ORDER_KEY)) ?? [];
  const next = order.filter((d) => d !== jobKey);
  next.push(jobKey);
  const overflow = next.length - MAX_SCRAPE_JOB_RECORDS;
  const evicted = overflow > 0 ? next.splice(0, overflow) : [];
  if (evicted.length > 0) {
    await Promise.all(evicted.map((d) => storage.delete(SCRAPE_JOB_KEY_PREFIX + d)));
    console.log(JSON.stringify({ scrape_job_progress: "evicted", count: evicted.length, dates: evicted }));
  }
  await storage.put(SCRAPE_JOB_ORDER_KEY, next);
}

/** `scrape-queue` の末尾に 1 件積み、drain を急がせるため alarm を「今すぐ」に
 * 上書きする。**push した時点で drain が保証される**よう、スケジューリングを
 * ここに内包する (呼び出し元が忘れても孤立しない)。 */
export async function pushScrapeQueueItem(storage: QueueStorage, item: QueuedScrapeItem): Promise<void> {
  const queue = (await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY)) ?? [];
  queue.push(item);
  const overflow = queue.length - MAX_SCRAPE_QUEUE_LENGTH;
  if (overflow > 0) {
    const dropped = queue.splice(0, overflow);
    console.error(
      JSON.stringify({ scrape_queue: "overflow_dropped", count: dropped.length, jobs: dropped.map((d) => d.jobKey) }),
    );
  }
  await storage.put(SCRAPE_QUEUE_KEY, queue);
  await storage.setAlarm(Date.now());
}

/** キュー先頭を 1 件取り出す。空なら `null`。 */
export async function popNextScrapeQueueItem(storage: QueueStorage): Promise<QueuedScrapeItem | null> {
  const queue = (await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY)) ?? [];
  const next = queue.shift();
  if (next === undefined) return null;
  await storage.put(SCRAPE_QUEUE_KEY, queue);
  return next;
}

export async function setRunningPointer(storage: QueueStorage, item: QueuedScrapeItem): Promise<void> {
  await storage.put(SCRAPE_RUNNING_KEY, item);
}

export async function clearRunningPointer(storage: QueueStorage): Promise<void> {
  await storage.delete(SCRAPE_RUNNING_KEY);
}

export interface OrphanRecoveryResult {
  /** 壊す前 (`pre_upload`) に死んだと判定し、キュー先頭へ積み直した jobKey。 */
  recovered: string | null;
  /** 壊した後 (`post_upload`) または phase 不明で fail-closed した jobKey。 */
  failed: string | null;
}

/** 前回の `alarm()` 呼び出しが `scrape-running` をクリアする前に死んだ孤児を
 * 回収する。**呼び出し元は、次に実行する job を pop するより前にこれを呼ぶこと。**
 *
 * 判定は phase だけを見る:
 * - `"pre_upload"` (まだ壊す前) → 安全。キュー先頭に積み直し、`state: "pending"`
 *   に戻して自動再実行させる
 * - `"post_upload"` または phase 欠落 (旧レコード・想定外) → **fail-closed**。
 *   取り込み (`has_kudgivt` リセット) が実際に走ったかどうか分からない状態で
 *   自動リトライすると二重取り込みの危険がある (Refs #205-55 条件4) ので、
 *   `state: "failed"` にして人手確認へ回す。絶対に自動で先へ進めない。 */
export async function recoverOrphan(storage: QueueStorage): Promise<OrphanRecoveryResult> {
  const running = await storage.get<QueuedScrapeItem>(SCRAPE_RUNNING_KEY);
  if (!running) return { recovered: null, failed: null };

  const record = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + running.jobKey);
  await storage.delete(SCRAPE_RUNNING_KEY);

  if (record?.phase === "pre_upload") {
    const queue = (await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY)) ?? [];
    queue.unshift(running);
    await storage.put(SCRAPE_QUEUE_KEY, queue);
    await recordScrapeJob(storage, running.jobKey, { state: "pending" });
    console.error(JSON.stringify({ scrape_orphan: "recovered", job: running.jobKey, phase: "pre_upload" }));
    return { recovered: running.jobKey, failed: null };
  }

  await recordScrapeJob(storage, running.jobKey, {
    state: "failed",
    error:
      "DO 再起動 (deploy / evict) で中断しました。取り込み (has_kudgivt リセット) 済みかどうか不明なため自動リトライしません。手動で状態を確認してください。",
  });
  console.error(
    JSON.stringify({ scrape_orphan: "failed_closed", job: running.jobKey, phase: record?.phase ?? "unknown" }),
  );
  return { recovered: null, failed: running.jobKey };
}

/** `scrapeJobKey` (`scrape-dispatch.ts`) の逆変換。`YYYY-MM-DD` または
 * `YYYY-MM-DD..YYYY-MM-DD` を分解する。 */
function splitJobKey(jobKey: string): [string, string] {
  const idx = jobKey.indexOf("..");
  if (idx === -1) return [jobKey, jobKey];
  return [jobKey.slice(0, idx), jobKey.slice(idx + 2)];
}

export interface MigrationResult {
  /** false = 既に移送済み (no-op)。 */
  ran: boolean;
  requeued: string[];
  failedClosed: string[];
}

/** この PR より前に投入された `scrape-job:*` レコードを、一度だけ新キューへ
 * 移送する (Refs #205-55 条件10、2026-08-01 時点で本番に残っている孤児)。
 *
 * **`compId` が要る** — `ScrapeJobRecord` / `jobKey` は comp_id を持たない
 * (DO インスタンスが comp_id 単位なので不要だった)。DO は `idFromName` で
 * 作られた自分の名前を逆引きできない (Cloudflare の仕様、一方向ハッシュ) ため、
 * **`alarm()` 単体では compId を復元できない。** compId を知っている呼び出し元
 * (`/cron/dtako` handler・WS 手動トリガー) からだけ呼べる。
 *
 * **判定は [`recoverOrphan`] と同じ規則をそのまま適用する** (新しい規則を
 * 足さない、Refs #205-55 条件10):
 * - `state: "pending"` → アップロードに到達していないので安全。`scrape-queue`
 *   に積む
 * - `state: "running"` → 旧レコードには `phase` が無い = 必ず fail-closed で
 *   `"failed"` (受け入れ条件4 の「phase 不明は壊した後扱い」を、移送前の
 *   レコード全件に対して適用した結果)
 * - `state: "done"` / `"failed"` → 対象外、そのまま
 *
 * 冪等: `scrape-queue` キーが**既に存在する** (undefined でない、空配列でも
 * 既存扱い) なら二度と実行しない。 */
export async function migrateLegacyScrapeJobsOnce(
  storage: QueueStorage,
  compId: string,
): Promise<MigrationResult> {
  const existingQueue = await storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY);
  if (existingQueue !== undefined) {
    return { ran: false, requeued: [], failedClosed: [] };
  }

  const order = (await storage.get<string[]>(SCRAPE_JOB_ORDER_KEY)) ?? [];
  const requeued: string[] = [];
  const failedClosed: string[] = [];
  const queue: QueuedScrapeItem[] = [];

  for (const jobKey of order) {
    const record = await storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + jobKey);
    if (!record) continue;
    if (record.state === "pending") {
      const [startDate, endDate] = splitJobKey(jobKey);
      queue.push({ jobKey, compId, startDate, endDate });
      requeued.push(jobKey);
    } else if (record.state === "running") {
      await recordScrapeJob(storage, jobKey, {
        state: "failed",
        error:
          "キュー永続化 (Refs #205-55) より前に投入され、DO 再起動で中断した可能性があるジョブです。phase 情報が無いため自動リトライしません。手動で状態を確認してください。",
      });
      failedClosed.push(jobKey);
    }
  }

  await storage.put(SCRAPE_QUEUE_KEY, queue);
  if (requeued.length > 0 || failedClosed.length > 0) {
    console.error(
      JSON.stringify({ scrape_queue_migration: "done", comp_id: compId, requeued, failed_closed: failedClosed }),
    );
  }
  if (queue.length > 0) {
    await storage.setAlarm(Date.now());
  }
  return { ran: true, requeued, failedClosed };
}

/** `fold_state: "running"` の古さの閾値 (ミリ秒)。**読み手に「これは残骸かもしれない」
 * と伝えるためだけの値** — これを超えても保存値は書き換えない ([`annotateFoldStaleness`])。
 *
 * ## 実測 (2026-08-26、測定条件つき)
 *
 * - 経路: kyuyo-mcp `get_dtako_scrape_progress` (読むだけ)。母集団は下記 3 件のみ
 * - 条件: comp 27324455 / **取り込みを伴わない fold のみの遡り実行** / `fold_pages: 4`
 * - fold は DO 内で直列 (`foldQueue`) なので、連続する `fold_started_at` の差を所要時間の
 *   近似として読んだ (厳密な計測ではなく**上限寄りの近似**)
 *
 * ```
 * 2026-08-21 05:40:40  読取日 07-01 → done (pages 4, drivers 92)
 * 2026-08-21 05:44:07  読取日 07-02 → done (pages 4, drivers 98)   差 3分27秒
 * 2026-08-21 05:47:22  読取日 07-03 → running (取り残された)        差 3分15秒
 * ```
 *
 * ⇒ **4 ページ完走で約 3.3 分。** 30 分はその約 9 倍で、読むだけの用途には十分な余裕がある。
 * **母集団が 3 件しかないので、ページ数や母集団が変われば測り直すこと。**
 * (Refs #633-21 の「★ この数字は未検証」を、この実測で置き換えた。) */
export const STALE_FOLD_THRESHOLD_MS = 30 * 60 * 1000;

/** `fold_state: "running"` を**終端に倒す**閾値 (ミリ秒、Refs #945)。
 *
 * **[`STALE_FOLD_THRESHOLD_MS`] を流用しない。** あちらは「読み手に疑わせる」ための値で、
 * こちらは**記録を書き換える**判定。まだ生きている fold を倒すと「動いていたものを
 * 止まったことにした記録」が残り、`skipped_out_of_scope` が壊れた fold を隠していたのと
 * 同じ型の欠陥 (Refs #944) を新しく作ってしまう。⇒ **上の実測 (約 3.3 分) の 100 倍以上**を
 * 取って、実質「その日のうちに終わらなかったものだけ」を倒す。
 *
 * **実測で本当に 6 時間かかる fold が見つかったら、この数字ではなく実測値を報告すること。** */
export const STALE_FOLD_REAP_MS = 6 * 60 * 60 * 1000;

/** 進捗応答用に、`fold_state: "running"` のレコードへ経過時間の算出値を添える。
 * **保存値 (`fold_state` そのもの) は書き換えない** — running が本当に残骸か
 * どうかは断定できない (deploy による DO evict で fold も巻き添えになった、
 * という読みは Refs #633-21 の推測であって確定情報ではない)。読み手が判断する
 * ための材料 (`fold_running_for_ms` / `fold_stale`) を渡すだけに留める。
 *
 * `now` は必ず引数で受ける (呼び出し元でテストできるよう `Date.now()` を
 * ここで直接呼ばない)。`fold_started_at` が無い旧レコードは `accepted_at` で
 * 代用する (精度は落ちるが、日単位の古さを見るには十分)。 */
export function annotateFoldStaleness(
  record: ScrapeJobRecord,
  now: number,
): ScrapeJobRecord & { fold_running_for_ms?: number; fold_stale?: boolean } {
  if (record.fold_state !== "running") return record;
  const startedAt = record.fold_started_at ?? record.accepted_at;
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return record;
  const fold_running_for_ms = Math.max(0, now - startedMs);
  return { ...record, fold_running_for_ms, fold_stale: fold_running_for_ms > STALE_FOLD_THRESHOLD_MS };
}

/** `fold_state: "running"` が始まってからの経過ミリ秒。`fold_started_at` が無い旧
 * レコードは `accepted_at` で代用する ([`annotateFoldStaleness`] と同じ規則)。
 * 時刻が読めなければ `null` — **0 に丸めない** (「経過 0 = 今始まった」と読めてしまう)。 */
function foldRunningForMs(record: ScrapeJobRecord, now: number): number | null {
  const startedMs = Date.parse(record.fold_started_at ?? record.accepted_at);
  if (Number.isNaN(startedMs)) return null;
  return Math.max(0, now - startedMs);
}

/** [`reapStaleFolds`] が `fold_error` に書く文面。**「いつから running か」と
 * 「その時刻をどう測ったか」を必ず両方書く** (Refs #945)。
 *
 * `fold_started_at` を持たない旧レコードでは `accepted_at` で代用しており、
 * **本当の fold 開始時刻は記録に残っていない**。これを書かないと、代用で出た
 * 「25 日」が実測値として読まれる (#945 本文がまさにそう読んでいる)。 */
function describeStaleFold(record: ScrapeJobRecord, runningForMs: number): string {
  const hours = Math.floor(runningForMs / (60 * 60 * 1000));
  const basis = record.fold_started_at
    ? `running を書いた時刻: ${record.fold_started_at}`
    : `★ fold_started_at を持たない旧レコードのため accepted_at (${record.accepted_at}) からの` +
      "経過で測っています — 実際の fold 開始時刻は記録に残っていません";
  return (
    `fold_state: "running" のまま約 ${hours} 時間 (閾値 ` +
    `${STALE_FOLD_REAP_MS / (60 * 60 * 1000)} 時間) を超えたため終端に倒しました。` +
    `${basis}。**fold が失敗したと確認できたわけではありません** — ` +
    "DO の再起動 (deploy / evict) 等で終端の記録が書かれないまま取り残された可能性があります。"
  );
}

/** [`reapStaleFolds`] の結果。倒した jobKey を返す — **呼び出し元が黙って捨てないため**。 */
export interface StaleFoldReapResult {
  reaped: string[];
}

/**
 * **取り残された `fold_state: "running"` を終端 (`stale`) に倒す** (Refs #945)。
 *
 * ## なぜ要るか
 *
 * `runFoldMonths` は `running` を書いた後、try/catch で終端を書く。**DO が evict /
 * 再起動されるとその catch は走らない**ので、記録は `running` のまま残る。取り込み
 * 本体には孤児回収 ([`recoverOrphan`]) が在るのに、**fold には対応物が 1 本も無かった** —
 * 結果、本番に最長 25 日 (旧レコードの `accepted_at` 代用で測った値) の `running` が
 * 9 件残り、**`done`/`failed`/`skipped_*` のどれにも入らないので失敗として数えられない**
 * 状態になっていた (「黙って落とす」の型)。
 *
 * ## 倒すのであって、リトライはしない
 *
 * fold をやり直すには取り込みの入力が要り、`/cron/dtako` は破壊的経路
 * (`has_kudgivt` を `DEFAULT FALSE` に戻す)。**勝手に回さない** — 数えられる終端に
 * するところまでが仕事で、回し直すかどうかは人が決める。
 *
 * ## `touchScrapeJobOrder` を通さない
 *
 * あれは「最後に触れた順」を更新し、[`MAX_SCRAPE_JOB_RECORDS`] を超えたぶんを古い方から
 * 捨てる。**掃除で 9 件を触ると 9 件が最新扱いになり、その分だけ別の (もっと新しい)
 * 記録が板から落ちる** — 記録を読めるようにするための掃除で記録を消しては本末転倒。
 * ⇒ 順序には触れず `put` だけする。
 *
 * **観測のための書き込みなので例外を投げない** ([`recordFoldProgress`] と同じ流儀)。
 * `now` は必ず引数で受ける (テストのため `Date.now()` をここで直接呼ばない)。
 */
export async function reapStaleFolds(
  storage: QueueStorage,
  now: number,
): Promise<StaleFoldReapResult> {
  const reaped: string[] = [];
  try {
    const order = (await storage.get<string[]>(SCRAPE_JOB_ORDER_KEY)) ?? [];
    for (const jobKey of order) {
      const key = SCRAPE_JOB_KEY_PREFIX + jobKey;
      const record = await storage.get<ScrapeJobRecord>(key);
      if (!record || record.fold_state !== "running") continue;
      const runningForMs = foldRunningForMs(record, now);
      if (runningForMs === null || runningForMs <= STALE_FOLD_REAP_MS) continue;
      await storage.put(key, {
        ...record,
        fold_state: "stale",
        fold_error: describeStaleFold(record, runningForMs),
      });
      reaped.push(jobKey);
    }
  } catch (err) {
    // **黙って 0 件にしない。** 掃除できなかったことと、掃除する物が無かったことは別。
    console.error(`reapStaleFolds failed: ${describeUnknownError(err)}`);
  }
  if (reaped.length > 0) {
    console.error(JSON.stringify({ kintai_fold: "reaped_stale", count: reaped.length, jobs: reaped }));
  }
  return { reaped };
}

/** `fold_state` 別の件数。**全ての状態を 0 件でも必ず載せる** (Refs #945)。
 *
 * `fold_state` を持たない (fold を回す前 / 回さなかった) レコードは `none` に数える —
 * **合計がレコード数と一致することを保証する**。issue #945 の「`fold_state` の集計は
 * `done`/`failed`/`skipped_*` しか拾わず、永久 `running` はどちらにも入らない」は、
 * 集計する側が状態を列挙していたことが原因。⇒ [`FOLD_STATES`] を正にして、
 * **状態が増えたら集計にも自動で載る**ようにする。 */
export function countFoldStates(
  records: readonly ScrapeJobRecord[],
): Record<FoldState | "none", number> {
  const counts = { none: 0 } as Record<FoldState | "none", number>;
  for (const state of FOLD_STATES) counts[state] = 0;
  for (const record of records) counts[record.fold_state ?? "none"] += 1;
  return counts;
}
