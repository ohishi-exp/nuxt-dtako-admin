import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * JSZip はモック (Refs #760 の 25)。`bundleZips` が「渡した名前・バイト列をそのまま
 * `file()` し、`generateAsync({ type: 'blob', compression: 'STORE' })` の結果を返す」こと
 * だけを見る。zip の中身の正しさは JSZip 側の責務 (`net780.ts` / `y-time-xlsx.ts` と同じ)。
 */
const { fileCalls, generateCalls, generated } = vi.hoisted(() => ({
  fileCalls: [] as Array<[string, unknown]>,
  generateCalls: [] as unknown[],
  generated: new Blob(['zip']),
}))
vi.mock('jszip', () => ({
  default: class {
    file(name: string, data: unknown) {
      fileCalls.push([name, data])
      return this
    }

    generateAsync(opts: unknown) {
      generateCalls.push(opts)
      return Promise.resolve(generated)
    }
  },
}))

import { bundleZips, bulkZipFilename } from '~/utils/operation-zip-bundle'

describe('bundleZips', () => {
  beforeEach(() => {
    fileCalls.length = 0
    generateCalls.length = 0
  })

  it('渡した順に file() し、STORE (無圧縮) の blob を返す', async () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new ArrayBuffer(2)
    const blob = await bundleZips([
      { name: 'csvdata-2607010533090000004219.zip', bytes: a },
      { name: 'csvdata-2607020533090000004219.zip', bytes: b },
    ])
    expect(blob).toBe(generated)
    expect(fileCalls).toEqual([
      ['csvdata-2607010533090000004219.zip', a],
      ['csvdata-2607020533090000004219.zip', b],
    ])
    expect(generateCalls).toEqual([{ type: 'blob', compression: 'STORE' }])
  })

  it('空なら file() せず、空の zip を返す (呼び出し側は 1 本も引けなければ呼ばない想定だが、呼んでも落ちない)', async () => {
    await bundleZips([])
    expect(fileCalls).toEqual([])
    expect(generateCalls).toHaveLength(1)
  })
})

describe('bulkZipFilename', () => {
  it('csvdata-<取引先>-<積地→卸地>-<ym>.zip。経路が無ければ all', () => {
    expect(bulkZipFilename('2271', '帯広市→釧路市', '2026-07')).toBe('csvdata-2271-帯広市→釧路市-2026-07.zip')
    expect(bulkZipFilename('大石畜産', null, '2026-07')).toBe('csvdata-大石畜産-all-2026-07.zip')
  })

  it('ファイル名に使えない文字は _ に寄せる (取引先名・経路の両方)', () => {
    expect(bulkZipFilename('A/B:C', '音更*→釧路?', '2026-07')).toBe('csvdata-A_B_C-音更_→釧路_-2026-07.zip')
    expect(bulkZipFilename('x', '<a>|"b"\\c', '2026-07')).toBe('csvdata-x-_a___b__c-2026-07.zip')
  })
})
