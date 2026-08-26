/**
 * relay が `device-data-proxy` を叩くための **device credential** の読み出し
 * (Refs #931 / #933、案 B)。
 *
 * ## なぜ `DTAKO_ACCOUNTS` に相乗りしないのか
 *
 * `DTAKO_ACCOUNTS` (KV `dtako_accounts`) は **投入が 1 回だけで、CI もデプロイも
 * 書き換えない**のが規範 (`CLAUDE.md`)。ここに欄を足すと**再投入**が要る。
 * ⇒ **同じ KV の別 key** (`dtako_device_creds`) に分けて、`DTAKO_ACCOUNTS` を
 * 無傷のまま置く。binding は既存の `DTAKO_CONFIG_KV` を使い回すので
 * **`wrangler.toml` も named environment の再宣言も要らない**。
 *
 * ## 中身
 *
 * `[{ "tenant_id": "...", "device_id": "...", "device_secret": "..." }, ...]`
 *
 * **tenant ごとに 1 件。** device JWT は 1 tenant に束縛される (pairing 時に確定)
 * ので、dtako の 2 社ぶんで 2 件になる。値は `POST /device/pair` の応答で、
 * **`device_secret` は 1 回しか返らない**ため人が投入する
 * (ここでは読むだけ・作らない)。
 *
 * ## 未設定は「落とす」ではなく「無い」を返す
 *
 * 履歴は**診断のための読み書き**なので、credential が無いことで取り込み本体を
 * 止めない。`null` を返して呼び出し側に loud に鳴らさせる
 * (`scrape-history-record.ts` の `recordScrapeHistoryLoud` と同じ方針)。
 * **ただし JSON が壊れている場合は throw する** — 「設定したのに効いていない」を
 * 「設定していない」と同じ静かさで扱わないため。
 */

import type { DtakoDeviceCredential } from "./device-proxy";

/** KV `dtako_device_creds` に置く 1 件。 */
export interface DtakoDeviceCredentialEntry {
  tenant_id: string;
  device_id: string;
  device_secret: string;
}

export class DtakoDeviceCredsError extends Error {}

/**
 * KV の生文字列をパースする。**未設定は空配列** (= 履歴を扱わない)、
 * **JSON 不正は throw** (= 設定ミスを黙らせない)。
 */
export function parseDtakoDeviceCreds(raw: string | null | undefined): DtakoDeviceCredentialEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DtakoDeviceCredsError("dtako_device_creds が JSON としてパースできません");
  }
  if (!Array.isArray(parsed)) {
    throw new DtakoDeviceCredsError("dtako_device_creds は JSON 配列である必要があります");
  }
  return parsed as DtakoDeviceCredentialEntry[];
}

/**
 * tenant に対応する credential を引く。**欠けている / 空欄がある行は無い扱い** —
 * 中途半端な値で mint しに行って 401 を並べるより、「無い」と言う方が読める。
 */
export function credentialForTenant(
  entries: DtakoDeviceCredentialEntry[],
  tenantId: string,
): DtakoDeviceCredential | null {
  if (!tenantId) return null;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    if (e.tenant_id !== tenantId) continue;
    const deviceId = typeof e.device_id === "string" ? e.device_id : "";
    const deviceSecret = typeof e.device_secret === "string" ? e.device_secret : "";
    if (!deviceId || !deviceSecret) return null;
    return { deviceId, deviceSecret };
  }
  return null;
}
