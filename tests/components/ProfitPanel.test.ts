import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProfitPanel from '~/components/ProfitPanel.vue'
import type { SelectedRowsSummary } from '~/utils/event-data-table'
import type { AllowanceLeg } from '~/utils/allowance-trips'
import type { VehicleDailySlip } from '~/utils/ichiban'
import { FORCE_MATCH_KEY, parseForceMatch } from '~/utils/allowance-force-match'
import { OPERATION_LEG_SALES_KEY, serializeOperationLegSales } from '~/utils/operation-leg-sales'
import { UIconStub } from '../helpers/stubs'

/**
 * 収支パネル = **便に一番星の明細を結ぶ画面** (突合一本化 PR-2、Refs #848)。
 *
 * 元は「区間ごとの検証スナップショットを R2 に保存する」画面だった。確定が①の
 * 強制突合 (`FORCE_MATCH_KEY`) に一本化されたので、テストの軸も変わる:
 *
 * 1. **書き先は `FORCE_MATCH_KEY` だけ。** スナップショットは読みも書きもしない
 * 2. **①の使用済み明細が分からないときは候補を出さない** (空の一覧を「候補が無い」と
 *    読ませない)。ここを間違えると**同じ売上が 2 つの便に乗る**
 * 3. **結んである明細は必ず外せる** (日付の外に結んだものも並べる)
 */

const { fetchDriverDailySlipsMock } = vi.hoisted(() => ({
  fetchDriverDailySlipsMock: vi.fn(),
}))

vi.mock('~/utils/ichiban', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/ichiban')>()
  return { ...actual, fetchDriverDailySlips: fetchDriverDailySlipsMock }
})

/** 本番と同じ形の運行NO (22 桁)。 */
const UNKO = '2607161000000000001318'
const OTHER_UNKO = '2607171000000000001318'

/** 2026-07-16 09:31 / 13:00 (JST 壁時計をそのまま読む epoch 秒)。 */
const LEG1_TS = Date.UTC(2026, 6, 16, 9, 31) / 1000
const LEG2_TS = Date.UTC(2026, 6, 16, 13, 0) / 1000

function leg(overrides: Partial<AllowanceLeg> = {}): AllowanceLeg {
  return {
    loadRowIndex: 0,
    unloadRowIndexes: [],
    originCity: '北海道釧路市西港1-98-41',
    destCity: '',
    viaCities: [],
    fromTs: LEG1_TS,
    toTs: null,
    ...overrides,
  }
}

function slip(overrides: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-07-16',
    vehicleNumber: '1318',
    customerCode: '000001',
    customerName: '㈱田浦畜産',
    originAreaName: '釧路',
    destAreaName: '上士幌',
    origin: '釧路',
    dest: '上士幌',
    isSubcontracted: false,
    amount: 41250,
    itemCode: '',
    itemName: '',
    quantity: 0,
    unitPrice: 0,
    unit: '',
    rowId: '20260716-12',
    requestKind: '0',
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

/** 粗利タブが書いた突合結果 (これがあって初めて候補を出せる)。 */
function writeLegSales(byUnko: Record<string, { seq: number, slipIds: string[] }[]>, ym = '2026-07') {
  localStorage.setItem(OPERATION_LEG_SALES_KEY, serializeOperationLegSales({
    ym,
    byUnko: Object.fromEntries(Object.entries(byUnko).map(([unkoNo, legs]) => [
      unkoNo,
      legs.map(l => ({ seq: l.seq, customers: [], slipIds: l.slipIds })),
    ])),
  }))
}

/**
 * localStorage の差し替え。**happy-dom の `localStorage` は Proxy なので `spyOn` が
 * 後続のテストまで壊す** (実測: 1 度 spy を挿すと以降の全テストが `missing` に落ちた)。
 * 丸ごと差し替えて `unstubAllGlobals` で戻す。
 */
function fakeStorage(items: Record<string, string>, opts: { throwOnGet?: boolean, setError?: unknown } = {}) {
  return {
    getItem: (key: string) => {
      if (opts.throwOnGet) throw new Error('SecurityError')
      return items[key] ?? null
    },
    setItem: (key: string, value: string) => {
      if (opts.setError !== undefined) throw opts.setError
      items[key] = value
    },
    removeItem: (key: string) => {
      delete items[key]
    },
    clear: () => {},
  }
}

/** この運行が突合結果に入っている、いちばん普通の状態。 */
function writeAggregated(slipIds: string[] = []) {
  writeLegSales({ [UNKO]: [{ seq: 1, slipIds }] })
}

function createWrapper(props: Partial<InstanceType<typeof ProfitPanel>['$props']> = {}) {
  return mount(ProfitPanel, {
    props: {
      unkoNo: UNKO,
      driverCd: '0123',
      range: { fromTs: LEG1_TS, toTs: LEG2_TS + 3600 },
      location: { originCity: '釧路市', destCity: '上士幌町' },
      summary: summary(),
      legs: [leg()],
      ...props,
    },
    global: { stubs: { UIcon: UIconStub } },
  })
}

describe('ProfitPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    fetchDriverDailySlipsMock.mockReset().mockResolvedValue([])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('画面の説明 — 同じチェックボックスが別の意味になったことを読ませる', () => {
    it('★ 保存先が変わったこと・粗利に効くこと・古いスナップショットが残ることを常に出す', async () => {
      writeAggregated()
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('確定の保存先が変わりました')
      expect(wrapper.text()).toContain('粗利タブ・運行手当タブの集計')
      expect(wrapper.text()).toContain('これ以降は増えません')
    })

    it('★ 上書きであって足し算ではないと出す', async () => {
      writeAggregated()
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('足し算ではありません')
    })

    it('★ どの乗務員CD で候補を引いたかを出す (CD 違いで候補が空になったのを「明細が無い」と読ませない)', async () => {
      writeAggregated()
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('乗務員CD 0123')
    })

    it('close ボタンで close を emit する', async () => {
      const wrapper = createWrapper()
      await flushPromises()
      await wrapper.find('button').trigger('click')
      expect(wrapper.emitted('close')).toBeTruthy()
    })
  })

  describe('明細の取得 — 乗務員で引く', () => {
    it('★ 乗務員CD で引き、候補の日付 ±1 日ぶん広げた期間を渡す', async () => {
      writeAggregated()
      createWrapper()
      await flushPromises()
      // vehicleDailyDateRange = (2026-07-16, 2026-07-17) をさらに前後 1 日広げる
      expect(fetchDriverDailySlipsMock).toHaveBeenCalledWith('0123', '2026-07-15', '2026-07-18')
    })

    it('★ 乗務員CD が無ければ引かず、理由を出す (車番で引いた明細を結んでも①に届かない)', async () => {
      const wrapper = createWrapper({ driverCd: null })
      await flushPromises()
      expect(wrapper.text()).toContain('乗務員CD が特定できない')
      expect(fetchDriverDailySlipsMock).not.toHaveBeenCalled()
    })

    it('区間が無ければ引かない', async () => {
      const wrapper = createWrapper({ range: null })
      await flushPromises()
      expect(wrapper.text()).toContain('乗務員CD が特定できない')
      expect(fetchDriverDailySlipsMock).not.toHaveBeenCalled()
    })

    it('取得中は検索中と出す', () => {
      fetchDriverDailySlipsMock.mockReturnValue(new Promise(() => {}))
      const wrapper = createWrapper()
      expect(wrapper.text()).toContain('検索中')
    })

    it('取得に失敗したらエラーを出す', async () => {
      fetchDriverDailySlipsMock.mockRejectedValue(new Error('network error'))
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('network error')
    })

    it('Error でない値で reject しても文字にして出す', async () => {
      fetchDriverDailySlipsMock.mockRejectedValue('connection refused')
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('connection refused')
    })

    it('乗務員CD / 区間が変われば引き直す', async () => {
      writeAggregated()
      const wrapper = createWrapper()
      await flushPromises()
      expect(fetchDriverDailySlipsMock).toHaveBeenCalledTimes(1)
      await wrapper.setProps({ driverCd: '0124' })
      await flushPromises()
      expect(fetchDriverDailySlipsMock).toHaveBeenCalledTimes(2)
    })

    it('★ 請求のみ (請求K=1) と「休み」は候補に出さない (中継で売上が二重に乗る / 便ではない)', async () => {
      writeAggregated()
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: 'billing', requestKind: '1', customerName: '通し請求' }),
        slip({ rowId: 'rest', itemName: '休み', customerName: '休み行' }),
        slip({ rowId: 'ok', customerName: '運送分' }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('運送分')
      expect(wrapper.text()).not.toContain('通し請求')
      expect(wrapper.text()).not.toContain('休み行')
    })
  })

  describe('結び先の便 — 選択区間に入る積み', () => {
    it('★ 区間に便が無ければ「便がありません」と言う (0 円の便として出さない)', async () => {
      writeAggregated()
      const wrapper = createWrapper({ legs: [leg({ fromTs: LEG1_TS - 86400 })] })
      await flushPromises()
      expect(wrapper.text()).toContain('選択した区間に便 (積みイベント) がありません')
    })

    it('★ 開始日時が読めない積みがあれば件数を言う (黙って落とさない)', async () => {
      writeAggregated()
      const wrapper = createWrapper({ legs: [leg({ fromTs: null }), leg()] })
      await flushPromises()
      expect(wrapper.text()).toContain('積みの開始日時が読めない便が 1 本')
    })

    it('読めない積みが無ければその注記は出さない', async () => {
      writeAggregated()
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).not.toContain('積みの開始日時が読めない便')
    })

    it('便の見出しに 便番号・日付・積地→卸地 を出す (卸地が無ければそう言う)', async () => {
      writeAggregated()
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('便1 07-16 北海道釧路市西港1-98-41 → (卸地なし)')
    })

    it('積地が空でも「?」で出す', async () => {
      writeAggregated()
      const wrapper = createWrapper({ legs: [leg({ originCity: '', destCity: '上士幌町' })] })
      await flushPromises()
      expect(wrapper.text()).toContain('便1 07-16 ? → 上士幌町')
    })

    it('★ 便が 2 本あれば選べる。既定は先頭で、押した便に切り替わる', async () => {
      writeLegSales({ [UNKO]: [{ seq: 1, slipIds: [] }, { seq: 2, slipIds: [] }] })
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper({ legs: [leg(), leg({ fromTs: LEG2_TS })] })
      await flushPromises()
      const headers = wrapper.findAll('button').filter(b => b.text().includes('便'))
      expect(headers).toHaveLength(2)
      // 先頭の便だけが開いている (表は 1 つ)
      expect(wrapper.findAll('table')).toHaveLength(1)

      await headers[1]!.trigger('click')
      await flushPromises()
      expect(wrapper.findAll('table')).toHaveLength(1)
      // 2 便目に結ぶと 2 便目の鍵で保存される
      await wrapper.find('tbody tr').trigger('click')
      expect(Object.keys(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY)))).toEqual([`${UNKO}#t${LEG2_TS}`])
    })
  })

  describe('★★ 候補は「空いている明細が分かるとき」しか出さない (二重計上を防ぐ)', () => {
    it('★ 突合結果が無ければ候補を出さず、理由を言う (空の一覧を「候補が無い」と読ませない)', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('このブラウザの粗利タブでこの月を集計すると、結べる候補が出ます')
      expect(wrapper.text()).not.toContain('結べる明細がありません')
      expect(wrapper.findAll('tbody tr')).toHaveLength(0)
    })

    it('★ 別の月の突合結果しか無ければ (その運行が入っていない) 候補を出さず、その月を言う', async () => {
      writeLegSales({ [OTHER_UNKO]: [{ seq: 1, slipIds: [] }] }, '2026-06')
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('粗利タブの突合結果 (2026-06) にこの運行はありません')
      expect(wrapper.findAll('tbody tr')).toHaveLength(0)
    })

    it('★ 突合結果が壊れていても候補を出さない (読めたぶんだけで候補を出すと二重計上になる)', async () => {
      localStorage.setItem(OPERATION_LEG_SALES_KEY, '{壊れ')
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('結べる候補が出ます')
      expect(wrapper.findAll('tbody tr')).toHaveLength(0)
    })

    it('★ localStorage 自体が読めなくても候補を出さない (空の Set に倒さない)', async () => {
      // **読めていれば候補が出る状態**にしてから読めなくする — 「たまたま空だった」
      // では catch を通ったことにならない。
      writeAggregated()
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      vi.stubGlobal('localStorage', fakeStorage(
        { [OPERATION_LEG_SALES_KEY]: localStorage.getItem(OPERATION_LEG_SALES_KEY)! },
        { throwOnGet: true },
      ))
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('結べる候補が出ます')
      expect(wrapper.findAll('tbody tr')).toHaveLength(0)
    })

    it('★ ①が別の便に当てた明細は候補に出さない (同じ売上を 2 つの便に付けない)', async () => {
      writeLegSales({
        [UNKO]: [{ seq: 1, slipIds: [] }],
        [OTHER_UNKO]: [{ seq: 1, slipIds: ['20260716-99'] }],
      })
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: '20260716-99', customerName: '他の便に当たり済み' }),
        slip({ rowId: '20260716-12', customerName: '空いている' }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('空いている')
      expect(wrapper.text()).not.toContain('他の便に当たり済み')
    })

    it('突合結果があって候補が 1 件も無ければ「結べる明細がありません」と言う', async () => {
      writeAggregated()
      fetchDriverDailySlipsMock.mockResolvedValue([slip({ saleDate: '2026-07-20' })])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('結べる明細がありません')
    })
  })

  describe('結ぶ / 外す — 書き先は FORCE_MATCH_KEY だけ', () => {
    beforeEach(() => {
      writeAggregated()
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
    })

    it('★ 行をクリックすると FORCE_MATCH_KEY に便の鍵で保存される', async () => {
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.find('input[type="checkbox"]').element as HTMLInputElement).toMatchObject({ checked: false })

      await wrapper.find('tbody tr').trigger('click')
      expect(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY)))
        .toEqual({ [`${UNKO}#t${LEG1_TS}`]: ['20260716-12'] })
      expect(wrapper.text()).toContain('41,250')
    })

    it('もう一度押すと外れる (キーごと消える)', async () => {
      const wrapper = createWrapper()
      await flushPromises()
      await wrapper.find('tbody tr').trigger('click')
      await wrapper.find('tbody tr').trigger('click')
      expect(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY))).toEqual({})
    })

    it('チェックボックスの直接クリックでも結べる', async () => {
      const wrapper = createWrapper()
      await flushPromises()
      await wrapper.find('tbody input[type="checkbox"]').trigger('click')
      expect(Object.keys(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY)))).toHaveLength(1)
    })

    it('チェックボックス列の余白クリックでも結べる', async () => {
      const wrapper = createWrapper()
      await flushPromises()
      await wrapper.find('tbody td').trigger('click')
      expect(Object.keys(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY)))).toHaveLength(1)
    })

    it('★ 保存済みの結びつけを読み戻し、チェック済みで出す', async () => {
      localStorage.setItem(FORCE_MATCH_KEY, JSON.stringify({ [`${UNKO}#t${LEG1_TS}`]: ['20260716-12'] }))
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.find('input[type="checkbox"]').element as HTMLInputElement).toMatchObject({ checked: true })
      expect(wrapper.text()).toContain('結び 1 件')
    })

    it('★ 保存できなければ黙らず言う (結んだつもりで残っていない事故を防ぐ)', async () => {
      vi.stubGlobal('localStorage', fakeStorage(
        { [OPERATION_LEG_SALES_KEY]: localStorage.getItem(OPERATION_LEG_SALES_KEY)! },
        { setError: new Error('QuotaExceededError') },
      ))
      const wrapper = createWrapper()
      await flushPromises()
      await wrapper.find('tbody tr').trigger('click')
      expect(wrapper.text()).toContain('結びつけを保存できませんでした')
      expect(wrapper.text()).toContain('QuotaExceededError')
    })

    it('Error でない値が投げられても文字にして言う', async () => {
      vi.stubGlobal('localStorage', fakeStorage(
        { [OPERATION_LEG_SALES_KEY]: localStorage.getItem(OPERATION_LEG_SALES_KEY)! },
        { setError: 'disk full' },
      ))
      const wrapper = createWrapper()
      await flushPromises()
      await wrapper.find('tbody tr').trigger('click')
      expect(wrapper.text()).toContain('結びつけを保存できませんでした — disk full')
    })

    it('保存に成功していれば失敗の注記は出さない', async () => {
      const wrapper = createWrapper()
      await flushPromises()
      await wrapper.find('tbody tr').trigger('click')
      expect(wrapper.text()).not.toContain('結びつけを保存できませんでした')
    })

    it('★ 検証スナップショット (POST /api/profit/snapshot) はもう呼ばない', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('$fetch', fetchMock)
      const wrapper = createWrapper()
      await flushPromises()
      await wrapper.find('tbody tr').trigger('click')
      expect(fetchMock).not.toHaveBeenCalled()
      // 保存ボタンそのものが無い (結んだ時点で保存されるので押す口が要らない)。
      expect(wrapper.findAll('button').filter(b => b.text().includes('保存'))).toHaveLength(0)
      vi.unstubAllGlobals()
    })
  })

  describe('結んである明細は必ず外せる', () => {
    it('★ 日付 ±1 日の外に結んだ明細も並べる (候補に出ないので外せなくなる)', async () => {
      writeAggregated()
      localStorage.setItem(FORCE_MATCH_KEY, JSON.stringify({ [`${UNKO}#t${LEG1_TS}`]: ['far'] }))
      fetchDriverDailySlipsMock.mockResolvedValue([slip({ rowId: 'far', saleDate: '2026-07-25', customerName: '離れた日' })])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('離れた日')
      await wrapper.find('tbody tr').trigger('click')
      expect(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY))).toEqual({})
    })

    it('★ 結んであるのに手元に無い明細は数えて言う (「結びつけが消えた」と読ませない)', async () => {
      writeAggregated()
      localStorage.setItem(FORCE_MATCH_KEY, JSON.stringify({ [`${UNKO}#t${LEG1_TS}`]: ['gone'] }))
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('この便に当たっている明細のうち 1 件がこの検索結果に見当たりません')
    })

    it('全部引けていればその注記は出さない', async () => {
      writeAggregated()
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).not.toContain('見当たりません')
    })
  })

  /**
   * **①が当てた明細を映す** (Refs #854)。#849 では `FORCE_MATCH_KEY` しか見ておらず、
   * ①が当てている便が「結び 0 件・0 円」に見えた。そのまま 1 件結ぶと置き換えで
   * ①の売上が消え、消えた明細は候補にも出ないので戻せなかった (本番 v0.0.532)。
   */
  describe('★★ ①が当てている便 (Refs #854)', () => {
    /** ①が便1 に `20260716-12` (¥41,250) を当てている状態。 */
    function writeIchibanHit() {
      writeLegSales({ [UNKO]: [{ seq: 1, slipIds: ['20260716-12'] }] })
    }

    it('★ 「結び 0 件・0 円」に見せない — ①が当てた明細を金額つきで出す', async () => {
      writeIchibanHit()
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('粗利タブが当てた 1 件')
      expect(wrapper.text()).toContain('41,250')
      expect(wrapper.text()).not.toContain('結び 0 件')
    })

    it('★ ①が当てた明細はチェック済みで出る (候補から消えない)', async () => {
      writeIchibanHit()
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.find('tbody input[type="checkbox"]').element as HTMLInputElement).toMatchObject({ checked: true })
    })

    it('★ 土台になること・追従が止まること・全部外すと①に戻ることを画面で言う', async () => {
      writeIchibanHit()
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('土台にした上書き')
      expect(wrapper.text()).toContain('粗利タブの集計に追従しなくなります')
      expect(wrapper.text()).toContain('全部外すと粗利タブの結果に戻ります')
    })

    it('★★ 触ったあとは「もう①には追従しない」に言い方が変わる (集計し直しても直らない理由が読めるように)', async () => {
      writeIchibanHit()
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip(),
        slip({ rowId: '20260716-77', customerName: '追加分', amount: 8000 }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('この便の明細は粗利タブが当てたものです')

      await wrapper.findAll('tbody tr')[1]!.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('伝票が直っても、内容はこのままです')
      expect(wrapper.text()).not.toContain('この便の明細は粗利タブが当てたものです')
    })

    it('①も当てていない便には、その手の注記を出さない', async () => {
      writeAggregated()
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).not.toContain('全部外すと粗利タブの結果に戻ります')
      expect(wrapper.text()).not.toContain('追従しません')
    })

    it('★★ 別の明細を足すと、①が当てたぶんを土台にして保存される (置き換えで消さない)', async () => {
      writeIchibanHit()
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip(),
        slip({ rowId: '20260716-77', customerName: '追加分', amount: 8000 }),
      ])
      const wrapper = createWrapper()
      await flushPromises()

      const rows = wrapper.findAll('tbody tr')
      expect(rows).toHaveLength(2)
      await rows[1]!.trigger('click')

      // ★ ①の 20260716-12 が残っていること。落ちていたら ¥41,250 が消える。
      expect(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY)))
        .toEqual({ [`${UNKO}#t${LEG1_TS}`]: ['20260716-12', '20260716-77'] })
      expect(wrapper.text()).toContain('49,250')
    })

    it('★ ①が当てた明細を外すと、その 1 件だけが落ちた上書きになる', async () => {
      writeLegSales({ [UNKO]: [{ seq: 1, slipIds: ['20260716-12', '20260716-77'] }] })
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip(),
        slip({ rowId: '20260716-77', customerName: '残す分', amount: 8000 }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      await wrapper.findAll('tbody tr')[0]!.trigger('click')

      expect(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY)))
        .toEqual({ [`${UNKO}#t${LEG1_TS}`]: ['20260716-77'] })
    })

    it('★★ 自分で外した明細をその場で戻せる (外すと候補からも消えると押し間違いが取り返せない)', async () => {
      writeLegSales({ [UNKO]: [{ seq: 1, slipIds: ['20260716-12', '20260716-77'] }] })
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip(),
        slip({ rowId: '20260716-77', customerName: '残す分', amount: 8000 }),
      ])
      const wrapper = createWrapper()
      await flushPromises()

      // ①が当てた 2 件を外す方向に 1 つ触る。
      await wrapper.findAll('tbody tr')[0]!.trigger('click')
      await flushPromises()
      expect(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY)))
        .toEqual({ [`${UNKO}#t${LEG1_TS}`]: ['20260716-77'] })

      // ★ 外した明細は `usedRowIds` (キャッシュはまだ①の結果) に居るので、`own` に
      // 入れ直さないと候補からも消えて**その場では戻せない**。
      // 並びは「結んである明細が先」なので、外したぶんは後ろに回る。
      const rows = wrapper.findAll('tbody tr')
      expect(rows).toHaveLength(2)
      const dropped = rows.find(r => r.text().includes('㈱田浦畜産'))!
      expect(dropped).toBeDefined()
      expect((dropped.find('input').element as HTMLInputElement).checked).toBe(false)

      // もう一度押せば戻る。
      await dropped.trigger('click')
      expect(parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY)))
        .toEqual({ [`${UNKO}#t${LEG1_TS}`]: ['20260716-77', '20260716-12'] })
    })

    it('★ 触るまでは FORCE_MATCH_KEY に 1 文字も書かない (「人が確定した」ことにしない)', async () => {
      writeIchibanHit()
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      createWrapper()
      await flushPromises()
      expect(localStorage.getItem(FORCE_MATCH_KEY)).toBeNull()
    })

    it('★ 人の上書きがある便では、①の結果を「当たっている」に混ぜ戻さない (合計に勝手に足さない)', async () => {
      writeIchibanHit()
      localStorage.setItem(FORCE_MATCH_KEY, JSON.stringify({ [`${UNKO}#t${LEG1_TS}`]: ['20260716-77'] }))
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip(),
        slip({ rowId: '20260716-77', customerName: '人が結んだ分', amount: 8000 }),
      ])
      const wrapper = createWrapper()
      await flushPromises()

      // 当たっているのは人が結んだ 1 件だけ (①の ¥41,250 は効いていない)。
      expect(wrapper.text()).toContain('結び 1 件')
      expect(wrapper.text()).not.toContain('粗利タブが当てた')
      expect(wrapper.text()).toContain('8,000')
      expect(wrapper.text()).not.toContain('49,250')

      // ★ ただし①の明細は**候補としては出す** — 外したものをその場で戻せるように。
      const ichibanRow = wrapper.findAll('tbody tr').find(r => r.text().includes('㈱田浦畜産'))
      expect(ichibanRow).toBeDefined()
      expect((ichibanRow!.find('input').element as HTMLInputElement).checked).toBe(false)
    })

    it('★ 別の便に①が当てた明細は、この便の「当たっている」に混ざらない', async () => {
      writeLegSales({ [UNKO]: [{ seq: 1, slipIds: [] }, { seq: 2, slipIds: ['20260716-12'] }] })
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper({ legs: [leg(), leg({ fromTs: LEG2_TS })] })
      await flushPromises()
      // 先頭の便 (seq 1) が開いている。seq 2 のぶんを引き込んでいないこと。
      expect(wrapper.text()).toContain('結び 0 件')
      expect(wrapper.text()).toContain('結べる明細がありません')
    })
  })

  describe('明細の表示', () => {
    beforeEach(() => writeAggregated())

    it('得意先・積地→卸地・品名・金額を出す', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ itemName: '生乳', quantity: 12, unit: 't', unitPrice: 3437 }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('㈱田浦畜産')
      expect(wrapper.text()).toContain('釧路 → 上士幌')
      expect(wrapper.text()).toContain('生乳 (12t @3,437)')
    })

    it('得意先・積地・卸地が空なら記号で埋める (空欄にしない)', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ customerName: '', originAreaName: '', origin: '', destAreaName: '', dest: '' }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('? → ?')
      expect(wrapper.text()).toContain('-')
    })

    it('エリア名が無ければ生の積地・卸地で出す', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ originAreaName: '', destAreaName: '', origin: '釧路市', dest: '上士幌町' }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('釧路市 → 上士幌町')
    })

    it('品名が無ければ「-」、数量・単価が 0 なら品名だけ', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: 'a', itemName: '' }),
        slip({ rowId: 'b', itemName: '生乳', quantity: 0, unitPrice: 0 }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      const cells = wrapper.findAll('tbody td').map(td => td.text())
      expect(cells).toContain('-')
      expect(cells).toContain('生乳')
    })

    it('数量だけ / 単価だけでも読める形で出す', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: 'a', itemName: '生乳', quantity: 12, unit: 't', unitPrice: 0 }),
        slip({ rowId: 'b', itemName: '飼料', quantity: 0, unitPrice: 500 }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('生乳 (12t)')
      expect(wrapper.text()).toContain('飼料 (@500)')
    })

    it('★ 根拠バッジは 3 段 (完全一致 / 部分一致 / 根拠なし)', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: 'a', originAreaName: '釧路市', destAreaName: '上士幌町' }),
        slip({ rowId: 'b', originAreaName: '北海道釧路市', destAreaName: '上士幌町' }),
        slip({ rowId: 'c', originAreaName: '苫小牧市', origin: '苫小牧', destAreaName: '千歳市', dest: '千歳' }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('完全一致')
      expect(wrapper.text()).toContain('部分一致')
      expect(wrapper.text()).toContain('根拠なし')
    })

    /**
     * **②の `scoreVehicleDailySlips` を撤去して `combinedMatchLevel` に寄せた** (Refs #858)。
     * 撤去前は「積地・卸地の両方が none でない」を `exact` にしていたので、**両方 partial でも
     * 画面に「完全一致」**と出ていた。帯広の実データ (`北海道釧路市西港２-101-1` vs
     * `北海道釧路市`) は partial が主で、**日常的に出ていた嘘**。
     */
    it('★★ 両方 partial は「部分一致」— 撤去前は「完全一致」と出ていた (Refs #858)', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: 'a', originAreaName: '北海道釧路市', destAreaName: '北海道上士幌町' }),
      ])
      const wrapper = createWrapper({ location: { originCity: '釧路市', destCity: '上士幌町' } })
      await flushPromises()
      expect(wrapper.text()).toContain('部分一致')
      expect(wrapper.text()).not.toContain('完全一致')
    })

    it('★ 片側だけ当たる明細は「根拠なし」— 撤去前は「部分一致」と出ていた (Refs #858)', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: 'a', originAreaName: '釧路市', destAreaName: '別海町', dest: '別海町' }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('根拠なし')
      expect(wrapper.text()).not.toContain('部分一致')
    })

    /**
     * **`combinedMatchLevel` は片方でも none なら none に畳む。**「積地は合っている明細」と
     * 「何も合っていない明細」が同じ「根拠なし」になるので、**候補を選ぶ手掛かりが消える。**
     * 本番 2026-07 の候補一覧では 1,971 件中 589 件 (29.9%) がこの状態で、候補が 2 件以上
     * ある便 471 本のうち **113 本**がバッジ一色になっていた。畳んだ側を 1 行で言わせる。
     */
    it('★★ 「根拠なし」でも積地だけ当たっていれば、そう言う (畳んだことを黙らない、Refs #858)', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: 'a', originAreaName: '釧路市', destAreaName: '別海町', dest: '別海町' }),
        slip({ rowId: 'b', originAreaName: '苫小牧市', origin: '苫小牧', destAreaName: '千歳市', dest: '千歳' }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      const cells = wrapper.findAll('tbody tr').map(tr => tr.text())
      // 積地だけ当たっている行 = バッジは「根拠なし」だが、畳んだ側を言う
      expect(cells.some(t => t.includes('根拠なし') && t.includes('積地のみ一致'))).toBe(true)
      // 何も当たっていない行 = 足さない (全行に同じ文字が並ぶと候補一覧が読みにくい)
      expect(cells.some(t => t.includes('根拠なし') && !t.includes('積地のみ一致') && !t.includes('卸地のみ一致'))).toBe(true)
    })

    it('★ 卸地だけ当たっていれば「卸地のみ一致」と言う', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: 'a', originAreaName: '東京都', origin: '東京', destAreaName: '上士幌町' }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('根拠なし')
      expect(wrapper.text()).toContain('卸地のみ一致')
    })

    it('両側とも当たっている行には側の一言を足さない (畳んで隠したものが無い)', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([
        slip({ rowId: 'a', originAreaName: '釧路市', destAreaName: '上士幌町' }),
      ])
      const wrapper = createWrapper()
      await flushPromises()
      expect(wrapper.text()).toContain('完全一致')
      expect(wrapper.text()).not.toContain('積地のみ一致')
      expect(wrapper.text()).not.toContain('卸地のみ一致')
    })

    it('選択区間の積地・卸地が取れていなくても出せる (根拠は付かない)', async () => {
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper({ location: null })
      await flushPromises()
      expect(wrapper.text()).toContain('根拠なし')
    })
  })

  describe('効率指標', () => {
    it('結んだ売上から 円/km・円/時間 を出す', async () => {
      writeAggregated()
      fetchDriverDailySlipsMock.mockResolvedValue([slip({ amount: 100 })])
      const wrapper = createWrapper({
        summary: summary({
          distanceKm: 10,
          durationMin: 60,
          byCategory: { drive: 30, loading: 0, unloading: 0, rest: 0, idle: 0, other: 0 },
        }),
      })
      await flushPromises()
      await wrapper.find('tbody tr').trigger('click')
      // yenPerKm = 100/10 = 10 / yenPerHourBound = 100/1 = 100 / yenPerHourDrive = 100/0.5 = 200
      expect(wrapper.text()).toContain('10')
      expect(wrapper.text()).toContain('100')
      expect(wrapper.text()).toContain('200')
    })

    it('分母が 0 の指標は「-」(0 で割った数を出さない)', async () => {
      writeAggregated()
      fetchDriverDailySlipsMock.mockResolvedValue([slip()])
      const wrapper = createWrapper({
        summary: summary({
          distanceKm: 0,
          durationMin: 0,
          byCategory: { drive: 0, loading: 0, unloading: 0, rest: 0, idle: 0, other: 0 },
        }),
      })
      await flushPromises()
      expect(wrapper.text()).toContain('-')
    })
  })
})
