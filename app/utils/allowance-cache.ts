/**
 * 運行手当タブの取得結果をブラウザに残す (pure)。
 *
 * 1 か月ぶんの集計は**イベントCSV を運行の本数だけ引く**ので重い (2026-07 の帯広5台で
 * 90 本、30 秒強)。運行詳細を見て戻ってくるたびに引き直すのは現実的でないため、
 * **切り出した便と一番星の明細を localStorage に残し、次からは差分だけ引く**。
 *
 * **残すのは「引いた生の材料」だけで、金額は残さない。** 料金・給与マスタは
 * コードに入っていて更新されるので、古い金額を持ち回ると**マスタを直したのに
 * 画面が変わらない**という最悪の壊れ方をする。読み込み時に必ず引き直す。
 *
 * **再取得が要るかは運行一覧で判定する。** 一覧 (`/api/operations`) は軽いので毎回
 * 引き、**運行NO と `has_kudgivt` が一致する運行だけ**キャッシュを使う。取り込み直しが
 * 走れば `has_kudgivt` が `false` に戻るので、そこで自動的に引き直しになる。
 */
import type { AllowanceLeg, CarryInUnload } from './allowance-trips'
import type { VehicleDailySlip } from './ichiban'

/** localStorage のキー。**形を変えるときは番号を上げる** (古い形は捨てられる)。 */
export const CACHE_KEY = 'dtako:allowance:cache:v1'
export const CACHE_VERSION = 1

/** 残す月数。増やすほど localStorage を食うので、直近だけ持つ。 */
export const MAX_MONTHS = 3

/** キャッシュに残す 1 運行ぶん。**手当 (金額) は入れない。** */
export interface CachedOperation {
  unkoNo: string
  readingDate: string
  operationDate: string | null
  driverName: string | null
  vehicleName: string | null
  /** 引いた時点の `has_kudgivt`。**これが変わったら引き直す。** */
  hasKudgivt: boolean
  legs: AllowanceLeg[]
  carryIn: CarryInUnload
  /** 引けなかった理由。**入っていればキャッシュを使わない** (一過性の失敗がありうる)。 */
  error: string | null
}

export interface MonthCache {
  ym: string
  /** 保存時刻 (ISO)。人に見せるのと、古い月を捨てる順を決めるのに使う。 */
  savedAt: string
  operations: CachedOperation[]
  /** 車輌C → 一番星明細。受け皿の車番も 1 つの車輌C として入る。 */
  slips: Record<string, VehicleDailySlip[]>
}

export interface CacheFile {
  version: number
  months: MonthCache[]
}

export function emptyCache(): CacheFile {
  return { version: CACHE_VERSION, months: [] }
}

/**
 * localStorage の中身を読む。**壊れていても投げない** — 空として扱って引き直す。
 * 版が違うキャッシュも捨てる (形が変わっているので信用できない)。
 */
export function parseCache(raw: string | null | undefined): CacheFile {
  if (!raw) return emptyCache()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return emptyCache()
  }
  const file = parsed as Partial<CacheFile>
  if (file?.version !== CACHE_VERSION || !Array.isArray(file.months)) return emptyCache()
  return { version: CACHE_VERSION, months: file.months }
}

export function serializeCache(file: CacheFile): string {
  return JSON.stringify(file)
}

/** その月のキャッシュ。無ければ null。 */
export function findMonth(file: CacheFile, ym: string): MonthCache | null {
  return file.months.find(m => m.ym === ym) ?? null
}

/**
 * 月を差し替えて (無ければ足して) 保存する形にする。
 * **古い月から捨てる** — `savedAt` の新しい順に `MAX_MONTHS` 件だけ残す。
 */
export function putMonth(file: CacheFile, month: MonthCache): CacheFile {
  const others = file.months.filter(m => m.ym !== month.ym)
  const months = [month, ...others]
    .sort((a, b) => (a.savedAt > b.savedAt ? -1 : 1))
    .slice(0, MAX_MONTHS)
  return { version: CACHE_VERSION, months }
}

/** 運行一覧の 1 件のうち、キャッシュを使えるかの判定に要る分だけ。 */
export interface ListedOperation {
  unko_no: string
  has_kudgivt: boolean
}

export interface FetchPlan<T> {
  /** キャッシュをそのまま使う運行。 */
  reuse: CachedOperation[]
  /** 引き直す運行。 */
  fetch: T[]
}

/**
 * 運行一覧とキャッシュを突き合わせて、**どれを引き直すか**を決める。
 *
 * キャッシュを使うのは **運行NO が一致し、`has_kudgivt` も一致し、前回失敗していない**
 * ものだけ。取り込み直しが走ると `has_kudgivt` が `false` に戻るので、それが引き直しの
 * 合図になる。`force` を立てると全部引き直す。
 *
 * **一覧に無くなった運行はキャッシュからも落ちる** (`reuse` は一覧を起点に組むため)。
 */
export function planOperationFetch<T extends ListedOperation>(
  listed: T[],
  cached: CachedOperation[],
  force: boolean,
): FetchPlan<T> {
  if (force) return { reuse: [], fetch: listed }
  const byUnkoNo = new Map(cached.map(op => [op.unkoNo, op]))
  const reuse: CachedOperation[] = []
  const fetch: T[] = []
  for (const item of listed) {
    const hit = byUnkoNo.get(item.unko_no)
    if (hit && hit.error === null && hit.hasKudgivt === item.has_kudgivt) reuse.push(hit)
    else fetch.push(item)
  }
  return { reuse, fetch }
}

export interface SlipPlan {
  /** キャッシュをそのまま使う車輌C の明細。 */
  reuse: Record<string, VehicleDailySlip[]>
  /** 引き直す車輌C。 */
  fetch: string[]
}

/**
 * 一番星の明細をどの車輌C ぶん引き直すか決める。
 *
 * **明細には「変わったか」を判定する材料が無い** (運行の `has_kudgivt` にあたるものが
 * 無い) ので、月のキャッシュがあればそのまま使い、**取り直しは `force` に任せる**。
 * 推測で期限を切ると、直したのに反映されない/毎回引き直すのどちらかに倒れる。
 */
export function planSlipFetch(
  vehicles: string[],
  cached: Record<string, VehicleDailySlip[]>,
  force: boolean,
): SlipPlan {
  const reuse: Record<string, VehicleDailySlip[]> = {}
  const fetch: string[] = []
  for (const vehicle of vehicles) {
    const hit = force ? undefined : cached[vehicle]
    if (hit) reuse[vehicle] = hit
    else fetch.push(vehicle)
  }
  return { reuse, fetch }
}

/** 保存時刻の表示 (`8/21 18:03`)。読めない値は空文字 (画面に `Invalid Date` を出さない)。 */
export function savedAtLabel(savedAt: string): string {
  const ts = Date.parse(savedAt)
  if (Number.isNaN(ts)) return ''
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
