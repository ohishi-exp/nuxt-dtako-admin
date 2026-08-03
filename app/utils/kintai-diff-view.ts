/**
 * オンプレ vs Supabase (GCP) 勤怠差タブの表示用 pure ロジック (Refs #615-5)。
 *
 * `/restraint-api/kintai/diff` ほか 3 口 (`workers/dtako-scraper-relay/src/kintai-diff.ts`
 * `/kintai-relay.ts`) と同じ形の応答を読むが、front から worker のソースは import
 * できない (別デプロイ単位・別 wrangler.toml)。**意味を合わせて独立に書き直す** —
 * `kintai-diff.ts` 自身が kyuyo-mcp の `get_kintai_diff` と同じことをコピーではなく
 * 独立に書いているのと同じ理由 (#606-8 の前例)。
 *
 * ★ このモジュールは「なぜ違うか」を判定しない (`docs/plan-615-onprem-gcp-diff.md`
 * 決定1)。差の区分・観測値をそのまま表示用に整形し、「どの操作で直りうるか」という
 * **処方の候補**を観測値の 0/非0 から機械的に導くだけ。「押せば直る」とは書かない —
 * 保証の有無は呼び出し側 (MySQL 取り直しの `guarantee`) が対象ごとに別に持つ。
 *
 * すべて `unknown` を受けて防御的に読む (root `npm install` が通らず front は CI が
 * 初検証のため、実行時前提を増やさない — CLAUDE.md の規範)。
 */

// ─────────────────────────────────────────────────────────────────────────
// GET /restraint-api/kintai/diff
// ─────────────────────────────────────────────────────────────────────────

export interface KintaiDiffCategoryCount {
  /** 切る前の総数。 */
  total: number
  /** `total` が応答の上限 (500) で切られているか。 */
  capped: boolean
}

function toCategoryCount(raw: unknown): KintaiDiffCategoryCount {
  const r = (raw ?? {}) as { total?: unknown, capped?: unknown }
  return {
    total: typeof r.total === 'number' && Number.isFinite(r.total) ? r.total : 0,
    capped: r.capped === true,
  }
}

/** 差の 5 区分 + 行数。フィールド名は worker 応答 (snake_case) を camelCase に読み替えるだけ。 */
export interface KintaiDiffSummary {
  month: string
  gcpRows: number
  onpremRows: number
  /** オンプレ応答の形が読めなかった。true のとき `onlyGcp` は「GCPにしか無い」の
   * 意味を持たない (onprem 側が空扱いになっているだけ) — 表示側は必ず警告を出すこと。 */
  onpremUnreadable: boolean
  onlyGcp: KintaiDiffCategoryCount
  onlyOnpremDriver0: KintaiDiffCategoryCount
  onlyOnpremOther: KintaiDiffCategoryCount
  valueDiffRestraintMatch: KintaiDiffCategoryCount
  valueDiffRestraintMismatch: KintaiDiffCategoryCount
}

export function parseKintaiDiffSummary(raw: unknown): KintaiDiffSummary | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.month !== 'string') return null
  const diff = (r.diff ?? {}) as Record<string, unknown>
  return {
    month: r.month,
    gcpRows: typeof diff.gcp_rows === 'number' && Number.isFinite(diff.gcp_rows) ? diff.gcp_rows : 0,
    onpremRows: typeof diff.onprem_rows === 'number' && Number.isFinite(diff.onprem_rows) ? diff.onprem_rows : 0,
    onpremUnreadable: diff.onprem_unreadable === true,
    onlyGcp: toCategoryCount(diff.only_gcp),
    onlyOnpremDriver0: toCategoryCount(diff.only_onprem_driver0),
    onlyOnpremOther: toCategoryCount(diff.only_onprem_other),
    valueDiffRestraintMatch: toCategoryCount(diff.value_diff_restraint_match),
    valueDiffRestraintMismatch: toCategoryCount(diff.value_diff_restraint_mismatch),
  }
}

/** 一覧に並べる 5 区分の定義。`note` は「原因ではなく前提」の注記 (Refs #615-5 やること3)。 */
export interface KintaiDiffCategoryDef {
  key: keyof Pick<
    KintaiDiffSummary,
    'onlyGcp' | 'onlyOnpremDriver0' | 'onlyOnpremOther' | 'valueDiffRestraintMatch' | 'valueDiffRestraintMismatch'
  >
  label: string
  note: string | null
}

export const KINTAI_DIFF_CATEGORIES: readonly KintaiDiffCategoryDef[] = [
  { key: 'onlyGcp', label: 'GCP のみ', note: null },
  {
    key: 'onlyOnpremDriver0',
    label: 'オンプレのみ (乗務員CD=0)',
    note: 'GCP が乗務員CD>0だけを対象にしているための意図的な除外です。欠けではありません。',
  },
  { key: 'onlyOnpremOther', label: 'オンプレのみ (乗務員CD≠0)', note: null },
  { key: 'valueDiffRestraintMatch', label: '値が違う (拘束時間は一致)', note: '内訳 (休憩/残業等) だけが違います。' },
  { key: 'valueDiffRestraintMismatch', label: '値が違う (拘束時間も不一致)', note: null },
] as const

/** `total` を人が読める形にする。上限で切られていれば「500+」のように示す (黙って切らない)。 */
export function fmtKintaiDiffCount(c: KintaiDiffCategoryCount): string {
  return c.capped ? `${c.total}+ (表示は500件まで)` : String(c.total)
}

// ─────────────────────────────────────────────────────────────────────────
// observations (GCP recalc dry-run の副産物。判定材料であって原因ではない)
// ─────────────────────────────────────────────────────────────────────────

export interface KintaiDiffObservationsView {
  staleDrivers: number | null
  foldWouldWriteDrivers: number | null
  warnings: string[]
  unkoDiffGcpOnlyInMonth: number | null
}

export function parseKintaiDiffObservations(raw: unknown): KintaiDiffObservationsView | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return {
    staleDrivers: typeof r.stale_drivers === 'number' && Number.isFinite(r.stale_drivers) ? r.stale_drivers : null,
    foldWouldWriteDrivers:
      typeof r.fold_would_write_drivers === 'number' && Number.isFinite(r.fold_would_write_drivers)
        ? r.fold_would_write_drivers
        : null,
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === 'string') : [],
    unkoDiffGcpOnlyInMonth:
      typeof r.unko_diff_gcp_only_in_month === 'number' && Number.isFinite(r.unko_diff_gcp_only_in_month)
        ? r.unko_diff_gcp_only_in_month
        : null,
  }
}

/** `/restraint-api/kintai/diff` 応答全体 (month/diff/observations/observations_error) を一括で読む。 */
export interface KintaiDiffApiResult {
  summary: KintaiDiffSummary | null
  observations: KintaiDiffObservationsView | null
  observationsError: string | null
}

export function parseKintaiDiffApiResponse(raw: unknown): KintaiDiffApiResult {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    summary: parseKintaiDiffSummary(raw),
    observations: parseKintaiDiffObservations(r.observations),
    observationsError: typeof r.observations_error === 'string' ? r.observations_error : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 処方の候補 (原因の断定ではない。観測値の非0/差の区分から機械的に導くだけ)
// ─────────────────────────────────────────────────────────────────────────

export type KintaiDiffPrescriptionKey = 'fold' | 'timecard' | 'mysql'

export interface KintaiDiffPrescription {
  key: KintaiDiffPrescriptionKey
  /** どの観測値からこの候補を出したか。 */
  observation: string
  /** その操作で何をするか。 */
  action: string
  /** この対象で実際に観測値が非0か (目安の強調表示用。falseでも押せなくはしない)。 */
  relevant: boolean
}

/**
 * 差 (summary) と観測値 (observations) から「処方の候補」を機械的に組む。
 * **これは原因の推定ではない** — 「非0の観測値がある」という事実の並べ替えでしかなく、
 * `relevant: true` でも「押せば直る」ことを意味しない (保証の有無は別途、対象ごとに確認する)。
 */
export function buildKintaiDiffPrescriptions(
  summary: KintaiDiffSummary | null,
  observations: KintaiDiffObservationsView | null,
): KintaiDiffPrescription[] {
  const staleOrFold = (observations?.staleDrivers ?? 0) > 0 || (observations?.foldWouldWriteDrivers ?? 0) > 0
  const onpremOnly = (summary?.onlyOnpremOther.total ?? 0) > 0
  const gcpOnlyOrUnko = (summary?.onlyGcp.total ?? 0) > 0 || (observations?.unkoDiffGcpOnlyInMonth ?? 0) > 0

  return [
    {
      key: 'fold',
      observation: 'stale、または畳み直すと変わる乗務員数が 0 でない',
      action: '畳み直す (GCP fold recalc)',
      relevant: staleOrFold,
    },
    {
      key: 'timecard',
      observation: 'オンプレにしか無い行 (乗務員CD≠0) がある = 打刻が GCP に運ばれていないかもしれない',
      action: '打刻を運び直す (オンプレ → GCP)',
      relevant: onpremOnly,
    },
    {
      key: 'mysql',
      observation: 'GCP にしか無い運行/行がある (dtako 入力欠けの可能性)',
      action: 'MySQL 側 (dtako) を取り直す — ★押しても直る保証はありません',
      relevant: gcpOnlyOrUnko,
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────
// POST /restraint-api/kintai/refresh/timecard — 打刻の運び直し (窓ぶん、続きは無い)
// ─────────────────────────────────────────────────────────────────────────

export interface KintaiWindowReportView {
  months: string[]
  drivers: number
  events: number
  driversWritten: number
  daysWritten: number
  daysDeleted: number
  misplaced: number
  unknownStates: string[]
  /** `true` なら件数は計画であって実績ではない (1 行も書いていない)。 */
  dryRun: boolean
}

export function parseKintaiWindowReport(raw: unknown): KintaiWindowReportView | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return {
    months: Array.isArray(r.months) ? r.months.filter((m): m is string => typeof m === 'string') : [],
    drivers: typeof r.drivers === 'number' && Number.isFinite(r.drivers) ? r.drivers : 0,
    events: typeof r.events === 'number' && Number.isFinite(r.events) ? r.events : 0,
    driversWritten: typeof r.driversWritten === 'number' && Number.isFinite(r.driversWritten) ? r.driversWritten : 0,
    daysWritten: typeof r.daysWritten === 'number' && Number.isFinite(r.daysWritten) ? r.daysWritten : 0,
    daysDeleted: typeof r.daysDeleted === 'number' && Number.isFinite(r.daysDeleted) ? r.daysDeleted : 0,
    misplaced: typeof r.misplaced === 'number' && Number.isFinite(r.misplaced) ? r.misplaced : 0,
    unknownStates: Array.isArray(r.unknownStates) ? r.unknownStates.filter((s): s is string => typeof s === 'string') : [],
    dryRun: r.dryRun === true,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /restraint-api/kintai/refresh/fold — GCP 側の畳み直し (1ページぶん。続きあり)
// ─────────────────────────────────────────────────────────────────────────

/** 1 ページぶんの応答。受け側の形をそのまま返す口 (reshape しない方針) なので、
 * ここでも `pickRecalcObservations` (kintai-diff.ts) と同じ防御的な読み方をする。 */
export interface KintaiFoldPageView {
  driversWritten: number
  staleDrivers: number | null
  warnings: string[]
  /** ページングの続きがあるか。`null` になるまで同じ引数 (`after_driver_cd` だけ更新) で叩き直す。 */
  nextAfterDriverCd: number | null
}

export function parseKintaiFoldPage(raw: unknown): KintaiFoldPageView {
  const obj = (raw ?? {}) as Record<string, unknown>
  const stale = (obj.stale ?? {}) as Record<string, unknown>
  const fold = (obj.fold ?? {}) as Record<string, unknown>
  const driversWrittenRaw = fold.drivers_written ?? obj.drivers_written
  const warningsRaw = Array.isArray(obj.warnings)
    ? obj.warnings
    : Array.isArray(fold.warnings)
      ? fold.warnings
      : []
  const nextRaw = obj.next_after_driver_cd
  return {
    driversWritten:
      typeof driversWrittenRaw === 'number' && Number.isFinite(driversWrittenRaw) ? driversWrittenRaw : 0,
    staleDrivers: typeof stale.drivers === 'number' && Number.isFinite(stale.drivers) ? stale.drivers : null,
    warnings: warningsRaw.filter((w): w is string => typeof w === 'string'),
    nextAfterDriverCd: typeof nextRaw === 'number' && Number.isFinite(nextRaw) ? nextRaw : null,
  }
}

/** ページングの進捗表示 (「何ページ目 / 何人終わったか」)。純粋な集計だけをここに持ち、
 * 実際にページを回すループ (fetch を挟む) は呼び出し側 (画面) が持つ。 */
export interface KintaiFoldProgress {
  pages: number
  driversWrittenTotal: number
  warnings: string[]
  done: boolean
}

export function foldProgressInitial(): KintaiFoldProgress {
  return { pages: 0, driversWrittenTotal: 0, warnings: [], done: false }
}

/** 1 ページぶんの結果を進捗に足し込む。`warnings` は重複を除いて積む (同じ警告が
 * ページごとに繰り返されて埋まるのを防ぐ)。 */
export function foldProgressAppend(prev: KintaiFoldProgress, page: KintaiFoldPageView): KintaiFoldProgress {
  const warnings = [...prev.warnings]
  for (const w of page.warnings) if (!warnings.includes(w)) warnings.push(w)
  return {
    pages: prev.pages + 1,
    driversWrittenTotal: prev.driversWrittenTotal + page.driversWritten,
    warnings,
    done: page.nextAfterDriverCd === null,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// POST /restraint-api/kintai/refresh/mysql — dtako (MySQL) 側の取り直し (①②③)
// ─────────────────────────────────────────────────────────────────────────

/** オンプレ rest-diff から引いた「押しても直る保証」。`guaranteed: true` は
 * `kind === "mismatch"` のときだけ — `dtako_missing`/`events_missing` は保証が無い
 * (rust-ichibanboshi 側のコード自身の doc、#615-2 で確認済み)。 */
export interface KintaiRefreshMysqlGuaranteeView {
  found: boolean
  kind: string | null
  guaranteed: boolean
}

export function parseKintaiRefreshMysqlGuarantee(raw: unknown): KintaiRefreshMysqlGuaranteeView | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return {
    found: r.found === true,
    kind: typeof r.kind === 'string' ? r.kind : null,
    guaranteed: r.guaranteed === true,
  }
}

export interface KintaiRefreshMysqlPreview {
  opeNo: string | null
  startOpe: string | null
  unkoNo: string | null
  guarantee: KintaiRefreshMysqlGuaranteeView | null
  guaranteeError: string | null
}

export function parseKintaiRefreshMysqlPreview(raw: unknown): KintaiRefreshMysqlPreview {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    opeNo: typeof r.ope_no === 'string' ? r.ope_no : null,
    startOpe: typeof r.start_ope === 'string' ? r.start_ope : null,
    unkoNo: typeof r.unko_no === 'string' ? r.unko_no : null,
    guarantee: parseKintaiRefreshMysqlGuarantee(r.guarantee),
    guaranteeError: typeof r.guarantee_error === 'string' ? r.guarantee_error : null,
  }
}

/** 実行 (`apply: true`) 成功時の応答 (`DtakoReimportReport` + `guarantee`) を表示用に読む。
 * オンプレ側の応答フィールドが増えても直さなくていいよう、防御的に拾うだけ拾う。 */
export interface KintaiRefreshMysqlApplyResultView {
  bytes: number | null
  entriesCount: number | null
  httpStatus: number | null
  autoloadHttpStatus: number | null
  resetHttpStatus: number | null
}

function toNumberOrNullLocal(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function parseKintaiRefreshMysqlApplyResult(raw: unknown): KintaiRefreshMysqlApplyResultView {
  const r = (raw ?? {}) as Record<string, unknown>
  const autoload = (r.autoload ?? {}) as Record<string, unknown>
  return {
    bytes: toNumberOrNullLocal(r.bytes),
    entriesCount: Array.isArray(r.entries) ? r.entries.length : null,
    httpStatus: toNumberOrNullLocal(r.http_status),
    autoloadHttpStatus: toNumberOrNullLocal(autoload.http_status),
    resetHttpStatus: toNumberOrNullLocal(autoload.reset_http_status),
  }
}

/**
 * 保証の有無を、**「押せば直る」と誤読されない文言**で 1 行にする
 * (#615-5 やること5・決定2)。`found: false` は「対象が rest-diff に見当たらない
 * (=判定不能)」であって直る保証があるわけではないので、`guaranteed` だけを見ないこと。
 *
 * ★ `found: false` の文言に「保証あり」という部分文字列を含めないこと —
 * 「保証**あり**の意味ではありません」のような否定文でも、部分一致のテスト
 * ガード (`not.toContain('保証あり')`) に引っかかる (2026-08-03 実際に CI で踏んだ)。
 * ガードを緩めるのではなく、文言側でこの部分文字列を避け続けること。
 */
export function fmtKintaiRefreshMysqlGuarantee(preview: KintaiRefreshMysqlPreview | null): string {
  if (!preview) return '保証の有無はまだ分かりません (まず「確認」を押してください)'
  if (preview.guaranteeError) return `保証を判定できませんでした: ${preview.guaranteeError}`
  const g = preview.guarantee
  if (!g) return '保証の有無は不明です (乗務員CD と対象月の両方を指定すると判定できます)'
  if (!g.found) return '対象がオンプレの rest-diff に見当たりません (判定不能 — 直る保証がある、という意味ではありません)'
  if (g.guaranteed) return `保証あり (kind: ${g.kind}) — この対象は押せば直る側です`
  return `保証なし (kind: ${g.kind ?? '不明'}) — 押しても直る保証はありません。実行後は結果を確認してください`
}
