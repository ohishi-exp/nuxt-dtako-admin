/**
 * dtako スクレイプが「ZIP でない応答」「想定と違うページ」で落ちた時に、**原本を
 * R2 へ残す**ための pure ロジック (Refs #633-22)。
 *
 * ## なぜ要るか — 3 日後には何も残っていなかった
 *
 * 失敗の証拠 (`TheearthEvidence`) は `dtako-scraper-relay-do.ts` が `console.error`
 * に出すだけで、DO storage の進捗レコードには短い要約しか残らない。console は
 * Tail Worker (`workers/dtako-scraper-relay-tail/`) 経由で Workers Logs に載るが、
 * **Tail Worker は転写するだけで保存しない**。
 *
 * その結果、2026-08-01 に comp 75700192 の日次 cron が
 * `CSV フォームの要素 (id=rdoSelect1) が見つかりません` で落ちた件は、3 日後に
 * 調べた時点で **「theearth が実際に何を返したか」を確定できなかった**
 * (#633-22 の調査で「確定できなかったこと」として報告)。次に再現した時に
 * 答えを出せるようにするのがこのモジュール。
 *
 * ## 新しい規範は作らない
 *
 * 保存先の形は ETC 明細の既存規範に揃える — `etc-meisai-client.ts` の
 * `EtcMeisaiNotCsvError` を `dtako-scraper-relay-do.ts` が
 * `` `${prefix}-errors/${user_id}/${Date.now()}.bin` `` へ put しているのと同じ
 * 「**CSV/ZIP でない応答は loud fail して R2 `{prefix}-errors/` に原本保存**」
 * (`CLAUDE.md` の規範) をそのまま dtako スクレイプへ広げる。
 *
 * ## prefix を env から取る理由
 *
 * `DTAKO_R2` (`dtako-uploads`) は**本番と staging で同じ bucket** を見る
 * (`wrangler.toml`)。ETC が `ETC_R2_PREFIX` を env ごとに分けているのと同じ理由で、
 * ここも env ごとの prefix にする。混ざると「本番で落ちたのか staging で落ちたのか」
 * が原本から判別できなくなる。
 */

import {
  isEmptyZip,
  TheearthNotZipError,
  TheearthPageMismatchError,
  type TheearthEvidence,
} from "./theearth-client";

/** R2 へ put する 1 件分。`body` は `R2Bucket.put` にそのまま渡せる形。 */
export interface ScrapeErrorArtifact {
  key: string;
  body: ArrayBuffer | string;
  contentType: string;
}

export interface ScrapeErrorArtifactInput {
  /** env の prefix (`DTAKO_SCRAPE_R2_PREFIX`)。 */
  prefix: string;
  compId: string;
  /** `scrapeJobKey` と同じ値 (`YYYY-MM-DD` か `YYYY-MM-DD..YYYY-MM-DD`)。 */
  jobKey: string;
  /** `Date.now()` 相当。**引数で受ける** — pure に保ってテストから固定するため。 */
  nowMs: number;
}

/** `{prefix}-errors/{comp_id}/{jobKey}/{nowMs}.{ext}`。
 *
 * 日付 (jobKey) を階層に含めるのは、同じ読取日を何度も取り直した時に**同じ場所へ
 * 並ぶ**ようにするため (ETC は user_id 単位で時刻だけを並べているが、こちらは
 * 「どの読取日が繰り返し落ちているか」が調査の入口になる)。 */
export function scrapeErrorR2Key(input: ScrapeErrorArtifactInput, ext: string): string {
  return `${input.prefix}-errors/${input.compId}/${input.jobKey}/${input.nowMs}.${ext}`;
}

/** [`TheearthPageMismatchError`] を保存する時の JSON の形 (原本 + 事実だけ)。 */
export interface PageMismatchArtifactBody {
  kind: "page_mismatch";
  message: string;
  comp_id: string;
  job_key: string;
  evidence: TheearthEvidence;
  /** 生の本文先頭 (`TheearthPageMismatchError.bodyPrefix`)。 */
  body_prefix: string;
}

/**
 * 失敗した error から「R2 に残す価値のある原本」を組み立てる。**残す価値が無ければ
 * `null`** — 呼び出し側は null なら put しない。
 *
 * | error | 残すもの | 理由 |
 * |---|---|---|
 * | [`TheearthNotZipError`] (空 ZIP 以外) | 生バイトそのまま (`.bin`) | HTML のエラーページ等。中身を見ないと分からない |
 * | [`TheearthNotZipError`] (空 ZIP) | **`null`** | EOCD 22 bytes に情報が無い。文言側が既に原因を言い切っている |
 * | [`TheearthPageMismatchError`] | evidence + 本文先頭 (`.json`) | 「どのページが返ったか」を後から読むため |
 * | それ以外 (timeout / セッション切れ / 想定外) | `null` | 応答本体を持っていない。message で足りる |
 *
 * **空 ZIP を保存しないのは意図的**。未来日プローブ (`run_dtako_scrape` に未来の
 * 日付を渡して `has_kudgivt` に触れずに失敗経路だけを試す、診断上の正規手段) を
 * 打つたびに 22 bytes のゴミが溜まるのを避ける。**プローブを殺さずにノイズだけ
 * 落とす** (Refs #633-22 — 未来日の hard reject をしない判断と対)。
 */
export function buildScrapeErrorArtifact(
  err: unknown,
  input: ScrapeErrorArtifactInput,
): ScrapeErrorArtifact | null {
  if (err instanceof TheearthNotZipError) {
    if (isEmptyZip(err.responseBytes)) return null;
    return {
      key: scrapeErrorR2Key(input, "bin"),
      body: err.responseBytes,
      contentType: err.contentType || "application/octet-stream",
    };
  }
  if (err instanceof TheearthPageMismatchError) {
    const body: PageMismatchArtifactBody = {
      kind: "page_mismatch",
      message: err.message,
      comp_id: input.compId,
      job_key: input.jobKey,
      evidence: err.evidence,
      body_prefix: err.bodyPrefix,
    };
    return {
      key: scrapeErrorR2Key(input, "json"),
      body: JSON.stringify(body, null, 2),
      contentType: "application/json; charset=utf-8",
    };
  }
  return null;
}
