import { describe, it, expect, afterEach } from 'vitest'
import { parseNet780Zip, net780EventCodeHex, downsampleSpeed, formatNet780Ts } from '~/utils/net780'
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
