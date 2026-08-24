/**
 * /restraint-wage 系の共有型・表示ヘルパ (Refs #244)。
 * 型は worker (workers/dtako-scraper-relay/src/{theearth-restraint-client,restraint-wage}.ts)
 * の応答と同型。
 */
// 職員区分の並び (事務 → 作業 → 整備 → 乗務 → その他) はタイムカード表と**同じ定義を
// 共有**する (ユーザー決定 2026-07-28 の並びをそのまま最低賃金チェックへ持ち込む)。
// 定義の置き場は kosoku-daily.ts のまま — そちらの `groupTimecardSheetsByCompany` と
// 判定を二重に持つと表記ゆれの追加で片方だけ直す事故が起きる。
import type { TimecardJobGroup } from './kosoku-daily'
import { TIMECARD_JOB_GROUPS, timecardJobGroup } from './kosoku-daily'

/** 打刻区間 ("YYYY-MM-DD HH:MM:SS")。タイムカード由来の日にだけ入る (Refs #424 PR-E)。
 * `end` は退社押し忘れ (未終業) だと null (nginx#780)。 */
export interface TimecardSession {
  start: string
  end: string | null
}

export interface RestraintSummaryDay {
  day: number
  isRestDay: boolean
  restraintMinutes: number | null
  workingMinutes: number | null
  overtimeMinutes: number | null
  nightMinutes: number | null
  overtimeNightMinutes: number | null
  /** 休日区分。タイムカード由来のみ (theearth 由来は暦を持たないので undefined)。 */
  holidayKind?: 'legal' | 'non_legal' | 'weekday'
  /** 自主出勤として賃金計算から外した実働 (分)。タイムカード由来のみ。 */
  voluntaryMinutes?: number
  /** その日の打刻区間 (中抜けがあれば 2 つ以上)。タイムカード由来のみ。 */
  sessions?: TimecardSession[]
  /** 打刻エラー (事務職・非夜勤の日跨ぎ) として賃金計算から外した拘束 (分)。
   * タイムカード由来のみ。0 より大きければその日は打刻エラー (Refs #433)。 */
  punchErrorMinutes?: number
  /** 退社打刻の無い日 (退社押し忘れ、nginx#780)。賃金計算から外れている。
   * タイムカード由来のみ・導入後に再取り込みしたサマリにだけ入る。 */
  missingClockOut?: boolean
  /** その日の休暇区分 (原文、公休 / 有休 / …)。タイムカード由来のみ (Refs #433)。 */
  leaves?: string[]
}

/**
 * `fillTheearthOnlyMetrics` (`timecard-summary.ts`) が埋め戻しうるキー
 * (運転・荷役・年度累計・拘束上限・当月超過・平均運転9h超、Refs #606-7)。
 */
export type TheearthBackfillKey =
  | 'drivingMinutes' | 'loadingMinutes' | 'fiscalCumulativeMinutes'
  | 'restraintLimitMinutes' | 'excessRestraintMinutes' | 'avgDriving9hOverCount'

export interface RestraintDriverSummary {
  driverCd: string
  driverName: string
  branchName: string
  workDays: number
  restDays: number
  restraintMinutes: number | null
  drivingMinutes: number | null
  loadingMinutes: number | null
  breakMinutes: number | null
  workingMinutes: number | null
  overtimeMinutes: number | null
  nightMinutes: number | null
  overtimeNightMinutes: number | null
  maxDailyRestraintMinutes: number | null
  fiscalCumulativeMinutes: number | null
  restraintLimitMinutes: number | null
  excessRestraintMinutes: number | null
  over15hDays: number
  avgDriving9hOverCount: number
  days: RestraintSummaryDay[]
  /** 打刻エラーの日数。タイムカード由来のみ (Refs #433)。 */
  punchErrorDays?: number
  /** 休暇の日数集計。タイムカード由来のみ。半休 (前休・後休) があるので
   * `paidLeave` は整数とは限らない (Refs #433)。 */
  leaveCounts?: {
    publicHoliday: number
    paidLeave: number
    absence: number
    specialLeave: number
    late: number
    earlyLeave: number
  }
  /**
   * この行 (タイムカード由来) のうち、どのキーを theearth (デジタコ拘束時間管理表)
   * 側から埋め戻したか (Refs #606-7)。**打刻からは構造的に出せない指標**
   * (運転・荷役・年度累計・拘束上限・当月超過・平均運転9h超) が対象。
   * 未設定 = 埋め戻し不要 (theearth 由来の行そのもの) か、埋め戻すものが無かった
   * (theearth 側にも値が無い) のどちらか — その行が theearth 由来かは
   * `WageReportRow.source` で分かるので、そちらと突き合わせて読む。
   */
  backfilledFromTheearth?: TheearthBackfillKey[]
}

export type WageCategoryKey =
  | 'statutory' | 'overtime' | 'night' | 'overtimeNight'
  | 'nonLegalHoliday' | 'nonLegalHolidayNight' | 'legalHoliday' | 'legalHolidayNight'
  | 'weekly40Excess'

export interface WageRow {
  driverCd: string
  driverName: string
  branchName: string
  hourlyRate: number | null
  minutes: Record<WageCategoryKey, number>
  amounts: Record<WageCategoryKey, number> | null
  totalAmount: number | null
  hourlyEquivalent: number | null
  minWage: { rate: number | null, prefecture: string | null, mapped: boolean }
  minWageDiff: number | null
  minWageTotalPay: number | null
  minWageStatutoryPay: number | null
  minWageNightPay: number | null
  totalPayDiff: number | null
  overtimeMinutes: number
  minWageOvertimeRate: number | null
  minWageOvertimePay: number | null
  actualOvertimePay: number | null
  overtimePayDiff: number | null
  nightOvertimeMinutes: number
  minWageNightOvertimeRate: number | null
  minWageNightOvertimePay: number | null
  actualNightOvertimePay: number | null
  nightOvertimePayDiff: number | null
}

export interface WageReportRow {
  summary: RestraintDriverSummary
  fetched_at: string | null
  last_verified_at: string | null
  wage: WageRow
  /** 行の出どころ (Refs #424 PR-D)。古い応答には無いので optional。 */
  source?: 'theearth' | 'timecard'
  /** 給与区分 (`SHAIN3.KKUBUN`): 1=月給 / 2=日給 / 3=時給 / 4=その他 (Refs #429)。
   * 社員マスタに無い / 未取り込みなら null。給与比較が「基本給(計算)」の
   * 単価の掛け方を決めるのに使う。 */
  pay_kubun?: number | null
  /** `restraint_source: 'gcp'` の応答で、GCP `day_summaries` にこの乗務員 × この月の
   * 行が無かった (= 欠測)。既定 (`current`) の応答では常に false / 未定義。
   * **0 分ではない** ので、金額・最低賃金割れの判定は出さずに「-」で表示する。 */
  restraint_missing?: boolean
}

export interface WageReportResponse {
  month: string
  rows: WageReportRow[]
  no_data_drivers: string[]
  warnings: string[]
  /** 拘束時間の出どころ。`current` = 従来どおり theearth 拘束表 + オンプレ打刻
   * (`kosoku-daily`)、`gcp` = GCP `kintai.day_summaries`。古い応答には無い。 */
  restraint_source?: RestraintSourceKey
}

/** 最低賃金チェックで選べる拘束時間ソース (既定は `current` = 従来の挙動)。 */
export type RestraintSourceKey = 'current' | 'gcp'

/** `prefecture` は最低賃金の一括設定で入った場合の根拠県 (手入力には付かない、Refs #409)。 */
export interface WageRateEntry { effectiveFrom: string, hourlyRate: number, prefecture?: string }
export interface WageMasterDriver { name?: string, rates: WageRateEntry[], retiredAt?: string }
export interface WageMaster { drivers: Record<string, WageMasterDriver> }

/** 最低賃金 (単価マスタタブ内、全社共通 1 本の履歴、Refs #253)。
 * worker 側の MinWageMaster (prefectures/branchToPrefecture) と互換の形で
 * 保存するが、フロントは単一の履歴だけを編集する (都道府県別マッピングはしない)。 */
export interface MinWageEntry { effectiveFrom: string, rate: number }
export interface MinWageMaster {
  prefectures: Record<string, MinWageEntry[]>
  branchToPrefecture: Record<string, string>
  defaultPrefecture?: string
}
/** minWageMaster.prefectures / defaultPrefecture に使う固定キー。 */
export const MIN_WAGE_DEFAULT_KEY = '全社共通'

export interface ArchiveCsvEntry {
  key: string
  range: string
  file: string
  kind: 'latest' | 'version' | 'history'
  size: number
  fetched_at: string | null
  last_verified_at: string | null
}

export interface ArchiveHistoryEntry { ts?: string, result?: string, sha256?: string, bytes?: number, raw?: string }

/** 時間給の法定区分列 (給与様式の並び、Refs #244)。 */
export const WAGE_COLUMNS: Array<{ key: WageCategoryKey, label: string }> = [
  { key: 'statutory', label: '法定時間内' },
  { key: 'overtime', label: '法定時間外' },
  { key: 'night', label: '深夜' },
  { key: 'overtimeNight', label: '時間外深夜' },
  { key: 'nonLegalHoliday', label: '法定外休日' },
  { key: 'nonLegalHolidayNight', label: '法定外休日深夜' },
  { key: 'legalHoliday', label: '法定休日' },
  { key: 'legalHolidayNight', label: '法定休日深夜' },
  { key: 'weekly40Excess', label: '週40超過' },
]

export const HISTORY_RESULT_LABEL: Record<string, string> = {
  'new-version': '変更あり (新版)',
  'unchanged': '変更なし',
  'no-data': '該当データなし',
}

/** 分 → "XhYYm" (null は "-")。コロン区切りは時刻と紛らわしいため h m 表記 (Refs #251)。 */
export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return '-'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h${String(m).padStart(2, '0')}m`
}

/** 円 (null は "-")。 */
export function fmtYen(v: number | null | undefined): string {
  return v == null ? '-' : v.toLocaleString('ja-JP')
}

/** "20260716T183000" (R2 版タイムスタンプ) → "2026-07-16 18:30"。 */
export function fmtArchiveTs(ts: string | null | undefined): string {
  if (!ts) return '-'
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : ts
}

/** 翌月 "YYYY-MM" (月末締め・翌月払いの支給月表示・給与 CSV 突合用、Refs #282)。
 * 12月は翌年1月へ繰り上がる。形式不正はそのまま返す。 */
export function nextYm(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/)
  if (!m) return ym
  const y = parseInt(m[1]!, 10)
  const mo = parseInt(m[2]!, 10)
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}

/** 前月 "YYYY-MM" (支給月ラベル → 勤務月の逆引き)。1月は前年12月へ繰り下がる。 */
export function prevYm(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/)
  if (!m) return ym
  const y = parseInt(m[1]!, 10)
  const mo = parseInt(m[2]!, 10)
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
}

/** "YYYY-MM" → "YYYY年M月"。 */
export function fmtYm(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/)
  return m ? `${m[1]}年${parseInt(m[2]!, 10)}月` : ym
}

/** 期間取得の上限 (給与DB は 1 社 10〜20 秒 × 会社数 × 月数 なので取り過ぎを防ぐ)。 */
export const MONTH_RANGE_MAX = 24

/**
 * `from`〜`to` (どちらも "YYYY-MM"、両端含む) の月を昇順で並べる。
 *
 * 逆順に指定されても入れ替えて扱う (画面で から/まで を逆に選べてしまうため)。
 * `max` 件で打ち切る — 給与DB の期間取得は 1 社 10〜20 秒かかるので、うっかり
 * 数年分を指定した時に何十分も走らせない。形式不正はどちらも空配列
 * (呼び出し側で「指定なし」として扱う)。
 */
export function monthRange(from: string, to: string, max = MONTH_RANGE_MAX): string[] {
  const valid = (ym: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(ym)
  if (!valid(from) || !valid(to)) return []
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  const out: string[] = []
  let cur = lo
  while (cur <= hi && out.length < max) {
    out.push(cur)
    cur = nextYm(cur)
  }
  return out
}

// ---- 月タブ「高速表示可」バッジの 2 段階判定 (Refs #543 followup、案A 2026-07-29) ----

/**
 * 「高速表示可」バッジの表示段階。
 *
 * - `full`: 拘束サマリ同期済み + relay の kintai 上流キャッシュ有り (フル表示)
 * - `synced-only`: 拘束サマリ同期済みのみ (弱表示 — キャッシュが無いぶん
 *   月切替で上流取得が要る可能性が高い)
 * - `none`: バッジ無し
 */
export type FastBadgeState = 'full' | 'synced-only' | 'none'

/**
 * 月タブの「高速表示可」バッジ判定 (pure)。
 *
 * `cachedMonths` が `null` = relay が `kintai_cached_months` を返さない旧応答 —
 * 従来どおりフル表示に fallback する (既存挙動を壊さない)。空配列は
 * 「キャッシュ無効 (フラグ off) or 何も載っていない」で、全て弱表示になる。
 *
 * キャッシュが有っても上流の版 (etag) が動いていれば読み直し (miss) になるため、
 * このバッジは「速いことが多い」目安であって保証ではない。
 */
export function fastBadgeState(
  ym: string,
  syncedMonths: readonly string[],
  cachedMonths: readonly string[] | null,
): FastBadgeState {
  if (!syncedMonths.includes(ym)) return 'none'
  if (cachedMonths === null || cachedMonths.includes(ym)) return 'full'
  return 'synced-only'
}

// ---- theearth (デジタコ) 拘束サマリの同期状態 (Refs #712) ----

/**
 * 月タブの「デジタコ拘束サマリ」状態。
 *
 * - `synced`: ichiban へ同期済み (緑丸が出る月)
 * - `archived-only`: 未同期だが **R2 アーカイブがある** — `loadWageReportSource` の
 *   `pick()` が R2 へフォールバックするので **行は落ちない。遅いだけ**。
 *   直し方も違う (theearth に触らない「全月再計算」で済む) ので、
 *   ここでは警告を出さない (既存の #460 バックフィル案内の領分)
 * - `unsynced`: 未同期で **R2 アーカイブも無い** = 一度も取り込んでいない月。
 *   theearth 由来の行が**丸ごと落ちている** — 打刻を持たない乗務員
 *   (本社以外の営業所、#613) はこの月の表に 1 行も出ない
 * - `out-of-scope`: そもそもこの月のデータが無い (未来月・取り込み対象外)
 */
export type TheearthSyncState = 'synced' | 'archived-only' | 'unsynced' | 'out-of-scope'

/**
 * theearth (デジタコ) 拘束サマリの状態 (pure、Refs #712)。
 *
 * **theearth 側には無人同期の経路が無い** — 書けるのは人が `/restraint-fetch`
 * (拘束CSV取得) を月ごとに実行したときだけで、cron 無人同期は timecard 側
 * (R2 `kintai/` prefix) しか書かない (#606-6)。cron 化はしない判断
 * (2026-08-21 オーナー: 「cron はいらない、人間が取り込むでいい」) なので、
 * **この表示が取り込みを起こす唯一のきっかけ**になる。
 *
 * ★ **`archiveMonths` を混ぜずに「未同期」だけで警告を出してはいけない。**
 * ichiban 未同期でも R2 アーカイブがあれば wage-report は R2 に落ちて行を出すので、
 * 「人が落ちている」は嘘になる。落ちるのは**両方無い**月だけ。
 *
 * `activeMonths` (実際には timecard 取り込み済み月) は「この月に何かデータがある」
 * ことの判定に使う — これが無いと、データの存在しない過去月・未来月まで警告で
 * 埋まって、本当に押すべき月が埋もれる。
 */
export function theearthSyncState(
  ym: string,
  syncedMonths: readonly string[],
  archiveMonths: readonly string[],
  activeMonths: readonly string[],
): TheearthSyncState {
  if (syncedMonths.includes(ym)) return 'synced'
  if (archiveMonths.includes(ym)) return 'archived-only'
  return activeMonths.includes(ym) ? 'unsynced' : 'out-of-scope'
}

/**
 * timecard 側が ichiban へ同期済みかどうか (#611 の無人同期、毎日 JST 4:00、Refs #614)。
 *
 * ★ `fastBadgeState` の判定 (full/synced-only/none) には**混ぜない**。「高速表示可」は
 * wage-report の R2 GET fan-out (theearth 側、約300本) を避けられるかどうかの目安で、
 * timecard 側は #606-5 で live-build 一本化済み — 同期の有無は表示速度に影響しない。
 * この関数は「timecard 側の無人同期がこの月までバックフィルできているか」という
 * 別軸の情報を画面が読めるようにするためだけに存在する。
 */
export function isTimecardSynced(ym: string, timecardSyncedMonths: readonly string[]): boolean {
  return timecardSyncedMonths.includes(ym)
}

// ---- 最低賃金チェックの並び (ユーザー決定 2026-07-30) ----

/** 職員区分の見出し。`other` は「推測で他の区分に混ぜない」ので中身を明示する。 */
export const MIN_WAGE_JOB_GROUP_LABEL: Record<TimecardJobGroup, string> = {
  clerical: '事務員',
  worker: '作業員',
  maintenance: '整備',
  driver: '乗務員',
  other: 'その他 (役員・特定技能・職種未設定)',
}

/** 並べ替えに使う社員マスタの所属 (対象月末時点)。全 null = マスタで引けない人。 */
export interface MinWageRowAttrs {
  /** 給与大臣の会社コード 4 桁 (`0100` 等)。null = 社員マスタに乗務員CD が無い。 */
  company: string | null
  /** 所属コード (`SHOZOKU.INCODE`)。**営業所の並び順の正** (Refs #409)。 */
  branchCode: number | null
  /** 営業所名 (`SHOZOKU.NAME1`)。 */
  branchName: string | null
  /** 職種名 (`SHOZOKU.NAME2`)。職員区分の判定元。 */
  jobName: string | null
}

/** 計算 (理論値) と給与 (支払い実績) を突き合わせる 3 列 × 3 組 (Refs #560)。 */
export interface MinWageCompareRow {
  /** 基本給: 法定時間内賃金 (計算) / 基本給扱い項目の合計 (給与)。 */
  calcBase: number | null
  paidBase: number | null
  diffBase: number | null
  /** 残業代: 基本給(法定内)以外のすべて = 合計 − 基本給 (計算) / 割増扱い項目の合計 (給与)。
   * 計算側が時間外系 3 区分だけだった頃は深夜(通常)・法定休日・法定外休日が
   * どの段にも入らず `基本給 + 残業代 ≠ 合計` になっていた (Refs #673)。 */
  calcOvertime: number | null
  paidOvertime: number | null
  diffOvertime: number | null
  /** 合計: 全区分合計 (計算) / 基本給 + 残業代 (給与)。 */
  calcTotal: number | null
  paidTotal: number | null
  diffTotal: number | null
}

/**
 * 比較列 (**給与 − 計算**、Refs #560)。給与比較タブの `diffBase`/`diffTotal` と
 * 同じ向きに揃える — マイナス = 支払いが換算理論値を下回っている。
 *
 * **どちらか片方でも無ければ差は null (「-」)** — 給与明細を取り込んでいない月や
 * 単価未設定の乗務員で 0 を出すと「一致した」に見えてしまう。
 */
export function minWageCompareRow(
  calc: { base: number | null, overtime: number | null, total: number | null },
  paid: { base: number, overtime: number } | null,
): MinWageCompareRow {
  const paidTotal = paid ? paid.base + paid.overtime : null
  const diff = (p: number | null, c: number | null) => (p == null || c == null ? null : p - c)
  return {
    calcBase: calc.base,
    paidBase: paid?.base ?? null,
    diffBase: diff(paid?.base ?? null, calc.base),
    calcOvertime: calc.overtime,
    paidOvertime: paid?.overtime ?? null,
    diffOvertime: diff(paid?.overtime ?? null, calc.overtime),
    calcTotal: calc.total,
    paidTotal,
    diffTotal: diff(paidTotal, calc.total),
  }
}

/** 会社 × 職員区分の 1 区画。`company` が null = 社員マスタで会社が引けない人。 */
export interface MinWageSection<T> {
  company: string | null
  jobGroup: TimecardJobGroup
  rows: T[]
}

/**
 * 最低賃金チェックの表を**会社 → 職員区分**で区切り、中を**営業所 → 乗務員CD**で
 * 並べる (ユーザー決定 2026-07-30)。
 *
 * - 会社は**会社コード昇順** (`0100` → `0200` → …)。4 桁ゼロ詰めなので文字列順 = 番号順。
 *   社員マスタで会社が引けない人は末尾の「会社不明」へ — 落とすとマスタ未登録の人が
 *   黙って表から消える (タイムカード表 `groupTimecardSheetsByCompany` と同じ作法)
 * - 職員区分は `TIMECARD_JOB_GROUPS` の順 = **事務員 → 作業員 → 整備 → 乗務員 → その他**。
 *   判定はタイムカード表と共有 (`timecardJobGroup`、`SHOZOKU.NAME2` の部分一致)
 * - 区分の中は**営業所ごとにまとめ**、その中を所属コード → 乗務員CD 順。所属は
 *   給与大臣では営業所 × 職種の組なので、区分で切れば営業所もまとまる
 *   (2026-07-30 のユーザー指摘)。**最低賃金は営業所の県で決まる** (Refs #409) ので、
 *   営業所が散らばらない並びは判定を読むうえでも効く
 * - **営業所の順は「その営業所が持つ最小の所属コード」** (`SHOZOKU.INCODE`、
 *   Refs #409 の「並びは所属コード」を営業所単位に読み替えたもの)。所属コードを
 *   そのまま行の第 1 キーにすると、**同じ営業所が区分の中で 2 つに割れる** —
 *   1 つの営業所が職種ごとに別コードを持つため (`本社 乗務員` と
 *   `本社 乗務員(トレーラ)` はどちらも乗務員区分だがコードが離れている)。
 *   2026-04 の本番データで 0200 の乗務員が 本社 → 諸富 → 大阪 → 本社 → 北九州 →
 *   大阪 と割れて出たので、営業所単位のまとめに直した
 * - 所属コードをまったく持たない営業所 (再取り込み前) は営業所名順で区分の末尾へ
 */
export function groupMinWageRows<T>(
  rows: readonly T[],
  driverCdOf: (row: T) => string,
  attrsOf: (row: T) => MinWageRowAttrs | null,
): Array<MinWageSection<T>> {
  const sections = new Map<string, MinWageSection<T>>()
  /** 営業所名 → その営業所の最小所属コード (全行から。区画をまたいで同じ順になる)。 */
  const branchRank = new Map<string, number>()
  for (const row of rows) {
    const attrs = attrsOf(row)
    const jobGroup = timecardJobGroup(attrs?.jobName)
    const company = attrs?.company ?? null
    const key = `${company ?? ''}|${jobGroup}`
    const section = sections.get(key) ?? { company, jobGroup, rows: [] }
    section.rows.push(row)
    sections.set(key, section)
    const branch = attrs?.branchName ?? ''
    const code = attrs?.branchCode ?? Number.POSITIVE_INFINITY
    const cur = branchRank.get(branch)
    if (cur === undefined || code < cur) branchRank.set(branch, code)
  }
  // `Infinity - Infinity` は NaN で比較関数が壊れるため引き算では比べない
  const cmpNum = (x: number, y: number) => (x === y ? 0 : x < y ? -1 : 1)
  const byRow = (a: T, b: T) => {
    const aa = attrsOf(a)
    const ba = attrsOf(b)
    const an = aa?.branchName ?? ''
    const bn = ba?.branchName ?? ''
    const inf = Number.POSITIVE_INFINITY
    return cmpNum(branchRank.get(an) ?? inf, branchRank.get(bn) ?? inf)
      || an.localeCompare(bn, 'ja')
      || cmpNum(aa?.branchCode ?? inf, ba?.branchCode ?? inf)
      || driverCdOf(a).localeCompare(driverCdOf(b), undefined, { numeric: true })
  }
  return [...sections.values()]
    .sort((a, b) =>
      (a.company === null ? 1 : 0) - (b.company === null ? 1 : 0)
      || (a.company ?? '').localeCompare(b.company ?? '')
      || TIMECARD_JOB_GROUPS.indexOf(a.jobGroup) - TIMECARD_JOB_GROUPS.indexOf(b.jobGroup))
    .map(s => ({ ...s, rows: [...s.rows].sort(byRow) }))
}

// ---- 表が 0 行のときの文言 (Refs #812) ----

/**
 * 表が 0 行だった理由の切り分け (pure、Refs #812)。
 *
 * - `loading-archive-months`: アーカイブ月一覧をまだ読めていない — **どちらとも
 *   言えない**
 * - `no-archive`: この月の R2 アーカイブが無い = 取り込み (`/restraint-fetch`) 漏れ
 * - `archive-present`: **アーカイブには在るのに 0 行** = 読み先の不具合
 */
export type EmptyWageReportCause = 'loading-archive-months' | 'no-archive' | 'archive-present'

/**
 * 表が 0 行のときに出す文言 (pure、Refs #812)。
 *
 * ★ **「アーカイブにありません」と言い切ってはいけない。** 本番 2026-07 で
 * 「この月の summary がアーカイブにありません」と出ていたのに、同じ月の
 * `/restraint-api/archive/summaries` は 111 名ぶんを完全に返していた
 * (原因は relay が ichiban の空の写しを掴んで R2 へ落ちなかったこと)。
 * **文言が原因の切り分けを妨げ、調査に半日かかった。**
 * `archiveMonths` を突き合わせて「取り込み漏れ」と「読み先の不具合」を
 * 分けて出す。
 */
export function emptyWageReportCause(
  ym: string,
  archiveMonths: readonly string[],
  archiveMonthsLoaded: boolean,
): EmptyWageReportCause {
  if (!archiveMonthsLoaded) return 'loading-archive-months'
  return archiveMonths.includes(ym) ? 'archive-present' : 'no-archive'
}

/** `emptyWageReportCause` に対応する画面文言 (pure、Refs #812)。 */
export const EMPTY_WAGE_REPORT_NOTICE: Record<EmptyWageReportCause, string> = {
  'loading-archive-months':
    '集計が 0 行で返りました (アーカイブ月の一覧を読み込み中のため、取り込み漏れかどうかはまだ判定できません)',
  'no-archive':
    'この月の summary がアーカイブにありません (/restraint-fetch で取得するか、アーカイブタブで再計算してください)',
  // ★ 「アーカイブにありません」という語をここに入れないこと (引用の形でも)。
  // 拾い読みで**逆の意味に読まれる**うえ、文言を機械的に押さえられなくなる。
  'archive-present':
    'この月の summary はアーカイブに在るのに、集計が 0 行で返りました (取り込み漏れではありません — 読み先の不具合が疑われます。ichiban の写しが空のまま同期済みになっている等。再取得しても直らないので開発へ報告してください)',
}
