/**
 * `/restraint-report` (拘束時間管理表) の画面 — **#903 の 2 段目**。
 *
 * 再計算まわりの「失敗を『処理中』と言わない」は
 * `restraint-report-recalc.test.ts` が担当 (Refs #890)。**ここはそれ以外**
 * — 一覧の取得 / 表の組み立て / PDF の 2 つの口 / 見出しの表示 — を見る。
 *
 * 型は 1 段目 (#912) をなぞる:
 *
 * - **API は `~/utils/api` を `vi.mock` + `importOriginal`** ($fetch を持たない画面)
 * - **Nuxt UI は `NUXT_UI_PAGE_STUBS` で全部 stub** (実物は mount できない)
 * - **`w.text()` は textContent の連結**なので、区画の生死は文言ではなく要素で見る
 *   (この画面は表なので `<tr>` / `<td>` の数と中身で見る)
 *
 * ## この画面で踏みやすい「別の意味に読める」型
 *
 * 1. **「まだ選んでいない」「読み込み中」「取得に失敗」「0 件」を同じ見た目にしない**
 * 2. **★ 「実測して 0 分」と「データ無し」を同じ見た目にしない (#918 で決着)** —
 *    `fmt()` は `0` → **`0:00`** / `null` `undefined` → **`-`**。以前はどちらも
 *    空欄で、とくに `break_minutes` は「休憩 0 分」と「休憩データ無し」が
 *    区別できなかった。**記号の意味は凡例で画面にも出す** — 区別できるように
 *    しただけでは見る人が `-` を読めないので、**凡例が消えたら欠陥**として扱う
 * 3. **1 日に複数運行がある日を 1 行に潰さない** — 潰すと内訳が消える
 * 4. **PDF の進捗を出したまま消し忘れない** — 「まだ動いている」と読める
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import type {
  Driver, OperationDetail, RestraintDayRow, RestraintReportResponse, WeeklySubtotal,
} from '~/types'
import type { PdfProgressEvent } from '~/utils/api'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api } = vi.hoisted(() => ({
  api: {
    getDrivers: vi.fn(),
    getRestraintReport: vi.fn(),
    downloadRestraintReportPdfStream: vi.fn(),
    downloadRestraintReportPdfSingle: vi.fn(),
    recalculateStream: vi.fn(),
    recalculateDriverStream: vi.fn(),
  },
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDrivers: api.getDrivers,
  getRestraintReport: api.getRestraintReport,
  downloadRestraintReportPdfStream: api.downloadRestraintReportPdfStream,
  downloadRestraintReportPdfSingle: api.downloadRestraintReportPdfSingle,
  recalculateStream: api.recalculateStream,
  recalculateDriverStream: api.recalculateDriverStream,
}))

import Page from '~/pages/restraint-report.vue'

function driver(id: string, name: string): Driver {
  return { id, tenant_id: 't1', driver_cd: id, driver_name: name }
}

function op(o: Partial<OperationDetail> = {}): OperationDetail {
  return { unko_no: 'U1', drive_minutes: 0, cargo_minutes: 0, break_minutes: 0, restraint_minutes: 0, ...o }
}

function day(date: string, o: Partial<RestraintDayRow> = {}): RestraintDayRow {
  return {
    date,
    is_holiday: false,
    start_time: '08:00',
    end_time: '18:00',
    operations: [op({ drive_minutes: 300, cargo_minutes: 60, break_minutes: 60, restraint_minutes: 420 })],
    drive_minutes: 300,
    cargo_minutes: 60,
    break_minutes: 60,
    restraint_total_minutes: 420,
    restraint_cumulative_minutes: 420,
    drive_average_minutes: 300,
    rest_period_minutes: 660,
    remarks: '',
    ...o,
  }
}

function report(o: Partial<RestraintReportResponse> = {}): RestraintReportResponse {
  return {
    driver_id: 'd1',
    driver_name: '山田 太郎',
    year: 2026,
    month: 7,
    max_restraint_minutes: 780,
    days: [day('2026-07-01')],
    weekly_subtotals: [],
    monthly_total: {
      drive_minutes: 300,
      cargo_minutes: 60,
      break_minutes: 60,
      restraint_minutes: 420,
      fiscal_year_cumulative_minutes: 1200,
      fiscal_year_total_minutes: 1620,
    },
    ...o,
  }
}

function subtotal(date: string, o: Partial<WeeklySubtotal> = {}): WeeklySubtotal {
  return {
    week_end_date: date,
    drive_minutes: 600, cargo_minutes: 120, break_minutes: 120, restraint_minutes: 840,
    ...o,
  }
}

/**
 * `DriverSearchSelect` は別コンポーネント (別途 gate 済み) なので stub して
 * **「どの id を選んだか」だけ**をこの画面に渡す。
 */
const DriverSearchSelectStub = {
  name: 'DriverSearchSelect',
  props: ['modelValue', 'drivers', 'placeholder'],
  emits: ['update:modelValue'],
  template: `<div>
    <button class="pick-d1" @click="$emit('update:modelValue', 'd1')">d1</button>
    <button class="pick-unknown" @click="$emit('update:modelValue', 'zzz')">unknown</button>
    <span class="driver-count">{{ drivers.length }}</span>
  </div>`,
}

function mountPage() {
  return mount(Page, {
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, DriverSearchSelect: DriverSearchSelectStub } },
  })
}

/** ラベル**完全一致**で引く。部分一致だと「再計算」が「全員再計算」に当たる。 */
function button(w: VueWrapper, label: string) {
  const found = w.findAll('button').filter(b => b.text().trim() === label)
  expect(found, `「${label}」ボタンが 1 つでない`).toHaveLength(1)
  return found[0]!
}

async function setMonth(w: VueWrapper, ym = '2026-07') {
  await w.find('input[type="month"]').setValue(ym)
  await flushPromises()
}

async function pickDriver(w: VueWrapper, which: 'd1' | 'unknown' = 'd1') {
  await w.find(which === 'd1' ? '.pick-d1' : '.pick-unknown').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getDrivers.mockResolvedValue([driver('d1', '山田 太郎'), driver('d2', '佐藤 花子')])
  api.getRestraintReport.mockResolvedValue(report())
  api.downloadRestraintReportPdfStream.mockResolvedValue(undefined)
  api.downloadRestraintReportPdfSingle.mockResolvedValue(undefined)
  vi.stubGlobal('confirm', () => true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('/restraint-report ドライバー一覧の取得', () => {
  it('取得できたら選択肢に渡す', async () => {
    const w = mountPage()
    await flushPromises()

    expect(w.find('.driver-count').text()).toBe('2')
  })

  /**
   * ★ **ここは #912 で「現状の挙動」として固定していたものを書き換えた** (Refs #920)。
   *
   * 元のテストは `onMounted` の `.catch(() => {})` が握り潰す挙動 —
   * 「取得に失敗した」と「乗務員が 0 人」が同じ見た目になること — を assert して
   * いた。**その挙動自体が欠陥**なので、`SKILL.md` §7 の「その語を固定していた
   * テストは**今の嘘**を固定している。書き換えになるのが正しい」に当たる。
   *
   * **逆方向も同じだけ大事**で、失敗の文言だけ足すと**本当に 0 人の回**まで
   * 異常に見える。両方向を撃ち分けるところまでがこの節の担当。
   */
  describe('★ 「取得に失敗した」と「本当に 0 人」を別の文にする (Refs #920)', () => {
    it('失敗したら理由を出す (画面自体は今までどおり開く)', async () => {
      api.getDrivers.mockRejectedValue(new Error('API エラー (503): DB に繋がりません'))
      const w = mountPage()
      await flushPromises()

      // ★ 理由のうしろに「次に何をすればいいか」が付く (Refs #1008)。
      expect(w.text()).toContain('乗務員一覧を取得できませんでした (API エラー (503): DB に繋がりません'
        + ' — サーバ側の設定か障害です (権限の問題ではありません)。復旧してからページを再読み込みしてください)')
      // **断定しない。**確かめ方まで出す (#911 / #915 と同じ形)
      expect(w.text()).toContain('0 人なのか読めなかっただけなのかは、この画面では判りません')
      expect(w.text()).toContain('ページを再読み込みして確かめてください')
      // 画面は今までどおり開く (選択肢が空になるだけ)
      expect(w.find('.driver-count').text()).toBe('0')
      expect(w.text()).toContain('ドライバーと月を選択してください')
    })

    it('★ 逆方向: 取得できて 0 人だった回は警告を出さない (異常に見せない)', async () => {
      api.getDrivers.mockResolvedValue([])
      const w = mountPage()
      await flushPromises()

      expect(w.find('.driver-count').text()).toBe('0')
      expect(w.text()).not.toContain('取得できませんでした')
      expect(w.text()).not.toContain('判りません')
      expect(w.text()).toContain('ドライバーと月を選択してください')
    })

    it('Error 以外で失敗しても黙らず、[object Object] も出さない', async () => {
      api.getDrivers.mockRejectedValue({ status: 503 })
      const w = mountPage()
      await flushPromises()

      expect(w.text()).toContain('乗務員一覧を取得できませんでした (理由を読めませんでした)')
      expect(w.text()).not.toContain('[object Object]')
    })

    it('乗務員一覧が読めなくても、月報の取得エラーとは別の文として出る', async () => {
      // 同じ画面に 2 種類の失敗が出る。**混ざると「どっちが落ちたのか」が消える。**
      api.getDrivers.mockRejectedValue(new Error('一覧が落ちた'))
      api.getRestraintReport.mockRejectedValue(new Error('月報が落ちた'))
      const w = mountPage()
      await flushPromises()
      await setMonth(w)
      await pickDriver(w)

      const alerts = w.findAllComponents({ name: 'UAlert' })
      const titles = alerts.map(a => a.props('title'))
      expect(titles).toContain('乗務員一覧を取得できませんでした (一覧が落ちた)')
      expect(titles).toContain('月報が落ちた')
    })
  })
})

describe('/restraint-report 表示の 4 状態', () => {
  it('何も選んでいなければ「選択してください」だけ', async () => {
    const w = mountPage()
    await flushPromises()

    expect(w.text()).toContain('ドライバーと月を選択してください')
    expect(w.find('table').exists()).toBe(false)
    expect(w.text()).not.toContain('読み込み中')
  })

  it('片方だけでは取りに行かない (月だけ / ドライバーだけ)', async () => {
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    expect(api.getRestraintReport).not.toHaveBeenCalled()

    const w2 = mountPage()
    await flushPromises()
    await pickDriver(w2)
    expect(api.getRestraintReport).not.toHaveBeenCalled()
  })

  it('★ 読み込み中は「読み込み中...」— 空の表を出して「0 件」に見せない', async () => {
    let release: (r: RestraintReportResponse) => void = () => {}
    api.getRestraintReport.mockImplementation(() => new Promise<RestraintReportResponse>((r) => { release = r }))
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)

    expect(w.text()).toContain('読み込み中...')
    expect(w.find('table').exists()).toBe(false)
    expect(w.text()).not.toContain('ドライバーと月を選択してください')

    release(report())
    await flushPromises()
    expect(w.find('table').exists()).toBe(true)
    expect(w.text()).not.toContain('読み込み中...')
  })

  it('両方そろえば年月を渡して取りに行く', async () => {
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)

    expect(api.getRestraintReport).toHaveBeenCalledWith({ driver_id: 'd1', year: 2026, month: 7 })
  })

  it('★ 取得に失敗したら理由を出し、前の表を残さない', async () => {
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)
    expect(w.find('table').exists()).toBe(true)

    api.getRestraintReport.mockRejectedValue(new Error('API エラー (503): '))
    await setMonth(w, '2026-08')
    await flushPromises()

    expect(w.text()).toContain('API エラー (503):')
    expect(w.find('table').exists()).toBe(false)
    // 「まだ選んでいない」の文言と混ぜない。
    expect(w.text()).not.toContain('ドライバーと月を選択してください')
  })

  it('Error 以外が投げられても黙らない', async () => {
    api.getRestraintReport.mockRejectedValue('boom')
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)

    expect(w.text()).toContain('データ取得に失敗しました')
  })

  it('「表示」ボタンでも取り直せる (月とドライバーが揃うまでは押せない)', async () => {
    const w = mountPage()
    await flushPromises()
    expect((button(w, '表示').element as HTMLButtonElement).disabled).toBe(true)

    await setMonth(w)
    await pickDriver(w)
    expect((button(w, '表示').element as HTMLButtonElement).disabled).toBe(false)

    await button(w, '表示').trigger('click')
    await flushPromises()
    expect(api.getRestraintReport).toHaveBeenCalledTimes(2)
  })
})

describe('/restraint-report 表の組み立て', () => {
  async function show(res: RestraintReportResponse) {
    api.getRestraintReport.mockResolvedValue(res)
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)
    return w
  }

  it('見出しに令和の月と当月最大拘束時間と氏名を出す', async () => {
    const w = await show(report())

    expect(w.text()).toContain('令和8年7月分')
    expect(w.text()).toContain('13:00')       // max_restraint_minutes = 780
    expect(w.text()).toContain('山田 太郎')
  })

  it('休日は「休」1 行だけにして、時間の欄を空で埋めない', async () => {
    const w = await show(report({ days: [day('2026-07-05', { is_holiday: true })] }))

    const rows = w.findAll('tbody tr')
    // 休日行 + 月合計行。
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('休')
    expect(rows[0]!.findAll('td')[0]!.text()).toBe('05')
  })

  it('★ 1 日に複数運行がある日は運行ごとに行を積む (1 行に潰さない)', async () => {
    const w = await show(report({
      days: [day('2026-07-02', {
        operations: [
          op({ drive_minutes: 120, cargo_minutes: 30, break_minutes: 15, restraint_minutes: 165 }),
          op({ drive_minutes: 90, cargo_minutes: 20, break_minutes: 10, restraint_minutes: 120 }),
        ],
      })],
    }))

    const rows = w.findAll('tbody tr')
    // 1 運行目の行 + 2 運行目の行 + 月合計行。
    expect(rows).toHaveLength(3)
    expect(rows[0]!.findAll('td').map(t => t.text()).slice(0, 7))
      .toEqual(['02', '08:00', '18:00', '2:00', '0:30', '0:15', '2:45'])
    // 2 行目は内訳 4 セルだけ (日付・始業・終業は rowspan で 1 行目が持つ)。
    expect(rows[1]!.findAll('td').map(t => t.text())).toEqual(['1:30', '0:20', '0:10', '2:00'])
  })

  it('運行が 0 件の日でも日付行は消さず、内訳は「データ無し」にする (Refs #918)', async () => {
    const w = await show(report({
      days: [day('2026-07-03', { operations: [], start_time: null, end_time: null, rest_period_minutes: null })],
    }))

    const tds = w.findAll('tbody tr')[0]!.findAll('td').map(t => t.text())
    expect(tds[0]).toBe('03')
    expect(tds[1]).toBe('')     // 始業 (null) — 時刻列は文字列なので凡例の対象外
    expect(tds[2]).toBe('')     // 終業 (null)
    // ★ 運行 0 件 = **その日の内訳を読めていない**。空欄にすると「4 項目とも 0 分」と
    // 同じ見た目になるので `-` を出す。
    expect(tds.slice(3, 7)).toEqual(['-', '-', '-', '-'])
    expect(tds[10]).toBe('-')   // 休息時間 null
  })

  it('休息時間があれば出す', async () => {
    const w = await show(report({ days: [day('2026-07-04', { rest_period_minutes: 660 })] }))

    expect(w.findAll('tbody tr')[0]!.findAll('td')[10]!.text()).toBe('11:00')
  })

  /**
   * ★ **#918 の本体。**以前は `val == null || val === 0` で「データが無い」と
   * 「実測して 0 分」を**同じ空欄に潰して**いた。潰すのをやめたので、
   * **0 の側と null の側の両方**を固定する (片方だけだと、また潰す実装に
   * 戻しても半分は通ってしまう)。
   */
  it('実測して 0 分は 0:00 と書く (空欄にしない — Refs #918)', async () => {
    const w = await show(report({
      days: [day('2026-07-06', {
        operations: [op({ drive_minutes: 0, cargo_minutes: 0, break_minutes: 0, restraint_minutes: 0 })],
        restraint_total_minutes: 0,
        restraint_cumulative_minutes: 0,
        drive_average_minutes: 0,
        rest_period_minutes: 0,
      })],
    }))

    const tds = w.findAll('tbody tr')[0]!.findAll('td').map(t => t.text())
    expect(tds.slice(3, 11)).toEqual(['0:00', '0:00', '0:00', '0:00', '0:00', '0:00', '0:00', '0:00'])
  })

  /**
   * `null` 側。**型 (`RestraintDayRow`) は `rest_period_minutes` 以外を `number` と
   * 言っているが、これは API 応答をそう宣言しているだけ**で、欠測が来ないことを
   * 保証してはいない。`fmt()` が `null | undefined` を受ける以上、来たときに
   * 「0 分」と読める見た目にしないことを固定しておく。
   */
  it('データが無い分は - にする (0 分と混ぜない — Refs #918)', async () => {
    const w = await show(report({
      days: [day('2026-07-09', {
        operations: [op({
          drive_minutes: null as unknown as number,
          cargo_minutes: undefined as unknown as number,
          break_minutes: null as unknown as number,
          restraint_minutes: undefined as unknown as number,
        })],
        restraint_total_minutes: null as unknown as number,
        restraint_cumulative_minutes: undefined as unknown as number,
        drive_average_minutes: null as unknown as number,
        rest_period_minutes: null,
      })],
    }))

    const tds = w.findAll('tbody tr')[0]!.findAll('td').map(t => t.text())
    expect(tds.slice(3, 11)).toEqual(['-', '-', '-', '-', '-', '-', '-', '-'])
  })

  /**
   * **運転平均だけは `fmt()` の手前に `Math.round()` が挟まる。**`Math.round(null)`
   * は `0` なので、素通しすると**欠測が `0:00` (実測して 0 分) に化ける** —
   * `fmt()` を直しただけでは塞がらない穴なので独立して固定する。
   */
  it('運転平均が欠測でも 0:00 に倒さない (Math.round(null) === 0 の穴 — Refs #918)', async () => {
    const w = await show(report({
      days: [day('2026-07-10', { drive_average_minutes: null as unknown as number })],
    }))

    expect(w.findAll('tbody tr')[0]!.findAll('td')[9]!.text()).toBe('-')
  })

  it('運転平均は分に丸めてから整形する', async () => {
    const w = await show(report({ days: [day('2026-07-07', { drive_average_minutes: 125.6 })] }))

    expect(w.findAll('tbody tr')[0]!.findAll('td')[9]!.text()).toBe('2:06')
  })

  it('週の締めの日には小計行を挟む', async () => {
    const w = await show(report({
      days: [day('2026-07-04'), day('2026-07-05')],
      weekly_subtotals: [subtotal('2026-07-05')],
    }))

    const rows = w.findAll('tbody tr')
    // 04 の行 / 05 の行 / 小計 / 月合計。
    expect(rows).toHaveLength(4)
    expect(rows[2]!.text()).toContain('小計')
    expect(rows[2]!.findAll('td').map(t => t.text()).slice(0, 5))
      .toEqual(['小計', '10:00', '2:00', '2:00', '14:00'])
  })

  it('締めの日でない日には小計行を挟まない', async () => {
    const w = await show(report({
      days: [day('2026-07-04')],
      weekly_subtotals: [subtotal('2026-07-11')],
    }))

    // ★ 「小計」は表の見出し (`<th>`) にも出ているので `w.text()` では判定できない。
    // 区画の生死は**行**で見る (NUXT_UI_PAGE_STUBS の doc「4.」と同じ罠)。
    expect(w.findAll('tbody tr')).toHaveLength(2)
    expect(w.findAll('tbody tr').map(tr => tr.findAll('td')[0]!.text())).toEqual(['04', '合計'])
  })

  it('摘要はそのまま出す', async () => {
    const w = await show(report({ days: [day('2026-07-08', { remarks: '荷待ち 2h' })] }))

    expect(w.findAll('tbody tr')[0]!.findAll('td')[11]!.text()).toBe('荷待ち 2h')
  })

  it('月合計と年度の 3 数字を出す', async () => {
    const w = await show(report())

    const total = w.findAll('tbody tr').at(-1)!
    expect(total.findAll('td').map(t => t.text()).slice(0, 5))
      .toEqual(['合計', '5:00', '1:00', '1:00', '7:00'])
    expect(w.text()).toContain('4月〜前月 累計拘束時間:')
    expect(w.text()).toContain('20:00')   // fiscal_year_cumulative 1200
    expect(w.text()).toContain('27:00')   // fiscal_year_total 1620
  })

  /**
   * ★ **凡例 (Refs #918)。`0:00` と `-` を出し分けただけでは、見る人が `-` の意味を
   * 知らない。**
   *
   * **判定は「合成後の 1 文」で行う** — 凡例は `<span>` を挟んで組み立てられるので、
   * `toContain('データ無し')` のように語を 1 つずつ見ると、**語が全部あるのに文として
   * 成立していない**組み方 (順序が入れ替わる / `0:00` と `-` の説明が入れ替わる) を
   * 通してしまう。空白を潰した 1 本の文字列を丸ごと固定する。
   */
  function legendText(w: VueWrapper): string {
    const p = w.findAll('p').find(el => el.text().includes('時間列の見かた'))
    return (p?.text() ?? '').replace(/\s+/g, ' ').trim()
  }

  it('表の下に凡例を出し、「読んだ結果 0」と「読めていない」の違いを書く (Refs #918)', async () => {
    const w = await show(report())

    expect(legendText(w)).toBe(
      '時間列の見かた: 0:00 は実測して 0 分 (記録を読んだ結果が 0)、'
      + ' - はデータ無し (記録が無い、または取得できなかった'
      + ' — 0 分だったのかどうかも分かりません)。「休」の行は稼働の無い日です。',
    )
  })

  it('表が無いうちは凡例も出さない (説明する対象が無い)', async () => {
    const w = mountPage()
    await flushPromises()

    expect(legendText(w)).toBe('')
  })
})

describe('/restraint-report 単一 PDF', () => {
  it('月とドライバーが揃うまでは押せない', async () => {
    const w = mountPage()
    await flushPromises()
    expect((button(w, 'PDF').element as HTMLButtonElement).disabled).toBe(true)

    await setMonth(w)
    expect((button(w, 'PDF').element as HTMLButtonElement).disabled).toBe(true)

    await pickDriver(w)
    expect((button(w, 'PDF').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('表を出した後は、表に出ている氏名でファイルを作らせる', async () => {
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)
    await button(w, 'PDF').trigger('click')
    await flushPromises()

    expect(api.downloadRestraintReportPdfSingle).toHaveBeenCalledWith(2026, 7, 'd1', '山田 太郎', '「PDF」を押してください')
  })

  it('★ 表が出ていなくても、一覧の氏名で作らせる (氏名だけ空にしない)', async () => {
    api.getRestraintReport.mockRejectedValue(new Error('取得できません'))
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)
    await button(w, 'PDF').trigger('click')
    await flushPromises()

    expect(api.downloadRestraintReportPdfSingle).toHaveBeenCalledWith(2026, 7, 'd1', '山田 太郎', '「PDF」を押してください')
  })

  it('一覧にも居ないドライバーなら氏名は空で渡す (存在しない名前を作らない)', async () => {
    api.getRestraintReport.mockRejectedValue(new Error('取得できません'))
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w, 'unknown')
    await button(w, 'PDF').trigger('click')
    await flushPromises()

    expect(api.downloadRestraintReportPdfSingle).toHaveBeenCalledWith(2026, 7, 'zzz', '', '「PDF」を押してください')
  })

  it('失敗したら理由を出す', async () => {
    api.downloadRestraintReportPdfSingle.mockRejectedValue(new Error('PDF 生成に失敗: 503'))
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)
    await button(w, 'PDF').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('PDF 生成に失敗: 503')
  })

  it('Error 以外が投げられても黙らない', async () => {
    api.downloadRestraintReportPdfSingle.mockRejectedValue('boom')
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)
    await button(w, 'PDF').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('PDF出力に失敗しました')
  })
})

describe('/restraint-report 全員 PDF の進捗', () => {
  /** `onProgress` に流すイベント列を決めて「全員PDF」を押す。 */
  async function runPdf(events: PdfProgressEvent[], opts: { throws?: unknown } = {}) {
    api.downloadRestraintReportPdfStream.mockImplementation(
      async (_y: number, _m: number, onProgress: (e: PdfProgressEvent) => void) => {
        for (const e of events) onProgress(e)
        if ('throws' in opts) throw opts.throws
      },
    )
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await button(w, '全員PDF').trigger('click')
    await flushPromises()
    return w
  }

  it('月を選ぶまでは押せない (ドライバーは要らない)', async () => {
    const w = mountPage()
    await flushPromises()
    expect((button(w, '全員PDF').element as HTMLButtonElement).disabled).toBe(true)

    await setMonth(w)
    expect((button(w, '全員PDF').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('押した直後は「準備中...」を出す', async () => {
    api.downloadRestraintReportPdfStream.mockImplementation(() => new Promise(() => {}))
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await button(w, '全員PDF').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('準備中...')
  })

  it('データ取得中は「何人目 / 誰を」まで出す', async () => {
    const w = await runPdf([{ event: 'progress', step: 'fetch', current: 3, total: 10, driver_name: '佐藤 花子' }])

    expect(w.text()).toContain('データ取得中 (3/10) 佐藤 花子')
  })

  it('氏名が来ない回でも「undefined」と書かない', async () => {
    const w = await runPdf([{ event: 'progress', step: 'fetch', current: 3, total: 10 }])

    expect(w.text()).toContain('データ取得中 (3/10)')
    expect(w.text()).not.toContain('undefined')
  })

  it('レンダリング中は「PDF生成中...」', async () => {
    const w = await runPdf([{ event: 'progress', step: 'render' }])

    expect(w.text()).toContain('PDF生成中...')
  })

  it('知らない step が来ても前の表示を書き換えない', async () => {
    const w = await runPdf([
      { event: 'progress', step: 'render' },
      { event: 'progress', step: 'save' },
    ])

    expect(w.text()).toContain('PDF生成中...')
    expect(w.text()).not.toContain('undefined')
  })

  it('done で「ダウンロード完了」', async () => {
    const w = await runPdf([{ event: 'done' }])

    expect(w.text()).toContain('ダウンロード完了')
    expect(w.text()).not.toContain('PDF出力に失敗')
  })

  it('★ error イベントは理由を出し、進捗の見た目と混ぜない', async () => {
    const w = await runPdf([{ event: 'error', message: '対象月のデータがありません' }])

    expect(w.text()).toContain('対象月のデータがありません')
  })

  it('理由が無い error イベントでも黙らない', async () => {
    const w = await runPdf([{ event: 'error' }])

    expect(w.text()).toContain('PDF出力に失敗しました')
  })

  it('知らない event が来ても落ちない', async () => {
    const w = await runPdf([{ event: 'heartbeat' }])

    expect(w.text()).toContain('準備中...')
  })

  it('ストリームが例外で終わったら理由を出す', async () => {
    const w = await runPdf([], { throws: new Error('network error') })

    expect(w.text()).toContain('network error')
  })

  it('Error 以外が投げられても黙らない', async () => {
    const w = await runPdf([], { throws: 'boom' })

    expect(w.text()).toContain('PDF出力に失敗しました')
  })

  it('★ 進捗の文字は 3 秒後に消える (残っていると「まだ動いている」と読める)', async () => {
    vi.useFakeTimers()
    api.downloadRestraintReportPdfStream.mockImplementation(
      async (_y: number, _m: number, onProgress: (e: PdfProgressEvent) => void) => {
        onProgress({ event: 'done' })
      },
    )
    const w = mountPage()
    await flushPromises()
    await w.find('input[type="month"]').setValue('2026-07')
    await flushPromises()
    await button(w, '全員PDF').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('ダウンロード完了')

    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(w.text()).not.toContain('ダウンロード完了')
  })
})

describe('/restraint-report 再計算 (recalc test の続き — done / error / 進捗の後始末)', () => {
  it('月を選ぶまで「全員再計算」は押せない', async () => {
    const w = mountPage()
    await flushPromises()
    expect((button(w, '全員再計算').element as HTMLButtonElement).disabled).toBe(true)

    await setMonth(w)
    expect((button(w, '全員再計算').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('月とドライバーが揃うまで「再計算」は押せない', async () => {
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    expect((button(w, '再計算').element as HTMLButtonElement).disabled).toBe(true)

    await pickDriver(w)
    expect((button(w, '再計算').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('確認で「いいえ」を選んだら 1 回も呼ばない', async () => {
    vi.stubGlobal('confirm', () => false)
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await button(w, '全員再計算').trigger('click')
    await flushPromises()

    expect(api.recalculateStream).not.toHaveBeenCalled()
    expect(w.text()).not.toContain('準備中...')
  })

  it('1 人ぶんも確認で「いいえ」なら呼ばない (氏名を確認文に出す)', async () => {
    const asked: string[] = []
    vi.stubGlobal('confirm', (msg: string) => { asked.push(msg); return false })
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)
    await button(w, '再計算').trigger('click')
    await flushPromises()

    expect(asked[0]).toBe('山田 太郎 の 2026年7月を再計算します。よろしいですか？')
    expect(api.recalculateDriverStream).not.toHaveBeenCalled()
  })

  it('一覧に居ないドライバーでも確認文に「undefined」を出さない', async () => {
    const asked: string[] = []
    vi.stubGlobal('confirm', (msg: string) => { asked.push(msg); return false })
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w, 'unknown')
    await button(w, '再計算').trigger('click')
    await flushPromises()

    expect(asked[0]).toBe(' の 2026年7月を再計算します。よろしいですか？')
  })

  it('進捗は DL / 保存 / 処理 を撃ち分ける', async () => {
    const steps = [
      { step: 'download', label: '再計算中 (1/3) DL中...' },
      { step: 'save', label: '再計算中 (1/3) 保存中...' },
      { step: 'merge', label: '再計算中 (1/3) 処理中...' },
    ]
    for (const { step, label } of steps) {
      // 進捗を出した**まま**にする。解決させると `!gotDone` の分岐が走って
      // 「バックグラウンドで処理中...」に上書きされ、進捗の文言が測れない。
      api.recalculateStream.mockImplementation((_y: number, _m: number, onProgress: (e: unknown) => void) => {
        onProgress({ event: 'progress', current: 1, total: 3, step })
        return new Promise(() => {})
      })
      const w = mountPage()
      await flushPromises()
      await setMonth(w)
      await button(w, '全員再計算').trigger('click')
      await flushPromises()

      expect(w.text()).toContain(label)
    }
  })

  it('done は成功件数を出し、失敗が 0 件なら失敗を書かない', async () => {
    api.recalculateStream.mockImplementation(async (_y: number, _m: number, onProgress: (e: unknown) => void) => {
      onProgress({ event: 'done', success: 10, total: 10, failed: 0 })
    })
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await button(w, '全員再計算').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('完了: 10/10 成功')
    expect(w.text()).not.toContain('失敗')
  })

  it('★ 失敗があれば件数を出す (成功件数だけ見せて「全部通った」と読ませない)', async () => {
    api.recalculateStream.mockImplementation(async (_y: number, _m: number, onProgress: (e: unknown) => void) => {
      onProgress({ event: 'done', success: 8, total: 10, failed: 2 })
    })
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await button(w, '全員再計算').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('完了: 8/10 成功, 2 失敗')
  })

  it('failed が来ない応答でも「undefined 失敗」と書かない', async () => {
    api.recalculateStream.mockImplementation(async (_y: number, _m: number, onProgress: (e: unknown) => void) => {
      onProgress({ event: 'done', success: 10, total: 10 })
    })
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await button(w, '全員再計算').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('完了: 10/10 成功')
    expect(w.text()).not.toContain('undefined')
  })

  it('理由が無い error イベントでも黙らない', async () => {
    api.recalculateStream.mockImplementation(async (_y: number, _m: number, onProgress: (e: unknown) => void) => {
      onProgress({ event: 'error' })
    })
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await button(w, '全員再計算').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('再計算に失敗しました')
  })

  it('知らない event が来ても「準備中...」のまま壊れない', async () => {
    api.recalculateStream.mockImplementation(async (_y: number, _m: number, onProgress: (e: unknown) => void) => {
      onProgress({ event: 'heartbeat' })
    })
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await button(w, '全員再計算').trigger('click')
    await flushPromises()

    // 例外なしで done が来ない回 = 今までどおり「処理中」(Refs #890 の逆方向)。
    expect(w.text()).toContain('バックグラウンドで処理中...完了までお待ちください')
  })

  it('★ 終わった表示は 10 秒後に消える (残っていると次の回の結果に読める)', async () => {
    vi.useFakeTimers()
    api.recalculateStream.mockImplementation(async (_y: number, _m: number, onProgress: (e: unknown) => void) => {
      onProgress({ event: 'done', success: 1, total: 1, failed: 0 })
    })
    const w = mountPage()
    await flushPromises()
    await w.find('input[type="month"]').setValue('2026-07')
    await flushPromises()
    await button(w, '全員再計算').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('完了: 1/1 成功')

    await vi.advanceTimersByTimeAsync(10000)
    await flushPromises()
    expect(w.text()).not.toContain('完了: 1/1 成功')
  })
})

describe('/restraint-report 1 人ぶんの再計算', () => {
  async function runDriverRecalc(events: unknown[]) {
    api.recalculateDriverStream.mockImplementation(
      async (_y: number, _m: number, _id: string, onProgress: (e: unknown) => void) => {
        for (const e of events) onProgress(e)
      },
    )
    const w = mountPage()
    await flushPromises()
    await setMonth(w)
    await pickDriver(w)
    api.getRestraintReport.mockClear()
    await button(w, '再計算').trigger('click')
    await flushPromises()
    return w
  }

  it('進捗は DL / 保存 / 処理 を撃ち分ける', async () => {
    const w = await runDriverRecalc([{ event: 'progress', current: 2, total: 5, step: 'save' }])

    expect(w.text()).toContain('再計算中 (2/5) 保存中...')
  })

  it('★ 終わったら表を取り直す (古い表を新しい結果に読ませない)', async () => {
    const w = await runDriverRecalc([{ event: 'done' }])

    expect(w.text()).toContain('山田 太郎 再計算完了')
    expect(api.getRestraintReport).toHaveBeenCalledTimes(1)
  })

  it('error で終わった回は表を取り直さない (失敗を上書きで消さない)', async () => {
    const w = await runDriverRecalc([{ event: 'error', message: '対象データがありません' }])

    expect(w.text()).toContain('対象データがありません')
    expect(api.getRestraintReport).not.toHaveBeenCalled()
  })

  it('理由が無い error イベントでも黙らない', async () => {
    const w = await runDriverRecalc([{ event: 'error' }])

    expect(w.text()).toContain('再計算に失敗しました')
  })

  it('例外なしで done が来ない回は何も書き換えない', async () => {
    const w = await runDriverRecalc([])

    expect(w.text()).toContain('準備中...')
    expect(api.getRestraintReport).not.toHaveBeenCalled()
  })

  it('★ 終わった表示は 10 秒後に消える', async () => {
    vi.useFakeTimers()
    api.recalculateDriverStream.mockImplementation(
      async (_y: number, _m: number, _id: string, onProgress: (e: unknown) => void) => {
        onProgress({ event: 'done' })
      },
    )
    const w = mountPage()
    await flushPromises()
    await w.find('input[type="month"]').setValue('2026-07')
    await flushPromises()
    await w.find('.pick-d1').trigger('click')
    await flushPromises()
    await button(w, '再計算').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('山田 太郎 再計算完了')

    await vi.advanceTimersByTimeAsync(10000)
    await flushPromises()
    expect(w.text()).not.toContain('再計算完了')
  })
})
