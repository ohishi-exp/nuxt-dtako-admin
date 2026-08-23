import { describe, expect, it } from 'vitest'

import { parseNet780ArchiveBody } from '../../server/utils/net780-archive'
import { NET780_ARCHIVE_MAX_ITEMS } from '../../app/utils/net780-archive'
import { startOpeFromUnkoNo } from '../../server/utils/operation-zip'

// 実運行 (中村 2026-07-06)。
const UNKO_22 = '2607060418590000001109'

/** 末尾 4 桁だけ変えた 22 桁の運行NO を n 本作る。 */
function unkoNos(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${UNKO_22.slice(0, 18)}${String(i).padStart(4, '0')}`)
}

function fail(body: unknown): string {
  const r = parseNet780ArchiveBody(body)
  if (r.ok) throw new Error('ok になってしまった')
  return r.error
}

describe('parseNet780ArchiveBody', () => {
  it('22 桁の運行NO から ope_no / start_ope を組む (start_ope は operation-zip と同じ導出)', () => {
    const r = parseNet780ArchiveBody({ operationNos: [UNKO_22] })
    expect(r).toEqual({ ok: true, items: [{ ope_no: UNKO_22, start_ope: '2026/07/06 4:18:59' }] })
    if (r.ok) expect(r.items[0]!.start_ope).toBe(startOpeFromUnkoNo(UNKO_22))
  })

  it('23 桁は末尾を落として 22 桁にし、2マン (…1/…2) は dedupe する', () => {
    const other = unkoNos(2)[1]!
    const r = parseNet780ArchiveBody({ operationNos: [`${UNKO_22}1`, `${UNKO_22}2`, other] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.items.map(i => i.ope_no)).toEqual([UNKO_22, other])
    }
  })

  it('上限ちょうどは通り、超過は件数入りのメッセージで落とす (上限は dedupe 前の件数で見る)', () => {
    const okBody = { operationNos: unkoNos(NET780_ARCHIVE_MAX_ITEMS) }
    const ok = parseNet780ArchiveBody(okBody)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.items).toHaveLength(NET780_ARCHIVE_MAX_ITEMS)

    const over = unkoNos(NET780_ARCHIVE_MAX_ITEMS + 1)
    expect(fail({ operationNos: over })).toContain(String(over.length))
    // 同じ運行の 23 桁 2 本ずつでも、dedupe 前の件数で 400
    const dup = Array.from({ length: NET780_ARCHIVE_MAX_ITEMS + 1 }, (_, i) => `${UNKO_22}${i % 2 + 1}`)
    expect(fail({ operationNos: dup })).toContain(String(NET780_ARCHIVE_MAX_ITEMS))
  })

  it('operationNos が無い / 配列でない / 空 / body が null は落とす', () => {
    expect(fail(null)).toContain('operationNos')
    expect(fail({})).toContain('operationNos')
    expect(fail({ operationNos: UNKO_22 })).toContain('operationNos')
    expect(fail({ operationNos: [] })).toContain('空')
  })

  it('文字列でない要素は落とす', () => {
    expect(fail({ operationNos: [UNKO_22, 42] })).toContain('文字列')
  })

  it('桁数・文字種が違う運行NO は、その値入りで落とす', () => {
    const bad = UNKO_22.slice(0, 21)
    expect(fail({ operationNos: [UNKO_22, bad] })).toContain(bad)
    expect(fail({ operationNos: [`${UNKO_22}12`] })).toContain(`${UNKO_22}12`)
  })

  it('先頭 12 桁が日時として不正な運行NO は落とす', () => {
    const bad = `261306041859${UNKO_22.slice(12)}`
    expect(fail({ operationNos: [bad] })).toContain(bad)
  })
})
