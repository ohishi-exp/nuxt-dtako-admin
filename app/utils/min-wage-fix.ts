/**
 * 「判定できない」月の直し方 (Refs #1133) — 訴訟準備・給与比較と拘束×賃金・最低賃金チェックの共通部分。
 *
 * 画面側の部品は `MinWageFixesPanel.vue` (パネル) と `MinWageRateMasterButton.vue`
 * (単価マスタを最低賃金で作る)。ここは relay の既存の口 2 本の body の組み立て・応答の要約と、
 * 理由ごとの集計だけを持つ (coverage gate 対象)。
 *
 * **最低賃金がマスタにあるかは front で判定しない** — 月の引き当ては relay `minWageForBranch` が
 * 正本。引けなかった結果 (`minWageRate` null) と、県が引けたか (`minWagePrefecture`) だけを見る。
 */

/** 月 × 乗務員 1 件ぶんの材料 (wage-report の `wage.hourlyRate` / `wage.minWage` から作る)。 */
export interface MinWageFixInput {
  driverCd: string
  /** 勤務月 `YYYY-MM` */
  month: string
  hourlyRate: number | null
  minWageRate: number | null
  /** `mapped: false` でも非 null なら県は引けている (既定の県で額を引く)。null だけが「県が引けない」 */
  minWagePrefecture: string | null
}

/** 直し方 1 種類ぶん: 該当の件数・月の範囲 (両端を含む)・乗務員CD (重複なし、出現順)。 */
export interface MinWageFixGroup {
  count: number
  from: string
  to: string
  driverCds: string[]
}

export interface MinWageFixes {
  /** 最低賃金が引けない月のうち、県は引けている (過去の改定を取り込めば引ける見込み) */
  minWageMissing: MinWageFixGroup | null
  /** 最低賃金が引けない月のうち、所属から県が引けない (県を設定するまで取り込んでも引けない) */
  prefectureMissing: MinWageFixGroup | null
  /** 単価マスタに単価が無い月 (最低賃金も引けない月と重なることがある — 両方の手当てが要る) */
  rateMissing: MinWageFixGroup | null
}

function group(rows: MinWageFixInput[]): MinWageFixGroup | null {
  if (rows.length === 0) return null
  const months = rows.map(r => r.month).sort()
  return { count: rows.length, from: months[0]!, to: months[months.length - 1]!, driverCds: [...new Set(rows.map(r => r.driverCd))] }
}

/** 理由ごとに数える。どれも無ければ全部 null (パネルを出さない)。 */
export function minWageFixes(rows: readonly MinWageFixInput[]): MinWageFixes {
  return {
    minWageMissing: group(rows.filter(r => r.minWageRate === null && r.minWagePrefecture !== null)),
    prefectureMissing: group(rows.filter(r => r.minWageRate === null && r.minWagePrefecture === null)),
    rateMissing: group(rows.filter(r => r.hourlyRate === null)),
  }
}

export function hasMinWageFixes(f: MinWageFixes): boolean {
  return f.minWageMissing !== null || f.prefectureMissing !== null || f.rateMissing !== null
}

/** `3 件 (2025-01〜2025-03)` / 1 か月なら `1 件 (2025-01)` */
export function fmtMinWageFixGroup(g: MinWageFixGroup): string {
  return `${g.count} 件 (${g.from === g.to ? g.from : `${g.from}〜${g.to}`})`
}

// --- 過去の最低賃金の取り込み (POST /restraint-api/min-wage/import-mhlw) ---

export interface MinWageImportResponse {
  changed: boolean
  prefectures: number
  added: number
  updated: number
  unchanged?: number
  /** 履歴 (`source: 'history'`) のときだけ */
  years?: { from: string, to: string }
}

/** 取り込み結果の 1 文。全国一覧は県数、履歴は (県, 発効日) の件数が返る。取り込みは冪等 (変化なしは「改定なし」) */
export function describeMinWageImport(res: MinWageImportResponse): string {
  const range = res.years ? ` (${res.years.from}〜${res.years.to})` : ''
  const unit = res.years ? '件' : '都道府県'
  return res.changed
    ? `厚労省から ${res.prefectures} ${unit}を取り込みました${range} (新規 ${res.added} / 更新 ${res.updated})`
    : `厚労省から ${res.prefectures} ${unit}を確認しました${range} (改定なし)`
}

/** relay の取り込み口を叩く (拘束×賃金の「最新を取り込む / 過去の改定も取り込む」と「直し方」の共通)。 */
export function importMinWageFromMhlw<T extends MinWageImportResponse>(headers: Record<string, string>, source?: 'history'): Promise<T> {
  return $fetch<T>('/restraint-api/min-wage/import-mhlw', {
    method: 'POST',
    headers,
    ...(source ? { body: { source } } : {}),
  })
}

// --- 単価マスタを最低賃金で作る (POST /restraint-api/min-wage/apply-to-wage-master の driverCds / until) ---

export type RateMasterApplyStatus = 'add' | 'overwrite' | 'keep' | 'unmapped' | 'no-rate' | 'no-branch'

export interface RateMasterApplyItem {
  driverCd: string
  branch: string
  prefecture: string | null
  rate: number | null
  rateEffectiveFrom: string | null
  status: RateMasterApplyStatus
  prefectureDefaulted?: true
}

export interface RateMasterApplyResponse {
  added: number
  kept: number
  unresolved: number
  items: RateMasterApplyItem[]
  saved: boolean
}

/** 月の末日 `YYYY-MM-DD` */
function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

/** 期間 (勤務月 from〜to) の最低賃金の改定を、指定の乗務員に入れる body。`overwrite` は送らない
 * (単価がある乗務員は relay が keep にする — 会社が決めた単価を潰さない)。 */
export function buildRateMasterApplyBody(input: { driverCds: readonly string[], from: string, to: string, dryRun: boolean }) {
  return {
    asOf: `${input.from}-01`,
    until: monthEnd(input.to),
    driverCds: [...input.driverCds],
    ...(input.dryRun ? { dryRun: true } : {}),
  }
}

const STATUS_NOTE: Record<Exclude<RateMasterApplyStatus, 'add' | 'overwrite'>, string> = {
  'keep': '既に単価がある — 触りません (単価マスタタブで確認)',
  'unmapped': '所属から県が引けない — 拘束×賃金 → 最低賃金チェック → ▸ 最低賃金 で拠点の県を設定',
  'no-rate': 'その県の最低賃金が期間中に無い — 過去の最低賃金を取り込んでからやり直す',
  'no-branch': '社員マスタに所属が無い — 拘束×賃金の社員マスタタブで所属を入れる',
}

export interface RateMasterApplyLine {
  driverCd: string
  /** `架空県 1,000円/h (2024-10-05 発効)` か、入らない理由 */
  text: string
  willAdd: boolean
}

/** 応答を画面の行にする (入る行は 県・円/h・発効日、入らない人は理由)。 */
export function rateMasterApplyLines(res: RateMasterApplyResponse): RateMasterApplyLine[] {
  return res.items.map((i) => {
    if (i.status === 'add' || i.status === 'overwrite') {
      const pref = `${i.prefecture}${i.prefectureDefaulted ? ' (所属に県が無く既定の県)' : ''}`
      return { driverCd: i.driverCd, text: `${pref} ${i.rate!.toLocaleString('ja-JP')}円/h (${i.rateEffectiveFrom} 発効)`, willAdd: true }
    }
    return { driverCd: i.driverCd, text: STATUS_NOTE[i.status], willAdd: false }
  })
}

/** 確定後の 1 文。 */
export function describeRateMasterApply(res: RateMasterApplyResponse): string {
  const rest = [res.kept ? `据え置き ${res.kept} 名` : '', res.unresolved ? `入れられない ${res.unresolved} 名` : ''].filter(Boolean)
  return `単価マスタに ${res.added} 行を入れました${rest.length ? ` (${rest.join(' / ')})` : ''}`
    + (res.added > 0 ? ' — 続けて材料を取り直してください' : '')
}
