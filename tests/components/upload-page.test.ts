/**
 * `/upload` (デジタコ CSV アップロード) の画面 (Refs #903 の 1 段目)。
 *
 * この画面の要は **「取り込みは成功したが CSV 分割が失敗した」を別枠で出す**こと
 * (Refs ohishi-exp/rust-ichibanboshi#205 の 40)。分割に失敗した運行は
 * `has_kudgivt = FALSE` のまま残り、読み取り側 3 クエリが全部 TRUE で絞るので
 * **一覧からも欠け検知からも同時に消える**。取り込みの緑だけを出すと
 * 「全部入った」と読まれて、消えたことに誰も気づけない。
 *
 * あわせて、この画面が同じ見た目にしてはいけないもの:
 *
 * 1. **読み込み中と 0 件** (保留中・履歴の両方)
 * 2. **リランの成功と失敗** (同じ場所に出るので色と文言で撃ち分ける)
 * 3. **分割の「完了」と「N 件失敗したまま」** — 200 が返っても個別 PUT は失敗しうる
 *
 * テストの型は `members-page.test.ts` と同じ。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import type { PendingUpload, UploadResponse } from '~/types'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api } = vi.hoisted(() => ({
  api: {
    uploadZip: vi.fn(),
    getPendingUploads: vi.fn(),
    rerunUpload: vi.fn(),
    getUploads: vi.fn(),
    splitCsv: vi.fn(),
  },
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  uploadZip: api.uploadZip,
  getPendingUploads: api.getPendingUploads,
  rerunUpload: api.rerunUpload,
  getUploads: api.getUploads,
  splitCsv: api.splitCsv,
}))

import UploadPage from '~/pages/upload.vue'

function pending(overrides: Partial<PendingUpload> = {}): PendingUpload {
  return {
    id: 'up_1',
    tenant_id: 't_1',
    filename: '20260701.zip',
    status: 'pending_retry',
    error_message: null,
    created_at: '2026-07-01T03:00:00Z',
    ...overrides,
  }
}

function uploaded(overrides: Record<string, unknown> = {}) {
  return {
    id: 'up_1',
    filename: '20260701.zip',
    status: 'completed',
    created_at: '2026-07-01T03:00:00Z',
    ...overrides,
  }
}

function result(overrides: Partial<UploadResponse> = {}): UploadResponse {
  return { upload_id: 'up_1', operations_count: 91, status: 'completed', ...overrides }
}

function mountPage() {
  return mount(UploadPage, { global: { stubs: NUXT_UI_PAGE_STUBS } })
}

function button(w: VueWrapper, label: string) {
  const found = w.findAll('button').filter((b) => b.text().trim() === label)
  expect(found, `「${label}」ボタンが 1 つでない`).toHaveLength(1)
  return found[0]!
}

const dropZone = (w: VueWrapper) => w.find('div.border-dashed')

function zip(name = 'dtako.zip') {
  return new File(['x'], name, { type: 'application/zip' })
}

/** file input に本物のファイルを載せて change を起こす (happy-dom は代入を許さない)。 */
async function selectFile(w: VueWrapper, files: File[] | null) {
  const input = w.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: files, configurable: true })
  await input.trigger('change')
  await flushPromises()
}

describe('/upload デジタコ CSV アップロード', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    api.getPendingUploads.mockResolvedValue([])
    api.getUploads.mockResolvedValue([])
    api.uploadZip.mockResolvedValue(result())
    api.rerunUpload.mockResolvedValue(result())
    api.splitCsv.mockResolvedValue({ split_failed: 0 })
  })

  describe('ZIP を渡す口', () => {
    it('ドラッグ中だけ枠の色を変える', async () => {
      const w = mountPage()
      await flushPromises()
      expect(dropZone(w).classes()).toContain('border-gray-300')

      await dropZone(w).trigger('dragover')
      expect(dropZone(w).classes()).toContain('border-blue-500')

      await dropZone(w).trigger('dragleave')
      expect(dropZone(w).classes()).toContain('border-gray-300')
    })

    it('ドロップされた ZIP を送る', async () => {
      const w = mountPage()
      await flushPromises()
      await dropZone(w).trigger('drop', { dataTransfer: { files: [zip()] } })
      await flushPromises()
      expect(api.uploadZip).toHaveBeenCalledTimes(1)
      expect(w.text()).toContain('91 件の運行データを取り込みました')
      // ドロップし終わったら枠の色は戻す
      expect(dropZone(w).classes()).toContain('border-gray-300')
    })

    it('ファイルの無いドロップでは送らない', async () => {
      const w = mountPage()
      await flushPromises()
      await dropZone(w).trigger('drop', { dataTransfer: { files: [] } })
      await dropZone(w).trigger('drop')
      await flushPromises()
      expect(api.uploadZip).not.toHaveBeenCalled()
    })

    it('枠を押すと隠しファイル入力を開く', async () => {
      const w = mountPage()
      await flushPromises()
      // `mockImplementation` で本物の click を止める — 隠し input は枠の**中**にあり、
      // 本物の click は枠まで bubble して同じ handler を呼び直す (無限再帰になる)。
      const click = vi
        .spyOn(w.find('input[type="file"]').element as HTMLInputElement, 'click')
        .mockImplementation(() => {})
      await dropZone(w).trigger('click')
      expect(click).toHaveBeenCalled()
    })

    it('選ばれた ZIP を送り、入力は空に戻す (同じファイルをもう一度選べる)', async () => {
      const w = mountPage()
      await flushPromises()
      await selectFile(w, [zip()])
      expect(api.uploadZip).toHaveBeenCalledTimes(1)
      expect((w.find('input[type="file"]').element as HTMLInputElement).value).toBe('')
    })

    it('選び直しをキャンセルしたら送らない', async () => {
      const w = mountPage()
      await flushPromises()
      await selectFile(w, [])
      await selectFile(w, null)
      expect(api.uploadZip).not.toHaveBeenCalled()
    })

    it('ZIP でなければ送る前に断る', async () => {
      const w = mountPage()
      await flushPromises()
      await selectFile(w, [new File(['x'], 'dtako.csv', { type: 'text/csv' })])
      expect(api.uploadZip).not.toHaveBeenCalled()
      expect(w.text()).toContain('ZIP ファイルを選択してください')
    })

    it('送っている間は「アップロード中...」を出す', async () => {
      let resolve!: (v: UploadResponse) => void
      api.uploadZip.mockReturnValue(new Promise<UploadResponse>((r) => { resolve = r }))
      const w = mountPage()
      await flushPromises()
      await selectFile(w, [zip()])
      expect(w.text()).toContain('アップロード中...')

      resolve(result())
      await flushPromises()
      expect(w.text()).not.toContain('アップロード中...')
    })

    it('失敗したら理由を出す', async () => {
      api.uploadZip.mockRejectedValue(new Error('ZIP が壊れています'))
      const w = mountPage()
      await flushPromises()
      await selectFile(w, [zip()])
      expect(w.text()).toContain('ZIP が壊れています')
    })

    it('Error 以外で失敗しても黙らない', async () => {
      api.uploadZip.mockRejectedValue(413)
      const w = mountPage()
      await flushPromises()
      await selectFile(w, [zip()])
      expect(w.text()).toContain('アップロードに失敗しました')
    })
  })

  describe('★ 取り込み成功と CSV 分割失敗を別枠で出す (Refs #205-40)', () => {
    it('分割が失敗していたら、取り込みの緑とは別に赤で出して次の手順を言う', async () => {
      api.uploadZip.mockResolvedValue(result({ split_failed: 3 }))
      const w = mountPage()
      await flushPromises()
      await selectFile(w, [zip()])
      // 取り込みの成功表示は消さない (実際に入っているので)
      expect(w.text()).toContain('91 件の運行データを取り込みました')
      expect(w.text()).toContain('CSV分割が 3 件失敗しました')
      expect(w.text()).toContain('一覧にも欠け検知にも出てきません')
      expect(w.text()).toContain('CSV分割')
    })

    it('分割が 0 件失敗なら赤は出さない', async () => {
      api.uploadZip.mockResolvedValue(result({ split_failed: 0 }))
      const w = mountPage()
      await flushPromises()
      await selectFile(w, [zip()])
      expect(w.text()).not.toContain('件失敗しました')
    })

    it('古い alc で split_failed が無くても赤は出さない (不明を失敗と決めつけない)', async () => {
      api.uploadZip.mockResolvedValue(result())
      const w = mountPage()
      await flushPromises()
      await selectFile(w, [zip()])
      expect(w.text()).not.toContain('件失敗しました')
    })
  })

  describe('保留中のアップロード', () => {
    it('読み込み中は「保留中なし」と別の見た目にする', async () => {
      let resolve!: (v: PendingUpload[]) => void
      api.getPendingUploads.mockReturnValue(new Promise<PendingUpload[]>((r) => { resolve = r }))
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('読み込み中...')
      expect(w.text()).not.toContain('保留中のアップロードはありません')

      resolve([])
      await flushPromises()
      expect(w.text()).toContain('保留中のアップロードはありません')
    })

    it('状態ごとに色と文言を撃ち分ける', async () => {
      api.getPendingUploads.mockResolvedValue([
        pending({ id: 'a', status: 'completed' }),
        pending({ id: 'b', status: 'pending_retry' }),
        pending({ id: 'c', status: 'failed' }),
        pending({ id: 'd', status: 'processing' }),
      ])
      const w = mountPage()
      await flushPromises()
      const rows = w.findAll('div.rounded-lg.text-sm.border')
      expect(rows).toHaveLength(4)
      expect(rows[0]!.text()).toContain('完了')
      expect(rows[0]!.classes()).toContain('border-green-200')
      expect(rows[1]!.text()).toContain('保留中')
      expect(rows[1]!.classes()).toContain('border-yellow-200')
      expect(rows[2]!.text()).toContain('失敗')
      expect(rows[2]!.classes()).toContain('border-red-200')
      // 知らない状態は生の値をそのまま出す (勝手に「失敗」に寄せない)
      expect(rows[3]!.text()).toContain('processing')
      expect(rows[3]!.classes()).not.toContain('border-red-200')
    })

    it('リランは pending_retry / failed にだけ出す', async () => {
      api.getPendingUploads.mockResolvedValue([
        pending({ id: 'a', status: 'completed' }),
        pending({ id: 'b', status: 'pending_retry' }),
        pending({ id: 'c', status: 'failed' }),
      ])
      const w = mountPage()
      await flushPromises()
      expect(w.findAll('button').filter((b) => b.text().trim() === 'リラン')).toHaveLength(2)
    })

    it('エラー本文があれば行に出す', async () => {
      api.getPendingUploads.mockResolvedValue([pending({ error_message: 'unko_no が重複' })])
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('unko_no が重複')
    })

    it('日時は月/日 時:分 で出す', async () => {
      api.getPendingUploads.mockResolvedValue([pending()])
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toMatch(/\d{1,2}\/\d{1,2} \d{2}:\d{2}/)
    })

    it('再読み込みでもう一度取りに行く', async () => {
      const w = mountPage()
      await flushPromises()
      // 保留中カードの再読み込みボタン (ラベル無しの ghost)
      await w.findAll('button')[0]!.trigger('click')
      await flushPromises()
      expect(api.getPendingUploads).toHaveBeenCalledTimes(2)
    })

    // **現状の挙動を固定するテスト。** `loadPending` は catch を握りつぶして空配列に
    // するので、**取得に失敗したときと本当に 0 件のときが同じ見た目**になる。
    // 本番コードは #903 の制約 (テストのために本番コードを変えない) で触っていない。
    it('取得に失敗すると空一覧になる (失敗と 0 件が同じ見た目 — 現状の挙動)', async () => {
      api.getPendingUploads.mockRejectedValue(new Error('落ちた'))
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('保留中のアップロードはありません')
      expect(w.text()).not.toContain('落ちた')
    })
  })

  describe('リラン', () => {
    beforeEach(() => {
      api.getPendingUploads.mockResolvedValue([pending()])
    })

    it('成功したら件数を出し、行の状態を更新して読み直す', async () => {
      api.rerunUpload.mockResolvedValue(result({ operations_count: 12, status: 'completed' }))
      const w = mountPage()
      await flushPromises()
      await button(w, 'リラン').trigger('click')
      await flushPromises()
      expect(api.rerunUpload).toHaveBeenCalledWith('up_1')
      expect(w.text()).toContain('12 件取り込み完了')
      expect(api.getPendingUploads).toHaveBeenCalledTimes(2)
    })

    it('失敗したら理由を出す (成功と同じ場所に別の色で)', async () => {
      api.rerunUpload.mockRejectedValue(new Error('ZIP が R2 にありません'))
      const w = mountPage()
      await flushPromises()
      await button(w, 'リラン').trigger('click')
      await flushPromises()
      expect(w.text()).toContain('ZIP が R2 にありません')
      expect(w.find('span.text-red-600').exists()).toBe(true)
    })

    it('Error 以外で失敗しても黙らない', async () => {
      api.rerunUpload.mockRejectedValue('boom')
      const w = mountPage()
      await flushPromises()
      await button(w, 'リラン').trigger('click')
      await flushPromises()
      expect(w.text()).toContain('リランに失敗しました')
    })

    it('走っている間はどのリランも押せない', async () => {
      api.rerunUpload.mockReturnValue(new Promise(() => {}))
      const w = mountPage()
      await flushPromises()
      await button(w, 'リラン').trigger('click')
      await flushPromises()
      expect(button(w, 'リラン').attributes('disabled')).toBeDefined()
    })
  })

  describe('アップロード履歴 / CSV分割', () => {
    it('読み込み中は「履歴なし」と別の見た目にする', async () => {
      let resolve!: (v: unknown[]) => void
      api.getUploads.mockReturnValue(new Promise<unknown[]>((r) => { resolve = r }))
      const w = mountPage()
      await flushPromises()
      expect(w.text()).not.toContain('アップロード履歴なし')

      resolve([])
      await flushPromises()
      expect(w.text()).toContain('アップロード履歴なし')
    })

    it('取得に失敗すると空一覧になる (失敗と 0 件が同じ見た目 — 現状の挙動)', async () => {
      api.getUploads.mockRejectedValue(new Error('落ちた'))
      const w = mountPage()
      await flushPromises()
      expect(w.text()).toContain('アップロード履歴なし')
    })

    it('再読み込みでもう一度取りに行く', async () => {
      const w = mountPage()
      await flushPromises()
      await w.findAll('button')[1]!.trigger('click')
      await flushPromises()
      expect(api.getUploads).toHaveBeenCalledTimes(2)
    })

    it('CSV分割は completed にだけ出す', async () => {
      api.getUploads.mockResolvedValue([
        uploaded({ id: 'a', status: 'completed' }),
        uploaded({ id: 'b', status: 'failed' }),
      ])
      const w = mountPage()
      await flushPromises()
      expect(w.findAll('button').filter((b) => b.text().trim() === 'CSV分割')).toHaveLength(1)
    })

    describe('★ 200 が返っても「分割完了」と言い切らない (Refs #205-40)', () => {
      beforeEach(() => {
        api.getUploads.mockResolvedValue([uploaded()])
      })

      it('失敗が残っていたら件数を赤で出す', async () => {
        api.splitCsv.mockResolvedValue({ split_failed: 2 })
        const w = mountPage()
        await flushPromises()
        await button(w, 'CSV分割').trigger('click')
        await flushPromises()
        expect(api.splitCsv).toHaveBeenCalledWith('up_1')
        // **区画の中身で見る** — 見出し「アップロード履歴 / CSV分割」と次の
        // バッジ「完了」が textContent 上で隣り合い、`w.text()` には常に
        // 「分割完了」が現れる。文言の有無では成功表示の生死を判定できない。
        expect(w.find('span.text-red-600').text()).toBe('2 件失敗したままです')
        expect(w.find('span.text-green-600').exists()).toBe(false)
      })

      it('失敗 0 件なら「分割完了」', async () => {
        api.splitCsv.mockResolvedValue({ split_failed: 0 })
        const w = mountPage()
        await flushPromises()
        await button(w, 'CSV分割').trigger('click')
        await flushPromises()
        expect(w.find('span.text-green-600').text()).toBe('分割完了')
      })

      it('split_failed を返さない alc でも「分割完了」にする (現状の挙動)', async () => {
        api.splitCsv.mockResolvedValue({})
        const w = mountPage()
        await flushPromises()
        await button(w, 'CSV分割').trigger('click')
        await flushPromises()
        expect(w.find('span.text-green-600').text()).toBe('分割完了')
      })

      it('失敗したら理由を出す', async () => {
        api.splitCsv.mockRejectedValue(new Error('R2 に ZIP がありません'))
        const w = mountPage()
        await flushPromises()
        await button(w, 'CSV分割').trigger('click')
        await flushPromises()
        expect(w.find('span.text-red-600').text()).toBe('R2 に ZIP がありません')
      })

      it('Error 以外で失敗しても黙らない', async () => {
        api.splitCsv.mockRejectedValue(500)
        const w = mountPage()
        await flushPromises()
        await button(w, 'CSV分割').trigger('click')
        await flushPromises()
        expect(w.find('span.text-red-600').text()).toBe('失敗')
      })

      it('走っている間はどの分割も押せない', async () => {
        api.splitCsv.mockReturnValue(new Promise(() => {}))
        const w = mountPage()
        await flushPromises()
        await button(w, 'CSV分割').trigger('click')
        await flushPromises()
        expect(button(w, 'CSV分割').attributes('disabled')).toBeDefined()
      })
    })
  })
})
