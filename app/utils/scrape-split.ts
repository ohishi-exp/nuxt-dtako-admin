/**
 * スクレイプ (取り込み) 後の CSV 分割まわりの pure ロジック
 * (Refs ohishi-exp/rust-ichibanboshi#205 の 40)。
 *
 * ## なぜスクレイプに分割の面倒を見させるのか
 *
 * alc (`ippoan/rust-alc-api`) の `dtako_operations.has_kudgivt` は「この運行の CSV が
 * R2 に split 済みか」を表す列で、**読み取り側 3 クエリが全部 `has_kudgivt = TRUE` で
 * 絞っている** (`crates/alc-dtako/src/repo/dtako_y_time_export.rs` の
 * `list_operations` / `list_drivers_with_operations` / `list_operations_for_drivers`)。
 * `GET /api/dtako/events/etags` (欠け検知) だけでなく `GET /api/dtako/events`
 * (データ本体) も同じ repo を通る。
 *
 * 一方 `process_zip` は運行行を `delete_operation` + `insert_operation` で作り直すが、
 * `insert_operation` の列リストに `has_kudgivt` が無いので **アップロードのたびに
 * `DEFAULT FALSE` に戻る**。TRUE に戻すのは直後に走る split の成功だけ。
 *
 * ⇒ **split が失敗すると、その運行は入力からも欠け検知の母集団からも同時に消える。**
 * 2026-07-31 に実際に発生し (乗務員 1652 の運行 `2607011001540000003510`)、alc の
 * 運行数が 1130 → 1129 に減ったまま、人が管理画面の「CSV分割」ボタンを押すまで
 * 気づけなかった。人手の運用では同じことが繰り返されるので自動でやり直す。
 *
 * ## 叩く口と、その選び分けの根拠 (alc のコードで確認済み)
 *
 * - **`POST /api/split-csv/{upload_id}`** — 自動リトライはこちら。
 *   - 冪等: 毎回 R2 から ZIP を取り直して同じ key に PUT 上書きし `has_kudgivt` を
 *     TRUE にするだけ (`dtako_upload.rs` の `split_csv_from_r2`)。2 回走らせて問題ない
 *   - 件数上限なし
 *   - **呼び手のテナントで絞られない** — tenant は upload レコード側から引く
 *     (`repo/dtako_upload.rs` の `get_upload_tenant_and_key` は `WHERE id = $1` のみ)。
 *     管理者のテナントとスクレイプ対象 comp のテナントが違っても効く
 *
 *     ⚠️ **この自動リトライは、その「絞られない」挙動に依存している。** dtako の
 *     2 社 (27324455 / 75700192) は別テナントで、`全企業` スクレイプはログイン中の
 *     管理者と無関係な comp も回すため、テナント絞りだと片方が直せない。
 *     **将来 alc がこの口を呼び手のテナントで絞るようにしたら、別テナントぶんの
 *     自動リトライは黙って効かなくなる** — その時はここも直すこと (relay DO 側から
 *     内部経路で呼ぶ等)。マルチテナント基盤としては「レコード側の tenant で処理する」
 *     方が横断アクセスの余地を残すので、絞る変更が入ること自体はあり得る
 *     (#205 監督から別途起票予定、2026-07-31)。
 * - **`POST /api/split-csv-all`** — 手動の掃除ボタン用。
 *   - **テナント絞り** (`list_uploads_needing_split(tenant_id)`) なので、別テナントの
 *     comp の取り残しは掃えない
 *   - **1 リクエスト最大 50 件** (`SPLIT_CSV_ALL_LIMIT`)。超過分は `done` の `skipped`
 *     に出るので、**黙って切らずに画面へ出す** (`formatSplitAllDone`)
 *
 * ## `split_failed === 0` を「分割済み」と読まないこと
 *
 * alc 側の `update_has_kudgivt` が当たらなかった unko_no は `tracing::warn!` される
 * だけで `Ok(0)` が返る (`dtako_upload.rs` の `has_kudgivt not applied` 分岐、R2 側は
 * trim しない生文字列 / DB 側は trim 済みというキーのズレ)。`split_failed` は
 * 必要条件であって十分条件ではない。
 */

/** リトライ判断に使う、result イベントの必要部分だけの形。 */
export interface SplitRetryInput {
  upload_id?: string
  split_failed?: number
}

/**
 * この result に対して CSV 分割をやり直すべきか。やり直すなら upload_id を返す。
 *
 * - `split_failed` が無い (旧 relay / 旧 alc) → **リトライしない**。不明を 0 とも
 *   失敗とも決めつけない (画面には `splitStateLabel` が「不明」として出す)
 * - `split_failed === 0` → リトライしない。取り込み時の split が既に走って成功して
 *   いるので、もう一度回しても ZIP の再ダウンロードと再 PUT を無駄にするだけ
 * - `upload_id` が無い → 狙い撃ちできないのでリトライしない (手動の一括分割が担当)
 */
export function splitRetryTarget(evt: SplitRetryInput): string | null {
  if (typeof evt.split_failed !== 'number' || evt.split_failed <= 0) return null
  return evt.upload_id || null
}

/** 取り込み結果の行に添える、CSV 分割の状態表示 (取り込みの成否とは別建て)。 */
export type SplitState = 'ok' | 'unknown' | 'failed' | 'retrying' | 'recovered' | 'unrecovered'

export interface SplitStatus {
  state: SplitState
  message: string
}

/**
 * result イベントから、リトライ前の初期表示を作る。**分割の話をする根拠が無いとき
 * は `null`** (行に何も出さない)。
 *
 * 根拠が無い = `upload_id` も `split_failed` も無い、つまり
 * - そもそも alc への取り込みが行われていない (`INTERNAL_SHARED_SECRET` 未設定で
 *   自動アップロードを skip した場合など)、または
 * - relay が古くて構造化フィールドを載せていない
 *
 * どちらも「分割が失敗した」とは限らないので、ここで警告を出すと毎行が黄色くなり
 * 本物の失敗が埋もれる。
 */
export function initialSplitStatus(evt: SplitRetryInput): SplitStatus | null {
  if (typeof evt.split_failed !== 'number') {
    if (!evt.upload_id) return null
    return { state: 'unknown', message: 'CSV分割: 状態不明 (alc が split_failed を返していません)' }
  }
  if (evt.split_failed <= 0) {
    return { state: 'ok', message: 'CSV分割: 失敗 0 件' }
  }
  const base = `CSV分割: ${evt.split_failed} 件失敗 (この運行は読み取り側から消えます)`
  return evt.upload_id
    ? { state: 'retrying', message: `${base} — 自動でやり直しています...` }
    : { state: 'failed', message: `${base} — upload_id 不明のため自動リトライ不可。「未分割をまとめて分割」を実行してください` }
}

/** 自動リトライの結果表示。`splitFailed` はリトライ応答の `split_failed`。 */
export function retriedSplitStatus(
  splitFailed: number | null,
  error?: string,
): SplitStatus {
  if (error) {
    return { state: 'unrecovered', message: `CSV分割のやり直しに失敗: ${error}` }
  }
  if (splitFailed !== null && splitFailed > 0) {
    return { state: 'unrecovered', message: `CSV分割をやり直しましたが ${splitFailed} 件失敗したままです` }
  }
  return { state: 'recovered', message: 'CSV分割: やり直して成功しました' }
}

/**
 * 分割の状態表示の色。**取り込み行 (緑) の中に赤や黄色で出す**ので、成功行に
 * 埋もれない (制約: 取り込み成功と分割失敗が別々に見えること)。
 */
export function splitLineClass(state: string): string {
  switch (state) {
    case 'ok':
      return 'text-gray-500 dark:text-gray-400'
    case 'recovered':
      return 'text-green-700 dark:text-green-400'
    case 'retrying':
      return 'text-blue-600 dark:text-blue-400'
    case 'unknown':
      return 'text-amber-600 dark:text-amber-400'
    default:
      // failed / unrecovered — 運行が消えている状態なので最も強く出す
      return 'font-bold text-red-600 dark:text-red-400'
  }
}

// --- 取り込み後の答え合わせ (未分割の実数、Refs #205-40 / rust-alc-api#587) ---
//
// `split_failed === 0` は「分割済み」の十分条件ではない (冒頭参照) ので、
// **本当に読み取り側に出るようになったか**は `GET /api/dtako/events/etags` の
// `unsplit_total` (= `has_kudgivt = FALSE` の実数) で確かめる。2026-07-31 に消えた
// 1 件に気づけたのはこの値であって `split_failed` ではなかった。

/** alc 側 `MAX_RANGE_DAYS_ETAGS`。これを超える期間は 400 になる。 */
export const ETAGS_MAX_RANGE_DAYS = 40

/** 答え合わせに使う日付範囲。上限を超える / 日付が無いときは `null` (問い合わせない)。 */
export function unsplitCheckRange(dates: string[]): { from: string, to: string } | null {
  const sorted = [...dates].filter(Boolean).sort()
  const from = sorted[0]
  const to = sorted[sorted.length - 1]
  if (!from || !to) return null
  const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  if (!Number.isFinite(spanDays) || spanDays > ETAGS_MAX_RANGE_DAYS) return null
  return { from, to }
}

/**
 * `unsplit_total` を 1 行の日本語にする。
 *
 * **テナントの但し書きを必ず付ける** — この口は呼び手 (ログイン中の管理者) の
 * テナントで絞られるので、`全企業` スクレイプでは**もう一方の会社の未分割は
 * この数に入らない**。「0 件だから全部大丈夫」と読まれると、まさに今回直そうと
 * している見落としが別の形で再発する。
 */
export function formatUnsplitTotal(
  range: { from: string, to: string },
  total: number,
): { level: 'info' | 'error', text: string } {
  const period = range.from === range.to ? range.from : `${range.from}〜${range.to}`
  if (total > 0) {
    return {
      level: 'error',
      text: `未分割の運行が ${total} 件残っています (${period}、ログイン中のテナントのみ)。「未分割をまとめて分割」を実行してください`,
    }
  }
  return {
    level: 'info',
    text: `未分割の運行なし (${period}、ログイン中のテナントのみ — 他テナントの会社はこの数に入りません)`,
  }
}

/** `POST /api/split-csv/{id}` 応答から `split_failed` を取り出す (無ければ null)。 */
export function parseSplitCsvResponse(res: unknown): number | null {
  const v = (res as { split_failed?: unknown } | null)?.split_failed
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** `split-csv-all` の SSE `done` イベント (alc の `split_csv_all_handler` が送る形)。 */
export interface SplitAllDoneEvent {
  event?: string
  candidates?: number
  total?: number
  success?: number
  failed?: number
  skipped?: number
  message?: string
}

/**
 * `done` イベントを 1 行の日本語にする。**`skipped` を必ず出す** — alc は候補を
 * `SPLIT_CSV_ALL_LIMIT`(50) 件で切るので、切られたことが画面から分からないと
 * 「全部やった」と誤読される (制約: 上限を黙って超えない)。
 */
export function formatSplitAllDone(evt: SplitAllDoneEvent): string {
  const candidates = evt.candidates ?? 0
  const success = evt.success ?? 0
  const failed = evt.failed ?? 0
  const skipped = evt.skipped ?? 0
  const head = `候補 ${candidates} 件 / 処理 ${evt.total ?? success + failed} 件 (成功 ${success} / 失敗 ${failed})`
  if (skipped > 0) {
    return `${head} — 残り ${skipped} 件は 1 回あたりの上限 (50 件) で未処理です。もう一度実行してください`
  }
  return head
}
