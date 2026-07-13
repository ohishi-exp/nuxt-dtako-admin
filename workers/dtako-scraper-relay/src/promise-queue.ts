/**
 * Promise チェーンによる直列化キュー (pure、cloudflare 非依存)。DO はシングル
 * スレッド実行なので、先行タスクの完了を待つだけでロック無しに安全に直列化
 * できる。`DtakoScraperRelayDO` の theearthQueue (Refs #237) が使う — dvr-api /
 * daily-report-api の並列リクエストで、同一 DO 内の storage.get → theearth
 * への実 HTTP コール → storage.put がインターリーブし、cookie の lost update
 * でセッションが即座に無効化されるバグの修正。
 */
export class PromiseQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** job をキューの末尾に積み、先行 job が完了 (成功/失敗を問わず) してから実行する。
   * job 自身の失敗はこの呼び出し元に伝播するが、後続 job の実行は妨げない。
   * `tail` は release() 経由でのみ解決する内部同期用 Promise で reject しない
   * ため、素の `this.tail` を待てば十分 (catch でのガードは不要)。 */
  async enqueue<T>(job: () => Promise<T>): Promise<T> {
    const myTurn = this.tail;
    // `this.tail` への代入 (.then 登録) は下の `await myTurn` より前に行うため、
    // myTurn 解決時に release が resolve へ再代入されるコールバックの方が必ず
    // 先に走る — finally 到達時点で release は常に設定済み (?. は型上の保険)。
    let release: (() => void) | undefined;
    this.tail = myTurn.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await myTurn;
    try {
      return await job();
    } finally {
      release?.();
    }
  }
}
