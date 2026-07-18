/**
 * `app/utils/vehicle-settings-r2.ts` の pure ロジックテスト。
 */

import { describe, it, expect } from 'vitest'
import {
  VEHICLE_SETTINGS_R2_PREFIX,
  vehicleSettingsR2Paths,
  parseVehicleSettingsR2Key,
} from '../../app/utils/vehicle-settings-r2'

describe('vehicleSettingsR2Paths', () => {
  it('jsonObject / cfgObject が期待通りの key を組み立てる', () => {
    const paths = vehicleSettingsR2Paths('4437')
    expect(paths.jsonObject('20260514_093253-0-0-4437')).toBe(
      'vehicle-settings/4437/20260514_093253-0-0-4437.json',
    )
    expect(paths.cfgObject('20260514_093253-0-0-4437')).toBe(
      'vehicle-settings/4437/20260514_093253-0-0-4437.cfg',
    )
  })
})

describe('parseVehicleSettingsR2Key', () => {
  it('json key を分解できる', () => {
    expect(
      parseVehicleSettingsR2Key('vehicle-settings/4437/20260514_093253-0-0-4437.json'),
    ).toEqual({ vehicle_cd: '4437', dump_dir: '20260514_093253-0-0-4437', ext: 'json' })
  })

  it('cfg key も分解できる', () => {
    expect(
      parseVehicleSettingsR2Key('vehicle-settings/4437/20260514_093253-0-0-4437.cfg'),
    ).toEqual({ vehicle_cd: '4437', dump_dir: '20260514_093253-0-0-4437', ext: 'cfg' })
  })

  it('prefix が違えば null', () => {
    expect(parseVehicleSettingsR2Key('other-prefix/4437/x.json')).toBeNull()
  })

  it('vehicle_cd 直下にスラッシュが無ければ null', () => {
    expect(parseVehicleSettingsR2Key('vehicle-settings/4437')).toBeNull()
  })

  it('拡張子が無ければ null', () => {
    expect(parseVehicleSettingsR2Key('vehicle-settings/4437/no-ext')).toBeNull()
  })

  it('vehicle_cd が空文字なら null', () => {
    expect(parseVehicleSettingsR2Key('vehicle-settings//20260514.json')).toBeNull()
  })

  it('VEHICLE_SETTINGS_R2_PREFIX は vehicle-settings/', () => {
    expect(VEHICLE_SETTINGS_R2_PREFIX).toBe('vehicle-settings/')
  })
})
