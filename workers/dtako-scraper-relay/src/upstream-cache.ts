/**
 * kintai 系上流応答の DO SQLite キャッシュ + 条件付き再検証 (Refs #543 PR-2)。
 *
 * wage-report / kintai/kosoku-daily は毎回 rust-ichibanboshi から 1.7MB 級の
 * JSON を Cloudflare Tunnel 越しに取り直しており、転送がそのまま応答時間になる。
 * 本文を gzip して DO SQLite (`new_sqlite_classes`) に置き、**上流の版 (etag) が
 * 一致した時だけ**再利用する:
 *
 * - 版は `GET /api/kintai/version?month=` (rust-ichibanboshi#184) の opaque etag。
 *   一致 = 上流データ不変なので本文再取得を省ける (**古い値は一切返さない**)
 * - 版が引けない (未デプロイ・失敗) 時はキャッシュを読まずライブ取得へ倒す
 * - DO SQLite の行 2MB 制限があるため、gzip 後 1.9MB 超は格納をスキップして
 *   ライブ動作のまま (チャンク分割は今回やらない)
 * - 有効化は `UPSTREAM_CACHE=on` (wrangler.toml vars、既定 off) のときだけ
 *
 * このモジュールは pure (cloudflare runtime 非依存、SqlStorage は構造型で受ける)
 * — DO への配線は dtako-scraper-relay-do.ts の loadKintaiTextWithCache 参照。
 */

/** キャッシュ対象の上流の種別。month と合わせて主キーになる。 */
export type CacheKind = "daily" | "kosoku";

/** 1 取得単位のキャッシュ結果。live = フラグ off ではなく「版照会失敗で不使用」。 */
export type CachePieceState = "hit" | "miss" | "live";

/** DO SQLite の行 2MB 制限に対する余裕を見た格納上限 (gzip 後バイト数)。 */
export const UPSTREAM_CACHE_MAX_GZ_BYTES = 1_900_000;

/** `ctx.storage.sql` (SqlStorage) の最小構造型 — テストではメモリ実装を差す。 */
export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> };
}

export const UPSTREAM_CACHE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS upstream_cache (
  kind TEXT NOT NULL,
  month TEXT NOT NULL,
  body_gz BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  upstream_etag TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY (kind, month)
)`;

/**
 * DO SQLite 上のキャッシュ表への読み書き。テーブルは初回アクセス時に作る
 * (DO SQLite は同期 API なので await 不要)。
 */
export class UpstreamCache {
  private initialized = false;

  constructor(private readonly sql: SqlStorageLike) {}

  private ensureTable(): void {
    if (this.initialized) return;
    this.sql.exec(UPSTREAM_CACHE_TABLE_SQL);
    this.initialized = true;
  }

  /**
   * 版 (etag) が一致する行の gzip 本文を返す。行なし・版不一致は null。
   * 一致した時は verified_at を進める (「いつまでこの版が生きていたか」の記録)。
   */
  getFresh(kind: CacheKind, month: string, etag: string, now: number): Uint8Array | null {
    this.ensureTable();
    const rows = this.sql
      .exec("SELECT body_gz, upstream_etag FROM upstream_cache WHERE kind = ? AND month = ?", kind, month)
      .toArray();
    const row = rows[0];
    if (!row) return null;
    if (row.upstream_etag !== etag) return null;
    this.sql.exec(
      "UPDATE upstream_cache SET verified_at = ? WHERE kind = ? AND month = ?",
      now,
      kind,
      month,
    );
    const body = row.body_gz;
    // SqlStorage の BLOB は ArrayBuffer で返る (テスト実装は Uint8Array もあり得る)
    return body instanceof ArrayBuffer ? new Uint8Array(body) : (body as Uint8Array);
  }

  /**
   * 行を落とす (取り込み直後の無効化、Refs #543 PR-3)。行が無くても何もしない。
   * 消した月は次回読みが miss になり、版照会 → ライブ取得で作り直される。
   */
  delete(kind: CacheKind, month: string): void {
    this.ensureTable();
    this.sql.exec("DELETE FROM upstream_cache WHERE kind = ? AND month = ?", kind, month);
  }

  /**
   * gzip 本文を upsert する。**1.9MB 超は格納せず false** (呼び出し側は
   * ライブ動作のままで良い — 次回も再取得になるだけで壊れない)。
   */
  put(
    kind: CacheKind,
    month: string,
    bodyGz: Uint8Array,
    sha256: string,
    etag: string,
    now: number,
  ): boolean {
    this.ensureTable();
    if (bodyGz.byteLength > UPSTREAM_CACHE_MAX_GZ_BYTES) return false;
    // BLOB binding は ArrayBuffer で渡す (view の offset/length を確定させる)
    const buf = bodyGz.buffer.slice(bodyGz.byteOffset, bodyGz.byteOffset + bodyGz.byteLength);
    this.sql.exec(
      `INSERT INTO upstream_cache (kind, month, body_gz, sha256, upstream_etag, fetched_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, month) DO UPDATE SET
         body_gz = excluded.body_gz,
         sha256 = excluded.sha256,
         upstream_etag = excluded.upstream_etag,
         fetched_at = excluded.fetched_at,
         verified_at = excluded.verified_at`,
      kind,
      month,
      buf,
      sha256,
      etag,
      now,
      now,
    );
    return true;
  }
}

/** JSON テキストを gzip する (CompressionStream — Workers / Node 18+ 共通)。 */
export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** gzip 本文をテキストへ戻す。壊れた本文は throw (呼び出し側がライブへ倒す)。 */
export async function gunzipText(gz: Uint8Array | ArrayBuffer): Promise<string> {
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * `GET /api/kintai/version` の応答 (`{month, etag}`) から etag を取り出す。
 * 形が違う・空文字は null (= 版不明としてライブへ倒す)。
 */
export function parseVersionResponse(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const etag = (body as { etag?: unknown }).etag;
  return typeof etag === "string" && etag !== "" ? etag : null;
}

/**
 * リクエスト内の各取得単位の結果を 1 つの cacheState に畳む (phase log 用):
 *
 * - 何も記録なし (フラグ off / kintai 系を触らない) → "live"
 * - 全部 hit → "hit"
 * - どれかが miss → "miss" (取り直しが発生した)
 * - それ以外 (hit と live の混在・全部 live = 版照会失敗) → "live"
 */
export function aggregateCacheState(states: readonly CachePieceState[]): CachePieceState {
  if (states.length === 0) return "live";
  if (states.every((s) => s === "hit")) return "hit";
  if (states.includes("miss")) return "miss";
  return "live";
}

/** リクエスト 1 本ぶんの取得単位結果を集める (aggregateCacheState の器)。 */
export class CacheStateTracker {
  private readonly states: CachePieceState[] = [];

  add(state: CachePieceState): void {
    this.states.push(state);
  }

  aggregate(): CachePieceState {
    return aggregateCacheState(this.states);
  }
}
