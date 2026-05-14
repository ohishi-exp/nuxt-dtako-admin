/**
 * `app/utils/vehicle-settings-cfg.ts` の pure ロジックテスト。
 *
 * fixture: `tests/fixtures/vehicle-dump-sample.zip` (実機 NET780 dump、車輛 cd 4437)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseCfg,
  extractVehicleSettingsFromZip,
} from '../../app/utils/vehicle-settings-cfg'

const ZIP_FIXTURE = resolve(__dirname, '../fixtures/vehicle-dump-sample.zip')

describe('parseCfg', () => {
  it('Machine Infomation の MachineID / ファーム ver をコメント行から拾う', () => {
    const text = [
      '####    NET780 Deveice Configration 	  ####',
      '##  Machine Infomation',
      '#   MachineID : Lrbn06U06Q',
      '#   Main App  : 1. 0.93',
      '#   u-boot    : 1. 0. 2',
      '',
      'BASE_VEHICLECD = 4437',
    ].join('\r\n')

    const { machine_info, settings } = parseCfg(text)
    expect(machine_info.machine_id).toBe('Lrbn06U06Q')
    expect(machine_info.main_app).toBe('1.0.93')
    expect(machine_info.u_boot).toBe('1.0.2')
    expect(settings.BASE_VEHICLECD).toBe(4437)
  })

  it('整数値は number、ダブルクオート値は文字列で保持する (日本語 / 空文字 / 先頭空白あり)', () => {
    const text = [
      'BASE_VEHICLECD = 4437',
      'BUTT_11_NAME = "副免許証"',
      'BUTT_12_NAME = " 交代"',
      'BUTT_15_NAME = ""',
      'CALI_G_Z = -3',
    ].join('\r\n')

    const { settings } = parseCfg(text)
    expect(settings.BASE_VEHICLECD).toBe(4437)
    expect(settings.BUTT_11_NAME).toBe('副免許証')
    expect(settings.BUTT_12_NAME).toBe(' 交代')
    expect(settings.BUTT_15_NAME).toBe('')
    expect(settings.CALI_G_Z).toBe(-3)
  })

  it('セクション header コメントは無視され、未知の `# foo : bar` も machine_info に混ざらない', () => {
    const text = [
      '#   Base Settings',
      '#   Unknown Field : ignore me',
      'BASE_VEHICLECD = 4437',
    ].join('\r\n')

    const { machine_info, settings } = parseCfg(text)
    expect(machine_info).toEqual({})
    expect(settings.BASE_VEHICLECD).toBe(4437)
  })
})

describe('extractVehicleSettingsFromZip', () => {
  it('実機 dump zip (4437) を読んで vehicle_cd / machine_info / 主要 settings が取れる', async () => {
    const buf = readFileSync(ZIP_FIXTURE)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

    const result = await extractVehicleSettingsFromZip(ab)

    expect(result.vehicle_cd).toBe('4437')
    expect(result.dump_dir).toBe('20260514_093253-0-0-4437')
    expect(result.cfg_filename).toBe('20260514_093253-0-0-4437.cfg')

    expect(result.machine_info.machine_id).toBe('Lrbn06U06Q')
    expect(result.machine_info.main_app).toMatch(/^\d+\.\d+\.\d+$/)
    expect(result.machine_info.kernel).toMatch(/^\d+\.\d+\.\d+$/)

    expect(result.settings.BASE_VEHICLECD).toBe(4437)
    expect(result.settings.PULS_SPNUM).toBe(800)
    // CP932 decode が効いていることを日本語値で検証
    expect(result.settings.INPUT1_NAME).toBe('油種')
    expect(result.settings.INPUT3_UNIT).toBe('L')
  })
})
