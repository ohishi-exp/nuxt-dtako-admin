import { describe, expect, it } from 'vitest'
import {
  addDriverCd,
  buildLitigationCaseSavePayload,
  emptyLitigationCaseForm,
  isValidDriverCd,
  litigationCaseMonthCount,
  litigationCaseToForm,
  LITIGATION_CASE_MAX_DRIVERS,
  LITIGATION_CASE_MAX_MONTHS,
  LITIGATION_CASE_NAME_MAX_LENGTH,
  normalizeLitigationDriverCd,
  normalizeMonthOrder,
  removeDriverCd,
  validateLitigationCaseForm,
  type LitigationCaseFormInput,
  type LitigationCaseRecord,
} from '~/utils/litigation-case-form'

function baseForm(overrides: Partial<LitigationCaseFormInput> = {}): LitigationCaseFormInput {
  return {
    name: '未払残業代請求事件',
    fromMonth: '2024-04',
    toMonth: '2024-06',
    driverCds: ['1194', '1523'],
    memo: '',
    ...overrides,
  }
}

describe('emptyLitigationCaseForm', () => {
  it('全フィールド空の初期状態を返す', () => {
    expect(emptyLitigationCaseForm()).toEqual({ name: '', fromMonth: '', toMonth: '', driverCds: [], memo: '' })
  })
})

describe('litigationCaseToForm', () => {
  it('保存済みの案件をフォーム形式へ写す (driverCds は複製する)', () => {
    const entry: LitigationCaseRecord = {
      caseId: 'case-1',
      name: '事件A',
      fromMonth: '2024-01',
      toMonth: '2024-03',
      driverCds: ['1194'],
      memo: 'メモ',
      createdBy: 'viewer@example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
    const form = litigationCaseToForm(entry)
    expect(form).toEqual({ name: '事件A', fromMonth: '2024-01', toMonth: '2024-03', driverCds: ['1194'], memo: 'メモ' })
    // 複製であること (元の配列を書き換えても影響しない)
    form.driverCds.push('9999')
    expect(entry.driverCds).toEqual(['1194'])
  })
})

describe('isValidDriverCd / normalizeLitigationDriverCd', () => {
  it('数字1〜8桁を妥当とする', () => {
    expect(isValidDriverCd('1194')).toBe(true)
    expect(isValidDriverCd('12345678')).toBe(true)
  })

  it('前後空白を許容する (trim して判定)', () => {
    expect(isValidDriverCd('  1194  ')).toBe(true)
  })

  it('数字以外・9桁以上・空文字は不正', () => {
    expect(isValidDriverCd('abc')).toBe(false)
    expect(isValidDriverCd('123456789')).toBe(false)
    expect(isValidDriverCd('')).toBe(false)
  })

  it('normalizeLitigationDriverCd は前ゼロを除去する', () => {
    expect(normalizeLitigationDriverCd('01194')).toBe('1194')
    expect(normalizeLitigationDriverCd('  0042  ')).toBe('42')
  })
})

describe('addDriverCd', () => {
  it('新しい乗務員CDを末尾へ追加する', () => {
    const { driverCds, error } = addDriverCd(['1194'], '1523')
    expect(driverCds).toEqual(['1194', '1523'])
    expect(error).toBeNull()
  })

  it('前ゼロを正規化してから追加する', () => {
    const { driverCds } = addDriverCd([], '01194')
    expect(driverCds).toEqual(['1194'])
  })

  it('空文字/空白のみは何もしない (エラーも出さない)', () => {
    const { driverCds, error } = addDriverCd(['1194'], '   ')
    expect(driverCds).toEqual(['1194'])
    expect(error).toBeNull()
  })

  it('形式不正はエラーを返し、既存配列は変えない', () => {
    const { driverCds, error } = addDriverCd(['1194'], 'abc')
    expect(driverCds).toEqual(['1194'])
    expect(error).toMatch(/数字/)
  })

  it('既に居る乗務員CDは黙って無視する (重複除去)', () => {
    const { driverCds, error } = addDriverCd(['1194'], '01194')
    expect(driverCds).toEqual(['1194'])
    expect(error).toBeNull()
  })

  it(`上限 (${LITIGATION_CASE_MAX_DRIVERS}名) を超える追加はエラー`, () => {
    const many = Array.from({ length: LITIGATION_CASE_MAX_DRIVERS }, (_, i) => String(i + 1))
    const { driverCds, error } = addDriverCd(many, String(LITIGATION_CASE_MAX_DRIVERS + 1))
    expect(driverCds).toEqual(many)
    expect(error).toMatch(new RegExp(`${LITIGATION_CASE_MAX_DRIVERS}名まで`))
  })

  it('既存配列を書き換えない (イミュータブル)', () => {
    const original = ['1194']
    addDriverCd(original, '1523')
    expect(original).toEqual(['1194'])
  })
})

describe('removeDriverCd', () => {
  it('指定した乗務員CDだけを外す', () => {
    expect(removeDriverCd(['1194', '1523'], '1194')).toEqual(['1523'])
  })

  it('存在しないCDを指定しても変わらない', () => {
    expect(removeDriverCd(['1194'], '9999')).toEqual(['1194'])
  })
})

describe('normalizeMonthOrder', () => {
  it('昇順ならそのまま', () => {
    expect(normalizeMonthOrder('2024-04', '2024-06')).toEqual(['2024-04', '2024-06'])
  })

  it('逆順なら入れ替える', () => {
    expect(normalizeMonthOrder('2024-06', '2024-04')).toEqual(['2024-04', '2024-06'])
  })

  it('同じ月同士はそのまま', () => {
    expect(normalizeMonthOrder('2024-04', '2024-04')).toEqual(['2024-04', '2024-04'])
  })
})

describe('validateLitigationCaseForm', () => {
  it('正常な入力はエラー無し', () => {
    expect(validateLitigationCaseForm(baseForm())).toEqual([])
  })

  it('案件名が空ならエラー', () => {
    const errors = validateLitigationCaseForm(baseForm({ name: '   ' }))
    expect(errors).toContainEqual({ field: 'name', message: '案件名を入力してください' })
  })

  it(`案件名が${LITIGATION_CASE_NAME_MAX_LENGTH}文字を超えるとエラー`, () => {
    const tooLong = 'あ'.repeat(LITIGATION_CASE_NAME_MAX_LENGTH + 1)
    const errors = validateLitigationCaseForm(baseForm({ name: tooLong }))
    expect(errors.some(e => e.field === 'name')).toBe(true)
  })

  it('開始月が未選択/不正な形式ならエラー', () => {
    expect(validateLitigationCaseForm(baseForm({ fromMonth: '' })).some(e => e.field === 'fromMonth')).toBe(true)
    expect(validateLitigationCaseForm(baseForm({ fromMonth: '2024/04' })).some(e => e.field === 'fromMonth')).toBe(true)
  })

  it('終了月が未選択ならエラー', () => {
    expect(validateLitigationCaseForm(baseForm({ toMonth: '' })).some(e => e.field === 'toMonth')).toBe(true)
  })

  it(`期間が${LITIGATION_CASE_MAX_MONTHS}か月を超えるとエラー (逆順でも判定する)`, () => {
    const forward = validateLitigationCaseForm(baseForm({ fromMonth: '2020-01', toMonth: '2025-02' }))
    expect(forward.some(e => e.field === 'range')).toBe(true)
    const reversed = validateLitigationCaseForm(baseForm({ fromMonth: '2025-02', toMonth: '2020-01' }))
    expect(reversed.some(e => e.field === 'range')).toBe(true)
  })

  it(`期間がちょうど${LITIGATION_CASE_MAX_MONTHS}か月ならエラー無し`, () => {
    const errors = validateLitigationCaseForm(baseForm({ fromMonth: '2020-01', toMonth: '2024-12' }))
    expect(errors.some(e => e.field === 'range')).toBe(false)
  })

  it('開始月/終了月が不正な形式のときは期間チェック自体を行わない', () => {
    const errors = validateLitigationCaseForm(baseForm({ fromMonth: 'invalid', toMonth: '2024-06' }))
    expect(errors.some(e => e.field === 'range')).toBe(false)
  })

  it('乗務員が0名ならエラー', () => {
    const errors = validateLitigationCaseForm(baseForm({ driverCds: [] }))
    expect(errors).toContainEqual({ field: 'driverCds', message: '乗務員を1名以上追加してください' })
  })

  it(`乗務員が${LITIGATION_CASE_MAX_DRIVERS}名を超えるとエラー`, () => {
    const many = Array.from({ length: LITIGATION_CASE_MAX_DRIVERS + 1 }, (_, i) => String(i + 1))
    const errors = validateLitigationCaseForm(baseForm({ driverCds: many }))
    expect(errors.some(e => e.field === 'driverCds')).toBe(true)
  })

  it('複数のエラーが同時に出る', () => {
    const errors = validateLitigationCaseForm(baseForm({ name: '', fromMonth: '', toMonth: '', driverCds: [] }))
    expect(errors.map(e => e.field).sort()).toEqual(['driverCds', 'fromMonth', 'name', 'toMonth'])
  })
})

describe('buildLitigationCaseSavePayload', () => {
  it('caseId 省略時は body に含めない (新規作成)', () => {
    const payload = buildLitigationCaseSavePayload(baseForm())
    expect(payload).not.toHaveProperty('caseId')
    expect(payload).toEqual({
      name: '未払残業代請求事件',
      fromMonth: '2024-04',
      toMonth: '2024-06',
      driverCds: ['1194', '1523'],
      memo: '',
    })
  })

  it('caseId を渡すと body に含む (更新)', () => {
    const payload = buildLitigationCaseSavePayload(baseForm(), 'case-1')
    expect(payload.caseId).toBe('case-1')
  })

  it('fromMonth/toMonth は逆順でも昇順化する', () => {
    const payload = buildLitigationCaseSavePayload(baseForm({ fromMonth: '2024-06', toMonth: '2024-04' }))
    expect(payload.fromMonth).toBe('2024-04')
    expect(payload.toMonth).toBe('2024-06')
  })

  it('name/memo は trim する', () => {
    const payload = buildLitigationCaseSavePayload(baseForm({ name: '  事件名  ', memo: '  備考  ' }))
    expect(payload.name).toBe('事件名')
    expect(payload.memo).toBe('備考')
  })
})

describe('litigationCaseMonthCount', () => {
  it('両端含めた月数を返す', () => {
    expect(litigationCaseMonthCount('2024-04', '2024-06')).toBe(3)
    expect(litigationCaseMonthCount('2024-01', '2024-01')).toBe(1)
  })

  it('形式不正なら0', () => {
    expect(litigationCaseMonthCount('invalid', '2024-06')).toBe(0)
  })
})
