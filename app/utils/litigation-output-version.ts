/**
 * 訴訟準備の「出力」タブの **版** (Refs #1133 c1133-34) の pure ロジック。
 *
 * 「ZIP を作る」のたびに、その時点で作った Excel と変更記録の CSV を relay へ 1 つの版として保存する
 * (元データは取り込み直しで後から変わるので、出力した Excel そのものを残す)。ここは
 * 保存する結果 (`results`) の組み立てと読み戻し・案件の区切りとの照合・版の一覧の整形だけを持つ。
 * 通信と ZIP の組み立ては `litigation.vue`。
 *
 * ## 保存する結果の形 (relay は中身を解釈せず JSON のまま持つ)
 *
 * `{ v: 1, chunks: [{driverCd, from, to}], results: [...], changes: {finished, rows} }`
 *
 * - `chunks` は「どの区切りの結果か」の写し。案件の期間・乗務員を後から変えると区切りが変わるので、
 *   **今の区切りと完全に一致するときだけ**画面へ戻す ({@link litigationSnapshotMatchesChunks})
 * - `results` の添字は `chunks` と揃える。作らなかった冊は null のまま
 * - 読み戻しは **1 か所でも形が違えば全体を読めない扱い** (null) にする — 壊れた版を、
 *   一部だけ「未実行」や 0 件に見せない
 */
import { fmtJstDateTime } from './litigation-changes'
import { Y_TIME_SOURCES, Y_TIME_SOURCE_REASONS } from './litigation-errors'
import type { LitigationOutputChunk, LitigationOutputResult, LitigationOutputStatus, YTimeSourceInfo } from './litigation-output'
import type { YTimeSource, YTimeSourceReason } from '~/types'

/** 保存する結果の形の版 */
export const LITIGATION_OUTPUT_SNAPSHOT_VERSION = 1
/** relay が受ける `results` の上限 (JSON 文字列の文字数)。超えると 400 になるので送る前に見る */
export const LITIGATION_OUTPUT_RESULTS_MAX_CHARS = 500_000
/** 変更記録の CSV の保存用の名前 (ZIP 内の名前は日本語なので、relay の名前の規則に合うものに置き換える) */
export const LITIGATION_OUTPUT_CHANGES_STORAGE_NAME = 'changes.csv'

/** 変更記録タブの状態の写し (「ZIP に入るもの」の表示に要る) */
export interface LitigationOutputChanges {
  /** 変更記録タブで取りに行ったか */
  finished: boolean
  rows: number
}

export interface LitigationOutputSnapshot {
  v: typeof LITIGATION_OUTPUT_SNAPSHOT_VERSION
  chunks: { driverCd: string, from: string, to: string }[]
  results: (LitigationOutputResult | null)[]
  changes: LitigationOutputChanges
}

/** 「ZIP を作る」の結果から、保存する 1 つの JSON を作る。 */
export function buildLitigationOutputSnapshot(
  chunks: readonly LitigationOutputChunk[],
  results: readonly (LitigationOutputResult | null)[],
  changes: LitigationOutputChanges,
): LitigationOutputSnapshot {
  return {
    v: LITIGATION_OUTPUT_SNAPSHOT_VERSION,
    chunks: chunks.map(c => ({ driverCd: c.driverCd, from: c.from, to: c.to })),
    results: [...results],
    changes: { finished: changes.finished, rows: changes.rows },
  }
}

/** relay が数えるのと同じ数え方 (`JSON.stringify` の文字数)。 */
export function litigationOutputSnapshotChars(snapshot: LitigationOutputSnapshot): number {
  return JSON.stringify(snapshot).length
}

const STATUSES: readonly unknown[] = ['ok', 'empty', 'not_found', 'error'] satisfies LitigationOutputStatus[]

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(s => typeof s === 'string')
}

/**
 * 行の元の 5 欄 (Refs #1133 c1133-46)。**どの欄も無くてよい** — この欄ができる前に保存した版は
 * 1 つも持たず、運行から作ったものとして読む (版の形の番号は上げていない)。
 * 在って型が違うときだけ false。
 */
function parseSourceInfo(raw: Record<string, unknown>): YTimeSourceInfo | false {
  const { source, sourceReason, excludedReasons, excluded, missingMonths } = raw
  const info: YTimeSourceInfo = {}
  if (source !== undefined) {
    if (!Y_TIME_SOURCES.includes(source)) return false
    info.source = source as YTimeSource
  }
  if (sourceReason !== undefined) {
    if (!Y_TIME_SOURCE_REASONS.includes(sourceReason)) return false
    info.sourceReason = sourceReason as YTimeSourceReason
  }
  if (excludedReasons !== undefined) {
    if (!isRecord(excludedReasons) || !Object.values(excludedReasons).every(isCount)) return false
    info.excludedReasons = excludedReasons as Record<string, number>
  }
  if (excluded !== undefined) {
    if (!Array.isArray(excluded)) return false
    info.excluded = []
    for (const e of excluded as unknown[]) {
      if (!isRecord(e) || typeof e.date !== 'string' || typeof e.reason !== 'string') return false
      info.excluded.push({ date: e.date, reason: e.reason })
    }
  }
  if (missingMonths !== undefined) {
    if (!isStringArray(missingMonths)) return false
    info.missingMonths = missingMonths
  }
  return info
}

/**
 * 区切り 1 つの結果。形が違えば false (null は「作らなかった冊」なので別の値にする)。
 * 古い版の結果に残っている `kingaku` / `kingakuError` (c1133-31 の頃の時間の集計) は**読まずに無視する**
 * — 形が壊れていても弾かず、戻した結果にも入れない (時間の表は wage report から作る、c1133-36)。
 */
function parseResult(raw: unknown): LitigationOutputResult | false {
  if (!isRecord(raw)) return false
  const { driverCd, from, to, status, rows, missingDates, missingCount, warnings, warningsCount, message } = raw
  if (typeof driverCd !== 'string' || typeof from !== 'string' || typeof to !== 'string') return false
  if (typeof message !== 'string' || !STATUSES.includes(status)) return false
  if (rows !== null && !isCount(rows)) return false
  if (!isStringArray(missingDates) || !isCount(missingCount)) return false
  if (!isStringArray(warnings) || !isCount(warningsCount)) return false
  const sourceInfo = parseSourceInfo(raw)
  if (sourceInfo === false) return false
  return {
    driverCd,
    from,
    to,
    status: status as LitigationOutputStatus,
    rows,
    missingDates,
    missingCount,
    warnings,
    warningsCount,
    message,
    ...sourceInfo,
  }
}

/**
 * relay から返った `results` を読む。**形が 1 か所でも違えば null** (版の形の番号が違う・
 * 区切りと結果の数が合わない・結果の欄が壊れている)。relay は JSON として読めない行を null で返す。
 */
export function parseLitigationOutputSnapshot(raw: unknown): LitigationOutputSnapshot | null {
  if (!isRecord(raw) || raw.v !== LITIGATION_OUTPUT_SNAPSHOT_VERSION) return null
  if (!Array.isArray(raw.chunks) || !Array.isArray(raw.results) || raw.chunks.length !== raw.results.length) return null
  const chunks: LitigationOutputSnapshot['chunks'] = []
  for (const c of raw.chunks as unknown[]) {
    if (!isRecord(c) || typeof c.driverCd !== 'string' || typeof c.from !== 'string' || typeof c.to !== 'string') return null
    chunks.push({ driverCd: c.driverCd, from: c.from, to: c.to })
  }
  const results: (LitigationOutputResult | null)[] = []
  for (const r of raw.results as unknown[]) {
    const parsed = r === null ? null : parseResult(r)
    if (parsed === false) return null
    results.push(parsed)
  }
  const changes = raw.changes
  if (!isRecord(changes) || typeof changes.finished !== 'boolean' || !isCount(changes.rows)) return null
  return { v: LITIGATION_OUTPUT_SNAPSHOT_VERSION, chunks, results, changes: { finished: changes.finished, rows: changes.rows } }
}

/** 保存した結果の区切りが、今の案件の区切りと完全に一致するか (数・並び・乗務員・期間)。 */
export function litigationSnapshotMatchesChunks(
  snapshot: LitigationOutputSnapshot,
  chunks: readonly LitigationOutputChunk[],
): boolean {
  return snapshot.chunks.length === chunks.length
    && snapshot.chunks.every((c, i) => c.driverCd === chunks[i]!.driverCd && c.from === chunks[i]!.from && c.to === chunks[i]!.to)
}

// ---- 版の一覧 ----

/** 版に保存したファイル 1 つ。`label` は ZIP 内の名前 (日本語可)、`name` は保存用の名前 */
export interface LitigationOutputVersionFile {
  name: string
  label: string
  size: number
}

export interface LitigationOutputVersion {
  versionId: string
  /** ISO 文字列 (UTC) */
  createdAt: string
  /** 出力した人。relay が身元を持たなかった版は null */
  createdBy: string | null
  files: LitigationOutputVersionFile[]
}

/** 版 1 件 (`GET …/litigation-outputs` の要素・`version_id` つきの応答の `version`)。形が違えば null。 */
export function parseLitigationOutputVersion(raw: unknown): LitigationOutputVersion | null {
  if (!isRecord(raw) || typeof raw.versionId !== 'string' || typeof raw.createdAt !== 'string') return null
  if (raw.createdBy !== null && typeof raw.createdBy !== 'string') return null
  if (!Array.isArray(raw.files)) return null
  const files: LitigationOutputVersionFile[] = []
  for (const f of raw.files as unknown[]) {
    if (!isRecord(f) || typeof f.name !== 'string' || typeof f.label !== 'string' || !isCount(f.size)) return null
    files.push({ name: f.name, label: f.label, size: f.size })
  }
  return { versionId: raw.versionId, createdAt: raw.createdAt, createdBy: raw.createdBy, files }
}

/**
 * 版の一覧の応答を読む (relay の並び = 新しい順のまま)。応答そのものの形が違えば null。
 * **読めない版は黙って落とさず数える** (`unreadable`) — 画面が件数を言う。
 */
export function parseLitigationOutputVersions(raw: unknown): { versions: LitigationOutputVersion[], unreadable: number } | null {
  if (!isRecord(raw) || !Array.isArray(raw.versions)) return null
  const versions = (raw.versions as unknown[]).map(parseLitigationOutputVersion).filter(v => v !== null)
  return { versions, unreadable: raw.versions.length - versions.length }
}

/** ファイルの大きさの表示 (`VdfViewer.vue` の `fmtBytes` と同じ区切り)。 */
export function fmtLitigationFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 版の一覧の 1 行に出す値。上げる予定だった数は版が持たないので、出すのは保存できた数だけ。 */
export interface LitigationOutputVersionRow {
  /** JST の `YYYY-MM-DD HH:mm` */
  createdAtText: string
  createdBy: string
  /** Excel の冊数 (`.xlsx` の数) */
  excelCount: number
  fileCount: number
  /** 合計の大きさ */
  sizeText: string
}

export const LITIGATION_OUTPUT_CREATED_BY_UNKNOWN = '不明'

export function litigationOutputVersionRow(v: LitigationOutputVersion): LitigationOutputVersionRow {
  return {
    createdAtText: fmtJstDateTime(v.createdAt),
    createdBy: v.createdBy ?? LITIGATION_OUTPUT_CREATED_BY_UNKNOWN,
    excelCount: v.files.filter(f => f.name.endsWith('.xlsx')).length,
    fileCount: v.files.length,
    sizeText: fmtLitigationFileSize(v.files.reduce((sum, f) => sum + f.size, 0)),
  }
}
