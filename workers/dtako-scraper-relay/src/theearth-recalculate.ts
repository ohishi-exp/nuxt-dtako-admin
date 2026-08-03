/**
 * zip 取得直前に走らせる「作業時間再集計」(theearth F-DES1013 の `btnScore`
 * postback、`theearth-report-client.ts` の `recalculateWork`) の結果を outcome
 * 形に畳む共通ヘルパ (Refs #633-19)。
 *
 * ## なぜ要るか
 *
 * オンプレ/GCP 双方へどれだけ取り直しても、**上流 (theearth) の解析結果が古い
 * ままなら同じ古い値が入るだけ**だった (2026-08-04 実測、運行 1 件で再集計前後の
 * csvdata.zip の bytes が変化し、差が 5 件→3 件に減った)。「取り直す」の前に
 * 必ず再集計を挟む。
 *
 * ## 方針 (issue #633-19 の「★ 親の設計判断」節)
 *
 * - 再集計が失敗しても後続の zip 取得は続行する — 古いデータのまま取れる方が、
 *   何も取れないよりましなため。ただし黙って隠さず outcome に残す
 * - `VenusSessionExpiredError` だけは伝播させる — セッションが切れているなら
 *   直後の zip 取得も同じ理由で失敗するはずで、続行しても意味が無い
 * - 成功時も `{ ok: true }` を返す — 「再集計が走ったかどうか」を呼び出し側が
 *   追えるようにする (黙って成功させない)
 */
import { VenusSessionExpiredError } from "./theearth-client";

export type RecalculateOutcome = { ok: true } | { ok: false; error: string };

export async function recalculateBeforeFetch(
  recalculateWork: () => Promise<unknown>,
): Promise<RecalculateOutcome> {
  try {
    await recalculateWork();
    return { ok: true };
  } catch (err) {
    if (err instanceof VenusSessionExpiredError) throw err;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
