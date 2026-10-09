/**
 * rust-alc-api `POST /api/upload` への csvdata.zip 自動アップロード
 * (Refs ohishi-exp/dtako-scraper#22, ippoan/rust-alc-api#434 caller #4b)。
 *
 * このDOはブラウザ JWT を持たない server-to-server caller で、かつ
 * `comp_id` が複数 tenant にまたがる (nuxt-dtako-admin の管理者は自分の
 * tenant と無関係な comp_id もトリガーできる)。よって:
 *
 * - `device-data-proxy` (device JWT が要る = pairing が要る、Worker が device
 *   になるのは不自然) は不採用
 * - `alc-proxy` (browser JWT の tenant_id を逆引き) も不採用 — トリガーした
 *   管理者の tenant と comp_id の tenant が一致するとは限らないため、
 *   誤った tenant に書き込む恐れがある
 * - `alc-internal-proxy` の shared-secret 経路 (email-receiver が
 *   `/api/dtako/tickets` で使うのと同じ) を採用。`DTAKO_ACCOUNTS` (comp_id ->
 *   tenant_id) から解決した **正しい tenant_id を明示 `X-Tenant-ID` で渡す**。
 *
 * consumer が付けるのは `X-Alc-Proxy-Secret` (INTERNAL_SHARED_SECRET、consumer
 * worker proof) + `X-Tenant-ID` の 2 つだけ。OIDC mint / rust 向け
 * `X-Internal-Shared-Secret` の付与は auth-worker 側 (alc-internal-proxy.ts)
 * に集約されている。
 */

/** service binding fetch 用の絶対 URL base。host は binding が無視するが path が
 * `/alc-internal-proxy/...` で始まる必要がある (auth-worker 側が prefix を slice
 * して rust-alc-api に forward するため)。email-receiver の dtako.ts と同じ規約。 */
export const INTERNAL_PROXY_BASE = "https://auth-worker.internal";

export class AlcInternalUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlcInternalUploadError";
  }
}

export type FetchLike = typeof fetch;

export interface AlcInternalUploadInput {
  sharedSecret: string;
  tenantId: string;
  filename: string;
  zipBytes: ArrayBuffer;
}

/** `multipart/form-data` body を手組みする (rust-alc-api の `extract_file` は
 * フィールド名 `file` を要求する、`crates/alc-dtako/src/dtako_upload.rs` 参照)。 */
function buildMultipartBody(
  boundary: string,
  filename: string,
  zipBytes: ArrayBuffer,
): ArrayBuffer {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const combined = new Uint8Array(head.byteLength + zipBytes.byteLength + tail.byteLength);
  combined.set(head, 0);
  combined.set(new Uint8Array(zipBytes), head.byteLength);
  combined.set(tail, head.byteLength + zipBytes.byteLength);
  return combined.buffer;
}

/** `alc-internal-proxy` の **shared-secret class** へ送る 1 リクエスト。
 * `path` は `/alc-internal-proxy/...` で始めること (auth-worker 側の規約)。 */
export interface AlcInternalProxyRequest {
  path: string;
  /** `INTERNAL_SHARED_SECRET` (consumer worker proof)。 */
  sharedSecret: string;
  /** **caller が名乗る tenant。** shared-secret class では必須 — 省略できる形にしない。 */
  tenantId: string;
  contentType: string;
  /** バイト列でも `ReadableStream` でもよい (DVR の `.vdf` は DO で読み切らずに渡す。
   * ただし **forward 先の auth-worker が 1 度 `arrayBuffer()` でバッファする**ので、
   * end-to-end のストリーミングにはならない — `dvr-ingest.ts` の
   * `DvrFileIngestInput.body` 参照)。 */
  body: BodyInit;
}

/**
 * `AUTH_WORKER` service binding 経由で shared-secret class の口へ POST し、応答本文を
 * 返す。**非 2xx は本文付き loud fail** — 「送ったつもり」を作らない。
 *
 * ## ★ なぜ `lineworks-notify.ts` をここへ畳まないか (再検討しないで済むよう残す)
 *
 * あちらは `internal-jwt` class で、**`X-Tenant-ID` を付けない** (付けても
 * auth-worker が forward しない。tenant は rust が行 id から解決する)。
 * `tenantId` を optional にしてあちらもここへ寄せると、**shared-secret class の
 * 呼び出しで tenant を付け忘れても型が通る**形になる。caller が名乗る tenant は
 * この class の封じ込めの要 (Refs ippoan/rust-alc-api#434) なので、事故で落とせる
 * 形にしない。共通なのは fetch と非 2xx の 4 行で、畳むより危ない。
 */
export async function sendViaAlcInternalProxy(
  req: AlcInternalProxyRequest,
  fetchImpl: FetchLike,
): Promise<string> {
  const res = await fetchImpl(`${INTERNAL_PROXY_BASE}${req.path}`, {
    method: "POST",
    headers: {
      "X-Alc-Proxy-Secret": req.sharedSecret,
      "X-Tenant-ID": req.tenantId,
      "Content-Type": req.contentType,
    },
    body: req.body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new AlcInternalUploadError(
      `alc-internal-proxy ${req.path} failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return text;
}

/** `AUTH_WORKER` service binding 経由で `/alc-internal-proxy/api/upload` に zip を送る。 */
export async function uploadDtakoZipViaAlcInternalProxy(
  input: AlcInternalUploadInput,
  fetchImpl: FetchLike,
): Promise<string> {
  const boundary = `----dtakoScraperRelay${crypto.randomUUID().replace(/-/g, "")}`;
  return sendViaAlcInternalProxy(
    {
      path: "/alc-internal-proxy/api/upload",
      sharedSecret: input.sharedSecret,
      tenantId: input.tenantId,
      contentType: `multipart/form-data; boundary=${boundary}`,
      body: buildMultipartBody(boundary, input.filename, input.zipBytes),
    },
    fetchImpl,
  );
}

/**
 * `POST /api/upload` 応答 (`UploadResponse`) から、後続の CSV 分割リトライに要る
 * 情報だけを取り出す。
 *
 * **なぜ `split_failed` を運ぶ必要があるか** (Refs ohishi-exp/rust-ichibanboshi#205 の 40):
 * alc の `process_zip` は運行行を `delete_operation` + `insert_operation` で作り直すが
 * `insert_operation` の列リストに `has_kudgivt` が無いので **アップロードのたびに
 * `DEFAULT FALSE` に戻る**。TRUE に戻すのは直後に走る split の成功だけで、読み取り側
 * (`GET /api/dtako/events` / `/etags` / Y時間) は 3 クエリとも `has_kudgivt = TRUE` で
 * 絞っている。つまり **split が失敗するとその運行は入力からも欠け検知の母集団からも
 * 同時に消える** (2026-07-31 に実際に 1 運行が消えた)。alc は取り込み自体は成功
 * させたまま失敗件数を `split_failed` に載せてくる (ippoan/rust-alc-api#586) ので、
 * ここで拾って呼び手 (WS result / cron ログ) に構造化して渡す。
 *
 * **`split_failed === 0` は「分割済み」の十分条件ではない** — alc 側の
 * `update_has_kudgivt` が当たらなかった unko_no は `tracing::warn!` されるだけで
 * `Ok(0)` が返る (`crates/alc-dtako/src/dtako_upload.rs:1040-1046`)。0 を見て
 * 「問題なし」と言い切らないこと。
 *
 * パースできない / フィールドが無い応答 (旧 alc 等) では該当フィールドを `null` に
 * する。**`null` を 0 に丸めない** — 「失敗 0 件」と「不明」は別物で、丸めると
 * 旧 alc 相手に「分割は成功した」と嘘をつくことになる。
 */
export interface AlcUploadOutcome {
  uploadId: string | null;
  operationsCount: number | null;
  /** CSV 分割の失敗件数。`null` は「応答に無い = 不明」。 */
  splitFailed: number | null;
}

export function parseAlcUploadResponse(body: string): AlcUploadOutcome {
  const unknown: AlcUploadOutcome = { uploadId: null, operationsCount: null, splitFailed: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unknown;
  }
  if (typeof parsed !== "object" || parsed === null) return unknown;
  const obj = parsed as Record<string, unknown>;
  const uploadId = typeof obj.upload_id === "string" && obj.upload_id ? obj.upload_id : null;
  const operationsCount =
    typeof obj.operations_count === "number" && Number.isFinite(obj.operations_count)
      ? obj.operations_count
      : null;
  const splitFailed =
    typeof obj.split_failed === "number" && Number.isFinite(obj.split_failed)
      ? obj.split_failed
      : null;
  return { uploadId, operationsCount, splitFailed };
}

/**
 * `POST /api/recalculate-pending` (Refs ippoan/alc-dtako-worker#23)。
 *
 * 取り込み (`/api/upload`) は日別を書かず、新しい運行・変わった運行の 乗務員 × 月 に
 * 「要再計算」の印だけを付ける。印の分をまとめて計算し直して印を消すのがこの口で、
 * 取り込みの一区切り (cron 1 読取日 / バッチの終わり …) ごとに 1 回呼ぶ。呼ばないと
 * 取り込んだ日の日別が空のまま残る。
 *
 * 応答は件数だけ `{"processed": n, "failed": n, "remaining": n}`。alc は 1 回に R2 GET
 * 4000 件で止まり、残りがあれば `remaining > 0` を返すので、**`remaining` が 0 に
 * なるまで繰り返す**。`failed` は残っても繰り返さない (繰り返しても直らない)。
 *
 * **throw しない。** 呼び手は取り込み・fold を止めたくないので、失敗 (HTTP エラー・
 * JSON が読めない・通信) は `error` に種類を積んで、それまでに数えた件数と一緒に返す。
 */
export const RECALC_PENDING_PATH = "/alc-internal-proxy/api/recalculate-pending";

/** 1 回の呼び出しで繰り返す上限。alc が 1 回 4000 件で止まるので 20 回で 8 万件。
 * `remaining` が減らない異常のときに無限に叩かないための天井。 */
export const RECALC_PENDING_MAX_ROUNDS = 20;

export type RecalcPendingErrorKind = "http" | "parse" | "network";

export interface RecalcPendingResult {
  processed: number;
  failed: number;
  /** 最後に見た `remaining`。上限回数で止まったときは 0 より大きい。 */
  remaining: number;
  /** 実際に叩いた回数。 */
  rounds: number;
  error: { kind: RecalcPendingErrorKind; message: string } | null;
}

function parseRecalcPendingResponse(
  body: string,
): { processed: number; failed: number; remaining: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { processed, failed, remaining } = parsed as Record<string, unknown>;
  if (
    typeof processed !== "number" ||
    typeof failed !== "number" ||
    typeof remaining !== "number" ||
    !Number.isFinite(processed + failed + remaining)
  ) {
    return null;
  }
  return { processed, failed, remaining };
}

export async function recalcPendingViaAlcInternalProxy(
  input: { sharedSecret: string; tenantId: string },
  fetchImpl: FetchLike,
  maxRounds: number = RECALC_PENDING_MAX_ROUNDS,
): Promise<RecalcPendingResult> {
  const result: RecalcPendingResult = {
    processed: 0,
    failed: 0,
    remaining: 0,
    rounds: 0,
    error: null,
  };
  while (result.rounds < maxRounds) {
    result.rounds += 1;
    let body: string;
    try {
      body = await sendViaAlcInternalProxy(
        {
          path: RECALC_PENDING_PATH,
          sharedSecret: input.sharedSecret,
          tenantId: input.tenantId,
          contentType: "application/json",
          body: "{}",
        },
        fetchImpl,
      );
    } catch (err) {
      result.error = {
        kind: err instanceof AlcInternalUploadError ? "http" : "network",
        message: err instanceof Error ? err.message : String(err),
      };
      return result;
    }
    const counts = parseRecalcPendingResponse(body);
    if (!counts) {
      result.error = { kind: "parse", message: `応答を読めません: ${body.slice(0, 200)}` };
      return result;
    }
    result.processed += counts.processed;
    result.failed += counts.failed;
    result.remaining = counts.remaining;
    if (counts.remaining <= 0) return result;
  }
  return result;
}
