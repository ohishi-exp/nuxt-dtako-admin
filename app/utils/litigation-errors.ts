/**
 * 訴訟準備の「エラー」タブ (Refs #1133 c1133-5) の pure ロジック。
 *
 * 案件の **乗務員 × 月** を 1 行にして、次の 4 つの検知を並べる。**どれも既存の口を読むだけ**
 * (新しい計算はしない):
 *
 * | 列 | 素材 | 口 |
 * | --- | --- | --- |
 * | `alcOps` alc の運行 | Y時間の勤務日 (JSON) を月に畳んだ日数 | `getYTimePreview` (区切り 1 つにつき 1 回) と出力タブの `empty` |
 * | `yTime` Y時間の欠け | 同じプレビューの警告 (Y時間に入らなかった運行) + ZIP を作った冊はテンプレに書けなかった日 | `getYTimePreview` (alcOps と同じ応答) / `POST /api/y-time-export` (出力タブ) |
 * | `unkoGaps` alc にあって勤怠に無い運行 | 受け側の分類をそのまま (勤怠側が 0 件なら照合先なし) | `GET /restraint-api/kintai/unko-gaps?month=&driver_cd=` |
 * | `invariants` 最低賃金の不変条件 (条件1〜3) | relay が付ける `invariants` | `GET /restraint-api/wage-report?source=gcp&month=` |
 *
 * ## 判定は 4 つ — **取れなかったことを 0 件と同じ見た目にしない** (map skill「PR の基準」(7))
 *
 * | state | 意味 |
 * | --- | --- |
 * | `ng` | 異常あり |
 * | `ok` | 異常なし (調べて、無かった) |
 * | `unknown` | 判定できない — 取りに行ったが取れなかった / 取れたが判断材料が欠けていた。`message` に理由 |
 * | `pending` | 未実行 — まだ取りに行っていない |
 * | `noBaseline` | 照合先なし — 突き合わせる相手 (勤怠から運んだこの乗務員の運行) がその月 0 件。異常ではない |
 *
 * `unknown` と `pending` を分けるのは、「調べたが分からなかった」と「まだ調べていない」で
 * 次の一手が違うため (前者は理由を読む、後者はボタンを押す)。
 *
 * ★ 最低賃金チェックの**自動保存 (`POST /restraint-api/wage-snapshot`) はこのタブから呼ばない**。
 * wage-report を読むだけで、`restraint-wage.vue` の computed やタブは流用しない。
 */
import type { LitigationOutputChunk, LitigationOutputResult } from './litigation-output'
import type { KintaiUnkoGaps } from './kintai-unko-gaps'
import { kintaiUnkoGapsReadability } from './kintai-unko-gaps'
import type { WageInvariantCheck, WageReportResponse } from './restraint-wage-view'
import { fmtShiftOverlap, invariantRowStatus, nextYm } from './restraint-wage-view'
import { daysInMonth } from './timecard-view'
import { csvCell } from './wage-range-view'

export type LitigationCheckKey = 'alcOps' | 'yTime' | 'unkoGaps' | 'invariants'
export type LitigationCheckState = 'ng' | 'ok' | 'unknown' | 'pending' | 'noBaseline'

/** 列の並び (表・CSV・印刷で共通) */
export const LITIGATION_CHECK_KEYS: readonly LitigationCheckKey[] = ['alcOps', 'yTime', 'unkoGaps', 'invariants']

export const LITIGATION_CHECK_LABELS: Record<LitigationCheckKey, string> = {
  alcOps: 'alc の運行',
  yTime: 'Y時間の欠け',
  unkoGaps: 'alc にあって勤怠に無い運行',
  invariants: '最低賃金の不変条件',
}

export const LITIGATION_CHECK_STATE_LABELS: Record<LitigationCheckState, string> = {
  ng: '異常あり',
  ok: '異常なし',
  unknown: '判定できない',
  pending: '未実行',
  noBaseline: '照合先なし',
}

export interface LitigationCheckCell {
  state: LitigationCheckState
  message: string
}

export interface LitigationErrorRow {
  driverCd: string
  /** `YYYY-MM` */
  month: string
  cells: Record<LitigationCheckKey, LitigationCheckCell>
  /** 取り込みボタンを出すか (= alc の運行が 0 件と判定できた月だけ) */
  canImport: boolean
}

/** 1 回の取得の結果。失敗は画面に出す 1 文で持つ */
export type LitigationFetched<T> = { ok: true, value: T } | { ok: false, reason: string }

/** Y時間 に入らなかった運行 (プレビューの警告から拾う)。`reason` は画面に出す短い理由。 */
export interface LitigationYTimeDropped {
  unkoNo: string
  reason: string
}

/** 乗務員 × 月の「alc の運行」の素材。`ok` のときは同じプレビューから拾った
 * 「Y時間に入らなかった運行」(`dropped`) も持つ — Y時間の欠けを ZIP なしで判定するため。 */
export type LitigationAlcOpsEntry =
  | { ok: true, days: number, dropped: LitigationYTimeDropped[] }
  | { ok: false, notFound: boolean, reason: string }

/** Map のキー `乗務員CD|YYYY-MM` */
export function litigationDriverMonthKey(driverCd: string, month: string): string {
  return `${driverCd}|${month}`
}

/** `YYYY-MM` の初日と末日 (`YYYY-MM-DD`)。 */
export function litigationMonthBounds(month: string): { from: string, to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return { from: `${month}-01`, to: `${month}-${String(daysInMonth(y, m)).padStart(2, '0')}` }
}

/** 区切りに含まれる月 (`YYYY-MM`、古い順)。 */
export function litigationChunkMonths(chunk: Pick<LitigationOutputChunk, 'from' | 'to'>): string[] {
  const out: string[] = []
  const last = chunk.to.slice(0, 7)
  for (let cur = chunk.from.slice(0, 7); cur <= last; cur = nextYm(cur)) out.push(cur)
  return out
}

/**
 * Y時間の行 (1 行 = 1 暦日の勤務) を月ごとの日数に畳む。`months` に無い月の行は数えない
 * (区切りの外の日を別の月に足さない)。`months` の月は 0 日でもキーを持つ。
 */
export function foldYTimeDaysByMonth(rows: readonly { date: string }[], months: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of months) out[m] = 0
  for (const r of rows) {
    const m = r.date.slice(0, 7)
    if (m in out) out[m] = out[m]! + 1
  }
  return out
}

/** 上流 (rust-alc-api の Y時間 export) が「運行を Y時間に入れなかった」ときの警告。
 * `{運行NO}: departure_at/return_at が不足、skip` と `{運行NO}: KUDGIVT 取得失敗 (…)`。
 * `{日付}: 複数 segment 結合 …` は 1 行にまとめただけで欠けではないので拾わない。 */
const Y_TIME_DROPPED_RE = /^(\d{22,23}): (departure_at\/return_at が不足|KUDGIVT 取得失敗)/

/**
 * プレビューの警告から「Y時間に入らなかった運行」を拾い、**運行NO の先頭 4 桁 (YYMM)** で
 * 月に振り分ける (区切りの月だけ。区切りの外の運行は捨てる)。
 */
export function foldYTimeDroppedByMonth(warnings: readonly string[], months: readonly string[]): Record<string, LitigationYTimeDropped[]> {
  const out: Record<string, LitigationYTimeDropped[]> = {}
  for (const m of months) out[m] = []
  for (const w of warnings) {
    const hit = Y_TIME_DROPPED_RE.exec(w)
    if (!hit) continue
    const unkoNo = hit[1]!
    const month = `20${unkoNo.slice(0, 2)}-${unkoNo.slice(2, 4)}`
    if (!(month in out)) continue
    out[month]!.push({ unkoNo, reason: hit[2]!.startsWith('departure') ? '出庫/帰庫が無い' : '運行の中身 (KUDGIVT) が取れない' })
  }
  return out
}

/**
 * `getYTimePreview` の失敗を区切りの各月へ配る。**404 は「乗務員CD が alc に未登録」**
 * (alc が乗務員を引けなかった答え) なので `notFound` を立てる — 数えられないだけで、
 * 0 件と同じ扱いにはしない。
 */
export function litigationAlcOpsFailure(httpStatus: number | null, reason: string): LitigationAlcOpsEntry {
  return { ok: false, notFound: httpStatus === 404, reason }
}

// ---- 1 セルずつの判定 ----

export function alcOpsCell(entry: LitigationAlcOpsEntry | undefined, chunkResult: LitigationOutputResult | null): LitigationCheckCell {
  if (entry) {
    if (entry.ok) {
      return entry.days === 0
        ? { state: 'ng', message: 'alc に運行が 0 件 (Y時間の勤務日 0 日)' }
        : { state: 'ok', message: `勤務日 ${entry.days} 日` }
    }
    return entry.notFound
      ? { state: 'unknown', message: '乗務員CD が alc に未登録 (404) — 運行を数えられない' }
      : { state: 'unknown', message: entry.reason }
  }
  // 月単位を読む前でも、出力タブで区切りごと 0 件と分かっていれば言える
  if (chunkResult?.status === 'empty') {
    return { state: 'ng', message: 'この冊の期間の運行が 0 件 (出力タブの結果)' }
  }
  return { state: 'pending', message: '未実行 — 「検知を実行」で調べます' }
}

/**
 * 出力タブの結果から、その月に「Y時間に書けなかった日」があるかを出す。
 * `missingDates` はサーバが先頭 30 件に切り詰めるので、**総数が一覧より多く、
 * この月の日が一覧に 1 つも無いときは「無い」と言わず判定できないにする**。
 */
function yTimeCellFromOutput(month: string, result: LitigationOutputResult): LitigationCheckCell {
  if (result.status === 'error') return { state: 'unknown', message: result.message }
  if (result.status === 'not_found') {
    return { state: 'ng', message: '乗務員CD が alc に未登録で Y時間を作れない' }
  }
  const inMonth = result.missingDates.filter(d => d.startsWith(`${month}-`))
  if (inMonth.length > 0) {
    return { state: 'ng', message: `テンプレに行が無く書けなかった日: ${inMonth.join(', ')}` }
  }
  if (result.missingCount > result.missingDates.length) {
    return {
      state: 'unknown',
      message: `この冊で書けなかった日が ${result.missingCount} 日あり、一覧 (先頭 ${result.missingDates.length} 日) にこの月の日が入らなかった`,
    }
  }
  return result.status === 'empty'
    ? { state: 'ok', message: '書けなかった日なし (この冊は運行 0 件 — 「alc の運行」の列を見てください)' }
    : { state: 'ok', message: '書けなかった日なし' }
}

/** 「検知を実行」のプレビュー (`alcOps` と同じ応答) から、Y時間に入らなかった運行があるかを出す。 */
function yTimeCellFromPreview(entry: LitigationAlcOpsEntry): LitigationCheckCell {
  if (!entry.ok) {
    return entry.notFound
      ? { state: 'ng', message: '乗務員CD が alc に未登録で Y時間を作れない' }
      : { state: 'unknown', message: entry.reason }
  }
  if (entry.dropped.length > 0) {
    const shown = entry.dropped.slice(0, UNKO_NO_PREVIEW).map(d => `${d.unkoNo} (${d.reason})`).join(', ')
    const more = entry.dropped.length > UNKO_NO_PREVIEW ? ' ほか' : ''
    return { state: 'ng', message: `Y時間に入らなかった運行 ${entry.dropped.length} 件: ${shown}${more}` }
  }
  return entry.days === 0
    ? { state: 'ok', message: '欠けなし (この月は運行 0 件 — 「alc の運行」の列を見てください)' }
    : { state: 'ok', message: '欠けなし' }
}

/**
 * Y時間の欠け。**ZIP を作らなくても「検知を実行」で判定できる** — 同じプレビューから
 * 「Y時間に入らなかった運行」(出庫/帰庫不足・KUDGIVT 取得失敗) を拾う。ZIP を作った月は
 * 「テンプレに行が無く書けなかった日」も加える (これだけは Excel を作らないと分からない。
 * ただし訴訟準備は冊ごとに期間を振り直し、1 冊は最大 12 か月 = テンプレの行数より十分少ない)。
 * どちらかが異常・判定できないならそれを出す (ZIP 側を先に見る)。
 */
export function yTimeCell(month: string, result: LitigationOutputResult | null, alc?: LitigationAlcOpsEntry): LitigationCheckCell {
  const fromOutput = result ? yTimeCellFromOutput(month, result) : null
  const fromPreview = alc ? yTimeCellFromPreview(alc) : null
  if (fromOutput && fromOutput.state !== 'ok') return fromOutput
  if (fromPreview && fromPreview.state !== 'ok') return fromPreview
  return fromOutput ?? fromPreview ?? { state: 'pending', message: '未実行 — 「検知を実行」で調べます' }
}

/** 「alc にあって勤怠に無い運行」の運行NOを何件まで文に並べるか */
const UNKO_NO_PREVIEW = 3

export function unkoGapsCell(driverCd: string, entry: LitigationFetched<KintaiUnkoGaps> | undefined): LitigationCheckCell {
  if (!entry) return { state: 'pending', message: '未実行 — 「検知を実行」で調べます' }
  if (!entry.ok) return { state: 'unknown', message: entry.reason }
  const g = entry.value
  const readability = kintaiUnkoGapsReadability(g)
  if (readability === 'etags_unavailable') {
    return { state: 'unknown', message: 'GCP 側の運行一覧が引けていない — 0 件とは言えない' }
  }
  if (readability === 'driver_cds_unavailable') {
    return { state: 'unknown', message: 'alc が乗務員CD を返していない — 0 件とは言えない' }
  }
  // 乗務員CD 指定で呼ぶと受け側の「勤怠側にも運行がある月だけ」の絞り込みが外れるので、
  // 勤怠側が 0 件の月は alc の運行が全部「勤怠に無い」に数えられる。異常とは言わずに分ける
  if (g.onpremOperationsInMonth === 0) {
    return { state: 'noBaseline', message: 'この月は勤怠から運んだこの乗務員の運行が 0 件で、alc の運行と突き合わせる相手が無い' }
  }
  const mine = g.drivers.find(d => d.driverCd === driverCd)
  if (mine && mine.unkoNos.length > 0) {
    const shown = mine.unkoNos.slice(0, UNKO_NO_PREVIEW).join(', ')
    const more = mine.unkoNos.length > UNKO_NO_PREVIEW ? ' ほか' : ''
    const count = mine.truncated ? `${mine.unkoNos.length} 件以上` : `${mine.unkoNos.length} 件`
    return { state: 'ng', message: `勤怠に無い運行 ${count}: ${shown}${more}` }
  }
  if (g.driversTruncated) {
    return { state: 'unknown', message: '乗務員の一覧が途中で切れていて、この乗務員が入っていない' }
  }
  const unknownDriver = g.unknownDriverUnkoNos.length > 0
    ? ` (乗務員が分からない運行 ${g.unknownDriverUnkoNos.length} 件はこの判定に入らない)`
    : ''
  return { state: 'ok', message: `勤怠に無い運行なし${unknownDriver}` }
}

/** 崩れている条件を 1 文に並べる (`ng` のときだけ呼ぶ)。 */
function invariantNgMessage(inv: WageInvariantCheck): string {
  const parts: string[] = []
  const diff = inv.unaccounted?.diffMinutes ?? 0
  if (diff !== 0) parts.push(`条件1 実働−表区分合計 ${diff > 0 ? '+' : ''}${diff} 分`)
  if (inv.workingWithinRestraint === false) parts.push('条件2 実働が拘束を超える')
  if (inv.noShiftOverlap === false) parts.push(`条件3 勤務の時間帯が重なる ${fmtShiftOverlap(inv.shiftOverlap)}`.trimEnd())
  return parts.join(' / ')
}

export function invariantsCell(driverCd: string, entry: LitigationFetched<WageReportResponse> | undefined): LitigationCheckCell {
  if (!entry) return { state: 'pending', message: '未実行 — 「検知を実行」で調べます' }
  if (!entry.ok) return { state: 'unknown', message: entry.reason }
  const report = entry.value
  // invariants は拘束時間ソースが GCP の応答にだけ付く (Refs #1123)
  if (report.restraint_source !== 'gcp') {
    return { state: 'unknown', message: '拘束時間ソースが GCP でない応答が返った — 不変条件は GCP のときだけ付く' }
  }
  const rows = report.rows.filter(r => r.summary.driverCd === driverCd)
  if (rows.length === 0) {
    return report.no_data_drivers.includes(driverCd)
      ? { state: 'unknown', message: 'この月の賃金計算にデータが無い' }
      : { state: 'unknown', message: 'この月の賃金計算にこの乗務員の行が無い' }
  }
  if (rows.some(r => r.restraint_missing)) {
    return { state: 'unknown', message: 'GCP の拘束時間が欠測 (0 分ではない)' }
  }
  const ngRow = rows.find(r => invariantRowStatus(r.invariants) === 'ng')
  if (ngRow) return { state: 'ng', message: invariantNgMessage(ngRow.invariants!) }
  if (rows.some(r => invariantRowStatus(r.invariants) === 'unknown')) {
    return { state: 'unknown', message: '条件1〜3 のどれかが判定不能 (応答に材料が無い)' }
  }
  return { state: 'ok', message: '条件1〜3 すべて満たす' }
}

// ---- 表 ----

export interface LitigationErrorInput {
  driverCds: readonly string[]
  /** 案件の月 (`YYYY-MM`、古い順) */
  months: readonly string[]
  /** 出力タブの区切りと結果 (添字を揃える。未実行は null) */
  chunks: readonly LitigationOutputChunk[]
  results: readonly (LitigationOutputResult | null)[]
  /** キー `乗務員CD|YYYY-MM` */
  alcOps: ReadonlyMap<string, LitigationAlcOpsEntry>
  /** キー `乗務員CD|YYYY-MM` */
  unkoGaps: ReadonlyMap<string, LitigationFetched<KintaiUnkoGaps>>
  /** キー `YYYY-MM` (会社全体を 1 回で読む) */
  wageReports: ReadonlyMap<string, LitigationFetched<WageReportResponse>>
}

/** 乗務員 × 月の区切りの結果 (無ければ null)。 */
function chunkResultFor(input: LitigationErrorInput, driverCd: string, month: string): LitigationOutputResult | null {
  const first = `${month}-01`
  const i = input.chunks.findIndex(c => c.driverCd === driverCd && c.from <= first && first <= c.to)
  return i < 0 ? null : input.results[i] ?? null
}

/** 表の行を作る。並びは乗務員ごと・月の古い順 (出力タブと同じ)。 */
export function buildLitigationErrorRows(input: LitigationErrorInput): LitigationErrorRow[] {
  const out: LitigationErrorRow[] = []
  for (const driverCd of input.driverCds) {
    for (const month of input.months) {
      const key = litigationDriverMonthKey(driverCd, month)
      const chunkResult = chunkResultFor(input, driverCd, month)
      const cells: Record<LitigationCheckKey, LitigationCheckCell> = {
        alcOps: alcOpsCell(input.alcOps.get(key), chunkResult),
        yTime: yTimeCell(month, chunkResult, input.alcOps.get(key)),
        unkoGaps: unkoGapsCell(driverCd, input.unkoGaps.get(key)),
        invariants: invariantsCell(driverCd, input.wageReports.get(month)),
      }
      out.push({ driverCd, month, cells, canImport: cells.alcOps.state === 'ng' })
    }
  }
  return out
}

/** 列ごと・判定ごとの件数 (表の上の要約) */
export function countLitigationErrorCells(
  rows: readonly LitigationErrorRow[],
): Record<LitigationCheckKey, Record<LitigationCheckState, number>> {
  const zero = (): Record<LitigationCheckState, number> => ({ ng: 0, ok: 0, unknown: 0, pending: 0, noBaseline: 0 })
  const out = { alcOps: zero(), yTime: zero(), unkoGaps: zero(), invariants: zero() }
  for (const r of rows) {
    for (const k of LITIGATION_CHECK_KEYS) out[k][r.cells[k].state]++
  }
  return out
}

/** 1 つでも異常あり / 判定できないがある行か (表の「異常あり・判定できないがある行だけ」で絞る。照合先なしは入れない) */
export function litigationRowNeedsAttention(row: LitigationErrorRow): boolean {
  return LITIGATION_CHECK_KEYS.some(k => row.cells[k].state === 'ng' || row.cells[k].state === 'unknown')
}

/** Y時間の警告 (冊単位。月に割り振れないので表とは別に出す) */
export interface LitigationChunkWarning {
  driverCd: string
  label: string
  warnings: string[]
  warningsCount: number
}

export function litigationChunkWarnings(
  chunks: readonly LitigationOutputChunk[],
  results: readonly (LitigationOutputResult | null)[],
): LitigationChunkWarning[] {
  const out: LitigationChunkWarning[] = []
  chunks.forEach((c, i) => {
    const r = results[i]
    if (r && r.warningsCount > 0) {
      out.push({ driverCd: c.driverCd, label: c.label, warnings: r.warnings, warningsCount: r.warningsCount })
    }
  })
  return out
}

/** ZIP に入れる CSV のファイル名 */
export const LITIGATION_ERRORS_CSV_FILENAME = 'エラー一覧.csv'

/**
 * エラー一覧の CSV。**先頭に UTF-8 BOM** を付ける (Excel が Shift_JIS と誤認しないため)。
 * 1 行 = 乗務員 × 月、各検知は「判定」と「内容」の 2 列。冊単位の Y時間の警告は
 * 月に割り振れないので、空行のあとに別の表として続ける。
 */
export function litigationErrorsCsv(
  rows: readonly LitigationErrorRow[],
  driverName: (driverCd: string) => string,
  warnings: readonly LitigationChunkWarning[],
): string {
  const lines: string[] = []
  const header = ['乗務員CD', '氏名', '月']
  for (const k of LITIGATION_CHECK_KEYS) header.push(`${LITIGATION_CHECK_LABELS[k]} 判定`, `${LITIGATION_CHECK_LABELS[k]} 内容`)
  lines.push(header.map(csvCell).join(','))
  for (const r of rows) {
    const cols = [r.driverCd, driverName(r.driverCd), r.month]
    for (const k of LITIGATION_CHECK_KEYS) cols.push(LITIGATION_CHECK_STATE_LABELS[r.cells[k].state], r.cells[k].message)
    lines.push(cols.map(csvCell).join(','))
  }
  if (warnings.length > 0) {
    lines.push('')
    lines.push(['乗務員CD', '氏名', '期間', 'Y時間の警告 (冊単位・月に割り振れない)'].map(csvCell).join(','))
    for (const w of warnings) {
      const more = w.warningsCount > w.warnings.length ? ` ほか (全 ${w.warningsCount} 件)` : ''
      lines.push([w.driverCd, driverName(w.driverCd), w.label, `${w.warnings.join(' / ')}${more}`].map(csvCell).join(','))
    }
  }
  return `﻿${lines.join('\n')}\n`
}

// ---- 取り込みボタン ----

/**
 * 運行月 `month` を取り込むときに relay へ渡す期間 (**読取日**)。運行月とその翌月の 2 本。
 * 長距離の運行は運行終了の数日後に読み取られるので、運行月だけだと月末の運行を取りこぼす。
 * relay の期間上限が 31 日なので 1 か月ずつに分ける (呼ぶ側は直列に 1 本ずつ)。
 */
export function litigationImportRanges(month: string): { from: string, to: string }[] {
  return [litigationMonthBounds(month), litigationMonthBounds(nextYm(month))]
}

export type LitigationImportKind = 'ok' | 'empty' | 'forbidden' | 'error'

export interface LitigationImportOutcome {
  kind: LitigationImportKind
  message: string
}

/**
 * theearth の空 ZIP (その期間に運行が無い) を示す文言。relay の
 * `theearth-client.ts` `notZipMessage` が返す文の一部 — **relay の文言を変えたらここも**。
 * 空 ZIP 以外の「ZIP でない」(ログイン切れ等) は別の文言なので失敗のまま残る。
 */
export const THEEARTH_EMPTY_ZIP_MARKER = '空の ZIP'

/**
 * `POST /restraint-api/litigation/alc-upload-driver` の応答 1 本を分類する。
 * - 2xx → `ok` (取り込んだ運行の件数)
 * - 502 かつ本文の `error` が空 ZIP の文 → `empty` (**失敗扱いにしない**。theearth にも無い)
 * - 403 → `forbidden` (取り込みは admin / payroll だけ)
 * - それ以外 → `error` (`reason` は呼び出し側が `api-error.ts` で組んだ 1 文)
 */
export function classifyLitigationImport(httpStatus: number | null, body: unknown, reason: string): LitigationImportOutcome {
  const b = (body ?? {}) as { operations_count?: unknown, split_failed?: unknown, error?: unknown }
  if (httpStatus !== null && httpStatus >= 200 && httpStatus < 300) {
    const count = typeof b.operations_count === 'number' ? `${b.operations_count} 件` : '件数不明'
    const split = typeof b.split_failed === 'number' && b.split_failed > 0
      ? ` (CSV 分割の失敗 ${b.split_failed} 件 — スクレイプ画面の「未分割をまとめて分割」で直してください)`
      : ''
    return { kind: 'ok', message: `取り込み ${count}${split}` }
  }
  if (httpStatus === 502 && typeof b.error === 'string' && b.error.includes(THEEARTH_EMPTY_ZIP_MARKER)) {
    return { kind: 'empty', message: 'その期間に運行なし (theearth にも無い)' }
  }
  if (httpStatus === 403) return { kind: 'forbidden', message: '取り込みは admin / payroll のみ' }
  return { kind: 'error', message: reason }
}
