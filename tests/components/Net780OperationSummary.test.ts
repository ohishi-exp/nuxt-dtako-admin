import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import JSZip from 'jszip'
import Net780OperationSummary from '~/components/Net780OperationSummary.vue'
import type { Net780ParseResult } from '~/utils/net780'
import { net780DateStartTs } from '~/utils/net780'
import { __setMockResult, __reset } from '../mocks/net780-wasm'

import { UIconStub } from '../helpers/stubs'

/** NuxtLink の to をそのまま href に映すスタブ (リンク先 URL の検証用)。 */
const NuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' }

/** UCard は useAppConfig 等 Nuxt app インスタンスに依存するため、素の div に差し替える。 */
const UCardStub = { template: '<div><slot name="header" /><slot /></div>' }

/** Net780Map は Google Maps SDK を読み込むため、受け取った current-time を
 * 記録するだけのスタブに差し替えて検証する。 */
const Net780MapStub = {
  props: ['gps', 'currentTime'],
  template: '<div data-test="net780-map" :data-current-time="currentTime" />',
}

async function fakeZipBlob(): Promise<Blob> {
  const zip = new JSZip()
  zip.file('sub/dummy.inf', 'dummy')
  return zip.generateAsync({ type: 'blob' })
}

function createWrapper(propsOverrides = {}) {
  return mount(Net780OperationSummary, {
    props: {
      operationNo: '2607030428090000001109',
      ...propsOverrides,
    },
    global: { stubs: { UIcon: UIconStub, NuxtLink: NuxtLinkStub, Net780Map: Net780MapStub, UCard: UCardStub } },
  })
}

describe('Net780OperationSummary', () => {
  afterEach(() => {
    __reset()
  })

  describe('未アーカイブ時', () => {
    beforeEach(() => {
      // 未アーカイブ (404) → notFound 分岐で /net780 検索リンクを表示させる
      vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 404 }))
    })

    it('未アーカイブ時の検索リンクは readingDate/vehicleCd/driverCd を引き継ぐ', async () => {
      const wrapper = createWrapper({
        readingDate: '2026-07-04',
        vehicleCd: '1109',
        driverCd: '1412',
      })
      await flushPromises()
      const link = wrapper.find('a')
      // /net780 の NET780 検索は読取日 (ReadNo) 基準のため、運行日ではなく
      // 読取日を渡す (Refs #316)
      expect(link.attributes('href')).toBe('/net780?readingDate=2026-07-04&vehicleCd=1109&driverCd=1412')
    })

    it('CD 不明時はリンクに readingDate だけ付く', async () => {
      const wrapper = createWrapper({ readingDate: '2026-07-04' })
      await flushPromises()
      expect(wrapper.find('a').attributes('href')).toBe('/net780?readingDate=2026-07-04')
    })
  })

  describe('アーカイブ済み時の速度チャート ←→ キー操作', () => {
    const date = '2026-07-03'
    const dayStart = net780DateStartTs(date)
    // GPS 軌跡点 (地図ピン連動の一覧に見立てる点列)。
    const gpsPoints = [
      { ts: dayStart + 60, lat: 43.0, lon: 143.0 },
      { ts: dayStart + 120, lat: 43.01, lon: 143.01 },
      { ts: dayStart + 180, lat: 43.02, lon: 143.02 },
    ]

    beforeEach(async () => {
      const result: Net780ParseResult = {
        header: null,
        inf: null,
        distance_total_m: 1000,
        // buildSpeedChartData は同一 run 内 (SPEED_GAP_THRESHOLD_SECS=5秒 以内) の
        // 連続点しか折れ線化しないため、間隔を詰めて1つの run に収める。
        speed: [
          { record_start_ts: dayStart, offset_secs: 0, speed_kmh: 10 },
          { record_start_ts: dayStart, offset_secs: 1, speed_kmh: 20 },
          { record_start_ts: dayStart, offset_secs: 2, speed_kmh: 30 },
          { record_start_ts: dayStart, offset_secs: 3, speed_kmh: 0 },
        ],
        gps: gpsPoints,
        events: [],
        warnings: [],
      }
      __setMockResult(result)
      vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(await fakeZipBlob()))
    })

    it('チャートに ←→ キーで GPS 点を1つずつ移動でき、地図の current-time に反映される', async () => {
      const wrapper = createWrapper({ readingDate: date })
      // load() は blob.arrayBuffer() → JSZip 展開 → wasm モジュール動的 import と
      // 複数 tick にまたがる非同期処理を挟むため、複数回 flush する。
      for (let i = 0; i < 10 && wrapper.find('svg').exists() === false; i++) {
        await flushPromises()
      }

      const svg = wrapper.find('svg')
      expect(svg.exists()).toBe(true)

      const mapStub = wrapper.find('[data-test="net780-map"]')
      // 未操作時はその日の 00:00 (dayStart) を指す
      expect(mapStub.attributes('data-current-time')).toBe(String(dayStart))

      await svg.trigger('keydown', { key: 'ArrowRight' })
      // dayStart に最も近い GPS 点 (gpsPoints[0]) から +1 点分 = gpsPoints[1]
      expect(wrapper.find('[data-test="net780-map"]').attributes('data-current-time'))
        .toBe(String(gpsPoints[1]!.ts))

      await svg.trigger('keydown', { key: 'ArrowRight' })
      expect(wrapper.find('[data-test="net780-map"]').attributes('data-current-time'))
        .toBe(String(gpsPoints[2]!.ts))

      // 末尾を超えて進めない
      await svg.trigger('keydown', { key: 'ArrowRight' })
      expect(wrapper.find('[data-test="net780-map"]').attributes('data-current-time'))
        .toBe(String(gpsPoints[2]!.ts))

      await svg.trigger('keydown', { key: 'ArrowLeft' })
      expect(wrapper.find('[data-test="net780-map"]').attributes('data-current-time'))
        .toBe(String(gpsPoints[1]!.ts))
    })
  })
})
