import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ProfitPanel from '~/components/ProfitPanel.vue'
import type { SelectedRowsSummary } from '~/utils/event-data-table'
import type { VehicleDailySlip } from '~/utils/ichiban'
import { UIconStub } from '../helpers/stubs'

const { fetchVehicleDailySlipsMock } = vi.hoisted(() => ({
  fetchVehicleDailySlipsMock: vi.fn(),
}))

vi.mock('~/utils/ichiban', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/ichiban')>()
  return { ...actual, fetchVehicleDailySlips: fetchVehicleDailySlipsMock }
})

function slip(overrides: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-06-21',
    vehicleNumber: '8504',
    customerCode: '000001',
    customerName: '㈱田浦畜産',
    // デフォルトの location prop (originCity: '長崎市', destCity: '北九州市') と
    // 部分一致するように、市区町村を含む地域名にしておく (suggested=true になる想定)。
    originAreaName: '長崎県長崎市',
    destAreaName: '福岡県北九州市',
    origin: '釧路',
    dest: '福岡県北九州市',
    isSubcontracted: false,
    amount: 65000,
    itemCode: '',
    itemName: '',
    quantity: 0,
    unitPrice: 0,
    unit: '',
    rowId: 'row-1',
    ...overrides,
  }
}

function summary(overrides: Partial<SelectedRowsSummary> = {}): SelectedRowsSummary {
  return {
    distanceKm: 100,
    durationMin: 480,
    byCategory: { drive: 300, loading: 60, unloading: 60, rest: 60, idle: 0, other: 0 },
    rowCount: 3,
    ...overrides,
  }
}

function createWrapper(props: Partial<InstanceType<typeof ProfitPanel>['$props']> = {}) {
  return mount(ProfitPanel, {
    props: {
      vehicleCode: '8504',
      unkoNo: 'unko-1',
      range: { fromTs: 0, toTs: 3600 },
      location: { originCity: '長崎市', destCity: '北九州市' },
      summary: summary(),
      ...props,
    },
    global: { stubs: { UIcon: UIconStub } },
  })
}

describe('ProfitPanel', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchVehicleDailySlipsMock.mockReset()
    // /api/profit/snapshot 用の global $fetch。デフォルトは「未保存」(reject) とし、
    // 既存の suggested ベースのテストが影響を受けないようにする。
    fetchMock.mockReset().mockRejectedValue(new Error('404'))
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('vehicleCode が無ければ突合不能メッセージを表示し fetch しない', async () => {
    const wrapper = createWrapper({ vehicleCode: null })
    await flushPromises()
    expect(wrapper.text()).toContain('車輌CD が特定できない')
    expect(fetchVehicleDailySlipsMock).not.toHaveBeenCalled()
  })

  it('伝票を取得し、積地・卸地とも一致する伝票が自動チェックされる', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    const wrapper = createWrapper()
    await flushPromises()

    expect(wrapper.find('input[type="checkbox"]').element as HTMLInputElement).toMatchObject({ checked: true })
    expect(wrapper.text()).toContain('65,000')
  })

  it('チェックを外すと確定売上が再計算される', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    const wrapper = createWrapper()
    await flushPromises()

    await wrapper.find('tbody tr').trigger('click')
    await flushPromises()

    // 確定売上 0 円 → 円/km 等も '-' になる
    expect(wrapper.text()).toContain('0 円')
  })

  it('外したチェックを再度クリックすると確定売上に再度加算される', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    const wrapper = createWrapper()
    await flushPromises()

    const row = wrapper.find('tbody tr')
    await row.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('0 円')

    await row.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('65,000')
  })

  it('チェックボックスの直接クリックでも確定/解除できる', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    const wrapper = createWrapper()
    await flushPromises()

    await wrapper.find('tbody input[type="checkbox"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('0 円')
  })

  it('チェックボックス列のセル (input 以外の余白部分) クリックでも確定/解除できる', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    const wrapper = createWrapper()
    await flushPromises()

    await wrapper.find('tbody td').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('0 円')
  })

  it('伝票が無い場合は空メッセージを表示する', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([])
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('見つかりませんでした')
  })

  it('fetch が失敗したらエラーメッセージを表示する', async () => {
    fetchVehicleDailySlipsMock.mockRejectedValue(new Error('network error'))
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('network error')
  })

  it('fetch が Error でない値で reject しても String() でメッセージ化して表示する', async () => {
    fetchVehicleDailySlipsMock.mockRejectedValue('connection refused')
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('connection refused')
  })

  it('closeボタンで close を emit する', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([])
    const wrapper = createWrapper()
    await flushPromises()
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('range が無ければ突合不能メッセージを表示する', async () => {
    const wrapper = createWrapper({ range: null })
    await flushPromises()
    expect(wrapper.text()).toContain('車輌CD が特定できない')
    expect(fetchVehicleDailySlipsMock).not.toHaveBeenCalled()
  })

  it('vehicleCode/range の変化で再取得する', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    const wrapper = createWrapper()
    await flushPromises()
    expect(fetchVehicleDailySlipsMock).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ range: { fromTs: 100, toTs: 200 } })
    await flushPromises()
    expect(fetchVehicleDailySlipsMock).toHaveBeenCalledTimes(2)
  })

  it('効率指標 (円/km・円/時間) が確定売上から計算され表示される', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip({ amount: 100 })])
    const wrapper = createWrapper({ summary: summary({ distanceKm: 10, durationMin: 60, byCategory: { drive: 30, loading: 0, unloading: 0, rest: 0, idle: 0, other: 0 } }) })
    await flushPromises()
    // yenPerKm = 100/10 = 10, yenPerHourBound = 100/1 = 100, yenPerHourDrive = 100/0.5 = 200
    expect(wrapper.text()).toContain('10')
    expect(wrapper.text()).toContain('100')
    expect(wrapper.text()).toContain('200')
  })

  it('距離・時間が 0 なら効率指標は "-" になる (ゼロ除算ガードの表示側)', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    const wrapper = createWrapper({ summary: summary({ distanceKm: 0, durationMin: 0, byCategory: { drive: 0, loading: 0, unloading: 0, rest: 0, idle: 0, other: 0 } }) })
    await flushPromises()
    expect(wrapper.text()).toContain('- / -')
  })

  it('location が null でも突合できる (?. / ?? のフォールバックで空文字扱い)', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    const wrapper = createWrapper({ location: null })
    await flushPromises()
    // dtako 側の地名が無いので突合根拠なし (suggested=false) → 手動でチェックは付かない
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('根拠なし')
  })

  it('得意先名・積地卸地が空文字の伝票はフォールバック表示 (「-」「?」) になる', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([
      slip({ rowId: 'empty-all', customerName: '', originAreaName: '', destAreaName: '', origin: '', dest: '' }),
    ])
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('? → ?')
  })

  it('発地N/着地N (自由入力) へのフォールバックで表示する (地域マスタ値が空の場合)', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([
      slip({ rowId: 'freetext-fallback', originAreaName: '', destAreaName: '', origin: '釧路', dest: '福岡県北九州市' }),
    ])
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('釧路 → 福岡県北九州市')
  })

  it('積地・卸地どちらか一方だけ一致する伝票は「部分一致」バッジで自動チェックされない', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([
      slip({ rowId: 'partial-only', originAreaName: '長崎県長崎市', destAreaName: '東京都', origin: '', dest: '大阪府' }),
    ])
    const wrapper = createWrapper()
    await flushPromises()
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    expect(wrapper.text()).toContain('部分一致')
  })

  it('品名が空なら品名列は「-」表示 (数量/単価が入力されていても)', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([
      slip({ rowId: 'no-item', itemName: '', quantity: 5, unitPrice: 1000 }),
    ])
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('-')
  })

  it('品名・数量・単価がすべて揃っていれば「品名 (数量単位 @単価)」で表示する (同一日でも単価が異なりうることの目視確認用)', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([
      slip({ rowId: 'full-item', itemName: '冷凍食品', quantity: 10.5, unitPrice: 6190, unit: '個' }),
    ])
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('冷凍食品 (10.5個 @6,190)')
  })

  it('品名はあるが数量・単価が未入力 (0) なら品名のみ表示する', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([
      slip({ rowId: 'item-only', itemName: '雑貨', quantity: 0, unitPrice: 0 }),
    ])
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('雑貨')
    expect(wrapper.text()).not.toContain('雑貨 (')
  })

  it('数量のみ入力 (単価0) なら数量だけ括弧内に表示する', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([
      slip({ rowId: 'qty-only', itemName: '雑貨', quantity: 3, unit: '個', unitPrice: 0 }),
    ])
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('雑貨 (3個)')
  })

  it('単価のみ入力 (数量0) なら単価だけ括弧内に表示する', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([
      slip({ rowId: 'price-only', itemName: '雑貨', quantity: 0, unitPrice: 500 }),
    ])
    const wrapper = createWrapper()
    await flushPromises()
    expect(wrapper.text()).toContain('雑貨 (@500)')
  })

  it('保存済みスナップショットがあれば suggested 判定より優先して確認状態を復元する', async () => {
    // suggested=false になる伝票 (地域が一致しない) を、スナップショットで確認済みとして復元する
    fetchVehicleDailySlipsMock.mockResolvedValue([
      slip({ rowId: 'restored-1', originAreaName: '東京都', destAreaName: '大阪府' }),
    ])
    fetchMock.mockResolvedValue({
      schemaVersion: 1,
      confirmedSlips: [{ rowId: 'restored-1' }],
    })
    const wrapper = createWrapper()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/profit/snapshot', {
      query: { ym: '1970-01', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' },
    })
    expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('保存ボタンをクリックするとスナップショットをPOSTし「保存しました」を表示する', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return Promise.resolve({ saved: true, changed: true, savedAt: '2026-07-19T00:00:00.000Z' })
      return Promise.reject(new Error('404'))
    })
    const wrapper = createWrapper()
    await flushPromises()

    await wrapper.find('button.bg-blue-600').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('/api/profit/snapshot', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ vehicleCode: '8504', unkoNo: 'unko-1', confirmedAmount: 65000 }),
    }))
    expect(wrapper.text()).toContain('保存しました')
  })

  it('チェック変更後は保存ステータスが idle に戻る (再保存を促す)', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return Promise.resolve({ saved: true, changed: true, savedAt: 'x' })
      return Promise.reject(new Error('404'))
    })
    const wrapper = createWrapper()
    await flushPromises()

    await wrapper.find('button.bg-blue-600').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('保存しました')

    await wrapper.find('tbody tr').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('保存しました')
  })

  it('保存に失敗したら「保存に失敗しました」を表示する', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return Promise.reject(new Error('network error'))
      return Promise.reject(new Error('404'))
    })
    const wrapper = createWrapper()
    await flushPromises()

    await wrapper.find('button.bg-blue-600').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('保存に失敗しました')
  })

  it('保存中はボタンが disabled になり「保存中...」を表示する', async () => {
    fetchVehicleDailySlipsMock.mockResolvedValue([slip()])
    let resolvePost: (() => void) | undefined
    fetchMock.mockImplementation((url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') return new Promise((resolve) => { resolvePost = () => resolve({ saved: true, changed: true, savedAt: 'x' }) })
      return Promise.reject(new Error('404'))
    })
    const wrapper = createWrapper()
    await flushPromises()

    const clickPromise = wrapper.find('button.bg-blue-600').trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('保存中...')
    expect((wrapper.find('button.bg-blue-600').element as HTMLButtonElement).disabled).toBe(true)

    resolvePost?.()
    await clickPromise
    await flushPromises()
  })
})
