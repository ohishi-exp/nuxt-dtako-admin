import { describe, it, expect } from 'vitest'
import { parseKintaiAlcUploadResult } from '~/utils/kintai-alc-upload'

const OPE_NO_22 = '2605230341010000004219'
const START_OPE = '2026/05/23 3:41:01'

function body(over: Record<string, unknown> = {}) {
  return {
    ope_no: OPE_NO_22,
    start_ope: START_OPE,
    bytes: 8912,
    entries: ['KUDGURI.csv', 'KUDGIVT.csv'],
    upload_id: 'up_123',
    operations_count: 2,
    split_failed: 0,
    split_confirmed: false,
    notes: {
      has_kudgivt: 'この取り込みで対象運行の has_kudgivt は DEFAULT FALSE に戻ります。',
      split: 'split_failed=0 は取り込み直後のスナップショットでしかなく確定ではありません。',
      preview: 'この口に preview はありません。',
    },
    ...over,
  }
}

describe('parseKintaiAlcUploadResult', () => {
  it('DtakoAlcUploadReport をそのまま camelCase に読み替える', () => {
    expect(parseKintaiAlcUploadResult(body())).toEqual({
      opeNo: OPE_NO_22,
      startOpe: START_OPE,
      uploadId: 'up_123',
      operationsCount: 2,
      splitFailed: 0,
      splitConfirmed: false,
      notes: {
        hasKudgivt: 'この取り込みで対象運行の has_kudgivt は DEFAULT FALSE に戻ります。',
        split: 'split_failed=0 は取り込み直後のスナップショットでしかなく確定ではありません。',
        preview: 'この口に preview はありません。',
      },
    })
  })

  it('★ split_confirmed は常に false を返す (応答が true でも読まない — 分割済みと誤読させない)', () => {
    expect(parseKintaiAlcUploadResult(body({ split_confirmed: true })).splitConfirmed).toBe(false)
  })

  it('operations_count=0 も null と区別して表示できる (黙って隠さない)', () => {
    expect(parseKintaiAlcUploadResult(body({ operations_count: 0 })).operationsCount).toBe(0)
  })

  it('split_failed が無い (null) 応答は splitFailed が null のまま (0 と混同しない)', () => {
    expect(parseKintaiAlcUploadResult(body({ split_failed: null })).splitFailed).toBeNull()
  })

  it('raw が壊れた形 (null/非object/notes欠落) でも例外を投げず null/空に倒す', () => {
    expect(parseKintaiAlcUploadResult(null)).toEqual({
      opeNo: null,
      startOpe: null,
      uploadId: null,
      operationsCount: null,
      splitFailed: null,
      splitConfirmed: false,
      notes: { hasKudgivt: null, split: null, preview: null },
    })
    expect(parseKintaiAlcUploadResult('garbage').opeNo).toBeNull()
    expect(parseKintaiAlcUploadResult({}).notes).toEqual({ hasKudgivt: null, split: null, preview: null })
  })
})
