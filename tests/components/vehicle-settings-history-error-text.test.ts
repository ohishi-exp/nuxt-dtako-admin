/**
 * `/vehicle-settings/history` と `<VehicleSettingsDumpPicker>` が**画面に出す 1 文**
 * (Refs #1005 / #996 / #890)。
 *
 * 直す前の 5 か所は `throw new Error(\`HTTP ${res.status}: ${res.statusText}\`)` で、
 * **本文を一度も読んでいなかった**。`res.statusText` は reason phrase なので
 * **本番 (workerd) では空** — 画面に出ていたのは実測でこれだけだった:
 *
 * ```
 * HTTP 503:      ← 理由が 1 文字も無い
 * ```
 *
 * (dev の node は reason phrase を埋めるので**この症状は dev では再現しない**。
 * だからこのファイルは `statusText: ''` を**本番の形として明示的に**使う。)
 *
 * ここで固定するのは**ページの接頭辞まで込みの合成後の 1 文**で、
 *
 *  - 理由が本文から出ていること (`describeApiError` の拾い順は `api-error.ts` が正)
 *  - **何をすればいいか**が書いてあること (401 → 再ログイン / 5xx → 復旧待ち)
 *  - **その画面に実在するボタンの表記**で書いていること
 *  - **5 か所を同じ文にしない**こと (下表)
 *
 * | # | 呼ぶ場所 | route | 実際に来る status | やり直し方 |
 * | --- | --- | --- | --- | --- |
 * | A | `history.vue` `loadSummary` | `GET /history` (引数無し) | 401 / 503 | **ボタンが無い** → ページ再読み込み |
 * | B | `history.vue` `loadHistory` | `GET /history?vehicle_cd=` | 401 / **400** / 503 | 「履歴を取得」 |
 * | C | `history.vue` `loadDetail` | `GET /object?key=` | 401 / **404** / 503 | 一覧を取り直して行 |
 * | D | `DumpPicker` `loadHistory` | `GET /history?vehicle_cd=` | 401 / **400** / 503 | **「履歴取得」** (「を」が無い) |
 * | E | `DumpPicker` `selectDump` | `GET /object?key=` | 401 / **404** / 503 | 一覧を取り直して行 |
 *
 * **B と D は同じ route を同じ status で叩くのに文が違う** — ボタンの表記が違うから。
 * **A は同じファイルの B と同じ route なのに文が違う** — 再取得ボタンが無いから。
 * 一括置換にしていないことの根拠が、このファイルの `toBe` に載っている。
 *
 * ## ★ 404 は `nextStepForStatus` の枝を通る (C / E) — Refs #1005 #1021
 *
 * 404 が「その他 4xx」に落ちると**こう出る**:
 *
 * ```
 * dump JSON の取得に失敗しました: 404 object not found: vehicle-settings/… —
 * 送った内容をサーバが受け付けませんでした。上の理由のとおりに直してから
 * 「履歴を取得」で一覧を取り直し、行をクリックし直してください
 * ```
 *
 * **これは事実に反する。行をクリックしただけの人は何も送っておらず、直せるものも無い。**
 * 動線 (一覧の取り直し) が正しく出ることは、前置きが嘘でよい理由にならない。
 *
 * #1005 では**呼び出し側で 404 を撃ち分ける暫定** (`describeMissingDump`) を 2 ファイルに
 * 置いていた。#1021 で `nextStepForStatus` に 404 の枝が入り、**暫定は 2 か所とも消えた**。
 * 変わったのは**理由の半分**だけ — 暫定は本文を読まず `この dump は R2 にもう存在しません`
 * と自分で書いていたが、いまは `describeResponseFailure` が本文の
 * `object not found: <key>` を拾う。**次の一手の側は同じ趣旨**。
 *
 * 下の `it` は**誤った前置き (「送った内容」) が出ていないこと**を陰性対照で押さえている。
 * **この 2 行 (`not.toContain('送った内容')`) が本体**なので、文言を足すときは
 * ここを書き換えて通すのではなく、**文言の方を直すこと**。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('~/utils/api', () => ({
  currentAccessToken: vi.fn(() => 'dummy-token'),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

import HistoryPage from '~/pages/vehicle-settings/history.vue'
import DumpPicker from '~/components/VehicleSettingsDumpPicker.vue'

const realFetch = globalThis.fetch

/** **本番と同じ形**の応答 — reason phrase 無し。`res.statusText` に落ちる実装なら
 * 区切り文字の後ろが空になってここで落ちる。 */
function respond(status: number, body: string) {
  globalThis.fetch = (async () => new Response(body, {
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

/** Nitro が自前の `server/api/*` のエラーで返す本文の形。**`error` は真偽値**。 */
function nitroBody(statusCode: number, msg: string): string {
  return JSON.stringify({
    error: true,
    url: '/api/vehicle-settings/history',
    statusCode,
    statusMessage: msg,
    message: msg,
  })
}

/** `requireAuth` (`@ippoan/auth-client/src/server/auth.mjs`) が実際に投げる本文。
 * `statusMessage` は `'Unauthorized'` 固定 — **日本語の理由は最初から無い**。 */
const UNAUTHORIZED_BODY = nitroBody(401, 'Unauthorized')

/** この画面には赤枠が最大 3 つ出る (集計 / 履歴 / 詳細)。**接頭辞で選ぶ。** */
function errorTextStartingWith(w: ReturnType<typeof mount>, prefix: string): string {
  const box = w.findAll('div')
    .filter(d => d.classes().includes('bg-red-50'))
    .map(d => d.text())
    .find(t => t.startsWith(prefix))
  expect(box, `「${prefix}」で始まる赤枠が出ていない`).toBeDefined()
  return box!
}

const HISTORY_LIST = JSON.stringify([
  {
    key: 'vehicle-settings/4437/20260514_093253-0-0-4437.json',
    vehicle_cd: '4437',
    dump_dir: '20260514_093253-0-0-4437',
    uploaded_at: '2026-05-14T00:32:53Z',
    size: 1234,
    machine_id: null,
    firm_main_app: null,
  },
  {
    key: 'vehicle-settings/4437/20260401_101010-0-0-4437.json',
    vehicle_cd: '4437',
    dump_dir: '20260401_101010-0-0-4437',
    uploaded_at: '2026-04-01T01:10:10Z',
    size: 1234,
    machine_id: null,
    firm_main_app: null,
  },
])

/** 一覧だけ 200 で返す (詳細を叩く前段)。**2 件返す** — 1 件だと picker が自動選択する。 */
function respondList() {
  globalThis.fetch = (async () => new Response(HISTORY_LIST, {
    status: 200,
    statusText: '',
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

describe('A. /vehicle-settings/history の「登録済み車輛一覧」(再取得ボタンが無い) — Refs #1005', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  async function mountWith(status: number, body: string) {
    respond(status, body)
    const w = mount(HistoryPage, {
      global: { stubs: { NuxtLink: true, VehicleSettingsDisplay: true } },
    })
    await flushPromises()
    return w
  }

  const P = '登録済み車輛一覧の取得に失敗しました: '

  /** この口の 503 は `R2 binding (DTAKO_R2) not available` (英語)。
   * **理由が英語でも「次に何をすればいいか」は日本語で出る**。 */
  it('503 (R2 binding 無し) — 設定・障害だと書き、権限の話にしない', async () => {
    const t = errorTextStartingWith(
      await mountWith(503, nitroBody(503, 'R2 binding (DTAKO_R2) not available')), P,
    )
    expect(t).toBe(
      P + '503 R2 binding (DTAKO_R2) not available — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してからページを再読み込みしてください',
    )
    expect(t).not.toContain('再ログイン')
  })

  it('401 — 再ログインを案内する', async () => {
    const t = errorTextStartingWith(await mountWith(401, UNAUTHORIZED_BODY), P)
    expect(t).toBe(
      P + '401 Unauthorized — ログインが切れています。'
      + '再ログインしてからページを再読み込みしてください'
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)',
    )
  })

  /** ★ **無いボタンの名前で案内しない** — `loadSummary` は `onMounted` からしか
   * 呼ばれず、この画面に集計の再取得ボタンは 1 つも無い。 */
  it('画面に無いボタンの名前を出さない (陰性対照)', async () => {
    const t = errorTextStartingWith(await mountWith(503, nitroBody(503, 'x')), P)
    expect(t).not.toContain('履歴を取得')
    expect(t).not.toContain('再取得')
    expect(t).toContain('ページを再読み込み')
  })

  /** ★ **陰性対照** — 直す前はここが `HTTP 503:` (理由が空) だった。 */
  it('本文の JSON を貼らず、区切り文字の後ろも空にならない (陰性対照)', async () => {
    const t = errorTextStartingWith(await mountWith(503, nitroBody(503, 'x')), P)
    expect(t).not.toContain('"error":true')
    expect(t).not.toContain('statusCode')
    expect(t).not.toMatch(/HTTP \d{3}:/)
    expect(t.endsWith(':')).toBe(false)
  })
})

describe('B. /vehicle-settings/history の履歴取得 (ボタン = 「履歴を取得」) — Refs #1005', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  /** 集計 (onMounted) を先に済ませてから、履歴だけを失敗させる。 */
  async function searchWith(status: number, body: string, cd = '4437') {
    respondList()
    const w = mount(HistoryPage, {
      global: { stubs: { NuxtLink: true, VehicleSettingsDisplay: true } },
    })
    await flushPromises()
    respond(status, body)
    await w.find('#vehicle-cd').setValue(cd)
    // ★ **やり直し方に書くボタンが実在すること**をここで確かめる (表記そのまま)。
    const btn = w.findAll('button').find(b => b.text() === '履歴を取得')
    expect(btn, '「履歴を取得」ボタンが見つからない').toBeDefined()
    await w.find('form').trigger('submit')
    await flushPromises()
    return w
  }

  const P = '履歴の取得に失敗しました: '

  /** ★ **この口だけ 400 が実際に来る** (`history.vue` の集計側には来ない)。
   * `vehicle_cd` は自由入力なので、記号や空白を入れると `history.get.ts` の
   * `/^[A-Za-z0-9_\-]+$/` で弾かれる。**入力を直して押し直す動線**になる。 */
  it('400 (vehicle_cd の形) — 送った内容の話にし、「履歴を取得」で案内する', async () => {
    const t = errorTextStartingWith(
      await searchWith(400, nitroBody(400, 'vehicle_cd は英数 / _ / - のみ'), '4437 A'), P,
    )
    expect(t).toBe(
      P + '400 vehicle_cd は英数 / _ / - のみ — '
      + '送った内容をサーバが受け付けませんでした。'
      + '上の理由のとおりに直してからもう一度「履歴を取得」を押してください',
    )
    expect(t).not.toContain('再ログイン')
  })

  it('401 — 再ログインと「履歴を取得」を案内する', async () => {
    expect(errorTextStartingWith(await searchWith(401, UNAUTHORIZED_BODY), P)).toBe(
      P + '401 Unauthorized — ログインが切れています。'
      + '再ログインしてからもう一度「履歴を取得」を押してください'
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)',
    )
  })

  it('503 — 設定・障害だと書く', async () => {
    expect(errorTextStartingWith(
      await searchWith(503, nitroBody(503, 'INTERNAL_SHARED_SECRET binding が未設定です')), P,
    )).toBe(
      P + '503 INTERNAL_SHARED_SECRET binding が未設定です — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してからもう一度「履歴を取得」を押してください',
    )
  })

  /** ★ **同じ画面・同じ route・同じ status なのに別の文**。集計側には再取得ボタンが
   * 無いので「次の一手」が違う。**2 つの赤枠を同時に出して突き合わせる。** */
  it('A (集計) と同じ画面・同じ 503 でも「次の一手」が違う', async () => {
    // 集計 (onMounted) も履歴も 503 にして、赤枠を 2 つ同時に出す。
    respond(503, nitroBody(503, 'R2 binding (DTAKO_R2) not available'))
    const w = mount(HistoryPage, {
      global: { stubs: { NuxtLink: true, VehicleSettingsDisplay: true } },
    })
    await flushPromises()
    await w.find('#vehicle-cd').setValue('4437')
    await w.find('form').trigger('submit')
    await flushPromises()
    const summary = errorTextStartingWith(w, '登録済み車輛一覧の取得に失敗しました: ')
    const history = errorTextStartingWith(w, P)
    // 理由は同一 (同じ route の同じ 503)。
    expect(summary.split(' — ')[0]).toBe('登録済み車輛一覧の取得に失敗しました: 503 R2 binding (DTAKO_R2) not available')
    expect(history.split(' — ')[0]).toBe('履歴の取得に失敗しました: 503 R2 binding (DTAKO_R2) not available')
    expect(summary.split(' — ')[1]).not.toBe(history.split(' — ')[1])
    expect(summary).toContain('ページを再読み込み')
    expect(history).toContain('「履歴を取得」')
  })
})

describe('C. /vehicle-settings/history の dump 詳細 (行クリック) — Refs #1005', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  async function clickRowWith(status: number, body: string) {
    respondList()
    const w = mount(HistoryPage, {
      global: { stubs: { NuxtLink: true, VehicleSettingsDisplay: true } },
    })
    await flushPromises()
    await w.find('#vehicle-cd').setValue('4437')
    await w.find('form').trigger('submit')
    await flushPromises()
    respond(status, body)
    const rows = w.findAll('tbody tr')
    expect(rows.length, 'dump 一覧の行が出ていない').toBeGreaterThan(0)
    await rows[0]!.trigger('click')
    await flushPromises()
    return w
  }

  const P = 'dump JSON の取得に失敗しました: '
  const KEY = 'vehicle-settings/4437/20260514_093253-0-0-4437.json'

  /** ★ **この口だけ 404 が来る** (`object.get.ts`)。一覧を出した後に R2 から
   * 消えた形なので、**押し直すべきは行ではなく一覧**。
   *
   * **#1021 で理由の半分が変わった** — #1005 の暫定 (`describeMissingDump`) は
   * 本文を読まず `この dump は R2 にもう存在しません` と自分で書いていたが、
   * 恒久策は `describeResponseFailure` を通るので **`object.get.ts` の本文
   * (`object not found: <key>`) が理由になる**。次の一手の側は
   * `nextStepForStatus` の 404 の枝が持つ。 */
  it('404 (一覧の後に R2 から消えた) — 消えた事実と一覧の取り直しを書く', async () => {
    const t = errorTextStartingWith(await clickRowWith(404, nitroBody(404, `object not found: ${KEY}`)), P)
    expect(t).toBe(
      P + `404 object not found: ${KEY} — `
      + '指していた対象がサーバにもう存在しません。'
      + '画面の情報が古くなっているので、'
      + '「履歴を取得」で一覧を取り直し、行をクリックし直してください',
    )
  })

  /** ★ **陰性対照** — `describeResponseFailure` に 404 を通していたら出ていた前置き。
   * **行をクリックしただけの人は何も送っていない**ので、これが出たら嘘。 */
  it('404 — 「送った内容を直せ」を 1 文字も出さない (陰性対照)', async () => {
    const t = errorTextStartingWith(await clickRowWith(404, nitroBody(404, `object not found: ${KEY}`)), P)
    expect(t).not.toContain('送った内容')
    expect(t).not.toContain('直してから')
    expect(t).not.toContain('再ログイン')
    // 正しい動線は残っていること (陽性対照)。
    expect(t).toContain('一覧を取り直し')
  })

  /** 404 を撃ち分けても**他の 4xx は今までどおり**「その他 4xx」の文に落ちる。 */
  it('400 (404 以外の 4xx) — 「送った内容」の文はこちらに残る', async () => {
    const t = errorTextStartingWith(await clickRowWith(400, nitroBody(400, 'key must end with .json')), P)
    expect(t).toBe(
      P + '400 key must end with .json — '
      + '送った内容をサーバが受け付けませんでした。'
      + '上の理由のとおりに直してから「履歴を取得」で一覧を取り直し、行をクリックし直してください',
    )
  })

  it('401 — 再ログインを案内する', async () => {
    expect(errorTextStartingWith(await clickRowWith(401, UNAUTHORIZED_BODY), P)).toBe(
      P + '401 Unauthorized — ログインが切れています。'
      + '再ログインしてから「履歴を取得」で一覧を取り直し、行をクリックし直してください'
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)',
    )
  })

  /** 本文が空でも**区切り文字の後ろが空にならない** (本番は reason phrase が無い)。 */
  it('本文が空の 503 でも「空だった」と言う', async () => {
    expect(errorTextStartingWith(await clickRowWith(503, ''), P)).toBe(
      P + '503 (応答本文が空でした) — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してから「履歴を取得」で一覧を取り直し、行をクリックし直してください',
    )
  })
})

describe('D / E. <VehicleSettingsDumpPicker> (ボタン = 「履歴取得」) — Refs #1005', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  async function searchWith(status: number, body: string) {
    respond(status, body)
    const w = mount(DumpPicker, { props: { label: '左' } })
    await w.find('input[type=text]').setValue('4437')
    const btn = w.findAll('button').find(b => b.text() === '履歴取得')
    expect(btn, '「履歴取得」ボタンが見つからない').toBeDefined()
    await w.find('form').trigger('submit')
    await flushPromises()
    return w
  }

  async function clickRowWith(status: number, body: string) {
    respondList()
    const w = mount(DumpPicker, { props: { label: '左' } })
    await w.find('input[type=text]').setValue('4437')
    await w.find('form').trigger('submit')
    await flushPromises()
    respond(status, body)
    const rows = w.findAll('tbody tr')
    expect(rows.length, 'dump 一覧の行が出ていない').toBeGreaterThan(0)
    await rows[0]!.trigger('click')
    await flushPromises()
    return w
  }

  const PH = '履歴の取得に失敗しました: '
  const PD = 'dump JSON の取得に失敗しました: '
  const KEY = 'vehicle-settings/4437/20260514_093253-0-0-4437.json'

  it('D. 400 (vehicle_cd の形) — 「履歴取得」で案内する', async () => {
    expect(errorTextStartingWith(
      await searchWith(400, nitroBody(400, 'vehicle_cd は英数 / _ / - のみ')), PH,
    )).toBe(
      PH + '400 vehicle_cd は英数 / _ / - のみ — '
      + '送った内容をサーバが受け付けませんでした。'
      + '上の理由のとおりに直してからもう一度「履歴取得」を押してください',
    )
  })

  it('D. 401 — 再ログインと「履歴取得」を案内する', async () => {
    expect(errorTextStartingWith(await searchWith(401, UNAUTHORIZED_BODY), PH)).toBe(
      PH + '401 Unauthorized — ログインが切れています。'
      + '再ログインしてからもう一度「履歴取得」を押してください'
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)',
    )
  })

  it('E. 404 — 消えた事実と一覧の取り直しを書く', async () => {
    const t = errorTextStartingWith(await clickRowWith(404, nitroBody(404, `object not found: ${KEY}`)), PD)
    expect(t).toBe(
      PD + `404 object not found: ${KEY} — `
      + '指していた対象がサーバにもう存在しません。'
      + '画面の情報が古くなっているので、'
      + '「履歴取得」で一覧を取り直し、行をクリックし直してください',
    )
    // 陰性対照 — `describeResponseFailure` に通していたら出ていた前置き。
    expect(t).not.toContain('送った内容')
  })

  /** ★ **C と E は同じ 1 本 (`nextStepForStatus` の 404 の枝) を通るので、文も
   * 一致していなければならない** — 違うのはボタンの表記だけ。
   * #1005 では「暫定処理の写しが 2 つある」ことを固定していたが、#1021 で
   * **写しは消え、共通の枝になった**。片方の画面だけ直したら落ちるのは同じ。 */
  it('C と E の 404 は、ボタンの表記だけが違う', async () => {
    const e = errorTextStartingWith(await clickRowWith(404, nitroBody(404, `object not found: ${KEY}`)), PD)

    respondList()
    const page = mount(HistoryPage, {
      global: { stubs: { NuxtLink: true, VehicleSettingsDisplay: true } },
    })
    await flushPromises()
    await page.find('#vehicle-cd').setValue('4437')
    await page.find('form').trigger('submit')
    await flushPromises()
    respond(404, nitroBody(404, `object not found: ${KEY}`))
    await page.findAll('tbody tr')[0]!.trigger('click')
    await flushPromises()
    const c = errorTextStartingWith(page, PD)

    expect(c.replace('「履歴を取得」', '')).toBe(e.replace('「履歴取得」', ''))
    expect(c).toContain('「履歴を取得」')
    expect(e).toContain('「履歴取得」')
    expect(e).not.toContain('「履歴を取得」')
  })

  it('E. 503 — 設定・障害だと書く', async () => {
    expect(errorTextStartingWith(
      await clickRowWith(503, nitroBody(503, 'R2 binding (DTAKO_R2) not available')), PD,
    )).toBe(
      PD + '503 R2 binding (DTAKO_R2) not available — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してから「履歴取得」で一覧を取り直し、行をクリックし直してください',
    )
  })

  /**
   * ★ **一括置換にしなかったことの陰性対照。**
   *
   * B (`history.vue`) と D (picker) は**同じ route を同じ 400 で叩く**が、
   * 押すボタンの表記が違う (`履歴を取得` / `履歴取得`)。**理由の側は一致し、
   * やり直し方だけが違う**ことをここで固定する。片方の文言をもう片方へ
   * コピーすると落ちる。
   */
  it('B と D は理由が同じで「次の一手」だけ違う', async () => {
    const body = nitroBody(400, 'vehicle_cd は英数 / _ / - のみ')

    respondList()
    const page = mount(HistoryPage, {
      global: { stubs: { NuxtLink: true, VehicleSettingsDisplay: true } },
    })
    await flushPromises()
    respond(400, body)
    await page.find('#vehicle-cd').setValue('4437 A')
    await page.find('form').trigger('submit')
    await flushPromises()
    const b = errorTextStartingWith(page, PH)

    const d = errorTextStartingWith(await searchWith(400, body), PH)

    expect(b.split(' — ')[0]).toBe(d.split(' — ')[0])
    expect(b.split(' — ')[1]).not.toBe(d.split(' — ')[1])
    expect(b).toContain('「履歴を取得」')
    expect(b).not.toContain('「履歴取得」')
    expect(d).toContain('「履歴取得」')
    expect(d).not.toContain('「履歴を取得」')
  })
})
