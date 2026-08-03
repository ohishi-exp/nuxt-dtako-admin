/**
 * 取り込み漏れ候補 (`kintai-unko-gaps.ts` の `drivers[].{driverCd, unkoNos}`) と
 * オンプレ vs Supabase の値差 (`kintai-diff-view.ts` の
 * `KintaiDiffValueDiffItem[]`) を、**乗務員CD + 運行日**で突き合わせる pure ロジック
 * (Refs #633-1)。
 *
 * ★ 新しい計算・新しい口は作らない。候補と差分は既に同じ画面 (`/restraint-wage` の
 * 「オンプレ vs Supabase」タブ) が両方持っている — ここでは受け取った2つの配列を
 * 乗務員CD+日付で引き当てるだけ。運行日は運行NOの**先頭6桁 (`YYMMDD`)** から作る。
 *
 * ★ 候補を一律に「取り込むべき」として出すのは誤り (issue #633 本文、2026-06 実測で
 * 2件の結論が逆だった)。1件ずつ、その日の値が実際に違うかを見せるためのモジュール。
 *
 * ★ 差分の items は**ライブ取得 (「取り直す」を押した直後) にしか存在しない**
 * (保存分のキャッシュは items を持たない、`kintai-diff-view.ts` の docs 参照)。
 * この月でまだライブ取得していない/読めなかった状態を「差はありません」と混同しない
 * よう、`KintaiDiffCacheState` (`kintai-diff-view.ts`) と同じ形の3状態
 * (`none`/`unreadable`/`ok`) で受け取る — 呼び出し側 (画面) がこの3状態を作る。
 */

export interface KintaiCandidateDiffItem {
  driverCd: string
  date: string
  diffFields: string[]
  gcp: Record<string, number>
  onprem: Record<string, number>
}

export interface KintaiCandidateDiffItems {
  match: KintaiCandidateDiffItem[]
  mismatch: KintaiCandidateDiffItem[]
}

/** ライブ取得の3状態。`kintai-diff-view.ts` の `KintaiDiffCacheState` と同じ形に
 * 揃える (「未確認」「読めなかった」「確認済み」を混同しないための共通作法)。 */
export type KintaiCandidateDiffItemsState =
  | { status: 'none' }
  | { status: 'unreadable' }
  | { status: 'ok', items: KintaiCandidateDiffItems, lastVerifiedAt: string | null }

export type KintaiCandidateDiffResult =
  /** この月の値差をまだライブ取得していない、または読めなかった。
   * 「両側一致」と混同しないこと — 判定材料がまだ無いだけ。 */
  | { kind: 'unconfirmed', date: string | null }
  /** 値差の一覧 (取得済み) に見当たらなかった。**「取り込む必要が無い」と断定しない** —
   * 日別サマリに出ない形の欠けもあり得るため、事実 (一致) だけを表す。 */
  | { kind: 'no_diff', date: string, lastVerifiedAt: string | null }
  /** 値が違うが拘束時間 (`restraint_minutes`) は一致 (内訳だけ違う)。 */
  | { kind: 'match', date: string, lastVerifiedAt: string | null, item: KintaiCandidateDiffItem }
  /** 拘束時間も不一致。 */
  | { kind: 'mismatch', date: string, lastVerifiedAt: string | null, item: KintaiCandidateDiffItem }

const UNKO_NO_22_RE = /^\d{22}$/
const UNKO_NO_23_RE = /^\d{23}$/

/** 運行NOの先頭6桁 (`YYMMDD`) から運行日 (`YYYY-MM-DD`) を作る。
 * 22桁・23桁のどちらでもない入力は `null` (`kintai-unko-gaps.ts` の
 * `kintaiUnkoGapsDeriveStartOpe` と同じ桁数の前提)。 */
export function kintaiCandidateDiffDateFromUnkoNo(unkoNo: string): string | null {
  if (!UNKO_NO_22_RE.test(unkoNo) && !UNKO_NO_23_RE.test(unkoNo)) return null
  const yy = Number(unkoNo.slice(0, 2))
  const mm = unkoNo.slice(2, 4)
  const dd = unkoNo.slice(4, 6)
  return `${2000 + yy}-${mm}-${dd}`
}

/** 乗務員CD の突合キー。マスタ側 (`employee-master.ts` の `normalizeDriverCdKey`) と
 * 同じ規則 (前ゼロ除去) だが、口が違う (unko-gaps は alc 由来、diff item はオンプレ/GCP
 * 由来) ためここでは独立に書く — コピーではなく独立に書き直す方針
 * (`kintai-diff-view.ts` 冒頭の docs、#606-8 の前例と同じ理由)。数字でない値は
 * そのまま返す (fail-soft)。 */
function normalizeDriverCdKeyLocal(driverCd: string): string {
  const trimmed = driverCd.trim()
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed
}

/**
 * 1件の候補 (乗務員CD + 運行NO) を、取得済みの値差一覧と突き合わせる。
 *
 * - `itemsState.status !== 'ok'` (まだライブ取得していない/読めなかった)、または
 *   運行NOの桁数が不正で運行日を作れない場合は `unconfirmed`
 * - 拘束不一致 (`mismatch`) を拘束一致 (`match`) より優先して探す (両方には出ない実装
 *   なので優先順位は実害無いが、`buildKintaiDiff` の分類と同じ重さの順にしておく)
 * - どちらにも見当たらなければ `no_diff` (その日は両側一致)
 */
export function lookupKintaiCandidateDiff(
  driverCd: string,
  unkoNo: string,
  itemsState: KintaiCandidateDiffItemsState,
): KintaiCandidateDiffResult {
  const date = kintaiCandidateDiffDateFromUnkoNo(unkoNo)
  if (itemsState.status !== 'ok' || date === null) return { kind: 'unconfirmed', date }

  const key = normalizeDriverCdKeyLocal(driverCd)
  const isSameDayDriver = (item: KintaiCandidateDiffItem) =>
    normalizeDriverCdKeyLocal(item.driverCd) === key && item.date === date

  const mismatch = itemsState.items.mismatch.find(isSameDayDriver)
  if (mismatch) return { kind: 'mismatch', date, lastVerifiedAt: itemsState.lastVerifiedAt, item: mismatch }

  const match = itemsState.items.match.find(isSameDayDriver)
  if (match) return { kind: 'match', date, lastVerifiedAt: itemsState.lastVerifiedAt, item: match }

  return { kind: 'no_diff', date, lastVerifiedAt: itemsState.lastVerifiedAt }
}

/** 画面に並べる分数フィールドの表示順とラベル (issue #633 の例と同じ4項目)。
 * `KINTAI_DIFF_MINUTE_FIELDS` (`kintai-diff.ts`、front からは import できない別
 * デプロイ単位) のうち候補の価値判断に要る分だけを抜く。 */
export const KINTAI_CANDIDATE_DIFF_DISPLAY_FIELDS: ReadonlyArray<{ field: string, label: string }> = [
  { field: 'restraint_minutes', label: '拘束' },
  { field: 'break_minutes', label: '休憩' },
  { field: 'working_minutes', label: '実働' },
  { field: 'overtime_minutes', label: '残業' },
] as const

export interface KintaiCandidateDiffFieldRow {
  field: string
  label: string
  gcp: number
  onprem: number
  differs: boolean
}

/** 値差アイテム1件を、表示用の4行 (拘束/休憩/実働/残業、各GCP⇔オンプレ) にする。
 * 欠けているフィールドは0扱い (`item.gcp`/`item.onprem` は防御的パース済みの
 * `Record<string, number>` — 想定外のキー欠けでも落ちない)。 */
export function kintaiCandidateDiffFieldRows(item: KintaiCandidateDiffItem): KintaiCandidateDiffFieldRow[] {
  return KINTAI_CANDIDATE_DIFF_DISPLAY_FIELDS.map(({ field, label }) => {
    const gcp = item.gcp[field] ?? 0
    const onprem = item.onprem[field] ?? 0
    return { field, label, gcp, onprem, differs: gcp !== onprem }
  })
}
