/**
 * `app/utils/vehicle-settings-labels.ts` の formatSetting テスト。
 *
 * - PDF 由来の代表的なキーがラベル / 単位 / scale / enum 適用後に正しく表示されるか
 * - 辞書未登録のキーは label=null で素通しされるか
 * - 文字列値 (引用付き) は数値スケールが適用されずそのまま表示されるか
 */

import { describe, it, expect } from 'vitest'
import {
  formatSetting,
  VEHICLE_SETTING_LABELS,
} from '../../app/utils/vehicle-settings-labels'

describe('formatSetting', () => {
  it('日本語ラベル + enum 意味付き (BASE_VOLUME)', () => {
    const r = formatSetting('BASE_VOLUME', 2)
    expect(r.label).toBe('音量')
    expect(r.enumMeaning).toBe('中')
    expect(r.formatted).toBe('2 (中)')
  })

  it('単位付き (OPER_BACKUPDAY)', () => {
    const r = formatSetting('OPER_BACKUPDAY', 30)
    expect(r.label).toBe('運行データ保存日数')
    expect(r.unit).toBe('日')
    expect(r.formatted).toBe('30 日')
  })

  it('scale 適用 (PULS_SPNUM 800 → 8.00 パルス)', () => {
    const r = formatSetting('PULS_SPNUM', 800)
    expect(r.label).toBe('速度パルス数')
    expect(r.scaledValue).toBeCloseTo(8.0)
    expect(r.formatted).toBe('8.00 パルス')
  })

  it('scale + 4 decimals (PULS_DISTFACTOR 10000 → 1.0000)', () => {
    const r = formatSetting('PULS_DISTFACTOR', 10000)
    expect(r.label).toBe('距離補正')
    expect(r.formatted).toBe('1.0000')
  })

  it('scale + 単位 (OPER_RUNDETECTSP 30 → 3.0 km/h)', () => {
    const r = formatSetting('OPER_RUNDETECTSP', 30)
    expect(r.formatted).toBe('3.0 km/h')
  })

  it('SPWARN 系の programmatic 生成 (一般道制限速度)', () => {
    const r = formatSetting('SPWARN_WAY1_START', 650)
    expect(r.label).toBe('一般道制限速度')
    expect(r.formatted).toBe('65.0 km/h')
  })

  it('ACCWARN 系の G スケール (ACCWARN_ACCEL_THLD_D 40 → 0.40 G)', () => {
    const r = formatSetting('ACCWARN_ACCEL_THLD_D', 40)
    expect(r.formatted).toBe('0.40 G')
  })

  it('BUTT_*_NAME は文字列値、scale は適用されない', () => {
    const r = formatSetting('BUTT_11_NAME', '副免許証')
    expect(r.label).toBe('ボタン11 名称')
    expect(r.formatted).toBe('"副免許証"')
    expect(r.scaledValue).toBeNull()
  })

  it('BUTT_*_TYPE の enum (BUTT_5_TYPE=6 → 免許証読取ボタン)', () => {
    const r = formatSetting('BUTT_5_TYPE', 6)
    expect(r.label).toBe('ボタン5 タイプ')
    expect(r.enumMeaning).toBe('免許証読取ボタン')
    expect(r.formatted).toBe('6 (免許証読取ボタン)')
  })

  it('ボタンA/B (cfg 番号 6,7) は PDF 表記の "ボタンA" になる', () => {
    expect(formatSetting('BUTT_6_NAME', '高速').label).toBe('ボタンA 名称')
    expect(formatSetting('BUTT_7_NAME', 'ＢＰ').label).toBe('ボタンB 名称')
  })

  it('T1/T2 温度警告 (T1_ALRM_CH1_MAX → CH1高温警告温度 [℃])', () => {
    expect(formatSetting('T1_ALRM_CH1_MAX', 50).label).toBe('CH1高温警告温度')
    expect(formatSetting('T1_ALRM_CH1_MAX', 50).formatted).toBe('50 ℃')
    expect(formatSetting('T2_NOTE_CH4_MIN', -40).label).toBe('CH4低温注意温度[状態2]')
  })

  it('空文字列値はそのまま `""` で表示される (COMM_APN)', () => {
    const r = formatSetting('COMM_APN', '')
    expect(r.formatted).toBe('""')
  })

  it('辞書にないキーは label=null で raw を素通しする', () => {
    const r = formatSetting('UNKNOWN_KEY_FOO', 123)
    expect(r.label).toBeNull()
    expect(r.formatted).toBe('123')
  })

  it('数値だが enum マッチしない値は raw + 単位だけ表示 (BASE_VOLUME=99)', () => {
    const r = formatSetting('BASE_VOLUME', 99)
    expect(r.label).toBe('音量')
    expect(r.enumMeaning).toBeNull()
    expect(r.formatted).toBe('99')
  })
})

describe('VEHICLE_SETTING_LABELS 辞書サイズ', () => {
  it('PDF カバー範囲: 主要 prefix が全て揃っている', () => {
    const keys = Object.keys(VEHICLE_SETTING_LABELS)
    expect(keys.some((k) => k.startsWith('BASE_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('PULS_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('OPER_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('DISP_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('SPWARN_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('ACCWARN_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('RVWARN'))).toBe(true)
    expect(keys.some((k) => k.startsWith('IDLWARN_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('LDWARN_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('REST_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('T1_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('T2_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('EXTIO_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('COMM_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('SERIAL_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('BUTT_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('DVR_'))).toBe(true)
    expect(keys.some((k) => k.startsWith('MVSND_'))).toBe(true)
    // 一定の網羅 (cfg 全 554 キーの過半数をカバー)
    expect(keys.length).toBeGreaterThan(280)
  })
})
