/**
 * 最小の in-memory R2Bucket mock。`r2/read.ts` (get/list/delimiter) が使う
 * メソッドだけを実装する。cursor ページングは無し (テストでは 1 ページに収まる
 * 件数しか使わない — 複数ページの挙動は `listAllR2`/`listDelimitedPrefixes` 自体の
 * loop ロジックを別途ユニットテストで network-mock して確認する)。
 */
export interface MockR2Entry {
  value: string;
  customMetadata?: Record<string, string>;
}

export function createMockR2(initial: Record<string, MockR2Entry> = {}): R2Bucket {
  const data = new Map<string, MockR2Entry>(Object.entries(initial));

  const bucket = {
    get: async (key: string) => {
      const entry = data.get(key);
      if (!entry) return null;
      return {
        key,
        customMetadata: entry.customMetadata ?? {},
        text: async () => entry.value,
      } as unknown as R2ObjectBody;
    },
    put: async (key: string, value: string, opts?: { customMetadata?: Record<string, string> }) => {
      data.set(key, { value, customMetadata: opts?.customMetadata });
      return null as unknown as R2Object;
    },
    list: async (opts: R2ListOptions = {}) => {
      const prefix = opts.prefix ?? "";
      const delimiter = opts.delimiter;
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();

      if (!delimiter) {
        const objects = keys.map((key) => ({
          key,
          customMetadata: data.get(key)!.customMetadata ?? {},
        })) as unknown as R2Object[];
        return { objects, truncated: false, delimitedPrefixes: [] } as unknown as R2Objects;
      }

      const delimitedPrefixes = new Set<string>();
      const objects: R2Object[] = [];
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx === -1) {
          objects.push({ key, customMetadata: data.get(key)!.customMetadata ?? {} } as unknown as R2Object);
        } else {
          delimitedPrefixes.add(prefix + rest.slice(0, idx + delimiter.length));
        }
      }
      return {
        objects,
        truncated: false,
        delimitedPrefixes: [...delimitedPrefixes].sort(),
      } as unknown as R2Objects;
    },
  };

  return bucket as unknown as R2Bucket;
}
