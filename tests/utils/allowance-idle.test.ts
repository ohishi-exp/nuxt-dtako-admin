import { describe, it, expect } from 'vitest'
import { extractOperationIdle, DISTANCE_EVENT_NAMES } from '~/utils/allowance-idle'
import { extractAllowanceLegs } from '~/utils/allowance-trips'

const HEADERS = ['イベント名', '開始日時', '終了日時', '区間距離']
/** `区間距離` が無い CSV (距離だけ 0 になり、時間は出る)。 */
const TIME_ONLY_HEADERS = ['イベント名', '開始日時', '終了日時']
/** `extractAllowanceLegs` と便を突き合わせるときに要る市町村列まで入った CSV。 */
const FULL_HEADERS = ['イベント名', '開始日時', '終了日時', '開始市町村名', '終了市町村名', '区間距離']

/** 2026/7/1 の壁時計 → epoch 秒 (`parseEventDatetimeToTs` と同じ規約: TZシフトしない)。 */
function at(hour: number, min = 0): number {
  return Date.UTC(2026, 6, 1, hour, min, 0) / 1000
}

/** `at()` と同じ時刻の、イベントCSV 上の表記。 */
function hm(hour: number, min = 0): string {
  return `2026/7/1 ${hour}:${min}:0`
}

/** イベントCSV の 1 行。列は HEADERS の順。 */
function ev(name: string, start: string, end: string, km = '0'): string[] {
  return [name, start, end, km]
}

/** イベントCSV の 1 行。列は FULL_HEADERS の順。 */
function evFull(name: string, start: string, end: string, startCity: string, endCity: string, km: string): string[] {
  return [name, start, end, startCity, endCity, km]
}

const ALL_EMPTY = {
  startTs: null,
  endTs: null,
  preLoadSec: null,
  postUnloadSec: null,
  betweenSec: 0,
  haulSec: 0,
  totalSec: null,
  totalKm: 0,
  overlayKm: 0,
  preLoadKm: 0,
  haulKm: 0,
  betweenKm: 0,
  postUnloadKm: 0,
  otherKm: 0,
  legKm: [],
}

describe('extractOperationIdle', () => {
  it('運行開始 → 積み → 降し → 積み → 降し → 運行終了 を売上時間と非売上時間に切り分ける', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '0'),
      ev('積み', hm(5), hm(6), '0.5'),
      ev('運転', hm(6), hm(8), '120'),
      ev('降し', hm(8), hm(9), '0.5'),
      ev('運転', hm(9), hm(10), '60'), // 便と便の間の回送。どちらの便の距離でもない
      ev('積み', hm(10), hm(11), '0.5'),
      ev('運転', hm(11), hm(13), '100'),
      ev('降し', hm(13), hm(14), '0.5'),
      ev('運行終了', hm(15), hm(15, 30), '20'),
    ])
    expect(idle).toEqual({
      startTs: at(4),
      endTs: at(15, 30),
      // 始業 → 最初の積み
      preLoadSec: at(5) - at(4),
      // 便1の降し終了 → 便2の積み開始
      betweenSec: at(10) - at(9),
      // 積み開始 → その便の最後の降し終了 (売上が立つ時間)
      haulSec: (at(9) - at(5)) + (at(14) - at(10)),
      // 最後の降し終了 → 終業
      postUnloadSec: at(15, 30) - at(14),
      totalSec: at(15, 30) - at(4),
      // 距離を数える行 (運転・積み・降し・…) の Σ区間距離。回送も帰庫も入る
      totalKm: 302,
      // 重ね掛け行 (速度オーバー等) はこのフィクスチャに無いので 0
      overlayKm: 0,
      // 距離の内訳。**5 つ足すと totalKm** (始業0 + 売上222 + 便間60 + 降後20 + 他0)
      preLoadKm: 0,
      haulKm: 222,
      betweenKm: 60,
      postUnloadKm: 20,
      otherKm: 0,
      // 便ごとは 積みの行 → その便の最後の降しの行 まで
      legKm: [121, 101],
    })
  })

  it('複数卸しの便は「最後の降しの終了」までを売上時間・走行距離にする', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '0'),
      ev('積み', hm(5), hm(6), '1'),
      ev('降し', hm(8), hm(9), '30'),
      ev('降し', hm(10), hm(11), '20'),
      ev('運行終了', hm(12), hm(12), '40'),
    ])
    expect(idle.haulSec).toBe(at(11) - at(5))
    expect(idle.postUnloadSec).toBe(at(12) - at(11))
    expect(idle.betweenSec).toBe(0)
    expect(idle.legKm).toEqual([51])
    expect(idle.totalKm).toBe(91)
  })

  it('必要な列が無い CSV は推測せず全部 null / 0 を返す', () => {
    const rows = [ev('運行開始', hm(4), hm(4)), ev('積み', hm(5), hm(6))]
    // 終了日時 が無い
    expect(extractOperationIdle(['イベント名', '開始日時'], rows)).toEqual(ALL_EMPTY)
    // イベント名 が無い
    expect(extractOperationIdle(['開始日時', '終了日時'], rows)).toEqual(ALL_EMPTY)
    // 開始日時 が無い
    expect(extractOperationIdle(['イベント名', '終了日時'], rows)).toEqual(ALL_EMPTY)
  })

  it('区間距離 の列だけ無い CSV は距離だけ 0 / 空配列 にして時間は出す', () => {
    const idle = extractOperationIdle(TIME_ONLY_HEADERS, [
      ['運行開始', hm(4), hm(4)],
      ['積み', hm(5), hm(6)],
      ['降し', hm(8), hm(9)],
      ['運行終了', hm(12), hm(12)],
    ])
    expect(idle).toEqual({
      startTs: at(4),
      endTs: at(12),
      preLoadSec: at(5) - at(4),
      postUnloadSec: at(12) - at(9),
      betweenSec: 0,
      haulSec: at(9) - at(5),
      totalSec: at(12) - at(4),
      totalKm: 0,
      overlayKm: 0,
      preLoadKm: 0,
      haulKm: 0,
      betweenKm: 0,
      postUnloadKm: 0,
      otherKm: 0,
      // 「全便が 0km 走った」ではなく「距離が分からない」。便の数とは揃えない
      legKm: [],
    })
  })

  it('区間距離 が数として読めない行は 0 として足し、合計を NaN にしない', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), ''),
      ev('積み', hm(5), hm(6), 'abc'),
      ev('運転', hm(6), hm(8), ' 12.5 '),
      ev('降し', hm(8), hm(9), '-'),
      ev('運行終了', hm(12), hm(12), '3'),
    ])
    expect(idle.totalKm).toBe(15.5)
    expect(Number.isNaN(idle.totalKm)).toBe(false)
    expect(idle.legKm).toEqual([12.5])
    // 距離が読めなくても時間は出る
    expect(idle.haulSec).toBe(at(9) - at(5))
  })

  it('イベントが 0 行なら全部 null / 0', () => {
    expect(extractOperationIdle(HEADERS, [])).toEqual(ALL_EMPTY)
  })

  it('運行開始 が無ければ preLoadSec / totalSec だけ null、他は出る', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('積み', hm(5), hm(6)),
      ev('降し', hm(8), hm(9)),
      ev('運行終了', hm(12), hm(12)),
    ])
    expect(idle).toEqual({
      startTs: null,
      endTs: at(12),
      preLoadSec: null,
      postUnloadSec: at(12) - at(9),
      betweenSec: 0,
      haulSec: at(9) - at(5),
      totalSec: null,
      totalKm: 0,
      overlayKm: 0,
      preLoadKm: 0,
      haulKm: 0,
      betweenKm: 0,
      postUnloadKm: 0,
      otherKm: 0,
      legKm: [0],
    })
  })

  it('運行終了 が無ければ postUnloadSec / totalSec だけ null、他は出る', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4)),
      ev('積み', hm(5), hm(6)),
      ev('降し', hm(8), hm(9)),
    ])
    expect(idle).toEqual({
      startTs: at(4),
      endTs: null,
      preLoadSec: at(5) - at(4),
      postUnloadSec: null,
      betweenSec: 0,
      haulSec: at(9) - at(5),
      totalSec: null,
      totalKm: 0,
      overlayKm: 0,
      preLoadKm: 0,
      haulKm: 0,
      betweenKm: 0,
      postUnloadKm: 0,
      otherKm: 0,
      legKm: [0],
    })
  })

  it('積みも降しも無い運行は preLoadSec / postUnloadSec が null で totalSec だけ出る', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4)),
      ev('運転', hm(5), hm(6)),
      ev('運行終了', hm(12), hm(12)),
    ])
    expect(idle).toEqual({
      startTs: at(4),
      endTs: at(12),
      preLoadSec: null,
      postUnloadSec: null,
      betweenSec: 0,
      haulSec: 0,
      totalSec: at(12) - at(4),
      totalKm: 0,
      overlayKm: 0,
      preLoadKm: 0,
      haulKm: 0,
      betweenKm: 0,
      postUnloadKm: 0,
      otherKm: 0,
      legKm: [],
    })
  })

  it('日時が読めない行があっても、その区間だけ落として他は出す', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4)),
      ev('積み', hm(5), hm(6)),
      ev('降し', hm(8), ''), // 便1の降し終了が読めない
      ev('積み', 'こわれた', hm(11)), // 便2の積み開始が読めない
      ev('降し', hm(12), hm(13)),
      ev('積み', 'こわれた', hm(14)), // 便3の積み開始が読めない
      ev('運行終了', hm(15), hm(15)),
    ])
    expect(idle).toEqual({
      startTs: at(4),
      endTs: at(15),
      preLoadSec: at(5) - at(4),
      // 便1: 降しの終了が読めない / 便2・便3: 積みの開始が読めない → どれも加算しない
      haulSec: 0,
      // 便1→便2 は前の降しが読めない / 便2→便3 は次の積みが読めない → 加算しない
      betweenSec: 0,
      postUnloadSec: at(15) - at(13),
      totalSec: at(15) - at(4),
      totalKm: 0,
      overlayKm: 0,
      preLoadKm: 0,
      haulKm: 0,
      betweenKm: 0,
      postUnloadKm: 0,
      otherKm: 0,
      // 時刻が読めなくても距離は数える (便3 は降しが無いので 0)
      legKm: [0, 0, 0],
    })
  })

  it('降しが 1 つも無い便は haulSec に入らず、legKm はその位置に 0 を置く', () => {
    const rows = [
      evFull('運行開始', hm(4), hm(4), '釧路市', '釧路市', '0'),
      evFull('積み', hm(5), hm(6), '釧路市', '', '1'),
      evFull('運転', hm(6), hm(8), '釧路市', '清水町', '100'),
      evFull('降し', hm(8), hm(9), '', '清水町', '1'),
      // 積んだまま帰庫し、翌朝の運行の頭で降ろす便
      evFull('積み', hm(10), hm(11), '清水町', '', '1'),
      evFull('運転', hm(11), hm(14), '清水町', '釧路市', '50'),
      evFull('運行終了', hm(15), hm(15), '釧路市', '釧路市', '5'),
    ]
    const idle = extractOperationIdle(FULL_HEADERS, rows)
    expect(idle.haulSec).toBe(at(9) - at(5))
    expect(idle.betweenSec).toBe(at(10) - at(9))
    // 「最後の降し」は最終便ではなく運行全体の最後の降し
    expect(idle.postUnloadSec).toBe(at(15) - at(9))
    expect(idle.legKm).toEqual([102, 0])
    expect(idle.totalKm).toBe(158)
    // 便を間引かない。`extractAllowanceLegs` と同じ順・同じ本数
    expect(extractAllowanceLegs(FULL_HEADERS, rows).length).toBe(idle.legKm.length)
  })

  it('降しが 1 つも無い運行は postUnloadSec が null', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4)),
      ev('積み', hm(5), hm(6)),
      ev('運行終了', hm(15), hm(15)),
    ])
    expect(idle.postUnloadSec).toBeNull()
    expect(idle.haulSec).toBe(0)
    expect(idle.preLoadSec).toBe(at(5) - at(4))
    expect(idle.legKm).toEqual([0])
  })

  it('積みが連続した (降しを挟まない) 区間は betweenSec に入らない', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4)),
      ev('積み', hm(5), hm(6), '2'),
      ev('積み', hm(7), hm(8), '3'),
      ev('降し', hm(9), hm(10), '4'),
      ev('運行終了', hm(15), hm(15), '5'),
    ])
    expect(idle.betweenSec).toBe(0)
    // 降しは後ろの積み (便2) に属する。便1 は降し無しなので加算しない
    expect(idle.haulSec).toBe(at(10) - at(7))
    expect(idle.legKm).toEqual([0, 7])
    expect(idle.totalKm).toBe(14)
  })

  it('最初の積みより前の降し (前の運行の積み残し) は便に属さない', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '0'),
      ev('降し', hm(4, 30), hm(5), '9'), // 便が無いので legKm には入らない
      ev('積み', hm(6), hm(7), '1'),
      ev('降し', hm(8), hm(9), '2'),
      ev('運行終了', hm(15), hm(15), '0'),
    ])
    expect(idle.haulSec).toBe(at(9) - at(6))
    expect(idle.betweenSec).toBe(0)
    expect(idle.preLoadSec).toBe(at(6) - at(4))
    expect(idle.legKm).toEqual([3])
    // 便に入らない距離も totalKm には入る
    expect(idle.totalKm).toBe(12)
  })

  it('運行開始 / 運行終了 が複数あれば 最初の開始 と 最後の終了 を採る', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4)),
      ev('運行開始', hm(4, 30), hm(4, 30)),
      ev('積み', hm(5), hm(6)),
      ev('降し', hm(8), hm(9)),
      ev('運行終了', hm(15), hm(15)),
      ev('運行終了', hm(16), hm(16)),
    ])
    expect(idle.startTs).toBe(at(4))
    expect(idle.endTs).toBe(at(16))
    expect(idle.totalSec).toBe(at(16) - at(4))
  })

  it('列が足りない行があっても落ちず、読めない区間だけ落とす', () => {
    const idle = extractOperationIdle(HEADERS, [
      [],
      ['運行開始'],
      ['積み'],
      ['降し'],
      ['運行終了'],
    ])
    expect(idle).toEqual({ ...ALL_EMPTY, legKm: [0] })
  })

  it('イベントの順序が壊れている運行の負の秒は 0 に丸めない', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(6), hm(6)),
      ev('積み', hm(5), hm(6)), // 始業より前に積んでいる
      ev('降し', hm(3), hm(4)), // 積みより前に降ろしている
      ev('運行終了', hm(2), hm(2)),
    ])
    expect(idle.preLoadSec).toBe(at(5) - at(6))
    expect(idle.haulSec).toBe(at(4) - at(5))
    expect(idle.postUnloadSec).toBe(at(2) - at(4))
    expect(idle.totalSec).toBe(at(2) - at(6))
  })
})

/**
 * 走行距離の内訳 (Refs #760 の 5)。
 *
 * 本番実測 (中村一由 CD1412 / 2026-07 / 14運行 20,800.6km) では `totalKm` の
 * **過半が非売上走行**で、最大の内訳が便間だった。按分の分子 (`totalKm`) の中身を
 * 人が読めるようにするための値なので、**分類の取りこぼしを合計で検出できること**
 * (5 つ足すと `totalKm`) を最優先で固定する。
 */
describe('extractOperationIdle の走行距離の内訳', () => {
  /** 内訳の 5 つ。テストの意図 (どこに入ったか) を 1 行で読めるようにする。 */
  function breakdown(idle: ReturnType<typeof extractOperationIdle>) {
    return {
      preLoadKm: idle.preLoadKm,
      haulKm: idle.haulKm,
      betweenKm: idle.betweenKm,
      postUnloadKm: idle.postUnloadKm,
      otherKm: idle.otherKm,
    }
  }

  function sumBreakdown(idle: ReturnType<typeof extractOperationIdle>): number {
    return idle.preLoadKm + idle.haulKm + idle.betweenKm + idle.postUnloadKm + idle.otherKm
  }

  const ORDINARY = [
    ev('運行開始', hm(4), hm(4), '3'),
    ev('積み', hm(5), hm(6), '0.5'),
    ev('運転', hm(6), hm(8), '120'),
    ev('降し', hm(8), hm(9), '0.5'),
    ev('運転', hm(9), hm(10), '60'), // 便間の回送
    ev('積み', hm(10), hm(11), '0.5'),
    ev('運転', hm(11), hm(13), '100'),
    ev('降し', hm(13), hm(14), '0.5'),
    ev('運行終了', hm(15), hm(15, 30), '20'),
  ]

  it('**不変条件** 5 つを足すと totalKm になる (分類の取りこぼしが起きていない)', () => {
    const idle = extractOperationIdle(HEADERS, ORDINARY)
    expect(breakdown(idle)).toEqual({
      preLoadKm: 3, // 運行開始 の行 (最初の積みより前)
      haulKm: 222, // 便1 121 + 便2 101
      betweenKm: 60, // 降し → 次の積み の回送
      postUnloadKm: 20, // 最後の降し → 運行終了
      otherKm: 0,
    })
    expect(sumBreakdown(idle)).toBe(idle.totalKm)
    expect(idle.totalKm).toBe(305)
  })

  it('**不変条件** haulKm は legKm の和に一致する (便の数え方が 2 つに割れていない)', () => {
    const idle = extractOperationIdle(HEADERS, ORDINARY)
    expect(idle.haulKm).toBe(idle.legKm.reduce((a, b) => a + b, 0))
    expect(idle.legKm).toEqual([121, 101])
  })

  it('**不変条件** 区間距離 の列が無い CSV は内訳も 5 つとも 0 (totalKm が 0 なのと整合)', () => {
    const idle = extractOperationIdle(TIME_ONLY_HEADERS, [
      ['運行開始', hm(4), hm(4)],
      ['積み', hm(5), hm(6)],
      ['降し', hm(8), hm(9)],
      ['積み', hm(10), hm(11)],
      ['運行終了', hm(12), hm(12)],
    ])
    expect(breakdown(idle)).toEqual({ preLoadKm: 0, haulKm: 0, betweenKm: 0, postUnloadKm: 0, otherKm: 0 })
    expect(idle.totalKm).toBe(0)
    // 「距離が分からない」ので便ごとの配列は空のまま。haulKm (=0) とも矛盾しない
    expect(idle.legKm).toEqual([])
    expect(idle.haulKm).toBe(idle.legKm.reduce((a, b) => a + b, 0))
  })

  /**
   * **合計の一致は「丸め誤差の範囲」でしか保証できない。**
   *
   * `totalKm` は全行を行順に 1 本で足した値、内訳は同じ加数を 5 つに分けて足した値。
   * 浮動小数の加算に結合則が無いので、**同じ加数でもグループが違えば最下位ビットが
   * ずれる** (実測: 1桁小数・最大 61 行の運行 20,000 件で 59% が不一致、最大差 5.5e-12 km)。
   * 逃げ道 (totalKm を内訳の和で作り直す / otherKm を残差にする) は、按分の分子を
   * 動かす・通常運行の `otherKm` を 1e-13 にして画面の警告を常時点灯させるので採らない。
   */
  it('**不変条件** 行数が多く端数のある運行でも、内訳の合計と totalKm の差は丸め誤差の範囲', () => {
    // 決まった順で作る (乱数を使わない — 落ちたときに再現できないテストにしない)
    const rows: string[][] = [ev('運行開始', hm(4), hm(4), '1.3')]
    for (let i = 0; i < 40; i++) {
      const km = String(Math.round((i * 37.7 + 0.1) * 10) / 10)
      const name = i % 7 === 0 ? '積み' : i % 5 === 0 ? '降し' : '運転'
      rows.push(ev(name, hm(5), hm(6), km))
    }
    rows.push(ev('運行終了', hm(20), hm(20), '2.7'))
    const idle = extractOperationIdle(HEADERS, rows)
    expect(idle.totalKm).toBeGreaterThan(0)
    expect(Math.abs(sumBreakdown(idle) - idle.totalKm)).toBeLessThan(1e-9)
    expect(idle.haulKm).toBe(idle.legKm.reduce((a, b) => a + b, 0))
  })

  it('降しが 1 つも無い便の走行は otherKm に入れる (売上走行にも便間にも数えない)', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '0'),
      ev('積み', hm(5), hm(6), '1'),
      ev('運転', hm(6), hm(8), '100'),
      ev('降し', hm(8), hm(9), '1'),
      ev('運転', hm(9, 30), hm(10), '7'), // 便間の回送
      // 積んだまま帰庫した便 (降しが無い)
      ev('積み', hm(10), hm(11), '1'),
      ev('運転', hm(11), hm(14), '50'),
      ev('運行終了', hm(15), hm(15), '5'),
    ])
    expect(breakdown(idle)).toEqual({
      preLoadKm: 0,
      haulKm: 102,
      betweenKm: 7,
      // 降しが無い便なので「降し → 終業」ではなく分類不能
      postUnloadKm: 0,
      otherKm: 56, // 積み1 + 運転50 + 運行終了5
    })
    expect(sumBreakdown(idle)).toBe(idle.totalKm)
    expect(idle.legKm).toEqual([102, 0])
  })

  it('積みが 1 行も無い運行は走行ぜんぶが otherKm (始業→積み とは呼べない)', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '1'),
      ev('運転', hm(5), hm(6), '9'),
      ev('運行終了', hm(12), hm(12), '2'),
    ])
    expect(breakdown(idle)).toEqual({
      preLoadKm: 0,
      haulKm: 0,
      betweenKm: 0,
      postUnloadKm: 0,
      otherKm: 12,
    })
    expect(sumBreakdown(idle)).toBe(idle.totalKm)
    expect(idle.legKm).toEqual([])
  })

  it('最初の積みより前の降し (前の運行の積み残し) の走行は preLoadKm に入る', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '2'),
      ev('降し', hm(4, 30), hm(5), '9'), // 便に属さない降し
      ev('積み', hm(6), hm(7), '1'),
      ev('降し', hm(8), hm(9), '2'),
      ev('運行終了', hm(15), hm(15), '4'),
    ])
    expect(breakdown(idle)).toEqual({
      preLoadKm: 11, // 運行開始 2 + 積み残しの降し 9
      haulKm: 3,
      betweenKm: 0,
      postUnloadKm: 4,
      otherKm: 0,
    })
    expect(sumBreakdown(idle)).toBe(idle.totalKm)
    expect(idle.legKm).toEqual([3])
  })

  it('降しの時刻が読めない便でも距離は売上走行に数える (legKm と同じ規則)', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '0'),
      ev('積み', hm(5), hm(6), '1'),
      ev('降し', hm(8), '', '9'), // 終了日時 が読めない
      ev('運行終了', hm(15), hm(15), '5'),
    ])
    // 時間は出せない (haulSec 0) が、距離は 10km を売上走行に数える
    expect(idle.haulSec).toBe(0)
    expect(breakdown(idle)).toEqual({
      preLoadKm: 0,
      haulKm: 10,
      betweenKm: 0,
      postUnloadKm: 5,
      otherKm: 0,
    })
    expect(idle.haulKm).toBe(idle.legKm.reduce((a, b) => a + b, 0))
  })

  it('積みが連続した (降しを挟まない) 便の走行は otherKm に落ちる', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '0'),
      ev('積み', hm(5), hm(6), '2'),
      ev('積み', hm(7), hm(8), '3'),
      ev('降し', hm(9), hm(10), '4'),
      ev('運行終了', hm(15), hm(15), '5'),
    ])
    expect(breakdown(idle)).toEqual({
      preLoadKm: 0,
      haulKm: 7, // 便2 (積み3 + 降し4)
      betweenKm: 0,
      postUnloadKm: 5,
      otherKm: 2, // 降しの無い便1
    })
    expect(sumBreakdown(idle)).toBe(idle.totalKm)
  })

  it('イベントが 0 行なら内訳も 5 つとも 0', () => {
    const idle = extractOperationIdle(HEADERS, [])
    expect(breakdown(idle)).toEqual({ preLoadKm: 0, haulKm: 0, betweenKm: 0, postUnloadKm: 0, otherKm: 0 })
    expect(sumBreakdown(idle)).toBe(idle.totalKm)
  })
})

/**
 * **重ね掛け行を走行距離に足さない** (Refs #760 の 7)。
 *
 * イベントCSV は同じ走行を別の切り口で重ねて持つ行 (`専用道` / `一般道速度オーバー` /
 * `連続運転` …) を持ち、全行の `区間距離` を足すと同じ走行を二度数える。実測 (2026-07
 * 帯広5台 90 運行) で **全行Σ 101,891km に対して KUDGURI の 総走行距離 は 57,350km**、
 * `DISTANCE_EVENT_NAMES` の 8 つだけを足すと**全件ぴったり一致**した。
 *
 * 数えなかったぶんは `overlayKm` に出して、呼び出し側が
 * 「`totalKm + overlayKm` = 旧来の全行Σ」で検算できるようにする。
 */
describe('extractOperationIdle の重ね掛け行 (走行距離の二重計上)', () => {
  it('運転 132.7 と 専用道 452.9 が共存する運行は 運転 だけを数え、専用道 は overlayKm へ', () => {
    // 実データ (`2607312229040000001318`) と同じ形。専用道 は運行全体にまたがる 1 行
    const idle = extractOperationIdle(HEADERS, [
      ev('運転', hm(22, 29), hm(23, 45), '132.7'),
      ev('専用道', hm(23, 1), hm(23, 40), '452.9'),
    ])
    expect(idle.totalKm).toBe(132.7)
    expect(idle.overlayKm).toBe(452.9)
    // 旧来の全行Σ = 数えた分 + 数えなかった分。呼び出し側が検算できる
    // (足す順が違うので最下位ビットはずれる。#767 の内訳の不変条件と同じ扱い)
    expect(Math.abs(idle.totalKm + idle.overlayKm - 585.6)).toBeLessThan(1e-9)
  })

  it('便の中の速度オーバー行は legKm にも haulKm にも入らない (判定が 1 か所にある)', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '3'),
      ev('積み', hm(5), hm(6), '1'),
      ev('運転', hm(6), hm(8), '100'),
      ev('一般道速度オーバー', hm(6, 30), hm(7), '80'), // 上の運転と同じ走行の重ね掛け
      ev('降し', hm(8), hm(9), '1'),
      ev('運行終了', hm(15), hm(15), '5'),
    ])
    expect(idle.legKm).toEqual([102])
    expect(idle.haulKm).toBe(102)
    expect(idle.totalKm).toBe(110)
    expect(idle.overlayKm).toBe(80)
    // 時間側は 1 ミリも変わらない (重ね掛け行はもともと便にも区間にも効かない)
    expect(idle.haulSec).toBe(at(9) - at(5))
    expect(idle.preLoadSec).toBe(at(5) - at(4))
    expect(idle.postUnloadSec).toBe(at(15) - at(9))
  })

  it('既知の重ね掛け 6 名 + 未知のイベント名 は 0 として扱い、内訳のどこにも入れない', () => {
    // 実測で出た 6 名 (90 運行の合計 km 順) + 将来増えうる未知の名前
    const overlays = [
      '専用道',
      '一般道速度オーバー',
      '連続運転',
      '専用道速度オーバー',
      '一般道空車',
      '一般道実車',
      'まだ知らないイベント',
    ]
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '2'),
      ev('積み', hm(5), hm(6), '1'),
      ev('降し', hm(8), hm(9), '9'),
      ev('運行終了', hm(15), hm(15), '4'),
      ...overlays.map((name, i) => ev(name, hm(5), hm(9), String((i + 1) * 10))),
    ])
    expect(idle.totalKm).toBe(16)
    // 10+20+...+70
    expect(idle.overlayKm).toBe(280)
    expect(idle.preLoadKm + idle.haulKm + idle.betweenKm + idle.postUnloadKm + idle.otherKm).toBe(16)
    expect(idle.legKm).toEqual([10])
  })

  it('休憩 / 休息 / アイドリング は距離を数える側 (KUDGURI と一致するのはこの 8 つ)', () => {
    expect([...DISTANCE_EVENT_NAMES]).toEqual([
      '運転', '積み', '降し', '休憩', '休息', 'アイドリング', '運行開始', '運行終了',
    ])
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '1'),
      ev('休憩', hm(5), hm(6), '2'),
      ev('休息', hm(6), hm(7), '3'),
      ev('アイドリング', hm(7), hm(8), '4'),
      ev('運行終了', hm(15), hm(15), '5'),
    ])
    expect(idle.totalKm).toBe(15)
    expect(idle.overlayKm).toBe(0)
    // 積みが 1 行も無い運行なので内訳は otherKm にまとまる (#767 の規則そのまま)
    expect(idle.otherKm).toBe(15)
  })

  it('区間距離 の列が無い CSV は overlayKm も 0 (「重ね掛けが 0km」ではなく距離が分からない)', () => {
    const idle = extractOperationIdle(TIME_ONLY_HEADERS, [
      ['運行開始', hm(4), hm(4)],
      ['専用道', hm(5), hm(9)],
      ['運行終了', hm(12), hm(12)],
    ])
    expect(idle.totalKm).toBe(0)
    expect(idle.overlayKm).toBe(0)
  })

  it('重ね掛け行の 区間距離 が数として読めなくても overlayKm を NaN にしない', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '1'),
      ev('専用道', hm(5), hm(9), 'abc'),
      ev('連続運転', hm(5), hm(9), '7'),
    ])
    expect(idle.totalKm).toBe(1)
    expect(idle.overlayKm).toBe(7)
    expect(Number.isNaN(idle.overlayKm)).toBe(false)
  })

  it('**不変条件** 重ね掛け行があっても 内訳 5 つの和は totalKm のまま (#767 のテストが通り続ける)', () => {
    const idle = extractOperationIdle(HEADERS, [
      ev('運行開始', hm(4), hm(4), '3'),
      ev('専用道', hm(4), hm(15), '452.9'),
      ev('積み', hm(5), hm(6), '0.5'),
      ev('運転', hm(6), hm(8), '120'),
      ev('一般道速度オーバー', hm(6), hm(8), '11.5'),
      ev('降し', hm(8), hm(9), '0.5'),
      ev('運転', hm(9), hm(10), '60'),
      ev('積み', hm(10), hm(11), '0.5'),
      ev('運転', hm(11), hm(13), '100'),
      ev('降し', hm(13), hm(14), '0.5'),
      ev('運行終了', hm(15), hm(15, 30), '20'),
    ])
    const sum = idle.preLoadKm + idle.haulKm + idle.betweenKm + idle.postUnloadKm + idle.otherKm
    expect(sum).toBe(idle.totalKm)
    expect(idle.totalKm).toBe(305)
    expect(idle.overlayKm).toBe(464.4)
    expect(idle.haulKm).toBe(idle.legKm.reduce((a, b) => a + b, 0))
  })
})
