/**
 * 乗務員マスタ同期 (`/cron/driver-master`) を **comp_id を複数まとめて 1 回の
 * 手動実行で回す**ための pure ロジック (Refs ippoan/alc-app-s3#125)。
 *
 * `index.ts` の `handleDriverMasterRun` が唯一の呼び出し元。DO / Request /
 * env に触れないので node vitest から素で回せる (`vitest.config.ts` の
 * coverage include に登録済み)。
 *
 * ## ★ なぜ逐次 (Promise.all にしない) か
 *
 * theearth は同一アカウントの並行アクセスでセッションが競合して hang / 500 する。
 * DO 側も `enqueueScrape` で直列化しているが、**待たされている間 DO の fetch が
 * 開いたままになる**ので、ここでも 1 社ずつ await して投げる。
 * cron 経路 (`cron.ts` の `DRIVER_MASTER_SYNC_CRON` 分岐) は全社を
 * `Promise.all` で並べているが、あちらは **comp_id ごとに別 DO instance** で
 * 1 日 5 回の定時実行、こちらは人が押した 1 回。**cron の並列ループは変えない。**
 *
 * ## ★ 1 社が失敗しても残りを回す
 *
 * 2 社目が theearth で落ちたからといって 3 社目を止める理由が無い。失敗した社だけ
 * `error` を持ち、**全社が失敗したときだけ**呼び出し元が 502 に落とす
 * (`driverMasterOverallStatus`)。「1 社だけ落ちた」を 200 で静かに流さないための
 * 材料として、`results[].error` を必ず応答に載せる。
 *
 * ## ★ なぜ `cron-batch.ts` の `runBatchSequential` を使わないか
 *
 * 同じ worker に「直列で回して 1 件の失敗で止めない」helper が既にあるが、
 * **ここでは噛み合わない** (push の重複警告に対する検討結果、再検討しないで済むよう
 * 残す):
 *
 * - あちらの失敗検出は **`runOne` が throw すること**。こちらの失敗の大半は
 *   **DO が非 2xx を返す** (throw しない) なので `ok: true` に化ける。
 * - `VenusSessionExpiredError` での打ち切りは theearth を直に触る DO 内部の都合。
 *   こちらは DO への `fetch` 越しなのでその例外は届かず、常に死に分岐になる。
 * - 返す形が `{ok, result?, error?}` の入れ子で、必要な `{comp_id, status, …}` の
 *   平坦形へ index で zip し直すことになる。**畳むより増える。**
 *
 * 共通なのは `for..of` + try/catch の 6 行だけで、削れる複製ではない。
 */
import {
  parseDriverMasterUpsertResult,
  type DriverMasterUpsertSkipped,
} from "./theearth-driver-master-client";

/** DO (`POST /cron/driver-master`) を 1 社ぶん叩く注入口。`index.ts` が
 * `env.RELAY` を閉じ込めて渡す。**status と本文だけ**を返す — Response を
 * そのまま渡すと呼び出し側で 1 度しか読めない。 */
export type DriverMasterDoCall = (compId: string) => Promise<{ status: number; text: string }>;

/** 失敗本文をエラー文字列に載せるときの上限。DO が返すのは小さな JSON なので、
 * これは「想定外に長い本文で応答が膨らむのを止める」ための上限であって、
 * 短く保つためのものではない (2026-09-02 に 200 で診断が切れた)。 */
export const ERROR_TEXT_MAX_CHARS = 1000;

/** 1 社ぶんの実行結果。`created` / `updated` / `skipped` は DO の応答
 * (`runDriverMasterSync` が返す `{created, updated, skipped}`) 由来で、
 * 読めなければ null / 空配列。 */
export interface DriverMasterCompResult {
  comp_id: string;
  /** DO の HTTP status。**DO を呼ぶ前 / 最中に例外になったら null**
   * (`cron.ts` の `NetprintDispatchResult` と同じ流儀)。 */
  status: number | null;
  created: number | null;
  updated: number | null;
  skipped: DriverMasterUpsertSkipped[];
  /** 失敗の理由。**成功した社にはこのキー自体が無い** — `error in result` で
   * 失敗を数えられる形にしておく。 */
  error?: string;
}

/** DO の応答から「失敗として名指しすべき理由」を取り出す。成功なら null。
 *
 * 2xx でも応答が読めなければ (`unreadable`) 失敗扱いにする — 書き込みが通ったか
 * 分からないものを「created 0 件」と同じ静かさで流さないため。 */
function driverMasterErrorText(
  status: number,
  text: string,
  unreadable: string | null,
): string | null {
  if (status < 200 || status >= 300) {
    // cron 分岐の `detail` と同じ形。DO が返した本文 (`{error: ...}`) がそのまま入る。
    // ★ 200 文字だと診断が切れる。実際 2026-09-02 に一覧の構造要約が
    // `引けない列=[乗務員CD,乗` で切れ、**原因を名指しするはずの見出しラベルが
    // 落ちた**。本文は DO が組んだ小さな JSON (ページ本文ではない) なので、
    // 切り詰めは「暴走を止める上限」であって「短く保つため」ではない。
    return `HTTP ${status}: ${text.slice(0, ERROR_TEXT_MAX_CHARS)}`;
  }
  return unreadable;
}

/** comp_id を **1 社ずつ順番に** DO へ投げ、1 社が失敗しても残りを回す。
 * 空配列を渡したら空配列 (呼び出し元が 404 で弾く前提)。 */
export async function runDriverMasterForComps(
  compIds: string[],
  callDo: DriverMasterDoCall,
): Promise<DriverMasterCompResult[]> {
  const results: DriverMasterCompResult[] = [];
  for (const compId of compIds) {
    let res: { status: number; text: string };
    try {
      res = await callDo(compId);
    } catch (err) {
      results.push({
        comp_id: compId,
        status: null,
        created: null,
        updated: null,
        skipped: [],
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const parsed = parseDriverMasterUpsertResult(res.text);
    const error = driverMasterErrorText(res.status, res.text, parsed.unreadable);
    const base: DriverMasterCompResult = {
      comp_id: compId,
      status: res.status,
      created: parsed.created,
      updated: parsed.updated,
      skipped: parsed.skipped,
    };
    results.push(error === null ? base : { ...base, error });
  }
  return results;
}

/** 全体の HTTP status。**全社が失敗したときだけ 502**、1 社でも通っていれば 200
 * (成否は `results[].error` で読む)。空配列は 200 — 呼び出し元が先に 404 で
 * 弾いているので実際には来ない。 */
export function driverMasterOverallStatus(results: DriverMasterCompResult[]): number {
  if (results.length > 0 && results.every((r) => r.error !== undefined)) return 502;
  return 200;
}
