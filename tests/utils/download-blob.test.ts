/**
 * `downloadBlobResponse` — fetch レスポンスをブラウザに保存させる共通処理 (Refs #169)。
 *
 * **ファイル名の出どころが 2 つある**のがこの lib の要点:
 *
 * 1. サーバが `content-disposition: attachment; filename="…"` を付けてきたら**それに従う**
 * 2. 付けてこなければ**呼び出し側の fallback** を使う
 *
 * 取り違えると、**サーバが名前を指定しているのに呼び出し側の名前で保存される** /
 * **名前が無い回に空のファイル名になる**という、どちらも「保存はできたのに中身と
 * 名前が合っていない」形の欠陥になる。ヘッダの有無で撃ち分けていることを固定する。
 *
 * 消費者は `y-time-export.vue` と `daily-report-edit.vue` (計 6 か所)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadBlobResponse } from '~/utils/download-blob'

/** 実際に `<a download>` に載った名前と、開放された Object URL を記録する。 */
let downloaded: string[]
let created: string[]
let revoked: string[]

beforeEach(() => {
  downloaded = []
  created = []
  revoked = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:mock-${created.length}`
    created.push(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => { revoked.push(url) })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloaded.push(this.download)
  })
})

afterEach(() => { vi.restoreAllMocks() })

function res(headers: Record<string, string> = {}) {
  return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers })
}

describe('downloadBlobResponse', () => {
  it('content-disposition の filename があればそれで保存する', async () => {
    await downloadBlobResponse(
      res({ 'content-disposition': 'attachment; filename="拘束時間管理表_2026年07月.pdf"' }),
      'fallback.bin',
    )

    expect(downloaded).toEqual(['拘束時間管理表_2026年07月.pdf'])
  })

  it('content-disposition が無ければ呼び出し側の名前で保存する', async () => {
    await downloadBlobResponse(res(), 'y_time_0001_2026-07-01_2026-07-31.xlsx')

    expect(downloaded).toEqual(['y_time_0001_2026-07-01_2026-07-31.xlsx'])
  })

  it('★ filename= を持たない content-disposition は fallback に倒す (空の名前にしない)', async () => {
    await downloadBlobResponse(res({ 'content-disposition': 'attachment' }), 'fallback.zip')

    expect(downloaded).toEqual(['fallback.zip'])
  })

  it('作った Object URL は必ず開放する (掴んだまま離さない)', async () => {
    await downloadBlobResponse(res(), 'x.bin')

    expect(created).toHaveLength(1)
    expect(revoked).toEqual(created)
  })
})
