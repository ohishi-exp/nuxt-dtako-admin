import { describe, it, expect } from 'vitest'
import type { AllowanceReportRow } from '~/utils/allowance-report'
import {
  decodeCsvBytes,
  driverKey,
  pdfRouteKey,
  routeText,
  parsePdfAllowanceCsv,
  parsePdfTripFile,
  serializePdfTripFile,
  comparePdfTrips,
  type PdfTrip,
  type ScreenTrip,
} from '~/utils/allowance-pdf-compare'

const HEADER = 'ym,vehicle_no,sheet_code,driver_name,date,trip_seq,route_raw,origin,dest,item_name,quantity_t,allowance_yen,page,confidence'
const line = (over: Partial<Record<string, string>> = {}) => {
  const c: Record<string, string> = {
    ym: '2026-07', vehicle_no: '1109', sheet_code: '40', driver_name: '中村 一由',
    date: '2026-07-01', trip_seq: '1', route_raw: '釧路〜上士幌', origin: '釧路', dest: '上士幌',
    item_name: '飼料', quantity_t: '12.63', allowance_yen: '9000', page: '1', confidence: 'ok', ...over,
  }
  return HEADER.split(',').map(h => c[h] ?? '').join(',')
}

function row(over: Partial<AllowanceReportRow> = {}): AllowanceReportRow {
  return {
    unkoNo: '2607010419590000001109',
    date: '2026-07-01',
    driverName: '中村 一由',
    vehicleName: '帯広800か1109',
    seq: 1,
    fromTs: null,
    originCity: '北海道釧路市西港１-98-41',
    destCity: '北海道河東郡上士幌町上士幌東３線',
    viaCities: '',
    masterDest: '上士幌',
    allowanceYen: 9000,
    status: 'ok',
    destSource: 'event',
    ...over,
  }
}
const screen = (over: Partial<AllowanceReportRow> = {}, payYen: number | null = 9000): ScreenTrip =>
  ({ row: row(over), payYen })

const trip = (over: Partial<PdfTrip> = {}): PdfTrip => ({
  driverName: '中村一由', date: '2026-07-01', origin: '釧路', dest: '上士幌', allowanceYen: 9000, ...over,
})
const file = (trips: PdfTrip[]) => ({ ym: '2026-07', trips })

describe('decodeCsvBytes', () => {
  it('UTF-8 を読む', () => {
    expect(decodeCsvBytes(new TextEncoder().encode('中村 一由,釧路'))).toBe('中村 一由,釧路')
  })

  it('UTF-8 として壊れていれば Shift_JIS で読み直す', () => {
    // `中村` の Shift_JIS (0x92 0x86 0x91 0xBA)。UTF-8 としては不正。
    expect(decodeCsvBytes(new Uint8Array([0x92, 0x86, 0x91, 0xBA]))).toBe('中村')
  })
})

describe('driverKey', () => {
  it('半角・全角の空白を落として突合キーにする (PDF `佐竹繁` とデジタコ `佐竹 繁`)', () => {
    expect(driverKey('佐竹 繁')).toBe('佐竹繁')
    expect(driverKey('佐竹　繁')).toBe('佐竹繁')
    expect(driverKey(null)).toBe('')
    expect(driverKey(undefined)).toBe('')
  })
})

describe('pdfRouteKey', () => {
  it('マスタの語彙に寄せる (`釧路〜士幌` は `溝口`)', () => {
    expect(pdfRouteKey({ origin: '釧路', dest: '士幌' })).toBe('釧路|溝口')
    expect(pdfRouteKey({ origin: '釧路', dest: '上士幌' })).toBe('釧路|上士幌')
  })

  it('複数卸し・括弧書きは最終卸し地を採る', () => {
    expect(pdfRouteKey({ origin: '苫小牧', dest: '清水・富士' })).toBe('苫小牧|富士')
    expect(pdfRouteKey({ origin: '駒場（釧路）', dest: '別海' })).toBe('駒場|別海')
  })
})

describe('routeText', () => {
  it('片側が取れていなければ `(不明)` と書く', () => {
    expect(routeText('釧路|溝口')).toBe('釧路 → 溝口')
    expect(routeText('釧路|')).toBe('釧路 → (不明)')
    expect(routeText('')).toBe('(不明) → (不明)')
  })
})

describe('parsePdfAllowanceCsv', () => {
  it('手当表CSV を便に開き、月は行の日付から決める', () => {
    const { file: f, warnings } = parsePdfAllowanceCsv([HEADER, line(), line({ date: '2026-07-02', dest: '標茶', allowance_yen: '8000' })].join('\n'))
    expect(warnings).toEqual([])
    expect(f.ym).toBe('2026-07')
    expect(f.trips).toEqual([
      { driverName: '中村一由', date: '2026-07-01', origin: '釧路', dest: '上士幌', allowanceYen: 9000 },
      { driverName: '中村一由', date: '2026-07-02', origin: '釧路', dest: '標茶', allowanceYen: 8000 },
    ])
  })

  it('BOM と CRLF を落とす', () => {
    const { file: f } = parsePdfAllowanceCsv(`﻿${HEADER}\r\n${line()}\r\n`)
    expect(f.trips).toHaveLength(1)
  })

  it('引用符入りの値を割れる', () => {
    const { file: f } = parsePdfAllowanceCsv([HEADER, line({ route_raw: '"釧路〜清水,富士"' })].join('\n'))
    expect(f.trips).toHaveLength(1)
  })

  it('列が足りなければ投げる (握りつぶすと「0 便の PDF」と区別が付かない)', () => {
    expect(() => parsePdfAllowanceCsv('a,b,c\n1,2,3')).toThrow()
    expect(() => parsePdfAllowanceCsv('')).toThrow()
    expect(() => parsePdfAllowanceCsv('   \n\n')).toThrow()
  })

  it('読めない行は捨てて理由を残す', () => {
    const { file: f, warnings } = parsePdfAllowanceCsv([
      HEADER, line(), line({ date: '' }), line({ date: '2026/07/03' }), line({ allowance_yen: '－' }),
    ].join('\n'))
    expect(f.trips).toHaveLength(1)
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain('3 行目')
  })

  it('列が途中で切れた行も落ちない', () => {
    const short = '2026-07,1109,40,中村 一由,2026-07-05,1,釧路〜上士幌,釧路,上士幌,飼料,12,7000'
    const { file: f } = parsePdfAllowanceCsv([HEADER, short].join('\n'))
    expect(f.trips[0]!.allowanceYen).toBe(7000)
  })

  it('列の順が違っても名前で拾い、足りない列は空として読む', () => {
    const { file: f } = parsePdfAllowanceCsv([
      'driver_name,date,allowance_yen,origin,dest',
      '中村 一由,2026-07-05,7000,釧路,上士幌',
      '中村 一由,2026-07-06,7000',
    ].join('\n'))
    expect(f.trips).toEqual([
      { driverName: '中村一由', date: '2026-07-05', origin: '釧路', dest: '上士幌', allowanceYen: 7000 },
      { driverName: '中村一由', date: '2026-07-06', origin: '', dest: '', allowanceYen: 7000 },
    ])
  })

  it('金額が空の行は ¥0 の便にせず捨てる (合計が静かに減るため)', () => {
    const { file: f, warnings } = parsePdfAllowanceCsv([HEADER, line(), line({ date: '2026-07-06', allowance_yen: '' })].join('\n'))
    expect(f.trips).toHaveLength(1)
    expect(warnings[0]).toContain('金額が読めません')
  })

  it('読める便が 1 行も無ければ投げる', () => {
    expect(() => parsePdfAllowanceCsv([HEADER, line({ date: '' })].join('\n'))).toThrow()
  })
})

describe('parsePdfTripFile / serializePdfTripFile', () => {
  it('保存した形をそのまま読み戻す', () => {
    const f = file([trip()])
    expect(parsePdfTripFile(serializePdfTripFile(f))).toEqual(f)
  })

  it('未設定・壊れた値は「無かった」として扱う (投げない)', () => {
    expect(parsePdfTripFile(null)).toBeNull()
    expect(parsePdfTripFile(undefined)).toBeNull()
    expect(parsePdfTripFile('')).toBeNull()
    expect(parsePdfTripFile('{')).toBeNull()
    expect(parsePdfTripFile('42')).toBeNull()
    expect(parsePdfTripFile('null')).toBeNull()
    expect(parsePdfTripFile('[]')).toBeNull()
    expect(parsePdfTripFile(JSON.stringify({ trips: [trip()] }))).toBeNull()
    expect(parsePdfTripFile(JSON.stringify({ ym: '2026-07' }))).toBeNull()
    expect(parsePdfTripFile(JSON.stringify({ ym: '2026-07', trips: [] }))).toBeNull()
  })
})

describe('comparePdfTrips', () => {
  it('日付も経路も合えば素直に当たる', () => {
    const r = comparePdfTrips(file([trip()]), [screen()])
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ status: 'matched', dateShift: false, routeDiff: false, diffYen: 0 })
    expect(r.total).toMatchObject({ pdfTrips: 1, pdfYen: 9000, screenTrips: 1, screenYen: 9000, matched: 1, amountDiff: 0 })
  })

  it('経路が合えば日付が 1 日ずれても当てる (印は残す)', () => {
    const r = comparePdfTrips(file([trip({ date: '2026-07-02' })]), [screen()])
    expect(r.entries[0]).toMatchObject({ status: 'matched', dateShift: true, routeDiff: false })
    expect(r.total.dateShift).toBe(1)
  })

  it('日付が合えば経路が違っても当てる (印は残す)', () => {
    const r = comparePdfTrips(file([trip({ dest: '標茶', allowanceYen: 8000 })]), [screen()])
    expect(r.entries[0]).toMatchObject({ status: 'matched', dateShift: false, routeDiff: true, diffYen: 1000 })
    expect(r.total).toMatchObject({ routeDiff: 1, amountDiff: 1, amountDiffYen: 1000 })
  })

  it('日付も経路も合う便を先に当てる (1 日ずれに横取りさせない)', () => {
    const r = comparePdfTrips(
      file([trip({ date: '2026-07-02' }), trip()]),
      [screen(), screen({ date: '2026-07-02', seq: 2 })],
    )
    const shifted = r.entries.filter(e => e.dateShift)
    expect(shifted).toHaveLength(0)
    expect(r.total.matched).toBe(2)
  })

  it('同じ日・同じ経路の便が並んでも、1 つずつ別の便に当てる', () => {
    // 実データで頻出 (中村 07-03 の 釧路→標茶 が 2 便)。
    const r = comparePdfTrips(
      file([trip({ dest: '標茶', allowanceYen: 8000 }), trip({ dest: '標茶', allowanceYen: 8000 })]),
      [
        screen({ destCity: '北海道川上郡標茶町多和', masterDest: 'FCS標茶' }, 8000),
        screen({ destCity: '北海道川上郡標茶町多和', masterDest: 'FCS標茶', seq: 2 }, 8000),
      ],
    )
    expect(r.entries.filter(e => e.status === 'matched')).toHaveLength(2)
    expect(r.entries.map(e => e.seq).sort()).toEqual([1, 2])
    expect(r.total).toMatchObject({ matched: 2, pdfOnly: 0, screenOnly: 0, amountDiff: 0 })
  })

  it('当たらなかった便を PDF側・画面側に分けて出す', () => {
    const r = comparePdfTrips(
      file([trip({ date: '2026-07-20' })]),
      [screen({ date: '2026-07-05', seq: 3 }, null)],
    )
    const pdfOnly = r.entries.find(e => e.status === 'pdf_only')!
    const screenOnly = r.entries.find(e => e.status === 'screen_only')!
    expect(pdfOnly).toMatchObject({ pdfDate: '2026-07-20', screenDate: '', screenYen: null, diffYen: null, unkoNo: '', seq: 0 })
    expect(screenOnly).toMatchObject({ screenDate: '2026-07-05', seq: 3, pdfYen: null, diffYen: null })
    expect(r.total).toMatchObject({ pdfOnly: 1, pdfOnlyYen: 9000, screenOnly: 1, screenOnlyYen: 0 })
  })

  it('手当が決まっていない便は金額違いに数えない', () => {
    const r = comparePdfTrips(file([trip()]), [screen({}, null)])
    expect(r.entries[0]).toMatchObject({ status: 'matched', screenYen: null, diffYen: null })
    expect(r.total).toMatchObject({ matched: 1, amountDiff: 0, screenYen: 0 })
  })

  it('画面にしかない便の手当も合計する', () => {
    const r = comparePdfTrips(file([]), [screen({ date: '2026-07-09' }, 12000)])
    expect(r.total).toMatchObject({ screenOnly: 1, screenOnlyYen: 12000, pdfTrips: 0 })
  })

  it('乗務員ごとに分けて、氏名の空白ゆれを吸収する', () => {
    const r = comparePdfTrips(
      file([trip({ driverName: '佐竹繁' }), trip()]),
      [screen({ driverName: '佐竹　繁' }), screen()],
    )
    expect(r.drivers.map(d => d.driverName)).toEqual(['中村一由', '佐竹繁'].sort())
    expect(r.drivers.every(d => d.matched === 1)).toBe(true)
    expect(r.total.matched).toBe(2)
  })

  it('片側にしか居ない乗務員も落とさない', () => {
    const r = comparePdfTrips(file([trip({ driverName: '西島健太' })]), [screen()])
    expect(r.drivers).toHaveLength(2)
    expect(r.total).toMatchObject({ pdfOnly: 1, screenOnly: 1 })
  })

  it('便が 1 つも無くても壊れない', () => {
    const r = comparePdfTrips(file([]), [])
    expect(r.entries).toEqual([])
    expect(r.drivers).toEqual([])
    expect(r.total).toMatchObject({ pdfTrips: 0, screenTrips: 0, matched: 0 })
  })

  it('PDF の便に「その日の何便目か」を振る (過払いの印の鍵)', () => {
    const r = comparePdfTrips(
      file([trip(), trip({ dest: '標茶', allowanceYen: 8000 }), trip({ date: '2026-07-02' })]),
      [],
    )
    expect(r.entries.map(e => [e.pdfDate, e.pdfSeq])).toEqual([
      ['2026-07-01', 1], ['2026-07-01', 2], ['2026-07-02', 1],
    ])
  })

  it('画面にしかない便には便番号を振らない (PDF の便ではない)', () => {
    const r = comparePdfTrips(file([]), [screen()])
    expect(r.entries[0]).toMatchObject({ status: 'screen_only', pdfSeq: 0, overpaid: false })
  })
})

describe('comparePdfTrips (手当表PDF 側の過払い)', () => {
  const OVERPAID = { '佐竹繁|2026-07-27|2': { pdfRoute: '広尾|松山/士幌', pdfYen: 9000 } }

  /** 実データ: `2026-07-27 佐竹 繁` の 2 便目。PDF `広尾〜士幌 ¥9,000` / 画面 `広尾→富士 ¥8,000`。 */
  const satake = () => comparePdfTrips(
    file([
      trip({ driverName: '佐竹繁', date: '2026-07-27', origin: '苫小牧', dest: '富士', allowanceYen: 12000 }),
      trip({ driverName: '佐竹繁', date: '2026-07-27', origin: '広尾', dest: '士幌', allowanceYen: 9000 }),
    ]),
    [
      screen({ driverName: '佐竹 繁', date: '2026-07-27', originCity: '北海道苫小牧市晴海町43-45', destCity: '北海道帯広市富士町西５線', masterDest: '富士' }, 12000),
      screen({ driverName: '佐竹 繁', date: '2026-07-27', seq: 2, originCity: '北海道広尾郡広尾町会所前６', destCity: '北海道帯広市富士町西５線', masterDest: '富士' }, 8000),
    ],
    OVERPAID,
  )

  it('印が無ければ素の「金額違い」として出す', () => {
    const r = comparePdfTrips(
      file([trip({ dest: '標茶', allowanceYen: 8000 })]),
      [screen()],
    )
    expect(r.entries[0]).toMatchObject({ overpaid: false, diffYen: 1000 })
    expect(r.total).toMatchObject({ amountDiff: 1, amountDiffYen: 1000, overpaid: 0, overpaidYen: 0 })
  })

  it('印を付けた便は「金額違い」から抜けて「過払い」に移る', () => {
    const r = satake()
    const marked = r.entries.find(e => e.overpaid)!
    expect(marked).toMatchObject({ pdfSeq: 2, pdfRoute: '広尾|松山/士幌', screenRoute: '広尾|富士', diffYen: -1000 })
    expect(r.total).toMatchObject({ amountDiff: 0, amountDiffYen: 0, overpaid: 1, overpaidYen: -1000 })
  })

  it('合計は動かさない (黙って消さない)', () => {
    const r = satake()
    expect(r.total).toMatchObject({ matched: 2, pdfYen: 21000, screenYen: 20000 })
  })

  it('乗務員ごとにも数える', () => {
    expect(satake().drivers[0]).toMatchObject({ driverName: '佐竹繁', amountDiff: 0, overpaid: 1, overpaidYen: -1000 })
  })
})
