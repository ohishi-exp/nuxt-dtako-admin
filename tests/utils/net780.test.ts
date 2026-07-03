import { describe, it, expect, afterEach } from 'vitest'
import { parseNet780Zip, net780EventCodeHex, downsampleSpeed, formatNet780Ts, buildSpeedChartData } from '~/utils/net780'
import type { Net780ParseResult, Net780SpeedPoint } from '~/utils/net780'
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
    // 先頭点は維持される (等間隔サンプリングの起点)
    expect(sampled[0]).toEqual(points[0])
  })
})

describe('buildSpeedChartData', () => {
  it('点数が2未満なら null を返す', () => {
    expect(buildSpeedChartData([], 800, 180, 8)).toBeNull()
    expect(buildSpeedChartData([{ record_start_ts: 0, offset_secs: 0, speed_kmh: 0 }], 800, 180, 8)).toBeNull()
  })

  it('単一レコードでは offset_secs がそのまま時間軸になる', () => {
    const points: Net780SpeedPoint[] = [
      { record_start_ts: 1000, offset_secs: 0, speed_kmh: 0 },
      { record_start_ts: 1000, offset_secs: 0.5, speed_kmh: 10 },
      { record_start_ts: 1000, offset_secs: 1.0, speed_kmh: 20 },
    ]
    const chart = buildSpeedChartData(points, 100, 100, 0)!
    expect(chart.pointCount).toBe(3)
    expect(chart.maxSpeed).toBe(20)
    expect(chart.maxSecs).toBe(1.0)
    // x は 0, 50, 100 (等間隔の offset_secs をそのまま正規化)
    expect(chart.polyline).toBe('0.0,100.0 50.0,50.0 100.0,0.0')
  })

  it('レコード境界をまたいでも record_start_ts を加味した絶対時刻で単調増加する (offset_secs 巻き戻りバグの回帰)', () => {
    // record 1: start_ts=1000, offset 0..1.0 / record 2: start_ts=1002 (record 1 の
    // 2 秒後から開始), offset は再び 0 から。offset_secs だけを x に使うと
    // record 2 の点が record 1 の途中に巻き戻ってしまう。
    const points: Net780SpeedPoint[] = [
      { record_start_ts: 1000, offset_secs: 0, speed_kmh: 0 },
      { record_start_ts: 1000, offset_secs: 1.0, speed_kmh: 10 },
      { record_start_ts: 1002, offset_secs: 0, speed_kmh: 20 },
      { record_start_ts: 1002, offset_secs: 1.0, speed_kmh: 30 },
    ]
    const chart = buildSpeedChartData(points, 100, 100, 0)!
    const xs = chart.polyline.split(' ').map(pair => Number(pair.split(',')[0]))
    // 絶対時刻 (1000, 1001, 1002, 1003) が単調増加するので x も単調増加のはず
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(xs[0]).toBe(0)
    expect(xs[3]).toBe(100)
  })
})
