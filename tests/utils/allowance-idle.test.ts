import { describe, it, expect } from 'vitest'
import { extractOperationIdle } from '~/utils/allowance-idle'
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
      // 全イベントの Σ区間距離 (回送も帰庫も入る)
      totalKm: 302,
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

  it('区間距離 の列だけ無い CSV は距離だけ 0 にして時間は出す', () => {
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
      legKm: [0],
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
