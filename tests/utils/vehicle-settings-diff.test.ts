/**
 * `app/utils/vehicle-settings-diff.ts` の pure ロジックテスト。
 */

import { describe, it, expect } from 'vitest'
import {
  diffSettings,
  diffMachineInfo,
  diffVehicleSettings,
  HIGHLIGHTED_DIFF_KEYS,
} from '../../app/utils/vehicle-settings-diff'
import type { VehicleSettings } from '../../app/utils/vehicle-settings-cfg'

describe('diffSettings', () => {
  it('全て同じなら空配列', () => {
    const a = { BASE_VEHICLECD: 4437, BUTT_11_NAME: '副免許' }
    const b = { BASE_VEHICLECD: 4437, BUTT_11_NAME: '副免許' }
    expect(diffSettings(a, b)).toEqual([])
  })

  it('値変更は changed として出る', () => {
    const a = { BASE_VEHICLECD: 4437, DVR_INFREC_ENABLE: 1 }
    const b = { BASE_VEHICLECD: 4437, DVR_INFREC_ENABLE: 0 }
    const d = diffSettings(a, b)
    expect(d).toEqual([
      { key: 'DVR_INFREC_ENABLE', left: 1, right: 0, changeType: 'changed' },
    ])
  })

  it('left にだけある key は removed, right にだけある key は added', () => {
    const a = { ONLY_LEFT: 'x', SHARED: 1 }
    const b = { ONLY_RIGHT: 'y', SHARED: 1 }
    const d = diffSettings(a, b)
    // ソート是キー辞書順: ONLY_LEFT, ONLY_RIGHT (SHARED は同一なので除外)
    expect(d).toEqual([
      { key: 'ONLY_LEFT', left: 'x', right: undefined, changeType: 'removed' },
      { key: 'ONLY_RIGHT', left: undefined, right: 'y', changeType: 'added' },
    ])
  })

  it('number と string の同値似 (4437 vs "4437") は型不一致なので changed として検出する', () => {
    const d = diffSettings({ K: 4437 }, { K: '4437' })
    expect(d).toHaveLength(1)
    expect(d[0]?.changeType).toBe('changed')
  })

  it('返りは cfg key の辞書順', () => {
    const a = { Z: 1, A: 1, M: 1 }
    const b = { Z: 2, A: 2, M: 2 }
    const d = diffSettings(a, b)
    expect(d.map((x) => x.key)).toEqual(['A', 'M', 'Z'])
  })
})

describe('diffMachineInfo', () => {
  it('main_app のバージョン違いを拾う', () => {
    const d = diffMachineInfo(
      { machine_id: 'Lrbn06U06Q', main_app: '1.0.92' },
      { machine_id: 'Lrbn06U06Q', main_app: '1.0.93' },
    )
    expect(d).toEqual([
      { field: 'main_app', left: '1.0.92', right: '1.0.93', changeType: 'changed' },
    ])
  })

  it('片方にしか無いフィールドを added/removed で出す', () => {
    const d = diffMachineInfo(
      { machine_id: 'A', sub_app: 'x' },
      { machine_id: 'A' },
    )
    expect(d).toEqual([
      { field: 'sub_app', left: 'x', right: undefined, changeType: 'removed' },
    ])
  })

  it('両方 undefined のフィールドは出さない', () => {
    const d = diffMachineInfo({ machine_id: 'A' }, { machine_id: 'A' })
    expect(d).toEqual([])
  })
})

describe('diffVehicleSettings', () => {
  it('highlighted には DVR_*_ENABLE の diff だけ含まれる', () => {
    const left: VehicleSettings = {
      vehicle_cd: '4437',
      dump_dir: 'a',
      cfg_filename: 'a.cfg',
      machine_info: { machine_id: 'A' },
      settings: { DVR_INFREC_ENABLE: 1, BASE_VEHICLECD: 4437, PULS_SPNUM: 800 },
    }
    const right: VehicleSettings = {
      vehicle_cd: '4437',
      dump_dir: 'b',
      cfg_filename: 'b.cfg',
      machine_info: { machine_id: 'A' },
      settings: { DVR_INFREC_ENABLE: 0, BASE_VEHICLECD: 4437, PULS_SPNUM: 810 },
    }
    const d = diffVehicleSettings(left, right)

    expect(d.machine_info).toEqual([])
    expect(d.settings.map((s) => s.key)).toEqual(['DVR_INFREC_ENABLE', 'PULS_SPNUM'])
    expect(d.highlighted.map((s) => s.key)).toEqual(['DVR_INFREC_ENABLE'])
  })

  it('HIGHLIGHTED_DIFF_KEYS に主要な DVR_*_ENABLE が含まれている', () => {
    expect(HIGHLIGHTED_DIFF_KEYS.has('DVR_INFREC_ENABLE')).toBe(true)
    expect(HIGHLIGHTED_DIFF_KEYS.has('DVR_EVTREC_ENABLE')).toBe(true)
    expect(HIGHLIGHTED_DIFF_KEYS.has('DVR_AUDIO_ENABLE')).toBe(true)
    expect(HIGHLIGHTED_DIFF_KEYS.has('BASE_VEHICLECD')).toBe(false)
  })
})
