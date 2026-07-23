/**
 * 乗務員氏名の仮名化 (issue #374 の合意事項)。
 *
 * MCP tool の応答は Claude (Anthropic API) に送られるため、`WageRow` /
 * `RestraintDriverSummary` 等が持つ `driverName` フィールドを再帰的に除去し、
 * `driverCd` だけを残す。金額はそのまま送ってよい (合意済み)。
 *
 * server.ts (mcp/server.ts) が全 tool の戻り値をこの関数でラップしてから返す
 * — 個々の tool 実装が氏名を漏らさない設計に依存しない defense-in-depth。
 */
export function redactDriverNames<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === "driverName") continue;
      out[key] = redact(v);
    }
    return out;
  }
  return value;
}
