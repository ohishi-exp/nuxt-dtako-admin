/**
 * auth-worker の **RPC entrypoint** (`InternalEntrypoint.forwardAlcTenantData`) 越しに
 * alc の tenant (data) 経路を叩くための型と、応答の畳み方 (Refs #950 /
 * ippoan/auth-worker#483)。
 *
 * ## なぜ RPC なのか — bearer を提示する相手ではなかった
 *
 * relay → auth-worker は **元から service binding** (`wrangler.toml` の
 * `[[services]] AUTH_WORKER`)。旧実装は device credential を KV から読み、
 * `POST /device/token` で短命 JWT を mint し、`/device-data-proxy` に
 * `Authorization: Bearer` を付けて送っていたが、**その往復はすべて binding の内側**で
 * 起きていた。**直接呼べる相手に bearer を提示していた**ことになる。
 *
 * **Workers RPC の名前付きメソッドは binding からしか呼べず、HTTP の面に出ない。**
 * ⇒ **device credential も pairing も KV 投入も要らない。** tenant は relay が
 * 既に持っている (`DTAKO_ACCOUNTS` の `tenant_id`) ものをそのまま渡す。
 *
 * ## 名指しをやめない
 *
 * 旧 `dtako-device-creds.ts` は「**黙って動かない**」を避けるために、credential が
 * 無い状態を名指しして loud fail していた。RPC 化で「credential が無い」は
 * 成立しなくなるが、**性質は残す** — [`unwrapAlcTenantData`] が失敗を
 * **status と本文抜粋つきで名指し**して throw する。**黙って 0 件にしない。**
 */

/** `forwardAlcTenantData` の戻り (auth-worker#483 で固定)。 */
export interface AlcTenantDataResult {
  status: number;
  body: string;
  contentType: string | null;
}

/** `forwardAlcTenantData` の引数 (auth-worker#483 で固定)。 */
export interface AlcTenantDataInput {
  tenantId: string;
  path: string;
  method: string;
  /** `?limit=20` のような query (先頭の `?` を含む)。 */
  search?: string;
  body?: string;
  contentType?: string;
}

/**
 * `AUTH_WORKER_RPC` binding の面。**テストではそのまま差し替えられる**ように、
 * binding 型ではなくこの最小 interface に依存する。
 */
export interface AlcTenantDataForwarder {
  forwardAlcTenantData(input: AlcTenantDataInput): Promise<AlcTenantDataResult>;
}

/** RPC 越しの失敗。**何が起きたかを文面に含める** (呼び手が loud に鳴らせるように)。 */
export class AlcTenantRpcError extends Error {}

/**
 * binding が張られていないときの文言。**「黙って動かない」を避ける**ためだけに居る
 * (`entrypoint` を宣言し忘れた named environment で、静かに 0 件にならないように)。
 */
export const ALC_TENANT_RPC_MISSING =
  "AUTH_WORKER_RPC binding がありません " +
  "(wrangler.toml の top-level / env.staging / env.preview に " +
  'entrypoint = "InternalEntrypoint" の [[services]] が要ります)';

/**
 * 2xx なら本文を返し、それ以外は **status と本文抜粋つきで throw** する。
 *
 * `label` は「何をしようとして落ちたか」(例: `alc scraper history`)。
 * **黙って空を返さない** — 呼び手が「0 件だった」と「引けなかった」を取り違えないため。
 */
export function unwrapAlcTenantData(label: string, res: AlcTenantDataResult): string {
  if (res.status < 200 || res.status >= 300) {
    throw new AlcTenantRpcError(`${label} failed (${res.status}): ${res.body.slice(0, 300)}`);
  }
  return res.body;
}

/**
 * binding を検証して返す。未設定なら [`ALC_TENANT_RPC_MISSING`] を throw する。
 * **`undefined` を黙って通さない**ための関門。
 */
export function requireAlcTenantForwarder(
  binding: AlcTenantDataForwarder | undefined | null,
): AlcTenantDataForwarder {
  if (!binding) throw new AlcTenantRpcError(ALC_TENANT_RPC_MISSING);
  return binding;
}
