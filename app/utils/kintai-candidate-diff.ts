/**
 * 取り込み漏れ候補 (`kintai-unko-gaps.ts` の `drivers[].{driverCd, unkoNos}`) と
 * オンプレ vs Supabase の値差 (`kintai-diff-view.ts` の
 * `KintaiDiffValueDiffItem[]`) を、**乗務員CD + 運行日**で突き合わせる pure ロジック
 * (Refs #633-1、#633-3 で day_absent/one_sided を追加)。
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
 *
 * ★★ #633-3 で直したバグの原型 (絶対に繰り返さないこと): 値差 items に見当たらない
 * 日を無条件に「両側一致」と読んでいた。しかし運行NOの先頭6桁は**運行の開始日**で
 * あって**勤怠の暦日**ではない — 日跨ぎ勤務 (前日 20 時台開始・翌日終業) では
 * 折り畳んだ勤務の暦日が運行の開始日と1日ずれる。この場合その日はそもそも
 * **突き合わせてすらいない** (両側とも行が存在しない)。「一致」と「未突合」を
 * 区別するため、relay の `compared_days` (両側に行があった日、一致していても
 * 不一致でも入る) を必ず経由すること — **`compared_days` を「一致した日」と
 * 読み替えたくなったら、それがこのバグの再発**。
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

/** `day_absent`/`one_sided` 判定に要る「日」単位の材料 (Refs #633-3)。
 * キーは全て `normalizeDriverCdKeyLocal` 済みの `乗務員CD|暦日` — 呼び出し側
 * ([`buildKintaiCandidateDayCoverage`]) が1回だけ正規化して Set にまとめ、
 * 候補1件ずつの照合は `.has()` (O(1)) で済ませる。 */
export interface KintaiCandidateDayCoverage {
  /** 両側に行があった日 (一致していても不一致でも入る — 「比較できた」の意味)。 */
  comparedDays: Set<string>
  /** `compared_days` がカテゴリ上限で切られていたか。true のときは
   * `comparedDays` に無くても「両側に無い」と断定できない (見えている範囲が
   * 全部ではないため) — 呼び出し側は `unconfirmed` に倒すこと。 */
  comparedDaysCapped: boolean
  /** GCP にしか行が無かった日。 */
  onlyGcpDays: Set<string>
  /** オンプレにしか行が無かった日 (`only_onprem_driver0` + `only_onprem_other`)。 */
  onlyOnpremDays: Set<string>
}

/** ライブ取得の3状態。`kintai-diff-view.ts` の `KintaiDiffCacheState` と同じ形に
 * 揃える (「未確認」「読めなかった」「確認済み」を混同しないための共通作法)。
 * `dayCoverage: null` は `compared_days` が応答に無い/壊れている (古いキャッシュ・
 * 将来の形変更) — この場合 `match`/`mismatch` 以外はすべて `unconfirmed` に倒す
 * (「一致」と嘘をつくより「判別できない」と言う方を選ぶ、Refs #633-3)。 */
export type KintaiCandidateDiffItemsState =
  | { status: 'none' }
  | { status: 'unreadable' }
  | {
    status: 'ok'
    items: KintaiCandidateDiffItems
    dayCoverage: KintaiCandidateDayCoverage | null
    lastVerifiedAt: string | null
  }

export type KintaiCandidateDiffResult =
  /** この月の値差をまだライブ取得していない、または読めなかった。
   * 「両側一致」と混同しないこと — 判定材料がまだ無いだけ。
   * `compared_days` が応答に無い/capped のときもここに倒す (Refs #633-3)。 */
  | { kind: 'unconfirmed', date: string | null }
  /** 値差の一覧 (取得済み) に見当たらず、かつ `compared_days` に両側の行があった
   * ことが確認できた日。**ここで初めて「その日は両側一致」と言ってよい。** */
  | { kind: 'no_diff', date: string, lastVerifiedAt: string | null }
  /** 値が違うが拘束時間 (`restraint_minutes`) は一致 (内訳だけ違う)。 */
  | { kind: 'match', date: string, lastVerifiedAt: string | null, item: KintaiCandidateDiffItem }
  /** 拘束時間も不一致。 */
  | { kind: 'mismatch', date: string, lastVerifiedAt: string | null, item: KintaiCandidateDiffItem }
  /** `compared_days` に無く、`only_gcp`/`only_onprem_*` の items にも無い — **その日は
   * 両側とも勤務行が存在せず、突き合わせていない** (日跨ぎ勤務で運行の開始日と
   * 勤怠の暦日がずれている可能性、1445/2026-06-25 の実例)。「一致」でも「不一致」
   * でもなく「判定できない」という意味 (Refs #633-3)。 */
  | { kind: 'day_absent', date: string, lastVerifiedAt: string | null }
  /** `compared_days` に無いが、`only_gcp` または `only_onprem_*` の items にはある —
   * 片側にしか勤務行が無い日 (Refs #633-3)。 */
  | { kind: 'one_sided', date: string, lastVerifiedAt: string | null, side: 'gcp' | 'onprem' }

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

function dayCoverageKey(driverCd: string, date: string): string {
  return `${normalizeDriverCdKeyLocal(driverCd)}|${date}`
}

/** relay の生キー (`乗務員CD|暦日`、前ゼロ等は未正規化) を正規化して Set にする。 */
function normalizeRawDayKeys(rawKeys: string[]): Set<string> {
  const out = new Set<string>()
  for (const raw of rawKeys) {
    const sep = raw.indexOf('|')
    if (sep < 0) {
      out.add(raw)
      continue
    }
    out.add(dayCoverageKey(raw.slice(0, sep), raw.slice(sep + 1)))
  }
  return out
}

/**
 * `kintai-diff-view.ts` の `parseKintaiDiffDayCoverageFromResponse` が返す生データから
 * [`KintaiCandidateDayCoverage`] を組む (1回だけ正規化、候補ごとの照合は `.has()` で
 * 済ませるため)。`comparedDays: null` (`compared_days` が応答に無い/壊れている) の
 * ときは `null` を返す — 呼び出し側は `dayCoverage: null` として状態に持たせ、
 * `lookupKintaiCandidateDiff` が `unconfirmed` に倒す。
 */
export function buildKintaiCandidateDayCoverage(raw: {
  comparedDays: { keys: string[], capped: boolean } | null
  onlyGcpDays: Array<{ driverCd: string, date: string }>
  onlyOnpremDays: Array<{ driverCd: string, date: string }>
}): KintaiCandidateDayCoverage | null {
  if (!raw.comparedDays) return null
  return {
    comparedDays: normalizeRawDayKeys(raw.comparedDays.keys),
    comparedDaysCapped: raw.comparedDays.capped,
    onlyGcpDays: new Set(raw.onlyGcpDays.map(r => dayCoverageKey(r.driverCd, r.date))),
    onlyOnpremDays: new Set(raw.onlyOnpremDays.map(r => dayCoverageKey(r.driverCd, r.date))),
  }
}

/**
 * 1件の候補 (乗務員CD + 運行NO) を、取得済みの値差一覧・日カバレッジと突き合わせる。
 *
 * 判定順序 (Refs #633-3、この順で決め打つ):
 * 1. `itemsState.status !== 'ok'`、または運行NOの桁数が不正で運行日を作れない → `unconfirmed`
 * 2. 値差 items (`mismatch` を `match` より優先) に見つかれば、その区分をそのまま返す
 *    (値差 items にある = 両側に行がある確定なので、`compared_days` を見るまでもない)
 * 3. `dayCoverage` が無い、または `comparedDaysCapped` → `unconfirmed`
 *    (「一致」と嘘をつくより「判別できない」と言う方を選ぶ)
 * 4. `compared_days` にあれば `no_diff` (**ここで初めて「両側一致」と言ってよい**)
 * 5. `only_gcp`/`only_onprem_*` のどちらかにあれば `one_sided`
 * 6. どこにも無ければ `day_absent` (両側とも突き合わせていない)
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

  const coverage = itemsState.dayCoverage
  if (!coverage || coverage.comparedDaysCapped) return { kind: 'unconfirmed', date }

  const dayKey = dayCoverageKey(driverCd, date)
  if (coverage.comparedDays.has(dayKey)) {
    return { kind: 'no_diff', date, lastVerifiedAt: itemsState.lastVerifiedAt }
  }
  if (coverage.onlyGcpDays.has(dayKey)) {
    return { kind: 'one_sided', date, lastVerifiedAt: itemsState.lastVerifiedAt, side: 'gcp' }
  }
  if (coverage.onlyOnpremDays.has(dayKey)) {
    return { kind: 'one_sided', date, lastVerifiedAt: itemsState.lastVerifiedAt, side: 'onprem' }
  }
  return { kind: 'day_absent', date, lastVerifiedAt: itemsState.lastVerifiedAt }
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
