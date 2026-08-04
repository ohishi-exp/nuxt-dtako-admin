/**
 * `/cron/dtako/*` の複数運行バッチ処理 (Refs #633)。
 *
 * ## なぜ要るか
 *
 * ログイン回数の削減は #642 (DO インスタンス内でのログインセッション使い回し)
 * で既に達成済み — 1 件ずつ呼んでも同じセッションが再利用される。この機能の
 * 目的は**それとは別**で、**呼び出し側 (kyuyo-mcp) の HTTP 往復回数**を減らす
 * こと。15 運行を直すのに 15 回のツール呼び出しが要ると、そのたびにモデルの
 * 往復が発生する。1 回の HTTP 呼び出しで N 件を直列に処理できれば、往復は 1 回で
 * 済む。
 *
 * ## 直列である理由
 *
 * theearth への並行アクセスはセッションロックで hang/500 になる
 * (`downloadCsvZip` の doc comment、`scrape-queue.ts` と同じ制約)。バッチの
 * 中身を並列化しないこと。呼び出し元 (DO) はバッチ全体を 1 つの `enqueueScrape`
 * job として直列化する — 同一 comp_id への他の cron/WS スクレイプとも競合しない。
 *
 * ## セッション切れでの打ち切り
 *
 * `VenusSessionExpiredError` は「このセッションで以後何をやっても同じ理由で
 * 失敗する」ことを意味するため、残りの項目を打ち切る (無駄なリトライをしない)。
 * 打ち切ったこと自体と残件数は必ず応答に残す (`truncated`/`remaining`) —
 * 黙って件数が減っているのが一番危険なので、これは exports の契約として明示する。
 */
import { VenusSessionExpiredError } from "./theearth-venus-client";

/** 1 バッチで受け付ける最大件数。超過は 400 で拒否し、切り詰めない
 * (親指示「黙って truncate は禁止」)。
 *
 * 根拠: 実測で運行 1 件の処理は数秒〜十数秒 (theearth への複数回の GET/POST を
 * 含む)。Cloudflare Workers はネットワーク I/O 待ちを CPU 時間に算入しないため
 * CPU 上限には掛からないが、20 件 × 十数秒 ≈ 数分は HTTP 呼び出し元 (kyuyo-mcp)
 * が同期で待つには妥当な上限と判断した (親の目安どおり)。実測でこれより大きく
 * ずれることが分かったら値を見直すこと。 */
export const CRON_BATCH_MAX_ITEMS = 20;

/** バッチ件数が上限を超えた時の error (400 相当)。`limit`/`received` を持たせて
 * メッセージの文字列だけでなく機械可読な形でも呼び出し元に伝える。 */
export class BatchTooLargeError extends Error {
  readonly limit: number;
  readonly received: number;
  constructor(limit: number, received: number) {
    super(`items は最大 ${limit} 件までです (${received} 件を受け取りました) — 分割して呼び直してください`);
    this.name = "BatchTooLargeError";
    this.limit = limit;
    this.received = received;
  }
}

/** バッチ件数が上限以内かを確認する。超過したら `BatchTooLargeError` を投げる
 * (呼び出し元は先頭で切り詰めずにこれを呼ぶこと)。 */
export function assertBatchSizeWithinLimit(itemCount: number, limit: number = CRON_BATCH_MAX_ITEMS): void {
  if (itemCount > limit) {
    throw new BatchTooLargeError(limit, itemCount);
  }
}

/** バッチ内 1 件の処理結果。`ok` で分岐し、失敗時は `error` に理由文字列を積む
 * (受け入れ条件2 — 1 件失敗しても他を止めない)。 */
export interface BatchItemOutcome<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

export interface BatchRunResult<T> {
  results: BatchItemOutcome<T>[];
  /** `VenusSessionExpiredError` で打ち切ったら true。 */
  truncated: boolean;
  /** 打ち切り時点で未着手だった件数 (`results.length + remaining === items.length`
   * が常に成り立つ — 打ち切りを起こした項目自体は `results` に失敗として積む)。 */
  remaining: number;
}

/**
 * `items` を先頭から直列に `runOne` で処理する。1 件の失敗は握り潰して次へ進む
 * (受け入れ条件2)。ただし `VenusSessionExpiredError` は「このセッションでは以後
 * 何をやっても同じ理由で失敗する」ことを意味するため、その項目を失敗として積んだ
 * 上で残りを打ち切る (受け入れ条件3、無駄なリトライをしない)。**ループにしない
 * — 1 job (1 バッチ呼び出し) につき打ち切りは 1 回だけ**。
 */
export async function runBatchSequential<Item, T>(
  items: readonly Item[],
  runOne: (item: Item, index: number) => Promise<T>,
): Promise<BatchRunResult<T>> {
  const results: BatchItemOutcome<T>[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      const result = await runOne(items[i], i);
      results.push({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ ok: false, error: message });
      if (err instanceof VenusSessionExpiredError) {
        return { results, truncated: true, remaining: items.length - i - 1 };
      }
    }
  }
  return { results, truncated: false, remaining: 0 };
}

// ---------------------------------------------------------------------------
// リクエスト body の判定・正規化 (単体形式/バッチ形式 共通の型で pure に扱う)。
// 単体形式の検証メッセージ・フィールド抽出は既存の各ハンドラと同一にしてあり、
// この関数を経由しても応答が変わらないことをテストで固定する (受け入れ条件3)。
// ---------------------------------------------------------------------------

export interface OperationZipItem {
  opeNo: string;
  startOpe: string;
  recalculate: boolean;
}

export interface OperationZipRequest {
  compId: string;
  items: OperationZipItem[];
  /** true なら `items` 配列形式で来た (バッチ)。false は単体形式 (既存経路)。 */
  isBatch: boolean;
}

/** バッチ `items` 配列の 1 要素を安全な Record に正規化する (`null`/`undefined`
 * 要素を空オブジェクト扱いにする、呼び出し元 = kyuyo-mcp 側の入力ミス想定)。
 * 単体形式の body 自体はこの正規化を通さない — 元の挙動 (body が壊れていれば
 * そのまま例外) を変えないため。 */
function asItemRecord(raw: unknown): Record<string, unknown> {
  return (raw ?? {}) as Record<string, unknown>;
}

function readOpeNoStartOpe(record: Record<string, unknown>): { opeNo: string; startOpe: string } {
  return {
    opeNo: typeof record.ope_no === "string" ? record.ope_no : "",
    startOpe: typeof record.start_ope === "string" ? record.start_ope : "",
  };
}

/** `POST /cron/dtako/operation-zip` の body を単体/バッチ両対応で解釈する。
 * `items` 配列が無ければ単体形式 (既存の `comp_id`/`ope_no`/`start_ope`/
 * `recalculate` のみ) として扱い、**既存のエラーメッセージを一字一句保つ**。 */
export function parseOperationZipRequest(body: {
  comp_id?: unknown;
  ope_no?: unknown;
  start_ope?: unknown;
  recalculate?: unknown;
  items?: unknown;
}): OperationZipRequest | { error: string } {
  const compId = typeof body.comp_id === "string" ? body.comp_id : "";
  if (Array.isArray(body.items)) {
    if (!compId) return { error: "comp_id / items が必要です" };
    const items: OperationZipItem[] = [];
    for (let i = 0; i < body.items.length; i++) {
      const record = asItemRecord(body.items[i]);
      const { opeNo, startOpe } = readOpeNoStartOpe(record);
      if (!opeNo || !startOpe) return { error: `items[${i}]: ope_no / start_ope が必要です` };
      items.push({ opeNo, startOpe, recalculate: record.recalculate === true });
    }
    return { compId, items, isBatch: true };
  }
  const { opeNo, startOpe } = readOpeNoStartOpe(body);
  if (!compId || !opeNo || !startOpe) return { error: "comp_id / ope_no / start_ope が必要です" };
  return { compId, items: [{ opeNo, startOpe, recalculate: body.recalculate === true }], isBatch: false };
}

export interface DtakoReimportItem {
  opeNo: string;
  startOpe: string;
  unkoNo: string;
  resetTimecard: boolean;
}

export interface DtakoReimportRequest {
  compId: string;
  items: DtakoReimportItem[];
  isBatch: boolean;
}

/** `POST /cron/dtako/reimport` の body を単体/バッチ両対応で解釈する。
 * `unko_no` は `reimport` にだけ要る (`alc-upload` は zip 内 KUDGURI から読む) —
 * この専用型・専用パーサで必須のまま保つ (3経路共通の任意フィールドにすると
 * 入れ忘れが通ってしまう)。 */
export function parseDtakoReimportRequest(body: {
  comp_id?: unknown;
  ope_no?: unknown;
  start_ope?: unknown;
  unko_no?: unknown;
  reset_timecard?: unknown;
  items?: unknown;
}): DtakoReimportRequest | { error: string } {
  const compId = typeof body.comp_id === "string" ? body.comp_id : "";
  if (Array.isArray(body.items)) {
    if (!compId) return { error: "comp_id / items が必要です" };
    const items: DtakoReimportItem[] = [];
    for (let i = 0; i < body.items.length; i++) {
      const record = asItemRecord(body.items[i]);
      const { opeNo, startOpe } = readOpeNoStartOpe(record);
      const unkoNo = typeof record.unko_no === "string" ? record.unko_no : "";
      if (!opeNo || !startOpe || !unkoNo) {
        return { error: `items[${i}]: ope_no / start_ope / unko_no が必要です` };
      }
      items.push({ opeNo, startOpe, unkoNo, resetTimecard: record.reset_timecard === true });
    }
    return { compId, items, isBatch: true };
  }
  const { opeNo, startOpe } = readOpeNoStartOpe(body);
  const unkoNo = typeof body.unko_no === "string" ? body.unko_no : "";
  if (!compId || !opeNo || !startOpe || !unkoNo) {
    return { error: "comp_id / ope_no / start_ope / unko_no が必要です" };
  }
  return {
    compId,
    items: [{ opeNo, startOpe, unkoNo, resetTimecard: body.reset_timecard === true }],
    isBatch: false,
  };
}

export interface DtakoAlcUploadItem {
  opeNo: string;
  startOpe: string;
}

export interface DtakoAlcUploadRequest {
  compId: string;
  items: DtakoAlcUploadItem[];
  isBatch: boolean;
}

/** `POST /cron/dtako/alc-upload` の body を単体/バッチ両対応で解釈する。
 * `unko_no` は不要 (zip 内 KUDGURI.csv から読むため、`reimport` と違い受け取らない)。 */
export function parseDtakoAlcUploadRequest(body: {
  comp_id?: unknown;
  ope_no?: unknown;
  start_ope?: unknown;
  items?: unknown;
}): DtakoAlcUploadRequest | { error: string } {
  const compId = typeof body.comp_id === "string" ? body.comp_id : "";
  if (Array.isArray(body.items)) {
    if (!compId) return { error: "comp_id / items が必要です" };
    const items: DtakoAlcUploadItem[] = [];
    for (let i = 0; i < body.items.length; i++) {
      const { opeNo, startOpe } = readOpeNoStartOpe(asItemRecord(body.items[i]));
      if (!opeNo || !startOpe) return { error: `items[${i}]: ope_no / start_ope が必要です` };
      items.push({ opeNo, startOpe });
    }
    return { compId, items, isBatch: true };
  }
  const { opeNo, startOpe } = readOpeNoStartOpe(body);
  if (!compId || !opeNo || !startOpe) return { error: "comp_id / ope_no / start_ope が必要です" };
  return { compId, items: [{ opeNo, startOpe }], isBatch: false };
}
