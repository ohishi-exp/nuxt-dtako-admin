/**
 * `/y-time-export` (Y時間 エクスポート) の画面 — **#903 の 2 段目**。
 *
 * 1 段目 (#912) が決めた型をなぞる:
 *
 * - **API は `~/utils/api` を `vi.mock` + `importOriginal`** で必要な関数だけ差し替える
 *   (この画面は `$fetch` を持たない。テンプレ R2 / xlsx は**生 `fetch`**)
 * - **`@ippoan/auth-client` は丸ごと差し替える** (`useAuth` は Nuxt の実 app が要る)
 * - **`w.text()` は textContent の連結**なので、区画の生死は文言ではなく**その区画の要素**で見る
 *
 * ## この画面で踏みやすい「別の意味に読める」型
 *
 * 1. **「まだ確認していない」「確認中」「無い」「読めなかった」を同じ見た目にしない** —
 *    テンプレ R2 の 5 状態 (`idle` / `checking` / `exists` / `missing` / `error`)
 * 2. **勤務が無い日を「行が無い」で消さない** — `previewRowsWithGaps` が期間内の全暦日を
 *    出す。消すと「その日は集計対象外だった」と読める
 * 3. **期間が無効なとき「0 行」と言わない** — 「期間が無効です。」と言い切る
 * 4. **保存済みフォーム値の復元に失敗しても黙って既定値に戻さない**…のではなく、
 *    ここは**黙って既定値で開くのが現状の挙動**。テストで固定して次の人に見せる
 *
 * ## ★ 現状の挙動として固定しているもの (直すのは別 issue)
 *
 * **`getDrivers()` は `app/utils/api.ts` の `createAuthFetch` 経由**で、
 * **非 2xx の本文を読まない**。本文が空だと画面には `API エラー (503): ` と
 * **区切り文字の後ろが空**の 1 文が出る。**これは #904 (`app/utils/api.ts` 側) で直る** —
 * この画面の当て忘れではないので、**現状の挙動としてそのまま固定**している
 * (直したのは #890 で**この画面が自分で読んでいる 3 つの口**だけ。下記の
 * `y-time-export-template-check.test.ts` が担当)。
 *
 * ## 行の元 (Refs #1133 c1133-47)
 *
 * プレビュー (`getYTimeRows()` = `POST /api/y-time-rows`) とダウンロード (`POST /api/y-time-export`) は
 * 同じ元 (勤怠の勤務の記録。倒したときだけ運行) の行を出す。**応答は乗務員の名前も期間も持たない**ので、
 * 見出しの名前は画面の一覧から、期間と暦日の展開は画面の入力から出す。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import type { Driver, YTimeRow, YTimeRowsPreview } from '~/types'
import { ResponseFailure } from '~/utils/api-error'

const { api, tokenRef } = vi.hoisted(() => ({
  api: { getDrivers: vi.fn(), getYTimeRows: vi.fn() },
  tokenRef: { value: 'jwt-token' as string | null },
}))

vi.mock('@ippoan/auth-client', () => ({ useAuth: () => ({ token: tokenRef }) }))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDrivers: api.getDrivers,
  getYTimeRows: api.getYTimeRows,
}))

import Page from '~/pages/y-time-export.vue'

const STORAGE_KEY = 'y-time-export-form-vars-v1'
const realFetch = globalThis.fetch

interface FetchCall { url: string, init: RequestInit | undefined }
let calls: FetchCall[] = []

/** 生 `fetch` を差し替える。`handler` が `Response` を返すか、投げる。 */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return handler(String(input), init)
  }) as typeof fetch
}

/** 本番と同じ形の応答 (HTTP/3 には reason phrase が無い)。 */
function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: '',
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function driver(cd: string, name: string): Driver {
  return { id: `id-${cd}`, tenant_id: 't1', driver_cd: cd, driver_name: name }
}

function row(date: string, o: Partial<YTimeRow> = {}): YTimeRow {
  return {
    date,
    previous_day_start: false,
    start_minutes_of_day: 8 * 60,
    end_minutes_from_bucket_date: 18 * 60,
    rest_prev_5_22: 0,
    rest_prev_22_0: 0,
    rest_today_0_5: 0,
    rest_today_5_22: 60,
    rest_today_22_0: 0,
    rest_next_0_5: 0,
    rest_next_5_22: 0,
    note: null,
    ...o,
  }
}

/** `getYTimeRows()` の応答。既定は運行の元へ倒した応答 (勤怠の設定が無い環境) */
function preview(o: Partial<YTimeRowsPreview> = {}): YTimeRowsPreview {
  return {
    source: 'alc',
    source_reason: 'not_configured',
    rows: [row('2026-07-01')],
    warnings: [],
    excluded: [],
    missing_months: [],
    ...o,
  }
}

function mountPage() {
  return mount(Page)
}

/** ラベル**完全一致**で押す。部分一致だと「R2 確認」と「R2 に保存」が混ざる。 */
function button(w: VueWrapper, label: string) {
  const found = w.findAll('button').filter(b => b.text().trim() === label)
  expect(found, `「${label}」ボタンが 1 つでない`).toHaveLength(1)
  return found[0]!
}

/** ドライバー / 期間 を埋めて「計算プレビュー」「ダウンロード」を押せる状態にする。
 * プレビューの見出しの期間と暦日の展開は、ここで入れた期間から出る (応答は期間を持たない)。 */
async function fillForm(w: VueWrapper, cd = '0001', from = '2026-07-01', to = '2026-07-03') {
  await w.find('select').setValue(cd)
  const dates = w.findAll('input[type="date"]')
  await dates[0]!.setValue(from)
  await dates[1]!.setValue(to)
  await flushPromises()
}

beforeEach(() => {
  calls = []
  localStorage.clear()
  tokenRef.value = 'jwt-token'
  api.getDrivers.mockReset()
  api.getYTimeRows.mockReset()
  api.getDrivers.mockResolvedValue([driver('0001', '山田'), driver('0002', '佐藤')])
  api.getYTimeRows.mockResolvedValue(preview())
  stubFetch(() => json(200, { exists: false, key: 'templates/x.xlsx' }))
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllGlobals()
})

describe('/y-time-export ドライバー一覧', () => {
  it('取得したドライバーが「cd : 名前」で選択肢に出る', async () => {
    const w = mountPage()
    await flushPromises()

    const options = w.findAll('option')
    // 先頭は「— 選択 —」(value 空)。これが無いと選び直せない。
    expect(options[0]!.attributes('value')).toBe('')
    expect(options.map(o => o.text())).toEqual(['— 選択 —', '0001 : 山田', '0002 : 佐藤'])
  })

  it('一覧の取得に失敗したら理由を出す (黙って空の選択肢にしない)', async () => {
    api.getDrivers.mockRejectedValue(new Error('API エラー (503): 取得できません'))
    const w = mountPage()
    await flushPromises()

    expect(w.text()).toContain('API エラー (503): 取得できません')
    // 「選べるものが無い」だけの見た目にしない。
    expect(w.findAll('option')).toHaveLength(1)
  })

  it('Error 以外が投げられても黙らない (既定文言が出る)', async () => {
    api.getDrivers.mockRejectedValue('boom')
    const w = mountPage()
    await flushPromises()

    expect(w.text()).toContain('ドライバー一覧の取得に失敗しました')
  })
})

describe('/y-time-export フォーム値の localStorage 復元', () => {
  it('保存済みの 4 値をすべて復元する', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      driverCd: '0002',
      dateFrom: '2026-06-01',
      dateTo: '2026-06-30',
      templateKey: 'templates/kyoto-soft/dev-test.xlsx',
    }))
    const w = mountPage()
    await flushPromises()

    expect((w.find('select').element as HTMLSelectElement).value).toBe('0002')
    const dates = w.findAll('input[type="date"]')
    expect((dates[0]!.element as HTMLInputElement).value).toBe('2026-06-01')
    expect((dates[1]!.element as HTMLInputElement).value).toBe('2026-06-30')
    expect((w.find('input[type="text"]').element as HTMLInputElement).value)
      .toBe('templates/kyoto-soft/dev-test.xlsx')
  })

  it('★ 空の保存 (キーが 1 つも無い) は既定のテンプレ Key を空にしない', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({}))
    const w = mountPage()
    await flushPromises()

    expect((w.find('input[type="text"]').element as HTMLInputElement).value)
      .toBe('templates/kyoto-soft/base.xlsx')
    expect((w.find('select').element as HTMLSelectElement).value).toBe('')
  })

  it('保存が無ければ既定値で開く', async () => {
    const w = mountPage()
    await flushPromises()

    expect((w.find('input[type="text"]').element as HTMLInputElement).value)
      .toBe('templates/kyoto-soft/base.xlsx')
  })

  it('壊れた JSON が入っていても画面は開く (既定値のまま)', async () => {
    localStorage.setItem(STORAGE_KEY, '{ not json')
    const w = mountPage()
    await flushPromises()

    expect((w.find('input[type="text"]').element as HTMLInputElement).value)
      .toBe('templates/kyoto-soft/base.xlsx')
    expect(w.text()).toContain('Y時間 エクスポート')
  })

  it('localStorage.getItem が投げても画面は開く (private mode 等)', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => {},
      clear: () => {},
    })
    const w = mountPage()
    await flushPromises()

    expect(w.text()).toContain('Y時間 エクスポート')
  })

  it('localStorage が無い環境 (SSR) でも mount できる', async () => {
    vi.stubGlobal('localStorage', undefined)
    const w = mountPage()
    await flushPromises()
    // 入力を変えても書き戻しで落ちない。
    await w.findAll('input[type="date"]')[0]!.setValue('2026-07-01')
    await flushPromises()

    expect(w.text()).toContain('Y時間 エクスポート')
  })

  it('入力を変えると 4 値まとめて書き戻す', async () => {
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '0002')

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      driverCd: '0002',
      dateFrom: '2026-07-01',
      dateTo: '2026-07-03',
      templateKey: 'templates/kyoto-soft/base.xlsx',
    })
  })

  it('localStorage.setItem が投げても入力は続けられる (quota / private mode)', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
      clear: () => {},
    })
    const w = mountPage()
    await flushPromises()
    await w.findAll('input[type="date"]')[0]!.setValue('2026-07-01')
    await flushPromises()

    expect((w.findAll('input[type="date"]')[0]!.element as HTMLInputElement).value)
      .toBe('2026-07-01')
  })
})

describe('/y-time-export テンプレ R2 の 5 状態', () => {
  /** 「R2 確認」を押して待つ。 */
  async function check(w: VueWrapper) {
    await button(w, 'R2 確認').trigger('click')
    await flushPromises()
  }

  it('開いた直後は「未確認」— 「無い」と混ぜない', async () => {
    const w = mountPage()
    await flushPromises()

    expect(w.text()).toContain('未確認 — 「R2 確認」をクリック')
    expect(w.text()).not.toContain('✗ なし')
  })

  it('確認中は「確認中...」— 「無い」でも「あり」でもない', async () => {
    let release: (r: Response) => void = () => {}
    stubFetch(() => new Promise<Response>((resolve) => { release = resolve }))
    const w = mountPage()
    await flushPromises()
    await button(w, 'R2 確認').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('確認中...')
    expect(w.text()).not.toContain('未確認')
    // 押しっぱなしで二重に走らせない。
    expect((button(w, 'R2 確認').element as HTMLButtonElement).disabled).toBe(true)

    release(json(200, { exists: false, key: 'templates/x.xlsx' }))
    await flushPromises()
    expect(w.text()).toContain('✗ なし')
  })

  it('あれば大きさと更新日時を出す', async () => {
    stubFetch(() => json(200, {
      exists: true,
      key: 'templates/kyoto-soft/base.xlsx',
      size: 20480,
      uploaded: '2026-07-01T00:00:00.000Z',
      etag: 'abc',
    }))
    const w = mountPage()
    await flushPromises()
    await check(w)

    expect(w.text()).toContain('✓ あり (20.0 KB')
    expect(w.text()).not.toContain('確認中')
  })

  it('無ければ「先に upload してください」まで出す (次の一手を書く)', async () => {
    const w = mountPage()
    await flushPromises()
    await check(w)

    expect(w.text()).toContain('✗ なし — 下の「テンプレ xlsx を R2 に保存」から先に upload してください')
  })

  it('★ 通信そのものが失敗したら理由を出す (「無い」に倒さない)', async () => {
    stubFetch(() => { throw new Error('Failed to fetch') })
    const w = mountPage()
    await flushPromises()
    await check(w)

    expect(w.text()).toContain('✗ 確認エラー: Failed to fetch')
    expect(w.text()).not.toContain('✗ なし')
  })

  it('Error 以外が投げられても黙らない', async () => {
    stubFetch(() => { throw 'boom' })
    const w = mountPage()
    await flushPromises()
    await check(w)

    expect(w.text()).toContain('✗ 確認エラー: チェックに失敗しました')
  })

  it('空白だけの Key は確認しに行かず「未確認」に戻す', async () => {
    const w = mountPage()
    await flushPromises()
    await w.find('input[type="text"]').setValue('   ')
    await flushPromises()
    await check(w)

    expect(calls.filter(c => c.url.startsWith('/api/y-time-template'))).toHaveLength(0)
    expect(w.text()).toContain('未確認 — 「R2 確認」をクリック')
  })

  it('★ Key を変えたら前の Key の結果を残さない (別の場所の話に読める)', async () => {
    stubFetch(() => json(200, {
      exists: true, key: 'templates/a.xlsx', size: 1024, uploaded: '2026-07-01T00:00:00.000Z', etag: 'e',
    }))
    const w = mountPage()
    await flushPromises()
    await check(w)
    expect(w.text()).toContain('✓ あり')

    await w.find('input[type="text"]').setValue('templates/b.xlsx')
    await flushPromises()

    expect(w.text()).not.toContain('✓ あり')
    expect(w.text()).toContain('未確認 — 「R2 確認」をクリック')
  })
})

describe('/y-time-export テンプレ保存 (dev 補助)', () => {
  async function pickFile(w: VueWrapper) {
    const input = w.find('input[type="file"]')
    const file = new File([new Uint8Array([1, 2, 3])], 'x.xlsx')
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
    await input.trigger('change')
    await flushPromises()
    return input
  }

  it('ファイル未選択では押せず、押せる状態になるのは選んでから', async () => {
    const w = mountPage()
    await flushPromises()
    expect((button(w, 'R2 に保存').element as HTMLButtonElement).disabled).toBe(true)

    await pickFile(w)
    expect((button(w, 'R2 に保存').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('選び直しを取り消したら (files が空) また押せなくなる', async () => {
    const w = mountPage()
    await flushPromises()
    await pickFile(w)

    const input = w.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [], configurable: true })
    await input.trigger('change')
    await flushPromises()

    expect((button(w, 'R2 に保存').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('保存できたら key と大きさを出す', async () => {
    stubFetch(() => json(200, { key: 'templates/kyoto-soft/base.xlsx', size: 20480 }))
    const w = mountPage()
    await flushPromises()
    await pickFile(w)
    await button(w, 'R2 に保存').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('✓ R2 に保存: templates/kyoto-soft/base.xlsx (20.0 KB)')
    const put = calls.find(c => c.init?.method === 'PUT')
    expect(put?.url).toBe('/api/y-time-template?key=templates%2Fkyoto-soft%2Fbase.xlsx')
  })

  it('保存中は「アップロード中...」で二重送信させない', async () => {
    let release: (r: Response) => void = () => {}
    stubFetch(() => new Promise<Response>((resolve) => { release = resolve }))
    const w = mountPage()
    await flushPromises()
    await pickFile(w)
    await button(w, 'R2 に保存').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('アップロード中...')
    expect(w.findAll('button').some(b => b.text().trim() === 'R2 に保存')).toBe(false)

    release(json(200, { key: 'k', size: 1024 }))
    await flushPromises()
    expect((button(w, 'R2 に保存').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('Error 以外が投げられても黙らない', async () => {
    stubFetch(() => { throw 'boom' })
    const w = mountPage()
    await flushPromises()
    await pickFile(w)
    await button(w, 'R2 に保存').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('✗ アップロードに失敗')
  })
})

describe('/y-time-export 計算プレビュー', () => {
  it('ドライバー / 期間 が埋まるまで押せない', async () => {
    const w = mountPage()
    await flushPromises()
    expect((button(w, '計算プレビュー').element as HTMLButtonElement).disabled).toBe(true)

    await w.find('select').setValue('0001')
    await flushPromises()
    expect((button(w, '計算プレビュー').element as HTMLButtonElement).disabled).toBe(true)

    await w.findAll('input[type="date"]')[0]!.setValue('2026-07-01')
    await flushPromises()
    expect((button(w, '計算プレビュー').element as HTMLButtonElement).disabled).toBe(true)

    await w.findAll('input[type="date"]')[1]!.setValue('2026-07-03')
    await flushPromises()
    expect((button(w, '計算プレビュー').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('計算中は「計算中...」で、まだ前の結果を出さない', async () => {
    let release: (v: YTimeRowsPreview) => void = () => {}
    api.getYTimeRows.mockImplementation(() => new Promise<YTimeRowsPreview>((r) => { release = r }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('計算中...')
    expect(w.text()).not.toContain('計算結果プレビュー')

    release(preview())
    await flushPromises()
    expect(w.text()).toContain('計算結果プレビュー')
  })

  it('★ 勤務が無い日も暦日として出す (行が無い日を消さない)', async () => {
    api.getYTimeRows.mockResolvedValue(preview({
      rows: [row('2026-07-02', { note: '通常' })],
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    const dates = w.findAll('tbody tr').map(tr => tr.findAll('td')[0]!.text())
    expect(dates).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
    // 「1 行 (勤務日) / 3 暦日」— 数え方の違いを画面に言わせる。
    expect(w.text()).toContain('1 行 (勤務日)')
    expect(w.text()).toContain('3 暦日')
  })

  it('勤務が無い日のセルは空 (0:00 と書かない)', async () => {
    api.getYTimeRows.mockResolvedValue(preview({
      rows: [row('2026-07-01')],
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '0001', '2026-07-01', '2026-07-02')
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    const emptyDay = w.findAll('tbody tr')[1]!.findAll('td')
    expect(emptyDay[0]!.text()).toBe('2026-07-02')
    // 備考 / 前日 / 始業 / 終業 / 休憩計 が全部空。
    expect(emptyDay.slice(2).every(td => td.text() === '')).toBe(true)
  })

  it('曜日は日〜土を出し、日曜と土曜だけ色分けの class が付く', async () => {
    api.getYTimeRows.mockResolvedValue(preview({
      rows: [],
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '0001', '2026-07-04', '2026-07-06') // 土 / 日 / 月
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    const trs = w.findAll('tbody tr')
    expect(trs.map(tr => tr.findAll('td')[1]!.text())).toEqual(['土', '日', '月'])
    expect(trs[0]!.classes()).toContain('bg-blue-50')
    expect(trs[1]!.classes()).toContain('bg-red-50')
    expect(trs[2]!.classes()).not.toContain('bg-red-50')
    expect(trs[2]!.classes()).not.toContain('bg-blue-50')
  })

  it('始業/終業/休憩を H:MM で出し、休憩 0 は空欄・休憩計は合計する', async () => {
    api.getYTimeRows.mockResolvedValue(preview({
      rows: [row('2026-07-01', {
        previous_day_start: true,
        note: '深夜跨ぎ',
        start_minutes_of_day: 22 * 60 + 30,
        end_minutes_from_bucket_date: 30 * 60, // 24h 越えも桁を落とさない
        rest_prev_5_22: 15,
        rest_today_5_22: 45,
      })],
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '0001', '2026-07-01', '2026-07-01')
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    const td = w.findAll('tbody tr')[0]!.findAll('td').map(t => t.text())
    expect(td[2]).toBe('深夜跨ぎ')
    expect(td[3]).toBe('1')          // F 列: 前日始業
    expect(td[4]).toBe('22:30')
    expect(td[5]).toBe('30:00')      // 24h 越えを 06:00 に丸めない
    expect(td[6]).toBe('00:15')
    expect(td[7]).toBe('')           // 0 は空欄
    expect(td[13]).toBe('01:00')     // 休憩計 15 + 45
  })

  it('★ 分が null でも [object Object] や NaN を出さず空欄にする (JSON は型を保証しない)', async () => {
    api.getYTimeRows.mockResolvedValue(preview({
      // 応答の形の検査 (`parseYTimeRowsPreview`) は行の中身を見ない (`date` だけ) ので、型が number でも
      // 上流が null を返せばそのまま来る。ガードはそのために書かれている。
      rows: [row('2026-07-01', { start_minutes_of_day: null as unknown as number })],
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '0001', '2026-07-01', '2026-07-01')
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    const td = w.findAll('tbody tr')[0]!.findAll('td').map(t => t.text())
    expect(td[4]).toBe('')
    expect(w.text()).not.toContain('NaN')
  })

  it('負の分は符号を落とさない', async () => {
    api.getYTimeRows.mockResolvedValue(preview({
      rows: [row('2026-07-01', { start_minutes_of_day: -90 })],
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '0001', '2026-07-01', '2026-07-01')
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    expect(w.findAll('tbody tr')[0]!.findAll('td')[4]!.text()).toBe('-01:30')
  })

  it('★ 期間が無効なら「0 行」ではなく「期間が無効です。」と言い切る (開始日が終了日より後)', async () => {
    api.getYTimeRows.mockResolvedValue(preview({ rows: [] }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '0001', '2026-07-03', '2026-07-01')
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('期間が無効です。')
    expect(w.find('tbody').exists()).toBe(false)
  })

  it.each([
    ['開始日', { dateFrom: 'not-a-date', dateTo: '2026-07-03' }],
    ['終了日', { dateFrom: '2026-07-01', dateTo: 'not-a-date' }],
  ])('期間が無効 (保存されていた%sが日付でない) でも同じ (片方だけ見て通さない)', async (_name, dates) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ driverCd: '0001', ...dates }))
    api.getYTimeRows.mockResolvedValue(preview({ rows: [] }))
    const w = mountPage()
    await flushPromises()
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('期間が無効です。')
    expect(w.find('tbody').exists()).toBe(false)
  })

  it('警告があれば別枠で出す (プレビューの表と混ぜない)', async () => {
    api.getYTimeRows.mockResolvedValue(preview({ warnings: ['2026-07-02: 打刻が 1 つ足りません'] }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('⚠ 警告:')
    expect(w.text()).toContain('2026-07-02: 打刻が 1 つ足りません')
  })

  it('★ 失敗したら理由を出し、前の結果を残さない (古い表を新しい結果に読ませない)', async () => {
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('計算結果プレビュー')

    // 本文の無い 503。どの操作が落ちたか・理由が無いこと・次の一手 (この画面に実在するボタン) を言う
    api.getYTimeRows.mockRejectedValue(new ResponseFailure(503, null))
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('プレビュー取得失敗: 503 応答に理由が入っていません — サーバ側の設定か障害です (権限の問題ではありません)。復旧してから「計算プレビュー」を押してください')
    expect(w.text()).not.toContain('計算結果プレビュー')
    // 行の元の表示も残さない
    expect(w.find('[data-testid="y-time-source"]').exists()).toBe(false)
  })

  it('Error 以外が投げられても黙らない', async () => {
    api.getYTimeRows.mockRejectedValue('boom')
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('プレビュー取得失敗: boom')
  })
})

describe('/y-time-export xlsx ダウンロード', () => {
  const clicked: string[] = []

  beforeEach(() => {
    clicked.length = 0
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download)
    })
  })

  afterEach(() => { vi.restoreAllMocks() })

  function xlsx(headers: Record<string, string> = {}) {
    return new Response(new Uint8Array([0x50, 0x4b]), {
      status: 200,
      statusText: '',
      headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ...headers },
    })
  }

  it('ドライバー / 期間 が埋まるまで押せない', async () => {
    const w = mountPage()
    await flushPromises()
    expect((button(w, 'ダウンロード').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('成功したら期間つきのファイル名で保存する', async () => {
    stubFetch(() => xlsx())
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()

    expect(clicked).toEqual(['y_time_0001_2026-07-01_2026-07-03.xlsx'])
    const post = calls.find(c => c.init?.method === 'POST')
    expect(post?.url).toBe('/api/y-time-export')
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      driver_cd: '0001',
      from: '2026-07-01',
      to: '2026-07-03',
      template_key: 'templates/kyoto-soft/base.xlsx',
    })
    expect(w.text()).not.toContain('xlsx 生成失敗')
  })

  it('ログイン中なら Authorization を載せる', async () => {
    stubFetch(() => xlsx())
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()

    const post = calls.find(c => c.init?.method === 'POST')
    expect((post?.init?.headers as Record<string, string>).authorization).toBe('Bearer jwt-token')
  })

  it('トークンが無い回は Authorization を載せない (空の Bearer を送らない)', async () => {
    tokenRef.value = null
    stubFetch(() => xlsx())
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()

    const post = calls.find(c => c.init?.method === 'POST')
    expect((post?.init?.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('生成中は「生成中...」で二重送信させない', async () => {
    let release: (r: Response) => void = () => {}
    stubFetch(() => new Promise<Response>((resolve) => { release = resolve }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('生成中...')
    expect(w.findAll('button').some(b => b.text().trim() === 'ダウンロード')).toBe(false)

    release(xlsx())
    await flushPromises()
    expect((button(w, 'ダウンロード').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('★ 成功しても警告があれば黙って落とさず全部出す', async () => {
    stubFetch(() => xlsx({
      'x-y-time-warnings': encodeURIComponent('2026-07-02: 打刻不足 / 2026-07-03: 重複'),
      'x-y-time-missing-dates': '2026-07-03',
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('2026-07-02: 打刻不足')
    expect(w.text()).toContain('2026-07-03: 重複')
    expect(w.text()).toContain('テンプレに日付が無い: 2026-07-03')
    // 保存自体はできている。
    expect(clicked).toHaveLength(1)
  })

  it('警告ヘッダが無い回は警告枠を出さない', async () => {
    stubFetch(() => xlsx())
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()

    expect(w.text()).not.toContain('⚠ 警告:')
  })

  it('通信そのものが失敗したら理由を出す', async () => {
    stubFetch(() => { throw new Error('Failed to fetch') })
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Failed to fetch')
    expect(clicked).toHaveLength(0)
  })

  it('Error 以外が投げられても黙らない', async () => {
    stubFetch(() => { throw 'boom' })
    const w = mountPage()
    await flushPromises()
    await fillForm(w)
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('ダウンロードに失敗しました')
  })
})

/**
 * `describeApiFailure` の残りの入り口 (Refs #890 のヘルパ)。
 * 「理由が無い」と「理由を読めなかった」を混ぜない、の**残りのケース**を
 * `y-time-export-template-check.test.ts` から漏れていたぶんだけ足す。
 */
describe('/y-time-export 非 2xx 本文の残りの形', () => {
  it('本文が JSON の文字列リテラルなら、それをそのまま理由にする', async () => {
    stubFetch(() => new Response(JSON.stringify('サーバが混んでいます'), {
      status: 503, statusText: '', headers: { 'content-type': 'application/json' },
    }))
    const w = mountPage()
    await flushPromises()
    await button(w, 'R2 確認').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('✗ 確認エラー: 503 サーバが混んでいます')
  })

  it('本文が JSON の null / 数値なら「理由の文字列がありません」と言う', async () => {
    for (const body of ['null', '42']) {
      stubFetch(() => new Response(body, {
        status: 500, statusText: '', headers: { 'content-type': 'application/json' },
      }))
      const w = mountPage()
      await flushPromises()
      await button(w, 'R2 確認').trigger('click')
      await flushPromises()

      expect(w.text()).toContain(`500 (本文に理由の文字列がありません: ${body})`)
      expect(w.text()).not.toContain('[object Object]')
    }
  })

  it('★ 本文の読み取り自体が失敗しても「空でした」に倒す (途中で切れた回)', async () => {
    // 応答ヘッダは来たが本文の受信中に切れた形。`res.text()` が reject する。
    stubFetch(() => ({
      ok: false,
      status: 502,
      statusText: '',
      headers: new Headers(),
      text: () => Promise.reject(new Error('network error while reading body')),
    } as unknown as Response))
    const w = mountPage()
    await flushPromises()
    await button(w, 'R2 確認').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('✗ 確認エラー: 502 (応答本文が空でした)')
  })
})

describe('/y-time-export 行の元 — プレビューとダウンロードが同じ元の行を出す (Refs #1133 c1133-47。値はすべて架空)', () => {
  const sourceBox = (w: VueWrapper) => w.find('[data-testid="y-time-source"]')
  const sourceLines = (w: VueWrapper) => sourceBox(w).findAll('[data-line]').map(l => [l.attributes('data-line'), l.text()])
  /** 勤怠の元の応答。行を作れなかった勤務 3 件 (うち 2 件は畳み直しで直る) と、勤務の記録の無い月 */
  const KINTAI: Partial<YTimeRowsPreview> = {
    source: 'kintai',
    source_reason: null,
    rows: [row('2026-07-01')],
    excluded: [
      { start: '2026-07-02 08:00:00', end: '2026-07-02 17:00:00', reason: 'no_non_working' },
      { start: '2026-07-03 08:00:00', end: '2026-07-03 17:00:00', reason: 'no_non_working' },
      { start: '2026-07-03 22:00:00', end: '2026-07-04 07:00:00', reason: 'overlap' },
    ],
    missing_months: ['2026-08'],
  }

  beforeEach(() => {
    api.getDrivers.mockResolvedValue([driver('9001', '架空 太郎'), driver('9002', '架空 次郎')])
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => { vi.restoreAllMocks() })

  async function previewWith(over: Partial<YTimeRowsPreview>, cd = '9001') {
    api.getYTimeRows.mockResolvedValue(preview(over))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, cd)
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()
    return w
  }

  it('★ プレビューの見出し: 乗務員の名前は画面の一覧から、期間は画面の入力から (応答は名前も期間も持たない)', async () => {
    const w = await previewWith(KINTAI)
    expect(api.getYTimeRows).toHaveBeenCalledWith('9001', '2026-07-01', '2026-07-03')
    const heading = w.find('h3').text()
    expect(heading).toContain('9001 : 架空 太郎')
    expect(heading).toContain('2026-07-01 〜 2026-07-03')
    expect(heading).toContain('1 行 (勤務日)')
    expect(heading).toContain('3 暦日')
  })

  it('★ プレビューを取った後に入力を変えても、見出しと暦日は取ったときの人・期間のまま (別の人の表に見せない)', async () => {
    const w = await previewWith(KINTAI)
    await fillForm(w, '9002', '2026-07-10', '2026-07-12')
    const heading = w.find('h3').text()
    expect(heading).toContain('9001 : 架空 太郎')
    expect(heading).toContain('2026-07-01 〜 2026-07-03')
    expect(w.findAll('tbody tr').map(tr => tr.findAll('td')[0]!.text())).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  it('★ 勤怠の元のプレビュー: 元・行を作れなかった勤務 (理由ごとの件数)・畳み直しの案内・勤務の記録の無い月を出す', async () => {
    const w = await previewWith(KINTAI)
    expect(sourceBox(w).text()).toContain('プレビューの行の元')
    expect(sourceLines(w)).toEqual([
      ['source', '勤怠の記録から作成'],
      ['excluded', '行を作れなかった勤務 3 件 (まだ畳み直していない 2 件・別の勤務と時間が重なる 1 件) — 始業の日付: 2026-07-02 (まだ畳み直していない), 2026-07-03 (まだ畳み直していない), 2026-07-03 (別の勤務と時間が重なる)'],
      ['refold', '勤怠の畳み直しが要ります (まだ畳み直していない勤務 2 件)'],
      ['missingMonths', '勤務の記録が無い月: 2026-08'],
    ])
  })

  it.each([
    ['not_configured', '運行から作成 (この環境は勤怠の設定が無い)'],
    ['out_of_scope', '運行から作成 (この会社は勤怠の記録が無い)'],
  ] as const)('★ 運行の元へ倒したプレビュー (%s): 倒した理由つきで「運行から作成」と言う', async (reason, text) => {
    const w = await previewWith({ source: 'alc', source_reason: reason })
    expect(sourceLines(w)).toEqual([['source', text]])
  })

  it('★ 行が 0 件のプレビュー: 何の 0 件かを元で言い分ける (行を作れなかった勤務が在れば「勤務が 0 件」と言わない)', async () => {
    const excludedOnly = await previewWith({ ...KINTAI, rows: [] })
    expect(sourceBox(excludedOnly).text()).toContain('行を作れた勤務が 0 件 (行を作れなかった勤務 3 件)')
    excludedOnly.unmount()

    const none = await previewWith({ ...KINTAI, rows: [], excluded: [] })
    expect(sourceBox(none).text()).toContain('この期間に勤務が 0 件')
    expect(sourceBox(none).text()).not.toContain('運行が 0 件')
    none.unmount()

    const alc = await previewWith({ source: 'alc', source_reason: 'out_of_scope', rows: [] })
    expect(sourceBox(alc).text()).toContain('この期間に運行が 0 件 (alc に取り込まれていない可能性)')
  })

  it('★ ダウンロードの後: 応答ヘッダから同じ行を出す (プレビューと同じ文)。行が 0 件ならそれも言う', async () => {
    stubFetch(() => new Response(new Uint8Array([0x50, 0x4b]), {
      status: 200,
      headers: {
        'x-y-time-rows': '1',
        'x-y-time-source': 'kintai',
        'x-y-time-excluded-reasons': 'no_non_working=2,overlap=1',
        'x-y-time-excluded': '2026-07-02:no_non_working,2026-07-03:no_non_working,2026-07-03:overlap',
        'x-y-time-missing-months': '2026-08',
      },
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '9001')
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()
    expect(sourceBox(w).text()).toContain('ダウンロードした Excel の行の元')
    const downloaded = sourceLines(w)
    w.unmount()

    // 同じ内容のプレビューと、出る行が 1 文字も違わない
    const p = await previewWith(KINTAI)
    expect(downloaded).toEqual(sourceLines(p))
    p.unmount()

    stubFetch(() => new Response(new Uint8Array([0x50, 0x4b]), {
      status: 200,
      headers: { 'x-y-time-rows': '0', 'x-y-time-source': 'alc', 'x-y-time-source-reason': 'out_of_scope' },
    }))
    const empty = mountPage()
    await flushPromises()
    await fillForm(empty, '9001')
    await button(empty, 'ダウンロード').trigger('click')
    await flushPromises()
    expect(sourceLines(empty)).toEqual([['source', '運行から作成 (この会社は勤怠の記録が無い)']])
    expect(sourceBox(empty).text()).toContain('この期間に運行が 0 件 (alc に取り込まれていない可能性)')
  })

  it('元を返さない応答 (ヘッダなし) のダウンロードは、元を言わない (運行の元に見せない)', async () => {
    stubFetch(() => new Response(new Uint8Array([0x50, 0x4b]), { status: 200 }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '9001')
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()
    expect(sourceBox(w).exists()).toBe(false)
  })

  it('★ 失敗の文 (プレビュー): 勤怠の経路の失敗は util の 1 文を出す。運行の経路の 404 (印つき) だけ「alc に登録が無い」と言う', async () => {
    api.getYTimeRows.mockRejectedValue(new ResponseFailure(502, {
      error: true, statusCode: 502, statusMessage: 'kintai y-time rows failed (relay)',
      message: '勤怠の勤務の記録を読めませんでした (relay 502: 読めない月が在る)',
      data: { source: 'kintai', stage: 'relay', status: 502 },
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '9001')
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('プレビュー取得失敗: 502 勤怠の勤務の記録を読めませんでした (relay 502: 読めない月が在る) — サーバ側の設定か障害です')
    expect(sourceBox(w).exists()).toBe(false)

    api.getYTimeRows.mockRejectedValue(new ResponseFailure(404, { error: true, statusCode: 404, statusMessage: 'backend error: driver_cd not found', data: { upstream: 'alc' } }))
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('プレビュー取得失敗: この乗務員CD は alc に登録が無い')

    // 印の無い 404 (勤怠の経路) は「登録が無い」と言わない
    api.getYTimeRows.mockRejectedValue(new ResponseFailure(404, { error: true, message: '勤務の記録から Y時間 の行を作れませんでした (上流 404: no route)', data: { source: 'kintai', stage: 'upstream', status: 404 } }))
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()
    expect(w.text()).not.toContain('alc に登録が無い')
    expect(w.text()).toContain('勤務の記録から Y時間 の行を作れませんでした (上流 404: no route)')
  })

  it('★ 失敗の文 (ダウンロード): 同じ言い分け。テンプレが無い 404 は「登録が無い」と言わない。失敗したら行の元を残さない', async () => {
    const w = await previewWith(KINTAI)
    expect(sourceBox(w).exists()).toBe(true)

    stubFetch(() => json(404, { error: true, statusCode: 404, statusMessage: 'backend error: driver_cd not found', data: { upstream: 'alc' } }))
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('xlsx 生成失敗: この乗務員CD は alc に登録が無い')
    expect(sourceBox(w).exists()).toBe(false)

    stubFetch(() => json(404, { error: true, statusCode: 404, statusMessage: 'template not found in R2: templates/x.xlsx', message: 'template not found in R2: templates/x.xlsx' }))
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()
    expect(w.text()).not.toContain('alc に登録が無い')
    expect(w.text()).toContain('xlsx 生成失敗: 404 template not found in R2: templates/x.xlsx')

    stubFetch(() => json(502, {
      error: true, statusCode: 502, message: '勤怠の勤務の記録を読めませんでした (relay 502: 読めない月が在る)',
      data: { source: 'kintai', stage: 'relay', status: 502 },
    }))
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('xlsx 生成失敗: 502 勤怠の勤務の記録を読めませんでした (relay 502: 読めない月が在る)')
  })

  it('★ 400 日を超える期間 (勤怠の元): relay の理由「400 日以内に」が読め、次の一手は「送った内容を直す」(プレビューもダウンロードも)', async () => {
    const TOO_LONG = {
      error: true, statusCode: 400, statusMessage: 'kintai y-time rows failed (relay)',
      message: '勤怠の勤務の記録を読めませんでした (relay 400: from〜to は 400 日以内にしてください: 2026-01-01..2027-03-31)',
      data: { source: 'kintai', stage: 'relay', status: 400, error: 'from〜to は 400 日以内にしてください: 2026-01-01..2027-03-31' },
    }
    api.getYTimeRows.mockRejectedValue(new ResponseFailure(400, TOO_LONG))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '9001', '2026-01-01', '2027-03-31')
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()
    expect(w.text()).toContain(
      'プレビュー取得失敗: 400 勤怠の勤務の記録を読めませんでした (relay 400: from〜to は 400 日以内にしてください: 2026-01-01..2027-03-31)'
      + ' — 送った内容をサーバが受け付けませんでした。上の理由のとおりに直してから「計算プレビュー」を押してください',
    )
    expect(w.text()).not.toContain('サーバ側の設定か障害です')

    stubFetch(() => json(400, TOO_LONG))
    await button(w, 'ダウンロード').trigger('click')
    await flushPromises()
    expect(w.text()).toContain(
      'xlsx 生成失敗: 400 勤怠の勤務の記録を読めませんでした (relay 400: from〜to は 400 日以内にしてください: 2026-01-01..2027-03-31)'
      + ' — 送った内容をサーバが受け付けませんでした。上の理由のとおりに直してから「ダウンロード」を押してください',
    )
  })

  it('説明文は元を言う (勤怠の勤務の記録から。倒したときだけ運行)', async () => {
    const w = mountPage()
    await flushPromises()
    const lead = w.find('p').text()
    expect(lead).toContain('勤怠の勤務の記録')
    expect(lead).toContain('勤怠の記録が無い会社・勤怠の設定が無い環境では、運行 (デジタコ) から作ります')
    expect(lead).not.toContain('KUDGIVT')
  })
})

describe('/y-time-export 暦日の書式 (2 桁の月日)', () => {
  it('10 月 10 日以降も 0 詰めで壊れない', async () => {
    api.getYTimeRows.mockResolvedValue(preview({
      rows: [],
    }))
    const w = mountPage()
    await flushPromises()
    await fillForm(w, '0001', '2026-10-10', '2026-10-12')
    await button(w, '計算プレビュー').trigger('click')
    await flushPromises()

    expect(w.findAll('tbody tr').map(tr => tr.findAll('td')[0]!.text()))
      .toEqual(['2026-10-10', '2026-10-11', '2026-10-12'])
  })
})

describe('/y-time-export リロード後の file input 救済', () => {
  /**
   * ブラウザが `<input type="file">` の選択状態を保持したまま再描画すると
   * `@change` が発火しない。`onMounted` がその状態を ref に同期する
   * (画面のコメント: 「HMR / リロード後に @change が発火しないケースの救済」)。
   * happy-dom は状態保持を再現しないので、**prototype の `files` を一時的に
   * 差し替えて**「もう選ばれている状態で開いた」を作る。
   */
  it('選択済みのまま開いたら、@change なしでも「R2 に保存」が押せる', async () => {
    const proto = globalThis.HTMLInputElement.prototype
    const original = Object.getOwnPropertyDescriptor(proto, 'files')
    const file = new File([new Uint8Array([1, 2, 3])], 'restored.xlsx')
    Object.defineProperty(proto, 'files', { configurable: true, get: () => [file] })
    try {
      const w = mountPage()
      await flushPromises()

      expect((button(w, 'R2 に保存').element as HTMLButtonElement).disabled).toBe(false)
    }
    finally {
      if (original) Object.defineProperty(proto, 'files', original)
      else Reflect.deleteProperty(proto, 'files')
    }
  })
})
