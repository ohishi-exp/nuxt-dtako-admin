/**
 * **手当表PDF から起こした CSV** と、この画面の集計 (デジタコ由来の便) を突き合わせる (pure)。
 *
 * 手当表PDF は**給与の正本**で、デジタコから出した手当が合っているかを確かめる唯一の
 * 外部の物差し。2026-07 の帯広5台で実際に測ると **PDF 313 便 ¥2,765,000 に対して
 * 画面は 267 便 ¥2,357,000** で、46 便ぶん足りなかった。差の内訳 (運行がまるごと無い日 /
 * 同じ日で便が足りない / 画面にしかない便) を**人が追える形で出す**のがこの util の役割。
 *
 * ## 突合の作り
 *
 * **乗務員の中で、日付と経路が合う便どうしを当てる。** 3 段階に分けて、当たり方の質を
 * `dateShift` / `routeDiff` で持って返す (黙って寄せない)。
 *
 * 1. **日付も経路も一致**
 * 2. **経路は一致・日付が ±1 日** — 深夜に積む便は PDF と 1 日ずれることがある
 * 3. **日付は一致・経路が違う** — 卸地の読み違い / 引き当てのズレ
 *
 * どれにも当たらなければ `pdf_only` (画面に無い便) / `screen_only` (PDF に無い便)。
 *
 * ## 経路の語彙は `allowance-rate.ts` に合わせる
 *
 * PDF は `釧路〜士幌` のような手当表の語彙、画面はデジタコの住所。**どちらも
 * `resolveDest` を通してマスタの語彙 (`釧路|溝口`) に寄せてから比べる。**
 * 寄せ方を別に作ると、金額を引くときと突き合わせるときで別の場所を指す。
 */
import { placeKey, resolveDest, normalizePlace } from './allowance-rate'
import { routeKey } from './allowance-provisional'
import { splitDelimitedLine } from './salary-compare'
import type { AllowanceReportRow } from './allowance-report'

/** localStorage のキー。**形を変えるときは番号を上げる。** */
export const PDF_TRIPS_KEY = 'dtako:allowance:pdf:v1'

/**
 * CSV のバイト列を文字列にする。UTF-8 → 失敗したら Shift_JIS。
 *
 * **`salary-file.ts` の `decodeCsvBytes` を使い回さない。** あちらは Excel バイナリを
 * 読むために `xlsx` を module 直下で import しているので、運行手当タブから呼ぶと
 * この画面の chunk に `xlsx` がまるごと乗る。手当表CSV は Excel ではないので要らない。
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return new TextDecoder('shift_jis').decode(bytes)
  }
}

/** PDF から起こした 1 便。 */
export interface PdfTrip {
  /** 氏名 (空白を落としたもの)。PDF は `佐竹繁`、デジタコは `佐竹 繁` と揺れる。 */
  driverName: string
  /** `YYYY-MM-DD`。 */
  date: string
  origin: string
  dest: string
  allowanceYen: number
}

/** 読み込んだ PDF の便と、それが何月ぶんか。 */
export interface PdfTripFile {
  ym: string
  trips: PdfTrip[]
}

/** 氏名の突合キー。空白 (半角・全角) を落とすだけ。 */
export function driverKey(name: string | null | undefined): string {
  return (name ?? '').replace(/[\s　]/g, '')
}

/** PDF 側の経路キー。**画面側の `routeKey` と同じ語彙に寄せる。** */
export function pdfRouteKey(trip: Pick<PdfTrip, 'origin' | 'dest'>): string {
  return `${placeKey(trip.origin)}|${normalizePlace(resolveDest(trip.origin, trip.dest))}`
}

/** 経路の表示 (`釧路 → 溝口`)。片側が空なら `(不明)`。 */
export function routeText(key: string): string {
  const [origin = '', dest = ''] = key.split('|')
  return `${origin || '(不明)'} → ${dest || '(不明)'}`
}

const REQUIRED = ['driver_name', 'date', 'origin', 'dest', 'allowance_yen'] as const
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * `obihiro-profit/allowance_2026-07.csv` の形を読む
 * (`ym,vehicle_no,sheet_code,driver_name,date,trip_seq,route_raw,origin,dest,...,allowance_yen,...`)。
 *
 * **列は名前で探す** — 並び順に依存すると、列が 1 つ増えただけで金額を取り違える。
 * 形が違えば投げる (握りつぶすと「0 便の PDF」と区別が付かない)。読めない行は捨てて
 * 理由を `warnings` に積む。
 */
export function parsePdfAllowanceCsv(text: string): { file: PdfTripFile, warnings: string[] } {
  const lines = text.replace(/﻿/g, '').split(/\r\n|\r|\n/).filter(l => l.trim() !== '')
  if (lines.length === 0) throw new Error('CSV が空です')
  const header = splitDelimitedLine(lines[0]!, ',').map(h => h.trim())
  const missing = REQUIRED.filter(name => !header.includes(name))
  if (missing.length > 0) {
    throw new Error(`列が足りません: ${missing.join(', ')} (手当表PDF から起こした CSV を選んでください)`)
  }
  const at = (cols: string[], name: string) => (cols[header.indexOf(name)] ?? '').trim()
  const trips: PdfTrip[] = []
  const warnings: string[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = splitDelimitedLine(lines[i]!, ',')
    const date = at(cols, 'date')
    const rawYen = at(cols, 'allowance_yen')
    const yen = Number(rawYen)
    if (!YMD_RE.test(date)) {
      warnings.push(`${i + 1} 行目: 日付が読めません (${date || '空'})`)
      continue
    }
    // **空欄を `Number('')` で 0 円にしない。** 金額が抜けた行を ¥0 の便として
    // 数えると、合計だけ静かに減って「PDF 側が安い」ように見える。
    if (rawYen === '' || !Number.isFinite(yen)) {
      warnings.push(`${i + 1} 行目: 金額が読めません (${rawYen || '空'})`)
      continue
    }
    trips.push({
      driverName: driverKey(at(cols, 'driver_name')),
      date,
      origin: at(cols, 'origin'),
      dest: at(cols, 'dest'),
      allowanceYen: yen,
    })
  }
  if (trips.length === 0) throw new Error('読める便が 1 行もありませんでした')
  // 何月ぶんかは**行の日付から決める** (`ym` 列を信じない — 転記のときに直し忘れる)。
  const ym = trips[0]!.date.slice(0, 7)
  return { file: { ym, trips }, warnings }
}

/** 保存済みの PDF を読む。**壊れていても投げない** — 「無かった」として扱う。 */
export function parsePdfTripFile(raw: string | null | undefined): PdfTripFile | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { ym, trips } = parsed as Partial<PdfTripFile>
  if (typeof ym !== 'string' || !Array.isArray(trips) || trips.length === 0) return null
  return { ym, trips }
}

export function serializePdfTripFile(file: PdfTripFile): string {
  return JSON.stringify(file)
}

/** 画面側の 1 便と、そこで実際に払う手当 (確定 or 暫定)。 */
export interface ScreenTrip {
  row: AllowanceReportRow
  /** 確定があればそれ、無ければ暫定。どちらも無ければ null。 */
  payYen: number | null
}

export type PdfCompareStatus = 'matched' | 'pdf_only' | 'screen_only'

/** 突合の 1 行。**当たった質 (`dateShift` / `routeDiff`) を持たせて、黙って寄せない。** */
export interface PdfCompareEntry {
  driverName: string
  status: PdfCompareStatus
  /** 経路は合うが日付が 1 日ずれて当たった。 */
  dateShift: boolean
  /** 日付は合うが経路が違うのに当てた。**人が中身を見る対象。** */
  routeDiff: boolean
  pdfDate: string
  pdfRoute: string
  pdfYen: number | null
  screenDate: string
  screenRoute: string
  screenYen: number | null
  /** 画面 − PDF。どちらか欠けていれば null。 */
  diffYen: number | null
  /** 画面側の便を指す (運行を開くのに使う)。 */
  unkoNo: string
  seq: number
}

/** 乗務員 1 人ぶんのまとめ。 */
export interface PdfCompareDriver {
  driverName: string
  pdfTrips: number
  pdfYen: number
  screenTrips: number
  screenYen: number
  matched: number
  pdfOnly: number
  pdfOnlyYen: number
  screenOnly: number
  screenOnlyYen: number
  /** 当たったが金額が違う便。 */
  amountDiff: number
  amountDiffYen: number
  dateShift: number
  routeDiff: number
}

export interface PdfCompareResult {
  entries: PdfCompareEntry[]
  drivers: PdfCompareDriver[]
  total: PdfCompareDriver
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD` 同士の日数差 (絶対値)。 */
function dayGap(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / MS_PER_DAY
}

function emptyDriver(driverName: string): PdfCompareDriver {
  return {
    driverName,
    pdfTrips: 0,
    pdfYen: 0,
    screenTrips: 0,
    screenYen: 0,
    matched: 0,
    pdfOnly: 0,
    pdfOnlyYen: 0,
    screenOnly: 0,
    screenOnlyYen: 0,
    amountDiff: 0,
    amountDiffYen: 0,
    dateShift: 0,
    routeDiff: 0,
  }
}

interface Slot {
  trip: ScreenTrip
  route: string
  used: boolean
}

/** 1 乗務員ぶんを突き合わせる。3 段階 (日付+経路 → 経路+±1日 → 日付のみ) の順に当てる。 */
function matchOne(driverName: string, pdf: PdfTrip[], screen: ScreenTrip[]): PdfCompareEntry[] {
  const slots: Slot[] = screen.map(trip => ({ trip, route: routeKey(trip.row), used: false }))
  const entries: PdfCompareEntry[] = []
  const rest: PdfTrip[] = []

  const take = (trip: PdfTrip, pass: number): Slot | null => {
    for (const slot of slots) {
      if (slot.used) continue
      const sameRoute = slot.route === pdfRouteKey(trip)
      const gap = dayGap(slot.trip.row.date, trip.date)
      const hit = pass === 1
        ? sameRoute && gap === 0
        : pass === 2 ? sameRoute && gap <= 1 : gap === 0
      if (!hit) continue
      slot.used = true
      return slot
    }
    return null
  }

  const pending = [...pdf]
  const matched = new Map<PdfTrip, { slot: Slot, pass: number }>()
  for (const pass of [1, 2, 3]) {
    for (const trip of pending) {
      if (matched.has(trip)) continue
      const slot = take(trip, pass)
      if (slot) matched.set(trip, { slot, pass })
    }
  }
  for (const trip of pending) {
    const hit = matched.get(trip)
    if (!hit) {
      rest.push(trip)
      continue
    }
    const { row, payYen } = hit.slot.trip
    entries.push({
      driverName,
      status: 'matched',
      dateShift: hit.pass === 2,
      routeDiff: hit.pass === 3,
      pdfDate: trip.date,
      pdfRoute: pdfRouteKey(trip),
      pdfYen: trip.allowanceYen,
      screenDate: row.date,
      screenRoute: hit.slot.route,
      screenYen: payYen,
      diffYen: payYen === null ? null : payYen - trip.allowanceYen,
      unkoNo: row.unkoNo,
      seq: row.seq,
    })
  }
  for (const trip of rest) {
    entries.push({
      driverName,
      status: 'pdf_only',
      dateShift: false,
      routeDiff: false,
      pdfDate: trip.date,
      pdfRoute: pdfRouteKey(trip),
      pdfYen: trip.allowanceYen,
      screenDate: '',
      screenRoute: '',
      screenYen: null,
      diffYen: null,
      unkoNo: '',
      seq: 0,
    })
  }
  for (const slot of slots) {
    if (slot.used) continue
    entries.push({
      driverName,
      status: 'screen_only',
      dateShift: false,
      routeDiff: false,
      pdfDate: '',
      pdfRoute: '',
      pdfYen: null,
      screenDate: slot.trip.row.date,
      screenRoute: slot.route,
      screenYen: slot.trip.payYen,
      diffYen: null,
      unkoNo: slot.trip.row.unkoNo,
      seq: slot.trip.row.seq,
    })
  }
  return entries
}

function tally(target: PdfCompareDriver, e: PdfCompareEntry) {
  // **`pdfOnlyYen` はここで足す。** `pdf_only` の枝で `e.pdfYen ?? 0` と書くと、
  // 実際には null になり得ないのに「null のとき」の分岐が生まれて宙に浮く。
  if (e.pdfYen !== null) {
    target.pdfTrips += 1
    target.pdfYen += e.pdfYen
    if (e.status === 'pdf_only') target.pdfOnlyYen += e.pdfYen
  }
  if (e.status !== 'pdf_only') {
    target.screenTrips += 1
    target.screenYen += e.screenYen ?? 0
  }
  if (e.status === 'matched') {
    target.matched += 1
    if (e.dateShift) target.dateShift += 1
    if (e.routeDiff) target.routeDiff += 1
    // 手当が決まっていない便 (`diffYen` が null) は「金額違い」に数えない。
    if (e.diffYen !== null && e.diffYen !== 0) {
      target.amountDiff += 1
      target.amountDiffYen += e.diffYen
    }
  }
  else if (e.status === 'pdf_only') target.pdfOnly += 1
  else {
    target.screenOnly += 1
    target.screenOnlyYen += e.screenYen ?? 0
  }
}

/**
 * PDF の便と画面の便を突き合わせる。
 *
 * **PDF の月に入る便だけを見る。** 画面が翌月に回した便 (積みが翌月 1 日になった運行) は
 * ここには出てこないので、`screen` に何を渡すかは呼び出し側が決める。
 */
export function comparePdfTrips(file: PdfTripFile, screen: ScreenTrip[]): PdfCompareResult {
  const pdfBy = new Map<string, PdfTrip[]>()
  for (const trip of file.trips) {
    const list = pdfBy.get(trip.driverName) ?? []
    list.push(trip)
    pdfBy.set(trip.driverName, list)
  }
  const screenBy = new Map<string, ScreenTrip[]>()
  for (const trip of screen) {
    const key = driverKey(trip.row.driverName)
    const list = screenBy.get(key) ?? []
    list.push(trip)
    screenBy.set(key, list)
  }
  const names = [...new Set([...pdfBy.keys(), ...screenBy.keys()])].sort()
  const entries: PdfCompareEntry[] = []
  const drivers: PdfCompareDriver[] = []
  const total = emptyDriver('合計')
  for (const name of names) {
    const mine = matchOne(name, pdfBy.get(name) ?? [], screenBy.get(name) ?? [])
    const driver = emptyDriver(name)
    for (const e of mine) {
      tally(driver, e)
      tally(total, e)
    }
    entries.push(...mine)
    drivers.push(driver)
  }
  return { entries, drivers, total }
}
