/**
 * 訴訟用の準備ページ (`/litigation`、Refs #1133) の画面ロジック。
 *
 * relay 側 (`workers/dtako-scraper-relay/src/litigation-case.ts`) と検証規則を
 * 揃えてある (乗務員CD: 数字1〜8桁・重複除去、期間: 最大 `LITIGATION_CASE_MAX_MONTHS`
 * か月) — ただしここは relay を呼ぶ前の**画面側の即時フィードバック**用で、
 * 最終的な正の検証は relay 側が行う (body を偽装されても relay 側で弾かれる)。
 *
 * 月の列挙は `restraint-wage-view.ts` の `monthRange` を再利用する (新設しない)。
 */
import { monthRange } from './restraint-wage-view'

/** 案件名の上限文字数 (relay と同一)。 */
export const LITIGATION_CASE_NAME_MAX_LENGTH = 100
/** 期間の上限 (月数、両端含む。relay と同一)。 */
export const LITIGATION_CASE_MAX_MONTHS = 60
/** 乗務員の上限件数 (relay と同一)。 */
export const LITIGATION_CASE_MAX_DRIVERS = 50

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DRIVER_CD_RE = /^\d{1,8}$/

/** relay から返る案件 1 件 (`GET/PUT /restraint-api/litigation-cases` の応答形)。 */
export interface LitigationCaseRecord {
  caseId: string
  name: string
  fromMonth: string
  toMonth: string
  driverCds: string[]
  memo: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** 画面の編集フォームが持つ状態。 */
export interface LitigationCaseFormInput {
  name: string
  fromMonth: string
  toMonth: string
  driverCds: string[]
  memo: string
}

export function emptyLitigationCaseForm(): LitigationCaseFormInput {
  return { name: '', fromMonth: '', toMonth: '', driverCds: [], memo: '' }
}

/** 保存済みの案件を編集フォームの形へ写す (開き直したときの復元用)。 */
export function litigationCaseToForm(entry: LitigationCaseRecord): LitigationCaseFormInput {
  return {
    name: entry.name,
    fromMonth: entry.fromMonth,
    toMonth: entry.toMonth,
    driverCds: [...entry.driverCds],
    memo: entry.memo,
  }
}

/** 乗務員CD の妥当性 (relay の入力検証と同じ規則: 数字 1〜8桁)。 */
export function isValidDriverCd(raw: string): boolean {
  return DRIVER_CD_RE.test(raw.trim())
}

/**
 * 前ゼロを除去して正規化する (relay の normalizeDriverCd と同一規則)。
 *
 * **`normalizeDriverCd` という名前にしない** — `app/utils/allowance-targets.ts` が
 * 同名で「前後の空白を trim するだけ (前ゼロは残す)」という**別の規則**を export
 * 済みで、Nuxt の auto-import は同名 export を後勝ちで無言に差し替える
 * (`npx nuxt typecheck` の `Duplicated imports` 警告で実際に踏んだ)。運行手当の
 * 対象保存が氏名紛れ込みを弾く前提と噛み合わなくなるため、この関数だけ別名にする。
 */
export function normalizeLitigationDriverCd(raw: string): string {
  return String(Number(raw.trim()))
}

/**
 * チップへ 1 件追加する (重複除去・形式検証・上限チェック込み)。
 * 追加できない/意味の無い入力 (空文字・既に居る・形式不正・上限超過) は
 * `error` にその理由を返す (`null` = 追加した、または何もしなくてよかった)。
 * 既存配列は書き換えない (呼び出し側が `driverCds` を差し替える)。
 */
export function addDriverCd(existing: readonly string[], raw: string): { driverCds: string[], error: string | null } {
  const trimmed = raw.trim()
  if (!trimmed) return { driverCds: [...existing], error: null }
  if (!isValidDriverCd(trimmed)) {
    return { driverCds: [...existing], error: `乗務員CD は数字 (最大8桁) で入力してください: ${raw}` }
  }
  const normalized = normalizeLitigationDriverCd(trimmed)
  if (existing.includes(normalized)) {
    return { driverCds: [...existing], error: null } // 既に居る (黙って無視)
  }
  if (existing.length >= LITIGATION_CASE_MAX_DRIVERS) {
    return { driverCds: [...existing], error: `乗務員は${LITIGATION_CASE_MAX_DRIVERS}名までです` }
  }
  return { driverCds: [...existing, normalized], error: null }
}

/** チップから 1 件外す。 */
export function removeDriverCd(existing: readonly string[], cd: string): string[] {
  return existing.filter(c => c !== cd)
}

/** from/to の順序を昇順へ入れ替える (画面で逆に選べてしまうため)。形式は検証しない。 */
export function normalizeMonthOrder(fromMonth: string, toMonth: string): [string, string] {
  return fromMonth <= toMonth ? [fromMonth, toMonth] : [toMonth, fromMonth]
}

export interface LitigationCaseFormError {
  field: 'name' | 'fromMonth' | 'toMonth' | 'driverCds' | 'range'
  message: string
}

/** フォームの入力検証。エラーが無ければ空配列 (= 保存してよい)。 */
export function validateLitigationCaseForm(input: LitigationCaseFormInput): LitigationCaseFormError[] {
  const errors: LitigationCaseFormError[] = []
  const name = input.name.trim()
  if (!name) {
    errors.push({ field: 'name', message: '案件名を入力してください' })
  }
  else if (name.length > LITIGATION_CASE_NAME_MAX_LENGTH) {
    errors.push({ field: 'name', message: `案件名は${LITIGATION_CASE_NAME_MAX_LENGTH}文字以内で入力してください` })
  }

  const fromValid = MONTH_RE.test(input.fromMonth)
  const toValid = MONTH_RE.test(input.toMonth)
  if (!fromValid) errors.push({ field: 'fromMonth', message: '開始月を選択してください' })
  if (!toValid) errors.push({ field: 'toMonth', message: '終了月を選択してください' })
  if (fromValid && toValid) {
    const [from, to] = normalizeMonthOrder(input.fromMonth, input.toMonth)
    const months = monthRange(from, to, LITIGATION_CASE_MAX_MONTHS + 1)
    if (months.length > LITIGATION_CASE_MAX_MONTHS) {
      errors.push({ field: 'range', message: `期間は${LITIGATION_CASE_MAX_MONTHS}か月以内にしてください` })
    }
  }

  if (input.driverCds.length === 0) {
    errors.push({ field: 'driverCds', message: '乗務員を1名以上追加してください' })
  }
  else if (input.driverCds.length > LITIGATION_CASE_MAX_DRIVERS) {
    errors.push({ field: 'driverCds', message: `乗務員は${LITIGATION_CASE_MAX_DRIVERS}名までです` })
  }

  return errors
}

/** 保存 API (`PUT /restraint-api/litigation-cases`) へ送る body。from/to は昇順化する。 */
export function buildLitigationCaseSavePayload(input: LitigationCaseFormInput, caseId?: string): Record<string, unknown> {
  const [fromMonth, toMonth] = normalizeMonthOrder(input.fromMonth, input.toMonth)
  return {
    ...(caseId ? { caseId } : {}),
    name: input.name.trim(),
    fromMonth,
    toMonth,
    driverCds: input.driverCds,
    memo: input.memo.trim(),
  }
}

/** 一覧行の表示用: 期間の月数 (両端含む)。形式不正なら 0。 */
export function litigationCaseMonthCount(fromMonth: string, toMonth: string): number {
  return monthRange(fromMonth, toMonth, LITIGATION_CASE_MAX_MONTHS + 1).length
}
