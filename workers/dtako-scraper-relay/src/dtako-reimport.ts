/**
 * 運行 1 件の csvdata.zip を取得 → オンプレの取り込み口へ push (Refs
 * ohishi-exp/rust-ichibanboshi#280, #205 の 67)。
 *
 * ## 目的 — base64 をモデルが書き写さない
 *
 * 以前は `get_operation_zip` (`operation-zip.ts`) が返す `zip_base64` を**モデルが
 * 書き写して**オンプレへ POST していた。書き写した時点で壊れる事故が 2 回起きて
 * いる (`base64: invalid input`)。しかも壊れた zip を投げても社内 nginx (CakePHP)
 * は黙って無視するため、原因が分からなかった。
 *
 * この module は ① zip 取得 (自前ログイン、`operation-zip.ts` の `get_operation_zip`
 * と同じ経路) と ② オンプレ push (`rust-ichibanboshi` の `POST /api/dtako/autoload`
 * — Refs #205 の 58/61/63/65、**変更しない**) を relay 内で完結させる。
 * **zip のバイト列は relay の外 (呼び出し元 kyuyo-mcp や、その先のモデル) へ出ない。**
 *
 * ## http_status は成否の証明にならない
 *
 * `rust-ichibanboshi` 側 (`src/routes/dtako_autoload.rs`) の module doc 参照:
 * `POST /dtako-events/autoload` は `api` フラグが無いと 307 で `/` へ redirect
 * するが、取り込み自体は redirect 判定より**前**に実行済み。`reset_timecard`
 * (③、勤務時間再登録) の応答も空 200 が成功の証明にならない — 成否は PHP の
 * Flash (session) にしか出ない。この module はオンプレの応答
 * (`http_status`/`location`/`reset_*` 等) をそのまま呼び出し元へ転送するだけで、
 * 成否判定はしない — 判定は呼び出し側 (人 / モデル) に委ねる。
 *
 * ## 経路と資格情報 (relay → オンプレ)
 *
 * kyuyo-mcp の `fetchIchibanJson` や relay 自身の他の経路 (`/api/kintai/pdf-json`
 * 等) と同じ `NUXT_ICHIBAN_API_URL` + CF Access Service Token
 * (`CF-Access-Client-Id`/`CF-Access-Client-Secret`) をそのまま使う。新しい
 * credential も allowlist 登録も要らない (Refs #280 の条件1、親へ報告済み)。
 */

import { listZipEntryNames } from "./operation-zip";
import { recalculateBeforeFetch, type RecalculateOutcome } from "./theearth-recalculate";

/** `unko_no` はオンプレ側の桁 (kintai-ops skill §4.6: GCP/theearth 側は22桁だが
 * 社内 nginx の URL キー・取り込みの対象指定は 23 桁)。**23 桁以外は拒否** —
 * 一括取り込み (月まるごと等) の事故を防ぐ歯止め (受け入れ条件9)。
 *
 * ③ (`reset_timecard: true`、`resetby-unko-no/{unko_no}` の対象) はこの regex を
 * そのまま使う — 23桁目 (対象CD) が「2マンの何人目か」を区別する実物の値が要る。
 * ①②のみ (`reset_timecard: false`、既定) は `UNKO_NO_22_RE` も許す — 取り込み
 * 対象は zip (`opeNo`+`startOpe`) が決めるので `unko_no` は「1件に紐付ける歯止めと
 * 監査ラベル」でしかなく、GCP (alc) 由来の 22 桁 (対象CD 抜き) しか無い運行
 * (取り込み漏れ候補) も通す必要がある (Refs #625)。**桁数のどちらでも「1件だけを
 * 名指す」という歯止めの目的は変わらない** — 緩めるのは「23桁ちょうど」→
 * 「22桁または23桁」だけで、「12桁以上なら何でも」にはしない。 */
export const UNKO_NO_RE = /^\d{23}$/;
export const UNKO_NO_22_RE = /^\d{22}$/;

/** `unko_no` の桁数ガード本体。`resetTimecard` で必要な桁数が変わる (上のコメント参照)。 */
export function isUnkoNoAcceptable(unkoNo: string, resetTimecard: boolean): boolean {
  if (resetTimecard) return UNKO_NO_RE.test(unkoNo);
  return UNKO_NO_RE.test(unkoNo) || UNKO_NO_22_RE.test(unkoNo);
}

export class DtakoReimportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DtakoReimportError";
  }
}

/**
 * push (② オンプレ autoload への POST) を送った後、応答を確定できずに失敗した
 * ことを示す (受け入れ条件・親指摘 2026-08-01)。**取り込みは応答より前に走る**
 * (`dtako_autoload.rs` 実測: 307 でも取り込み済み) ため、`deps.onpremAutoload` が
 * 例外を投げた場合 — DO の deploy 中断・network 断等で応答を読めなかった場合 —
 * **push 自体は届いていて取り込みが実行された可能性がある。** この例外は通常の
 * `DtakoReimportError` (= まだ push していない/対象が悪い、再実行して安全) と
 * 区別し、呼び出し元が「盲目的に再実行して二重取り込みにする」ことを防ぐ。
 */
export class DtakoReimportPushUncertainError extends DtakoReimportError {
  constructor(message: string) {
    super(message);
    this.name = "DtakoReimportPushUncertainError";
  }
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

/**
 * zip が push できる状態か (`PK\x03\x04` + 空でない) を **push の直前に**確認する
 * (受け入れ条件3)。`downloadOperationCsvZip` は取得時点で既に空 ZIP / 非 ZIP を
 * 弾いているが、「壊れたまま渡さない」を push 呼び出しの直前でも明示できるように
 * 独立したガードとして持つ — zip の取得経路が将来変わっても、この関数の呼び出しが
 * 残っていれば健全性検証は落ちない。
 */
export function assertZipReadyForPush(buf: ArrayBuffer): void {
  const bytes = new Uint8Array(buf);
  const magicOk =
    bytes.length >= 4 &&
    bytes[0] === ZIP_MAGIC[0] &&
    bytes[1] === ZIP_MAGIC[1] &&
    bytes[2] === ZIP_MAGIC[2] &&
    bytes[3] === ZIP_MAGIC[3];
  if (!magicOk) {
    throw new DtakoReimportError(
      `push 直前の zip 健全性検証に失敗しました (PK\\x03\\x04 magic 不一致、${bytes.length} bytes) — 壊れた zip は送信しません`,
    );
  }
}

/**
 * `POST /api/dtako/autoload` の相対 path + query を組む。**host は含めない**
 * (`rust-ichibanboshi` 側の内部アドレス方針と同じ — 呼び出し側の
 * `deps.onpremAutoload` が `NUXT_ICHIBAN_API_URL` を持つ)。
 */
export function buildAutoloadPath(unkoNo: string, resetTimecard: boolean): string {
  const q = new URLSearchParams({ unko_no: unkoNo, reset_timecard: resetTimecard ? "true" : "false" });
  return `/api/dtako/autoload?${q.toString()}`;
}

export interface DtakoReimportDeps {
  /** ① zip 取得の直前に走らせる「作業時間再集計」(theearth F-DES1013、Refs
   * #633-19)。**無条件で呼ぶ** (フラグは作らない — 「取り直す」= 最新にする、
   * が目的のため)。失敗は `recalculateBeforeFetch` が outcome に畳んで後続の
   * `fetchZip` を続行させる。`VenusSessionExpiredError` だけは伝播する。 */
  recalculateWork(): Promise<void>;
  /** ① zip 取得 (自前ログイン)。実装側 (DO) が opeNo/startOpe/comp_id を握って呼ぶ。 */
  fetchZip(): Promise<ArrayBuffer>;
  /** ② オンプレ autoload への POST。CF Access ヘッダは実装側で付ける。 */
  onpremAutoload(path: string, init: RequestInit): Promise<Response>;
}

export interface DtakoReimportInput {
  opeNo: string;
  startOpe: string;
  unkoNo: string;
  /** ③ (勤務時間再登録) まで続けるか。**既定 false** (受け入れ条件6) — 破壊的操作
   * (`time_card_dtako` への書き戻し) を既定で増やさない。 */
  resetTimecard?: boolean;
}

/** `dtako_autoload.rs` の応答を素通しする形。フィールドは呼び出し元 (kyuyo-mcp)
 * が固定の型を要求しないよう `Record<string, unknown>` のまま保つ — オンプレ側の
 * 応答フィールドが増えても、この module を直す必要が無い。 */
export interface DtakoReimportReport {
  ope_no: string;
  start_ope: string;
  unko_no: string;
  /** zip 取得直前に走らせた「作業時間再集計」の結果。成功時も含める — 再集計が
   * 走ったかどうかを呼び出し側が追えるようにする (受け入れ条件、Refs #633-19)。 */
  recalculate: RecalculateOutcome;
  /** 取得した zip の生サイズ (bytes)。 */
  bytes: number;
  /** zip 内のファイル名一覧 (展開しない列挙、`operation-zip.ts` と同じ parser)。
   * 受け入れ条件4。 */
  entries: string[];
  /** relay から見た push の応答コード (オンプレ rust の応答そのもの)。
   * **これ単体で成否を判断しないこと** — `autoload.http_status`/`reset_http_status`
   * と合わせて `response_excerpt`/`reset_note` を読むこと (受け入れ条件5)。 */
  http_status: number;
  /** オンプレ (`rust-ichibanboshi`) の JSON 応答をそのまま転送する
   * (`http_status`/`http_ok`/`location`/`response_excerpt`/`reset_*` 等)。
   * JSON でない応答が返った場合は `{parse_error: true, raw_excerpt}` に畳む
   * (黙って握り潰さない)。 */
  autoload: Record<string, unknown>;
}

/**
 * ① zip 取得 → ② オンプレ push を 1 回で完結させる。**preview は無い** — 内容を
 * 確認したいだけなら `get_operation_zip` を先に呼ぶこと。
 */
export async function runDtakoReimport(
  deps: DtakoReimportDeps,
  input: DtakoReimportInput,
): Promise<DtakoReimportReport> {
  const resetTimecard = input.resetTimecard === true;
  if (!isUnkoNoAcceptable(input.unkoNo, resetTimecard)) {
    throw new DtakoReimportError(
      resetTimecard
        ? `勤務時間再登録 (reset_timecard=true) は unko_no が23桁の数値である必要があります: "${input.unkoNo}"`
        : `unko_no は22桁または23桁の数値で指定してください: "${input.unkoNo}"`,
    );
  }
  const recalculate = await recalculateBeforeFetch(deps.recalculateWork);
  const zip = await deps.fetchZip();
  assertZipReadyForPush(zip);
  const entries = listZipEntryNames(zip);
  const path = buildAutoloadPath(input.unkoNo, resetTimecard);
  // push (fetch + 応答本文の読み出し) をひとまとめに try する — **どちらで失敗しても
  // 「サーバへは届いたかもしれない」という点で扱いは同じ**。fetch 自体が例外を投げる
  // (DO の deploy 中断・network 断) のはヘッダすら受け取れていないので厳密には
  // 「届いたか分からない」だが、CakePHP 側の取り込みは応答より前に走るため
  // (module doc 参照)、安全側に倒して両方とも「取り込み済みの可能性あり」として扱う。
  let res: Response;
  let bodyText: string;
  try {
    res = await deps.onpremAutoload(path, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: zip,
    });
    bodyText = await res.text();
  } catch (err) {
    throw new DtakoReimportPushUncertainError(
      `unko_no=${input.unkoNo} へのオンプレ push 中に応答を確定できませんでした — ` +
        "取り込みは応答より前に走るため、既に取り込み済みの可能性があります。" +
        "再実行の前に dtako_events (この unko_no) を確認してください: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  let autoload: Record<string, unknown>;
  try {
    autoload = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    // オンプレ (or その手前の nginx) が JSON 以外 (502 の HTML 等) を返すことも
    // ある — 黙って握り潰さず、抜粋を返す (kintai-relay.ts の readJson と同じ方針)。
    autoload = { parse_error: true, raw_excerpt: bodyText.slice(0, 300) };
  }
  return {
    ope_no: input.opeNo,
    start_ope: input.startOpe,
    unko_no: input.unkoNo,
    recalculate,
    bytes: zip.byteLength,
    entries,
    http_status: res.status,
    autoload,
  };
}
