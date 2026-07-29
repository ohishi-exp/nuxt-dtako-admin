/**
 * フェーズ別の壁時計計測 (Refs #543 PR-1)。
 *
 * wage-report / kintai/kosoku-daily の「どこが遅いか」を、キャッシュ導入 (PR-2 以降)
 * の前後で比較できるように残す。**計測は挙動を一切変えない**:
 *
 * - `measure` / `measureSync` は結果 (と例外) を素通しする — 計測の失敗が
 *   リクエストを落とすことはない (中身は算術と配列 push のみで throw しない)
 * - Workers 本番では CPU 実行中に `Date.now()` が進まない (timer freeze) ため、
 *   同期フェーズ (merge/rows 等) は 0ms 近くに出る。I/O (fetch / R2) の待ちは
 *   正しく壁時計で載る — 今回知りたいのはそちら
 *
 * 出力は 2 系統:
 * - `phaseTimingLogLine` — リクエスト末尾に 1 行だけ出す構造化ログ
 *   (`{phase_timing, route, month, phases, totalMs, cacheState}`)
 * - `serverTimingHeader` — ブラウザ Network パネルに出る `Server-Timing` ヘッダ
 *   (`daily-cur;dur=1234, build;dur=45, total;dur=2400` 形式)
 */

/** 1 フェーズの記録。bytes は上流応答サイズ (content-length or text 長)。 */
export interface PhaseEntry {
  name: string;
  ms: number;
  bytes?: number;
}

/** リクエスト 1 本ぶんのフェーズ計測。now は試験用に注入可能 (既定 Date.now)。 */
export class PhaseTimer {
  private readonly startedAt: number;
  private readonly phases: PhaseEntry[] = [];
  /** フェーズ確定前に届いた bytes (fetch 内部から先に報告される)。 */
  private readonly pendingBytes = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.startedAt = this.now();
  }

  /** 非同期フェーズを計測する。fn の結果・例外は素通し (例外時も所要は記録)。 */
  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    try {
      return await fn();
    } finally {
      this.push(name, this.now() - t0);
    }
  }

  /** 同期フェーズを計測する (Workers 本番では timer freeze で 0ms 近くに出る)。 */
  measureSync<T>(name: string, fn: () => T): T {
    const t0 = this.now();
    try {
      return fn();
    } finally {
      this.push(name, this.now() - t0);
    }
  }

  /** 既存コードを関数に包みにくい区間用: 開始してクローザを返す。 */
  begin(name: string): () => void {
    const t0 = this.now();
    return () => this.push(name, this.now() - t0);
  }

  /** 所要を伴わない出来事 (キャッシュ格納スキップ等) を 0ms フェーズとして残す。 */
  mark(name: string, bytes?: number): void {
    const entry: PhaseEntry = { name, ms: 0 };
    if (bytes !== undefined) entry.bytes = bytes;
    this.phases.push(entry);
  }

  /** フェーズの応答サイズを載せる。フェーズ未確定なら確定時に合流する。 */
  setBytes(name: string, bytes: number): void {
    const found = this.phases.find((p) => p.name === name);
    if (found) {
      found.bytes = bytes;
    } else {
      this.pendingBytes.set(name, bytes);
    }
  }

  private push(name: string, ms: number): void {
    const entry: PhaseEntry = { name, ms };
    const bytes = this.pendingBytes.get(name);
    if (bytes !== undefined) {
      entry.bytes = bytes;
      this.pendingBytes.delete(name);
    }
    this.phases.push(entry);
  }

  /** 記録済みフェーズと総所要 (生成時からの経過)。 */
  report(): { phases: PhaseEntry[]; totalMs: number } {
    return { phases: [...this.phases], totalMs: this.now() - this.startedAt };
  }

  /** `Server-Timing` ヘッダ値。metric 名はヘッダ token に許される文字へ落とす。 */
  serverTimingHeader(): string {
    const parts = this.phases.map(
      (p) => `${p.name.replace(/[^A-Za-z0-9_-]/g, "-")};dur=${p.ms}`,
    );
    parts.push(`total;dur=${this.now() - this.startedAt}`);
    return parts.join(", ");
  }
}

/** timer が無ければ素通し — 計測なし呼び出し (別経路) と共存させるため。 */
export function measurePhase<T>(
  timer: PhaseTimer | undefined,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return timer ? timer.measure(name, fn) : fn();
}

/**
 * リクエスト末尾に 1 行出す構造化ログ (JSON 文字列)。
 *
 * `cacheState` は PR-2 (キャッシュ導入) 用の予約フィールド — 現状は常に "live"。
 */
export function phaseTimingLogLine(
  route: string,
  month: string,
  timer: PhaseTimer,
  cacheState: string,
): string {
  const { phases, totalMs } = timer.report();
  return JSON.stringify({ phase_timing: route, month, phases, totalMs, cacheState });
}
