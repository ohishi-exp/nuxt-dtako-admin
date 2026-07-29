/**
 * 上流応答の短期メモ + in-flight 共有 (Refs #508)。
 *
 * 値の TTL キャッシュだけでは**同時発行**が止まらない — タブを開くと wage-report と
 * kosoku-daily 中継が同じ月をほぼ同時に取りに行き、両方 miss して 1.7MB 級の上流
 * フェッチが並ぶ (ohishi-exp/rust-ichibanboshi#154 で実測: 同じ月を 2〜3 回)。
 * 飛んでいる Promise を key ごとに共有し、後着は同じ結果を待つ。
 *
 * - `null`/`undefined` の解決値は memo しない (上流不調は次回再試行させる)
 * - load の失敗も memo しない。同時に待っていた呼び出しへは同じ失敗が伝わる —
 *   呼び出し側は従来どおり自分の catch で処理する
 * - 溢れたら古い順に落とす (月をまたいで無限に溜めない)
 */
export class UpstreamMemo {
  private readonly values = new Map<string, { at: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  /**
   * TTL 内の値 → そのまま返す / 同 key の取得が飛行中 → その Promise を待つ /
   * どちらも無ければ `load` を 1 回だけ実行する。`now` は呼び出し時刻 (ms) —
   * 外から渡すのは pure に単体テストするため。
   */
  async get<T>(key: string, now: number, load: () => Promise<T>): Promise<T> {
    const hit = this.values.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value as T;
    const flying = this.inflight.get(key);
    if (flying) return flying as Promise<T>;
    const p = (async () => {
      try {
        const value = await load();
        if (value != null) this.store(key, now, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  /**
   * key の memo 値を落とす (取り込み直後の無効化用、Refs #543 PR-3)。
   * in-flight は触らない — 飛行中の取得が完了すると再格納されうるが、それは
   * 高々 TTL ぶんの既容認の古さ (取り込み前に始まった取得が載るだけ)。
   */
  delete(key: string): void {
    this.values.delete(key);
  }

  private store(key: string, at: number, value: unknown): void {
    if (!this.values.has(key) && this.values.size >= this.maxEntries) {
      // ここに来る時点で values は必ず非空 — 最古の 1 件を落とす
      let oldestKey = "";
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.values) {
        if (v.at < oldestAt) {
          oldestKey = k;
          oldestAt = v.at;
        }
      }
      this.values.delete(oldestKey);
    }
    this.values.set(key, { at, value });
  }
}
