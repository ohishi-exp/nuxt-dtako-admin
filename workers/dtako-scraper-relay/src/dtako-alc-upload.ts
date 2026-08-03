/**
 * 運行 1 件の csvdata.zip を theearth から取得し、rust-alc-api の
 * `POST /api/upload` (`alc-internal-upload.ts` の
 * `uploadDtakoZipViaAlcInternalProxy`) へそのままアップロードする (Refs #633-7)。
 *
 * ## なぜ要るか
 *
 * オンプレ (theearth) は最新なのに alc の R2 CSV が古いまま、という型のずれ
 * (乗務員の付け替え・イベント分類の編集後の再アップロード漏れ) を直す唯一の手段が
 * `run_dtako_scrape` (読取日ぶん全部を巻き込む、有人取り直しで数分〜数十分) しか
 * 無かった。① zip 取得 (`downloadOperationCsvZip`、`dtako-reimport.ts` と同じ
 * 自前ログイン経路) と ② alc 投入 (`uploadDtakoZipViaAlcInternalProxy`、
 * `runCronDtakoScrape` が読取日ぶん全部で使うのと同じ経路) は**両方すでにある**。
 * この module はその 2 つを「運行 1 件」で繋ぐだけで、新しいログイン経路・
 * 新しい secret は増やさない。
 *
 * ## なぜ運行 1 件の zip で足りるか (rust-alc-api 実コード確認、2026-08-03)
 *
 * `crates/alc-dtako/src/dtako_upload.rs` の `process_zip` は zip 内の
 * KUDGURI.csv の**行数ぶんだけ** `insert_operation` する — 日次 zip 前提の
 * 処理ではない。運行 1 件の zip (KUDGURI に 1 行だけ) をそのまま渡せば
 * その 1 件だけが upsert される。`run_dtako_scrape` が読取日ぶん全部を
 * 巻き込むのは theearth 側の取得単位が日次だからであって、alc 側の受け口
 * (`/api/upload`) の制約ではない。
 *
 * ## split (CSV 分割) はこの応答の時点で確定しない
 *
 * `alc-internal-upload.ts` の module doc 参照: `try_split_csv` はアップロード
 * 直後に non-blocking で起動され、`split_failed` はその時点のスナップショット
 * でしかない。**`split_failed: 0` を「分割済み」と読まない** — kintai-ops skill
 * の「1 回の測定で結論を出さない」と同じ罠。呼び出し元には常に
 * `split_confirmed: false` + 説明文を返し、確定させたいなら時間を置いて
 * `upload_id` で改めて確認するよう案内する。
 *
 * ## has_kudgivt は FALSE に戻る (取り込みの既知の副作用)
 *
 * `insert_operation` の列リストに `has_kudgivt` が無いため `DEFAULT FALSE` に
 * 戻る。読み取り側 (`/api/dtako/events`/`/etags`/Y 時間) は `has_kudgivt = TRUE`
 * で絞っているため、split が成功するまでこの運行は読み取り側から一時的に消える。
 * `run_dtako_scrape` が明記しているのと同じ注意を、この応答にも必ず載せる。
 *
 * ## preview は無い (書き込み口)
 *
 * 中身を先に確認したいだけなら、既存の読み取り専用の口
 * (`POST /cron/dtako/operation-zip` = `get_operation_zip`) を同じ
 * `ope_no`/`start_ope` で先に叩くこと。
 */

import { listZipEntryNames } from "./operation-zip";
import { parseAlcUploadResponse } from "./alc-internal-upload";

export class DtakoAlcUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DtakoAlcUploadError";
  }
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

/**
 * alc 投入直前の zip 健全性検証 (`dtako-reimport.ts` の `assertZipReadyForPush`
 * と同じ不変条件 — 壊れた zip を送らない)。**独立したエラー型で投げる**ことで、
 * alc への投入そのものが失敗した場合 (`DtakoAlcUploadError`、投入部の異常) と
 * 区別する — こちらは投入する前 (取得側) の異常。
 */
export function assertZipReadyForAlcUpload(buf: ArrayBuffer): void {
  const bytes = new Uint8Array(buf);
  const magicOk =
    bytes.length >= 4 &&
    bytes[0] === ZIP_MAGIC[0] &&
    bytes[1] === ZIP_MAGIC[1] &&
    bytes[2] === ZIP_MAGIC[2] &&
    bytes[3] === ZIP_MAGIC[3];
  if (!magicOk) {
    throw new DtakoAlcUploadError(
      `alc 投入直前の zip 健全性検証に失敗しました (PK\\x03\\x04 magic 不一致、${bytes.length} bytes) — 壊れた zip は送信しません`,
    );
  }
}

export interface DtakoAlcUploadDeps {
  /** ① zip 取得 (自前ログイン)。実装側 (DO) が opeNo/startOpe/comp_id を握って呼ぶ。
   * theearth 側の失敗 (`VenusSessionExpiredError`/`ReportParamError` 等) は
   * そのまま伝播させてよい — 呼び出し元 (DO ハンドラ) が種類ごとに分けて応答する。 */
  fetchZip(): Promise<ArrayBuffer>;
  /** ② alc への投入 (`uploadDtakoZipViaAlcInternalProxy` を実装側がラップする)。
   * 失敗はそのまま投げてよい — この関数が `DtakoAlcUploadError` に包み直す。 */
  uploadZip(filename: string, zipBytes: ArrayBuffer): Promise<string>;
}

export interface DtakoAlcUploadInput {
  opeNo: string;
  startOpe: string;
}

export interface DtakoAlcUploadReport {
  ope_no: string;
  start_ope: string;
  /** 取得した zip の生サイズ (bytes)。 */
  bytes: number;
  /** zip 内のファイル名一覧 (展開しない列挙)。 */
  entries: string[];
  upload_id: string | null;
  operations_count: number | null;
  /** アップロード直後のスナップショット値。**確定ではない** (`split_confirmed`
   * と `notes.split` を必ず読むこと)。 */
  split_failed: number | null;
  /** 常に `false`。split は非同期のため、この応答の時点では確定できない
   * (受け入れ条件3)。 */
  split_confirmed: false;
  notes: {
    has_kudgivt: string;
    split: string;
    preview: string;
  };
}

const HAS_KUDGIVT_NOTE =
  "この取り込みで対象運行の has_kudgivt は DEFAULT FALSE に戻ります。" +
  "読み取り側 (events/etags/Y時間) は has_kudgivt=TRUE で絞っているため、" +
  "split (CSV分割) が成功するまでこの運行は読み取り側から一時的に消えます。";

const PREVIEW_NOTE =
  "この口に preview はありません (書き込み専用)。中身を先に確認したいだけなら、" +
  "読み取り専用の POST /cron/dtako/operation-zip (get_operation_zip) を同じ " +
  "ope_no/start_ope で先に叩いてください。";

function splitNote(splitFailed: number | null): string {
  if (splitFailed === null) {
    return (
      "この応答の split_failed は alc の応答に含まれていないため不明です。" +
      "split の成否はこの場では確定できません。"
    );
  }
  return (
    "split (CSV分割) はアップロード直後に非同期で走るため、この応答の " +
    `split_failed=${splitFailed} は取り込み直後のスナップショットでしかなく確定では` +
    "ありません。確定させたい場合は少し時間を置いてから upload_id で改めて確認して" +
    "ください (split_failed=0 を『分割済み』と読まない)。"
  );
}

/**
 * ① zip 取得 → ② alc 投入まで 1 回で完結させる。**preview は無い**
 * (`notes.preview` 参照)。
 */
export async function runDtakoAlcUpload(
  deps: DtakoAlcUploadDeps,
  input: DtakoAlcUploadInput,
): Promise<DtakoAlcUploadReport> {
  const zip = await deps.fetchZip();
  assertZipReadyForAlcUpload(zip);
  const entries = listZipEntryNames(zip);

  let body: string;
  try {
    body = await deps.uploadZip("csvdata.zip", zip);
  } catch (err) {
    throw new DtakoAlcUploadError(
      `alc への投入に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const outcome = parseAlcUploadResponse(body);

  return {
    ope_no: input.opeNo,
    start_ope: input.startOpe,
    bytes: zip.byteLength,
    entries,
    upload_id: outcome.uploadId,
    operations_count: outcome.operationsCount,
    split_failed: outcome.splitFailed,
    split_confirmed: false,
    notes: {
      has_kudgivt: HAS_KUDGIVT_NOTE,
      split: splitNote(outcome.splitFailed),
      preview: PREVIEW_NOTE,
    },
  };
}
