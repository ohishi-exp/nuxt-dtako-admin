import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import VdfViewer, { type VdfSegment } from '~/components/VdfViewer.vue'
import type { VdfTelemetry } from '~/utils/dtako-vid-wasm'

import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

/**
 * 「.vdf をダウンロード」ボタン (dvr-viewer 用)。ページが原本 (`sourceBlob`) を渡した
 * 1 ファイル表示の時だけ出し、押すと**原本そのもの**を表示中のファイル名で保存する。
 * vid-check (手元のファイルを読む画面) は原本を渡さないので出ない。
 */

const TELEMETRY: VdfTelemetry = {
  vehicle: '1926',
  driver: '1756',
  g: [],
  speed_rpm: [],
  gps: [],
  events: [],
  front_frame_count: 300,
  rear_frame_count: 0,
  video_start_ts: 0,
}

function segment(overrides: Partial<VdfSegment> = {}): VdfSegment {
  return {
    fileName: '20261126_061822-0-0-1926-20261126_084111-E.vdf',
    fileSize: 7,
    frontUrl: null,
    rearUrl: null,
    telemetry: TELEMETRY,
    duration: 30,
    ...overrides,
  }
}

function mountViewer(segments: VdfSegment[]) {
  return mount(VdfViewer, {
    props: { segments, fileLabel: segments[0]?.fileName ?? null },
    global: {
      stubs: { ...NUXT_UI_PAGE_STUBS, VidMap: true, VidTelemetryChart: true },
    },
  })
}

function downloadButton(w: ReturnType<typeof mountViewer>) {
  return w.findAll('button').find(b => b.text() === '.vdf をダウンロード')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('VdfViewer の .vdf ダウンロード', () => {
  it('原本があれば出し、押すと原本をそのファイル名で保存する', async () => {
    const source = new Blob([new Uint8Array([0x4e, 0x45, 0x54, 0x37, 0x38, 0x30, 0x01])])
    const created: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
      created.push(b as Blob)
      return 'blob:vdf'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download)
    })

    const w = mountViewer([segment({ sourceBlob: source })])
    const button = downloadButton(w)
    expect(button).toBeDefined()
    await button!.trigger('click')

    expect(created).toEqual([source])
    expect(names).toEqual(['20261126_061822-0-0-1926-20261126_084111-E.vdf'])
  })

  it('原本が無い (vid-check) なら出さない', () => {
    const w = mountViewer([segment()])
    expect(downloadButton(w)).toBeUndefined()
  })

  it('複数ファイルの結合表示では出さない (どれを保存するか決まらない)', () => {
    const blob = new Blob([new Uint8Array([1])])
    const w = mountViewer([
      segment({ sourceBlob: blob }),
      segment({ fileName: 'b.vdf', sourceBlob: blob }),
    ])
    expect(downloadButton(w)).toBeUndefined()
  })
})
