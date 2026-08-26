/**
 * デジタコ (theearth 拘束時間管理表) と 打刻 (live-build) の**月計拘束**の突合
 * (Refs #606 PR-F)。
 *
 * ## 何と何を比べているか (出どころを混ぜないこと)
 *
 * | 側 | 出どころ | 取得元 |
 * |---|---|---|
 * | **デジタコ** | **R2** (`restraint/` prefix の summary latest) | `GET /restraint-api/archive/summaries` |
 * | **打刻** | **live-build** (ichiban 経由でその場で組む) | `GET /restraint-api/wage-report` の `source === 'timecard'` 行 |
 *
 * 拘束時間の正は 2 系統あり、**アーカイブ (R2) と wage-report (live-build) は別の口**
 * なので、片方が欠けているだけで結論が 180 度変わる。**画面には必ず出どころを書く。**
 *
 * ## 「どちらが正か」はここでは決めない
 *
 * 採否は既にサーバ側で確定している — `mergeSummarySources`
 * (`workers/dtako-scraper-relay/src/timecard-summary.ts`) が乗務員CD 単位で
 * **打刻を採用**し、デジタコ側は打刻から構造的に出せない 6 指標の埋め戻し
 * (`fillTheearthOnlyMetrics`) にしか使わない。**負けた側の拘束は wage-report の
 * 応答に残らない**ので、ここでアーカイブを読み直して並べている。
 *
 * 画面が別の推奨を出すと**実際に賃金計算へ入った値と食い違う 2 つ目の「正」**が
 * 生まれるため、このモジュールは「どちらを採ったか」と「差がいくつか」しか出さない。
 * 三源目 (デジタコ運行からの算出) は #612 で保留中なので、**審判はまだ居ない。**
 *
 * ## 差の向き
 *
 * `diffMinutes` は **打刻 − デジタコ**。`kosoku-daily.ts` が実測付きで記録している
 * とおり**打刻で測ると拘束は増える**ので、正の値が設計どおりの向き。
 * **閾値 (許容誤差) は置かない** — 系統差の大きさは月・乗務員で変わり、
 * 勝手な閾値は「正常を異常に見せる」方向にしか効かないため。
 */

import type { RestraintDriverSummary, WageReportRow } from './restraint-wage-view'
import { fmtMinutes } from './restraint-wage-view'

/** `GET /restraint-api/archive/summaries` の `summaries[]` 1 件 (relay の応答と同型)。 */
export interface ArchiveSummaryEntry {
  data: RestraintDriverSummary
  fetchedAt: string | null
  lastVerifiedAt: string | null
}

/**
 * その乗務員をどちらの側が持っていたか。**「差が無い」とは別の軸**で、
 * `both` 以外は**比較していない** (差を 0 と読ませない)。
 */
export type RestraintSourceDiffKind = 'both' | 'theearth-only' | 'timecard-only'

export interface RestraintSourceDiffRow {
  driverCd: string
  driverName: string
  branchName: string
  kind: RestraintSourceDiffKind
  /** デジタコ (R2 アーカイブ) の月計拘束 (分)。その側に居なければ null。 */
  theearthMinutes: number | null
  /** 打刻 (live-build) の月計拘束 (分)。その側に居なければ null。 */
  timecardMinutes: number | null
  /**
   * **打刻 − デジタコ** (分)。**片側でも数値が無ければ null** —
   * 「差が無い (0)」と「比べられなかった (null)」を絶対に混ぜない。
   * `kind === 'both'` でも、拘束そのものが null の行では null になる。
   */
  diffMinutes: number | null
}

/** 区分の日本語ラベル。**「欠けている」とは書かない** — 下の注記を参照。 */
export const RESTRAINT_SOURCE_DIFF_KIND_LABEL: Record<RestraintSourceDiffKind, string> = {
  'both': '両方あり',
  'theearth-only': 'デジタコのみ',
  'timecard-only': '打刻のみ',
}

/**
 * 区分の意味 (title 属性等に出す短い説明)。
 *
 * **`theearth-only` を「打刻が欠けている」と書かないこと。** #613 で確定したとおり
 * **打刻システムは本社にしかない**ので、営業所の専業ドライバーに打刻が無いのは正常。
 */
export const RESTRAINT_SOURCE_DIFF_KIND_NOTE: Record<RestraintSourceDiffKind, string> = {
  'both': '両方に月計拘束があるので差を出しています (賃金に入るのは打刻側)',
  'theearth-only': 'デジタコにしか居ないため比較していません。営業所には打刻システムが無いのが正常です (#613)',
  'timecard-only': '打刻にしか居ないため比較していません (デジタコに乗らない本社系)',
}

/**
 * 表の「区分」列に出す文字列。
 *
 * ★ **`both` なのに比べられなかった行を「両方あり」とだけ書かない。** 値の列は
 * `fmtMinutes(null)` = `-` になるので、**「両方あり」と `-` が矛盾して読める**
 * (2026-08-26 の dev 実機確認で発見。差分レビューでは出なかった型)。
 * **どちら側の拘束が空なのかまで言い切る。**
 */
export function restraintSourceDiffKindLabel(
  row: Pick<RestraintSourceDiffRow, 'kind' | 'theearthMinutes' | 'timecardMinutes' | 'diffMinutes'>,
): string {
  const base = RESTRAINT_SOURCE_DIFF_KIND_LABEL[row.kind]
  if (row.kind !== 'both' || row.diffMinutes !== null) return base
  if (row.theearthMinutes === null && row.timecardMinutes === null) return `${base} (両方とも拘束が空)`
  return row.theearthMinutes === null ? `${base} (デジタコの拘束が空)` : `${base} (打刻の拘束が空)`
}

function makeRow(
  driverCd: string,
  named: Pick<RestraintDriverSummary, 'driverName' | 'branchName'>,
  theearthMinutes: number | null,
  timecardMinutes: number | null,
  kind: RestraintSourceDiffKind,
): RestraintSourceDiffRow {
  return {
    driverCd,
    driverName: named.driverName,
    branchName: named.branchName,
    kind,
    theearthMinutes,
    timecardMinutes,
    // 片側が null の行で 0 を作らない (「一致」に化ける)
    diffMinutes: theearthMinutes === null || timecardMinutes === null
      ? null
      : timecardMinutes - theearthMinutes,
  }
}

/**
 * アーカイブ (デジタコ) と wage-report (打刻) を乗務員CD で突き合わせて 1 行に畳む。
 *
 * 打刻側は **`source === 'timecard'` の行だけ**を採る — `source === 'theearth'` の行は
 * `mergeSummarySources` がアーカイブ側をそのまま通したものなので、採ると
 * **同じ値どうしを比べて「一致」と出してしまう。**
 *
 * 氏名・事業所は**採用された側**を優先する (`both` は打刻側) — 表の他の場所に出て
 * いる名前と食い違わせないため。並びは呼び出し側 (`sortRestraintSourceDiffRows`)。
 */
export function buildRestraintSourceDiffRows(
  theearth: readonly ArchiveSummaryEntry[],
  report: readonly WageReportRow[],
): RestraintSourceDiffRow[] {
  const punchByCd = new Map<string, RestraintDriverSummary>()
  for (const row of report) {
    if (row.source === 'timecard') punchByCd.set(row.summary.driverCd, row.summary)
  }
  const rows: RestraintSourceDiffRow[] = []
  const seen = new Set<string>()
  for (const entry of theearth) {
    const dtako = entry.data
    seen.add(dtako.driverCd)
    const punch = punchByCd.get(dtako.driverCd)
    rows.push(punch === undefined
      ? makeRow(dtako.driverCd, dtako, dtako.restraintMinutes, null, 'theearth-only')
      : makeRow(dtako.driverCd, punch, dtako.restraintMinutes, punch.restraintMinutes, 'both'))
  }
  for (const [driverCd, punch] of punchByCd) {
    if (seen.has(driverCd)) continue
    rows.push(makeRow(driverCd, punch, null, punch.restraintMinutes, 'timecard-only'))
  }
  return rows
}

/**
 * 並び: **比べられた行を差の絶対値が大きい順**に上へ、比べられなかった行はその下へ
 * (乗務員CD 昇順)。外れ値を上に出すのがこの表の唯一の運用価値なので、
 * 「一致した行」と「比較不能な行」はどちらも下に沈める。
 *
 * 同値の並びは乗務員CD の数値昇順で安定させる (`localeCompare` を使わないのは
 * ICU の照合順が Windows と Linux (CI) で食い違うため。`mergeSummarySources` と同じ理由)。
 */
export function sortRestraintSourceDiffRows(
  rows: readonly RestraintSourceDiffRow[],
): RestraintSourceDiffRow[] {
  return [...rows].sort((a, b) => {
    const ad = a.diffMinutes
    const bd = b.diffMinutes
    if (ad === null || bd === null) {
      // 片方だけ比較不能なら、比較できた方を上へ。両方 null なら CD 順に落とす
      if (ad !== bd) return ad === null ? 1 : -1
    }
    else {
      const d = Math.abs(bd) - Math.abs(ad)
      if (d !== 0) return d
    }
    return Number(a.driverCd) - Number(b.driverCd)
  })
}

/**
 * 一覧の見出しに出す件数。**合計は「比べられた行だけ」の合計**で、
 * 比較不能な行は 1 分も足していない (母集団を混ぜると差の大きさが読めなくなる)。
 */
export interface RestraintSourceDiffSummary {
  /** 差を出せた人数 (`diffMinutes !== null`)。 */
  comparedCount: number
  /** そのうち差が 0 だった人数。 */
  matchedCount: number
  /** そのうち差があった人数。 */
  differentCount: number
  /** デジタコにしか居ない人数 (営業所。打刻が無いのは正常)。 */
  theearthOnlyCount: number
  /** 打刻にしか居ない人数。 */
  timecardOnlyCount: number
  /** 両方に居るのに拘束が null で比べられなかった人数。 */
  bothButNoValueCount: number
  /** 比べられた行だけのデジタコ月計合計 (分)。 */
  theearthMinutes: number
  /** 比べられた行だけの打刻月計合計 (分)。 */
  timecardMinutes: number
  /** 上記 2 つの差 (打刻 − デジタコ)。 */
  diffMinutes: number
}

/** 一覧を 1 行に畳む。並び順に依存しない。 */
export function summarizeRestraintSourceDiff(
  rows: readonly RestraintSourceDiffRow[],
): RestraintSourceDiffSummary {
  const s: RestraintSourceDiffSummary = {
    comparedCount: 0,
    matchedCount: 0,
    differentCount: 0,
    theearthOnlyCount: 0,
    timecardOnlyCount: 0,
    bothButNoValueCount: 0,
    theearthMinutes: 0,
    timecardMinutes: 0,
    diffMinutes: 0,
  }
  for (const row of rows) {
    if (row.diffMinutes === null) {
      if (row.kind === 'theearth-only') s.theearthOnlyCount += 1
      else if (row.kind === 'timecard-only') s.timecardOnlyCount += 1
      else s.bothButNoValueCount += 1
      continue
    }
    s.comparedCount += 1
    if (row.diffMinutes === 0) s.matchedCount += 1
    else s.differentCount += 1
    s.theearthMinutes += row.theearthMinutes!
    s.timecardMinutes += row.timecardMinutes!
    s.diffMinutes += row.diffMinutes
  }
  return s
}

/**
 * **月まるごと比べられない**ときの理由 (比べられるなら null)。
 *
 * ★ これを出さずに「差のある乗務員はいません」とだけ書くと、**片側がまるごと
 * 落ちている月が「全員一致」に見える。** この repo で一番多い欠陥の型なので、
 * 0 行の理由は必ず名指しする。
 */
export function restraintSourceDiffUnavailableReason(
  summary: Pick<RestraintSourceDiffSummary, 'comparedCount' | 'theearthOnlyCount' | 'timecardOnlyCount'>,
): string | null {
  if (summary.comparedCount > 0) return null
  if (summary.theearthOnlyCount === 0 && summary.timecardOnlyCount === 0) {
    return 'この月はデジタコ側にも打刻側にも行がありません。どちらも取り込まれていないので、比較できていません (差が無いという意味ではありません)。'
  }
  if (summary.theearthOnlyCount === 0) {
    return 'この月はデジタコ (拘束時間管理表) を一度も取り込んでいないため、全員が比較できていません。無人で埋まる経路は無いので、画面『拘束CSV取得』でこの月を取り込んでください。'
  }
  if (summary.timecardOnlyCount === 0) {
    return 'この月は打刻側 (live-build) の行が 1 件もないため、全員が比較できていません。取り込み先の疎通を確認してください (古い写しにはフォールバックしません)。'
  }
  return '両方に居る乗務員が 1 人もいないため、比較できた行がありません。デジタコと打刻で乗務員CD の集合が重なっていません。'
}

/**
 * 符号つきの差 (分) → `+XhYYm` / `-XhYYm`。**null は「-」ではなく「比較不能」**と
 * 書き分ける — `fmtMinutes` の `-` を流用すると「0 に近い差」と見分けが付かない。
 *
 * `fmtMinutes` をそのまま負数に当てると `-2h-30m` になる (`%` が負を返す) ので、
 * **絶対値に当ててから符号を前置する。**
 */
export function fmtRestraintSourceDiffMinutes(minutes: number | null): string {
  if (minutes === null) return '比較不能'
  if (minutes === 0) return '±0'
  return `${minutes > 0 ? '+' : '-'}${fmtMinutes(Math.abs(minutes))}`
}
