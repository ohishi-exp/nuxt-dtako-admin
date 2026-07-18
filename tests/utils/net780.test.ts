import { describe, it, expect, afterEach } from 'vitest'
import {
  parseNet780Zip,
  net780EventCodeHex,
  downsampleSpeed,
  formatNet780Ts,
  buildSpeedChartData,
  buildDailySpeedCharts,
  buildDailyGpsPoints,
  extractCommOutageRanges,
  filterImplausibleGpsJumps,
  chartXRatioToTime,
  net780DateStartTs,
} from '~/utils/net780'
import type { Net780ParseResult, Net780SpeedPoint, Net780GpsPoint, Net780EventSummary } from '~/utils/net780'
import { __setMockResult, __setMockError, __reset } from '../mocks/net780-wasm'

afterEach(() => {
  __reset()
})

describe('parseNet780Zip', () => {
  it('wasm モジュールの parse_net780_zip の戻り値をそのまま返す', async () => {
    const result: Net780ParseResult = {
      header: {
        device_id: 'nrbn1Sk07T',
        vehicle_code: 3899,
        driver_code: 1270,
        start_at: '2026-07-01T06:02:39',
        end_at: '2026-07-01T16:37:10',
        distance_km: 139.905,
      },
      inf: null,
      distance_total_m: 139921,
      speed: [],
      gps: [],
      events: [],
      warnings: [],
    }
    __setMockResult(result)

    const parsed = await parseNet780Zip(new Uint8Array([1, 2, 3]))
    expect(parsed).toEqual(result)
  })

  it('parse_net780_zip が throw したエラーを伝播する', async () => {
    __setMockError(new Error('zip open failed'))
    await expect(parseNet780Zip(new Uint8Array())).rejects.toThrow('zip open failed')
  })
})

describe('net780EventCodeHex', () => {
  it('1 byte の 16 進表記 (0x 接頭辞、大文字、2 桁 0 埋め) を返す', () => {
    expect(net780EventCodeHex(0xFE)).toBe('0xFE')
    expect(net780EventCodeHex(0x0A)).toBe('0x0A')
    expect(net780EventCodeHex(0)).toBe('0x00')
  })
})

describe('formatNet780Ts', () => {
  it('JST 壁時計をそのまま格納した epoch を TZ シフトせず表示する', () => {
    // docs/net780-binary-format.md の実例: 運行開始日時 2026/07/01 06:02:39 (JST)
    // datetime.utcfromtimestamp(v) が JST 時刻になる値 = UTC として解釈した Date
    const ts = Date.UTC(2026, 6, 1, 6, 2, 39) / 1000
    expect(formatNet780Ts(ts)).toBe('2026-07-01 06:02:39')
  })
})

describe('downsampleSpeed', () => {
  function buildPoints(n: number): Net780SpeedPoint[] {
    return Array.from({ length: n }, (_, i) => ({
      record_start_ts: 0,
      offset_secs: i * 0.5,
      speed_kmh: i,
    }))
  }

  it('maxPoints 以下ならそのまま返す', () => {
    const points = buildPoints(10)
    expect(downsampleSpeed(points, 600)).toEqual(points)
  })

  it('maxPoints を超えると間引かれた点数になる', () => {
    const points = buildPoints(1200)
    const sampled = downsampleSpeed(points, 600)
    expect(sampled.length).toBe(600)
    // 先頭点は維持される (単調増加なので各バケットの最小値 = バケット先頭点)
    expect(sampled[0]).toEqual(points[0])
  })

  it('長い停止区間 (速度0が続く) が間引きで消えず、谷として残る (斜め線バグの回帰)', () => {
    // 高速走行 → 3000点 (1500秒 = 25分) 停止 (速度0) → 高速走行、という時系列。
    // 単純な等間隔インデックス抽出だと停止区間の大半が飛ばされ、直前の高速と
    // 直後の高速をほぼ直線で結んでしまい「緩やかに減速したように見える」誤った
    // 斜め線になる。min/max バケット方式なら停止区間の各バケットが (0,0) を
    // 残すので、間引き後も速度 0 の谷が維持されるはず。
    const driving = (offset: number, n: number, speed: number): Net780SpeedPoint[] =>
      Array.from({ length: n }, (_, i) => ({
        record_start_ts: 0,
        offset_secs: offset + i * 0.5,
        speed_kmh: speed,
      }))
    const points = [
      ...driving(0, 100, 80),
      ...driving(50, 3000, 0),
      ...driving(1550, 100, 80),
    ]
    const sampled = downsampleSpeed(points, 600)
    // 停止区間 (速度 0) に対応するサンプルが複数残っていること
    const zeroCount = sampled.filter(p => p.speed_kmh === 0).length
    expect(zeroCount).toBeGreaterThan(10)
  })
})

function xsOf(seg: string): number[] {
  return seg.split(' ').map(pair => Number(pair.split(',')[0]))
}

describe('buildSpeedChartData', () => {
  it('点数が2未満なら null を返す', () => {
    expect(buildSpeedChartData([], 800, 180, 8)).toBeNull()
    expect(buildSpeedChartData([{ record_start_ts: 0, offset_secs: 0, speed_kmh: 0 }], 800, 180, 8)).toBeNull()
  })

  it('単一レコードでは offset_secs がそのまま時間軸になり、1本の segment になる', () => {
    const points: Net780SpeedPoint[] = [
      { record_start_ts: 1000, offset_secs: 0, speed_kmh: 0 },
      { record_start_ts: 1000, offset_secs: 0.5, speed_kmh: 10 },
      { record_start_ts: 1000, offset_secs: 1.0, speed_kmh: 20 },
    ]
    const chart = buildSpeedChartData(points, 100, 100, 0)!
    expect(chart.pointCount).toBe(3)
    expect(chart.maxSpeed).toBe(20)
    expect(chart.maxSecs).toBe(1.0)
    expect(chart.segments).toHaveLength(1)
    // x は 0, 50, 100 (等間隔の offset_secs をそのまま正規化)
    expect(chart.segments[0]).toBe('0.0,100.0 50.0,50.0 100.0,0.0')
  })

  it('レコード境界をまたいでも record_start_ts を加味した絶対時刻で単調増加する (offset_secs 巻き戻りバグの回帰)', () => {
    // record 1: start_ts=1000, offset 0..1.0 / record 2: start_ts=1002 (record 1 の
    // 最終点の 1 秒後から開始、閾値未満の端数差なので同一 segment のまま)。
    // offset_secs だけを x に使うと record 2 の点が record 1 の途中に巻き戻ってしまう。
    const points: Net780SpeedPoint[] = [
      { record_start_ts: 1000, offset_secs: 0, speed_kmh: 0 },
      { record_start_ts: 1000, offset_secs: 1.0, speed_kmh: 10 },
      { record_start_ts: 1002, offset_secs: 0, speed_kmh: 20 },
      { record_start_ts: 1002, offset_secs: 1.0, speed_kmh: 30 },
    ]
    const chart = buildSpeedChartData(points, 100, 100, 0)!
    expect(chart.segments).toHaveLength(1)
    const xs = xsOf(chart.segments[0]!)
    // 絶対時刻 (1000, 1001, 1002, 1003) が単調増加するので x も単調増加のはず
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(xs[0]).toBe(0)
    expect(xs[3]).toBe(100)
  })

  it('record 境界に長い空白期間があると segment を分割し、直線補間しない (斜め線バグの回帰)', () => {
    // record 1 は t=1000〜1001、record 2 は 1 時間後の t=4601〜4602 に開始
    // (SPEED_GAP_THRESHOLD_SECS=5 を大きく超える空白期間)。
    const points: Net780SpeedPoint[] = [
      { record_start_ts: 1000, offset_secs: 0, speed_kmh: 80 },
      { record_start_ts: 1000, offset_secs: 1.0, speed_kmh: 90 },
      { record_start_ts: 4601, offset_secs: 0, speed_kmh: 10 },
      { record_start_ts: 4601, offset_secs: 1.0, speed_kmh: 20 },
    ]
    const chart = buildSpeedChartData(points, 100, 100, 0)!
    expect(chart.segments).toHaveLength(2)
    expect(chart.pointCount).toBe(4)
    // 2つの segment それぞれが独立した polyline (空白期間を跨ぐ直線が無い)
    expect(xsOf(chart.segments[0]!).length).toBe(2)
    expect(xsOf(chart.segments[1]!).length).toBe(2)
  })

  it('fixedMinTime/fixedMaxTime を渡すとデータの min/max ではなく固定範囲で正規化する', () => {
    const points: Net780SpeedPoint[] = [
      { record_start_ts: 100, offset_secs: 0, speed_kmh: 0 },
      { record_start_ts: 100, offset_secs: 0.5, speed_kmh: 50 },
    ]
    // データは t=100〜100.5 だが、0〜1000 の固定範囲で正規化する
    const chart = buildSpeedChartData(points, 100, 100, 0, 600, 0, 1000)!
    const xs = xsOf(chart.segments[0]!)
    expect(xs[0]).toBeCloseTo(10, 1) // (100-0)/1000*100
    expect(xs[1]).toBeCloseTo(10.05, 1) // (100.5-0)/1000*100
  })
})

describe('buildDailySpeedCharts', () => {
  it('点が無ければ空配列を返す', () => {
    expect(buildDailySpeedCharts([], 800, 180, 8)).toEqual([])
  })

  it('JST 暦日ごとに分割し、日付昇順で返す', () => {
    // 2026-07-01 06:00:00 UTC-as-JST と 2026-07-02 06:00:00 UTC-as-JST
    const day1 = Date.UTC(2026, 6, 1, 6, 0, 0) / 1000
    const day2 = Date.UTC(2026, 6, 2, 6, 0, 0) / 1000
    const points: Net780SpeedPoint[] = [
      { record_start_ts: day2, offset_secs: 0, speed_kmh: 40 },
      { record_start_ts: day2, offset_secs: 1, speed_kmh: 50 },
      { record_start_ts: day1, offset_secs: 0, speed_kmh: 10 },
      { record_start_ts: day1, offset_secs: 1, speed_kmh: 20 },
    ]
    const daily = buildDailySpeedCharts(points, 100, 100, 0)
    expect(daily.map(d => d.date)).toEqual(['2026-07-01', '2026-07-02'])
    expect(daily[0]!.chart.pointCount).toBe(2)
    expect(daily[1]!.chart.pointCount).toBe(2)
  })

  it('各日のチャートは 0:00〜24:00 固定範囲で正規化される (日をまたいでもスケールが揃う)', () => {
    const dayStart = Date.UTC(2026, 6, 1, 0, 0, 0) / 1000
    const points: Net780SpeedPoint[] = [
      // 6時ちょうどと 6時+0.5秒 (同一 run、gap 判定に引っかからない近接点)
      { record_start_ts: dayStart + 6 * 3600, offset_secs: 0, speed_kmh: 10 },
      { record_start_ts: dayStart + 6 * 3600, offset_secs: 0.5, speed_kmh: 20 },
    ]
    const daily = buildDailySpeedCharts(points, 100, 100, 0)
    expect(daily).toHaveLength(1)
    const xs = xsOf(daily[0]!.chart.segments[0]!)
    // 24h 固定幅で正規化: 6時 → 25.0 (6/24*100)、0.5 秒後はほぼ同じ位置
    expect(xs[0]).toBeCloseTo(25.0, 1)
    expect(xs[1]).toBeCloseTo(25.0, 1)
  })
})

const commEvent = (ts: number, code: number): Net780EventSummary => ({
  ts,
  code,
  subcode: 0,
  description: null,
  payload_ascii: null,
  payload_len: 0,
})

describe('buildDailyGpsPoints', () => {
  it('点が無ければ空配列を返す', () => {
    expect(buildDailyGpsPoints([])).toEqual([])
  })

  it('(0,0) の GPS 未捕捉プレースホルダーを除外する', () => {
    const day1 = net780DateStartTs('2026-07-01') + 6 * 3600
    const points: Net780GpsPoint[] = [
      { ts: day1, lat: 0, lon: 0 },
      { ts: day1 + 1, lat: 32.75, lon: 129.87 },
    ]
    const daily = buildDailyGpsPoints(points)
    expect(daily).toHaveLength(1)
    expect(daily[0]!.points).toHaveLength(1)
    expect(daily[0]!.points[0]!.lat).toBe(32.75)
  })

  it('JST 暦日ごとに分割し、日付昇順で返す', () => {
    const day1 = net780DateStartTs('2026-07-01') + 6 * 3600
    const day2 = net780DateStartTs('2026-07-02') + 6 * 3600
    const points: Net780GpsPoint[] = [
      { ts: day2, lat: 33, lon: 130 },
      { ts: day1, lat: 32, lon: 129 },
    ]
    const daily = buildDailyGpsPoints(points)
    expect(daily.map(d => d.date)).toEqual(['2026-07-01', '2026-07-02'])
  })

  it('通信断 (0xB8) 〜 通信復帰 (0xB9) 区間内の GPS 点を除外する', () => {
    const day1 = net780DateStartTs('2026-07-01') + 6 * 3600
    const points: Net780GpsPoint[] = [
      { ts: day1, lat: 43.0, lon: 143.0 }, // 通信断前 (正常)
      { ts: day1 + 60, lat: 42.6, lon: 144.2 }, // 通信断中 (異常、除外対象)
      { ts: day1 + 600, lat: 43.05, lon: 143.05 }, // 通信復帰後、十分な時間を空けて移動 (正常)
    ]
    const events = [commEvent(day1 + 30, 0xB8), commEvent(day1 + 90, 0xB9)]
    const daily = buildDailyGpsPoints(points, events)
    expect(daily[0]!.points).toHaveLength(2)
    expect(daily[0]!.points.map(p => p.lat)).toEqual([43.0, 43.05])
  })

  it('対応する通信復帰が無い場合は記録終端まで通信断とみなし除外する', () => {
    const day1 = net780DateStartTs('2026-07-01') + 6 * 3600
    const points: Net780GpsPoint[] = [
      { ts: day1, lat: 43.0, lon: 143.0 },
      { ts: day1 + 3600, lat: 42.6, lon: 144.2 },
    ]
    const events = [commEvent(day1 + 30, 0xB8)]
    const daily = buildDailyGpsPoints(points, events)
    expect(daily[0]!.points).toHaveLength(1)
    expect(daily[0]!.points[0]!.lat).toBe(43.0)
  })

  it('events を渡さない場合は従来通りフィルタしない', () => {
    const day1 = net780DateStartTs('2026-07-01') + 6 * 3600
    const points: Net780GpsPoint[] = [{ ts: day1, lat: 42.6, lon: 144.2 }]
    const daily = buildDailyGpsPoints(points)
    expect(daily[0]!.points).toHaveLength(1)
  })

  it('物理的にありえない速度のジャンプ先を除外する (通信断イベントが無くても)', () => {
    const day1 = net780DateStartTs('2026-07-01') + 6 * 3600
    const points: Net780GpsPoint[] = [
      { ts: day1, lat: 43.0, lon: 143.0 }, // 正常
      { ts: day1 + 60, lat: 42.6, lon: 144.2 }, // 60 秒で 44km 移動 (物理的にありえない、除外対象)
      { ts: day1 + 600, lat: 43.05, lon: 143.05 }, // 十分な時間を空けて正常に復帰
    ]
    const daily = buildDailyGpsPoints(points)
    expect(daily[0]!.points).toHaveLength(2)
    expect(daily[0]!.points.map(p => p.lat)).toEqual([43.0, 43.05])
  })
})

describe('filterImplausibleGpsJumps', () => {
  it('空配列を渡すと空配列を返す', () => {
    expect(filterImplausibleGpsJumps([])).toEqual([])
  })

  it('速度が妥当な範囲なら全点を残す', () => {
    const points: Net780GpsPoint[] = [
      { ts: 0, lat: 43.0, lon: 143.0 },
      { ts: 60, lat: 43.01, lon: 143.01 }, // 60 秒で ~1.2km ≒ 72km/h
    ]
    expect(filterImplausibleGpsJumps(points)).toEqual(points)
  })

  it('物理的にありえない速度のジャンプ先を除外する', () => {
    const points: Net780GpsPoint[] = [
      { ts: 0, lat: 43.0, lon: 143.0 },
      { ts: 60, lat: 42.6, lon: 144.2 }, // 60 秒で ~44.5km ≒ 2670km/h (除外対象)
      { ts: 120, lat: 43.01, lon: 143.01 },
    ]
    expect(filterImplausibleGpsJumps(points)).toEqual([points[0], points[2]])
  })

  it('直前の「採用済み」点と比較する (ジャンプ先で複数点続いても連鎖除外する)', () => {
    const points: Net780GpsPoint[] = [
      { ts: 0, lat: 43.0, lon: 143.0 },
      { ts: 60, lat: 42.6, lon: 144.2 }, // ジャンプ (除外)
      { ts: 120, lat: 42.601, lon: 144.201 }, // ジャンプ先付近に留まる (採用済み点=最初の点との比較で依然ジャンプなので除外)
      { ts: 3720, lat: 43.02, lon: 143.02 }, // 62 分後に実座標へ復帰 (妥当な速度なので採用)
    ]
    const result = filterImplausibleGpsJumps(points)
    expect(result).toEqual([points[0], points[3]])
  })

  it('至近距離の揺らぎ (0.3km 未満) は速度が高くても除外しない', () => {
    const points: Net780GpsPoint[] = [
      { ts: 0, lat: 43.0, lon: 143.0 },
      { ts: 1, lat: 43.001, lon: 143.0 }, // 1 秒で ~0.11km ≒ 400km/h だが距離が小さいので許容
    ]
    expect(filterImplausibleGpsJumps(points)).toEqual(points)
  })

  it('同時刻・逆順の点はそのまま残す (dt<=0 はスキップ判定しない)', () => {
    const points: Net780GpsPoint[] = [
      { ts: 100, lat: 43.0, lon: 143.0 },
      { ts: 100, lat: 42.6, lon: 144.2 }, // dt=0
    ]
    expect(filterImplausibleGpsJumps(points)).toEqual(points)
  })
})

describe('extractCommOutageRanges', () => {
  it('0xB8 → 0xB9 のペアを区間として抽出する', () => {
    const events = [commEvent(100, 0xB8), commEvent(200, 0xB9)]
    expect(extractCommOutageRanges(events)).toEqual([{ start: 100, end: 200 }])
  })

  it('未整列のイベント列でも時系列順に処理する', () => {
    const events = [commEvent(200, 0xB9), commEvent(100, 0xB8)]
    expect(extractCommOutageRanges(events)).toEqual([{ start: 100, end: 200 }])
  })

  it('対応する 0xB9 が無い 0xB8 は end=Infinity の区間にする', () => {
    const events = [commEvent(100, 0xB8)]
    expect(extractCommOutageRanges(events)).toEqual([{ start: 100, end: Infinity }])
  })

  it('通信断/復帰以外のイベントは無視する', () => {
    const events = [commEvent(50, 0xA0), commEvent(100, 0xB8), commEvent(200, 0xB9)]
    expect(extractCommOutageRanges(events)).toEqual([{ start: 100, end: 200 }])
  })

  it('イベントが無ければ空配列を返す', () => {
    expect(extractCommOutageRanges([])).toEqual([])
  })
})

describe('chartXRatioToTime', () => {
  const dayStart = net780DateStartTs('2026-07-01')

  it('ratio=0 は dayStart、ratio=1 は dayStart+24h になる', () => {
    expect(chartXRatioToTime(0, dayStart, 800, 8)).toBe(dayStart)
    expect(chartXRatioToTime(1, dayStart, 800, 8)).toBe(dayStart + 24 * 60 * 60)
  })

  it('ratio=0.5 は正午 (dayStart+12h) 付近になる', () => {
    const t = chartXRatioToTime(0.5, dayStart, 800, 8)
    expect(t).toBeCloseTo(dayStart + 12 * 60 * 60, 0)
  })

  it('範囲外の ratio は dayStart〜dayStart+24h にクランプされる', () => {
    expect(chartXRatioToTime(-1, dayStart, 800, 8)).toBe(dayStart)
    expect(chartXRatioToTime(2, dayStart, 800, 8)).toBe(dayStart + 24 * 60 * 60)
  })
})
