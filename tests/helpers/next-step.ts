/**
 * 一覧の取得失敗を出す `UAlert` の**不変条件**を 1 か所で言う (Refs #1008 PR-3)。
 *
 * > **どの経路でも「次に何をすればいいか」はちょうど 1 つ、かつ食い違わない。**
 *
 * ## なぜ 1 か所にまとめるのか
 *
 * この形の `UAlert` は **6 本**ある — `daily-hours` (乗務員 / 表)、
 * `operations` (乗務員 / 車両 / 表)、`restraint-report` (乗務員)。
 * 6 か所に条件を書き写すと**片方だけ直って片方が腐る**。
 *
 * ## ★ 「0 にしない」と「2 つにしない」は**別々に壊れた**
 *
 * | | 壊れ方 | いつ出たか |
 * | --- | --- | --- |
 * | **2 つ** | `title` が 403 で「ログインし直しても変わりません。管理者に依頼」と言うのに、`description` が「ページを再読み込みして確かめてください」と勧めていた | **dev で合成後を描画して初めて出た**。ヘルパを読んでいる限り出ない |
 * | **0** | その `description` を落としたら、**status を読めない経路**で次の一手が 1 つも無くなった | **4 経路を並べて初めて出た**。403 だけ見ていると出ない |
 *
 * **だから 4 経路 × 6 本を機械で回す。** 片方だけ測ると、もう片方に戻れてしまう。
 */
import { expect } from 'vitest'

/**
 * `describeListFailure` に入りうる例外の**全経路**と、そのとき `title` に入るべき次の一手。
 *
 * `RETRY` は 3 画面とも `RETRY_RELOAD = 'ページを再読み込みしてください'`
 * (押せるボタンが失敗した回に出ていないため。各 `.vue` の doc が正)。
 */
export const RETRY = 'ページを再読み込みしてください'

export const NEXT_STEP_CASES: { label: string, error: unknown, next: string }[] = [
  {
    label: '① status を読める (503) — 復旧待ち',
    error: new Error('API エラー (503): DB に繋がりません'),
    next: `復旧してから${RETRY}`,
  },
  {
    label: '② status を読める (403) — 管理者へ (retry を使わない枝)',
    error: new Error('API エラー (403): 権限がありません'),
    next: '管理者に許可の追加を依頼してください',
  },
  {
    label: '③ Error だが status を読めない — describeCaughtError は次の一手を付けない',
    error: new Error('Unexpected token \'<\' … is not valid JSON'),
    next: RETRY,
  },
  {
    label: '④ Error ですらない',
    error: { status: 503 },
    next: RETRY,
  },
]

/**
 * `title` と `description` の**合成後**に対して不変条件を測る。
 *
 * - **`title` に、その経路の次の一手が入っている** (0 にしない)
 * - **`title` の中の指示はちょうど 1 つ** — 「〜ください」の出現が 1 回だけ
 *   (`NEXT_STEP_CASES` の理由文には「ください」を入れていないので、2 回目が出たら
 *   それは**次の一手が 2 つ**という意味になる)
 * - **`description` は指示を 1 つも持たない** (2 つにしない / 食い違わせない)。
 *   **語を列挙して禁止するのではなく「命令形が 1 つも無い」で見る**ので、
 *   `nextStepForStatus` の文言を変えても空撃ちにならない。
 */
export function expectExactlyOneNextStep(title: unknown, description: unknown, next: string): void {
  const t = String(title)
  const d = String(description)
  expect(t, `title に次の一手が無い: ${t}`).toContain(next)
  expect([...t.matchAll(/ください/g)], `title の指示が 1 つではない: ${t}`).toHaveLength(1)
  expect(d, `description が指示を持っている (title と食い違いうる): ${d}`).not.toContain('ください')
}
