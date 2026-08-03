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

/**
 * [`KintaiDiffObservationsView.unkoDiffGcpOnlyInMonth`] の内訳 (Refs #615-7)。
 * worker (`kintai-diff.ts` の `KintaiDiffGcpOnlyDriverSplit`) をそのまま camelCase に
 * 読み替えるだけ。**3つの ops (`alsoInMonthOps`/`neverOnpremOps`/`otherMonthOnlyOps`) の和が
 * `unkoDiffGcpOnlyInMonth` と一致する** — 表示側はこの整合を崩さないこと。
 * 欠けたフィールドは 0 に倒す (undefined 安全)。
 */
export interface KintaiDiffGcpOnlyDriverSplitView {
  /** 対象乗務員がオンプレに一度も居ない (打刻システムが無い営業所 + 乗務員CD=0)。
   * **構造的なもので差ではない** — 画面で「差」「欠け」「異常」と呼ばないこと。 */
  neverOnpremDrivers: number
  neverOnpremOps: number
  /** 対象乗務員は当月オンプレにも居る。**取り込み漏れの候補** — ここが主役。 */
  alsoInMonthDrivers: number
  alsoInMonthOps: number
  /** 対象乗務員は別月にはオンプレに居る。 */
  otherMonthOnlyDrivers: number
  otherMonthOnlyOps: number
}

function toNumberOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function parseKintaiDiffGcpOnlyDriverSplit(raw: unknown): KintaiDiffGcpOnlyDriverSplitView {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    neverOnpremDrivers: toNumberOr0(r.never_onprem_drivers),
    neverOnpremOps: toNumberOr0(r.never_onprem_ops),
    alsoInMonthDrivers: toNumberOr0(r.also_in_month_drivers),
    alsoInMonthOps: toNumberOr0(r.also_in_month_ops),
    otherMonthOnlyDrivers: toNumberOr0(r.other_month_only_drivers),
    otherMonthOnlyOps: toNumberOr0(r.other_month_only_ops),
  }
}

export interface KintaiDiffObservationsView {
  staleDrivers: number | null
  foldWouldWriteDrivers: number | null
  warnings: string[]
  unkoDiffGcpOnlyInMonth: number | null
  /** [`KintaiDiffGcpOnlyDriverSplitView`] の docs 参照。上流に無ければ全フィールド 0。 */
  unkoDiffGcpOnlyDriverSplit: KintaiDiffGcpOnlyDriverSplitView
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
    unkoDiffGcpOnlyDriverSplit: parseKintaiDiffGcpOnlyDriverSplit(r.unko_diff_gcp_only_driver_split),
  }
}

/** `/restraint-api/kintai/diff` 応答全体 (month/diff/observations/observations_error) を一括で読む。
 * `fetchedAt`/`lastVerifiedAt` は突合結果のキャッシュ保存に伴って追加されたフィールド
 * (Refs #620-3) — この口はライブの突合 (約50秒) なので、応答が返った時点の
 * `lastVerifiedAt` は「たった今」になる。front はこれをそのまま「最終確認」表示に
 * 使い、保存分だけを読む別口 (`/kintai/diff-cache`) へ二度打ちしない。 */
export interface KintaiDiffApiResult {
  summary: KintaiDiffSummary | null
  observations: KintaiDiffObservationsView | null
  observationsError: string | null
  fetchedAt: string | null
  lastVerifiedAt: string | null
}

export function parseKintaiDiffApiResponse(raw: unknown): KintaiDiffApiResult {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    summary: parseKintaiDiffSummary(raw),
    observations: parseKintaiDiffObservations(r.observations),
    observationsError: typeof r.observations_error === 'string' ? r.observations_error : null,
    fetchedAt: typeof r.fetched_at === 'string' ? r.fetched_at : null,
    lastVerifiedAt: typeof r.last_verified_at === 'string' ? r.last_verified_at : null,
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
  // ★ never_onprem (打刻システムが無い営業所 + 乗務員CD=0) だけでは点灯させない (Refs #615-7) —
  // オンプレに居ない乗務員の運行を取り込む導線ではないため、押しても直らない。
  // also_in_month (取り込み漏れの候補) と other_month_only を基準にする。
  const gcpOnlyOrUnko =
    (summary?.onlyGcp.total ?? 0) > 0 ||
    (observations?.unkoDiffGcpOnlyDriverSplit.alsoInMonthOps ?? 0) > 0 ||
    (observations?.unkoDiffGcpOnlyDriverSplit.otherMonthOnlyOps ?? 0) > 0

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
      observation: '当月または別月にオンプレにも居る乗務員の運行が GCP にしか無い (dtako 入力欠けの可能性)',
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

// ─────────────────────────────────────────────────────────────────────────
// GET /restraint-api/kintai/diff-cache — 突合結果のキャッシュ (Refs #620-3)
//
// フル突合 (`/kintai/diff`、約50秒) の結果を保存し「最終確認日」を添えて出す。
// この口 (`/kintai/diff-cache`) は R2 read だけの軽い応答なので、月を選ぶ/タブを
// 開くたびに自動で叩いてよい — 突合そのもの (50秒) は「取り直す」ボタンを押した
// 時だけ叩く (自動では走らせない)。
//
// ★ 「未確認」「読めなかった」「確認済み (差0件を含む)」を混同しないこと —
// この repo で繰り返し要求される作法 (`stale_months` の `total_drivers`、
// `collected_etag_unko_nos()` が `Option` を返す理由、`onprem_unreadable` と同じ)。
// 3状態を1つの `KintaiDiffCacheState` (discriminated union) にまとめ、呼び出し側が
// 状態を取り違えないようにする。
// ─────────────────────────────────────────────────────────────────────────

export interface KintaiDiffCacheStateOk {
  status: 'ok'
  summary: KintaiDiffSummary
  observations: KintaiDiffObservationsView | null
  observationsError: string | null
  fetchedAt: string | null
  lastVerifiedAt: string | null
}

export type KintaiDiffCacheState =
  | { status: 'none' }
  | { status: 'unreadable' }
  | KintaiDiffCacheStateOk

/**
 * `/kintai/diff-cache` の応答を読む。`cached !== true` は「未確認」、
 * `unreadable: true` (または応答自体が壊れている) は「読めなかった」、それ以外は
 * 保存済みスナップショット (差0件のケースも含む — それは summary の各カテゴリが
 * 0 であることで表現される)。
 */
export function parseKintaiDiffCacheState(raw: unknown): KintaiDiffCacheState {
  if (raw == null || typeof raw !== 'object') return { status: 'unreadable' }
  const r = raw as Record<string, unknown>
  if (r.cached !== true) return { status: 'none' }
  if (r.unreadable === true) return { status: 'unreadable' }
  // `parseKintaiDiffSummary` はライブ応答向けに寛容 (`diff` が欠けていても 0 埋めの
  // summary を返す) — ここでそのまま使うと「diff が無い壊れた応答」を「差 0 件」に
  // 化けさせてしまう (#620-3 やること★ の混同そのもの)。キャッシュ応答は
  // `month`/`diff` が両方揃っていることを先に確認してから委譲する。
  if (typeof r.month !== 'string' || r.diff == null || typeof r.diff !== 'object') return { status: 'unreadable' }
  const summary = parseKintaiDiffSummary(r)
  if (!summary) return { status: 'unreadable' }
  return {
    status: 'ok',
    summary,
    observations: parseKintaiDiffObservations(r.observations),
    observationsError: typeof r.observations_error === 'string' ? r.observations_error : null,
    fetchedAt: typeof r.fetched_at === 'string' ? r.fetched_at : null,
    lastVerifiedAt: typeof r.last_verified_at === 'string' ? r.last_verified_at : null,
  }
}

/** ライブの突合 (`/kintai/diff`、「取り直す」を押した直後) の結果を、保存分の
 * 表示と同じ `KintaiDiffCacheState` に変換する。**二度目の read
 * (`/kintai/diff-cache`) を打たずに「最終確認」表示を更新するため** — ライブ応答
 * には保存に使ったのと同じ `fetchedAt`/`lastVerifiedAt` が既に載っている
 * (`handleKintaiDiff` が保存直後の値をそのまま返す)。 */
export function kintaiDiffCacheStateFromLiveResult(result: KintaiDiffApiResult): KintaiDiffCacheState {
  if (!result.summary) return { status: 'unreadable' }
  return {
    status: 'ok',
    summary: result.summary,
    observations: result.observations,
    observationsError: result.observationsError,
    fetchedAt: result.fetchedAt,
    lastVerifiedAt: result.lastVerifiedAt,
  }
}

/**
 * summary (5区分) から「差が0件だったか」を判定する。**`onlyOnpremDriver0` は
 * 除外する** — `KINTAI_DIFF_CATEGORIES` の note のとおり GCP が乗務員CD>0だけを
 * 対象にしている意図的な除外であって、差ではないため。
 *
 * ★ 運行NO単位の集計 (`observations.unkoDiffGcpOnlyDriverSplit` / 対象月に GCP に
 * しか無い運行数) はここでは一切参照しない。#620 の親コメントのとおり、その値は
 * `neverOnpremOps` (打刻システムが無い営業所の乗務員 + 乗務員CD=0) が9割超を
 * 占めるため、混ぜると毎月必ず「差あり」になる無意味な判定になる。この関数は
 * 日別サマリの5区分だけで判定し、運行NO単位の集計 (取り込み漏れ候補、#623-2 が
 * 別途扱う) とは独立に保つ。
 */
export function kintaiDiffHasAnyDiff(summary: KintaiDiffSummary): boolean {
  return (
    summary.onlyGcp.total > 0
    || summary.onlyOnpremOther.total > 0
    || summary.valueDiffRestraintMatch.total > 0
    || summary.valueDiffRestraintMismatch.total > 0
  )
}

/** ISO 文字列 (UTC) を JST の `MM/DD HH:mm` にする (`app/utils/profit-r2.ts` の
 * `restraintVersionTimestamp` と同じ JST 変換の作法 — 壁時計を UTC getter で読む)。
 * パースできなければ null。 */
export function fmtKintaiDiffLastVerified(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const jst = new Date(d.getTime() + 9 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(jst.getUTCMonth() + 1)}/${p(jst.getUTCDate())} ${p(jst.getUTCHours())}:${p(jst.getUTCMinutes())}`
}

/**
 * キャッシュ状態を画面の見出し文言にする。「未確認」「読めませんでした」
 * 「差はありません/差があります (最終確認: …)」を混同しない、この画面の唯一の窓口
 * (#620-3 やること★)。
 *
 * `onpremUnreadable` (オンプレ応答の形が読めなかった突合) のときは「差はありません」
 * と断定しない — 既存の警告 (画面側の別の UAlert) と矛盾しないよう、確認時刻だけ
 * 添えて有無の断定を避ける。
 */
export function fmtKintaiDiffCacheHeadline(state: KintaiDiffCacheState): string {
  if (state.status === 'none') return '未確認'
  if (state.status === 'unreadable') return '読めませんでした'
  const at = fmtKintaiDiffLastVerified(state.lastVerifiedAt)
  const atSuffix = at ? ` (最終確認: ${at})` : ' (確認時刻不明)'
  if (state.summary.onpremUnreadable) return `差の有無は判定できません${atSuffix}`
  return kintaiDiffHasAnyDiff(state.summary) ? `差があります${atSuffix}` : `差はありません${atSuffix}`
}
