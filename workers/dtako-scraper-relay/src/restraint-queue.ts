/**
 * /restraint-api のうち theearthQueue (DO 内直列化) が要るルートの判定 (Refs #507)。
 *
 * theearthQueue の存在理由は「theearth (ASP.NET) の同一セッションへの並行リクエストは
 * hang/500 する」(Refs #237) — つまり直列化が要るのは **theearth の cookie を
 * read→HTTP→write するルートだけ**。D1/R2/ichiban (rust-ichibanboshi) しか触らない
 * ルートまで同じキューに入れると、タブを開いた時の同時 6〜8 リクエストが 1 本ずつ
 * 処理され、体感が「全リクエストの合計時間」になる (本番実測: D1 のみの
 * employee-master が CPU 0ms のまま p95 31 秒)。
 *
 * ここに載せる = キューに入れる。判定は pathname のみ (メソッド違いは 404 に
 * 落ちるだけで、キューに入っても実害がない)。
 */
const THEEARTH_QUEUED_RESTRAINT_PATHS: ReadonlySet<string> = new Set([
  // theearth へログインして cookie を書く
  "/restraint-api/login",
  // cookie を破棄する — 進行中の theearth 呼び出しと順序を保つ
  "/restraint-api/logout",
  // theearth の帳票ページを cookie 付きで読む (F-ERS2010)
  "/restraint-api/report",
  // theearth から CSV を cookie 付きでダウンロードする
  "/restraint-api/csv",
  // 上流は CakePHP (theearth ではない) が、R2 の版管理を書くので保守的に直列のまま
  "/restraint-api/kintai/fetch",
]);

/** このパスは theearthQueue で直列化するべきか。載っていないルート
 * (wage-report / kosoku-daily 中継 / D1 / R2 系) は並行実行してよい。 */
export function needsTheearthQueue(pathname: string): boolean {
  return THEEARTH_QUEUED_RESTRAINT_PATHS.has(pathname);
}
