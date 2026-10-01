/**
 * R2 の in-memory 実装 (訴訟準備の出力の版のテスト用、Refs #1133 c1133-32)。
 * DO が使う面だけ: `put` / `get` (`body`・`text()`) / `head` / `list` / `delete` (**キーの配列も受ける**
 * — 30 日の掃除は 1 版ぶんのキーをまとめて消す)。
 */
type StoredObject = { bytes: Uint8Array; customMetadata?: Record<string, string> };

export class FakeR2 {
  readonly store = new Map<string, StoredObject>();
  /** 真を返したら `delete` を失敗させる (R2 の削除失敗の確認用)。 */
  failDelete: ((keys: string[]) => boolean) | null = null;
  /** `delete` の呼び出し (1 回 = 1 要素) */
  readonly deleteCalls: string[][] = [];

  async put(key: string, body: ArrayBuffer | Uint8Array | string, opts?: { customMetadata?: Record<string, string> }) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
    this.store.set(key, { bytes: new Uint8Array(bytes), ...(opts?.customMetadata ? { customMetadata: { ...opts.customMetadata } } : {}) });
  }

  async get(key: string) {
    const obj = this.store.get(key);
    if (!obj) return null;
    return {
      body: obj.bytes,
      size: obj.bytes.byteLength,
      customMetadata: obj.customMetadata,
      text: async () => new TextDecoder().decode(obj.bytes),
    };
  }

  async head(key: string) {
    const obj = this.store.get(key);
    return obj ? { customMetadata: obj.customMetadata } : null;
  }

  async delete(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    this.deleteCalls.push(list);
    if (this.failDelete?.(list)) throw new Error("R2_ERROR: injected failure");
    for (const key of list) this.store.delete(key);
  }

  async list({ prefix }: { prefix: string }) {
    return {
      objects: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      truncated: false as const,
    };
  }

  keys(): string[] {
    return [...this.store.keys()].sort();
  }
}
