/**
 * `/vehicle-settings` と `/vehicle-settings/unconfirmed` が**画面に出す 1 文** (Refs #996)。
 *
 * 直す前はどちらも応答本文をそのまま貼っていた:
 *
 * ```
 * 抽出失敗 (401): {"error":true,"statusCode":401,"statusMessage":"Unauthorized",…}
 * HTTP 503: {"error":true,…}
 * ```
 *
 * **ヘルパの戻り値だけ見ても、画面に何が出るかは決まらない。**ここで固定するのは
 * ページの接頭辞まで込みの**合成後の 1 文**で、
 *
 *  - 本文の JSON が 1 文字も出ないこと (**陰性対照**)
 *  - **何をすればいいか**が書いてあること (401 → 再ログイン、5xx → 復旧待ち)
 *  - **その画面に実在するボタンの表記**でやり直し方を書いていること
 *    (`設定を抽出` / `再取得` — 画面に無い語で案内すると探させる)
 *
 * `statusText: ''` は**本番の形**をそのまま使う (dev の HTTP/1.1 とは別物で、
 * 本番 h3 は reason phrase を持たない)。`res.statusText` に落ちる実装なら
 * ここで区切り文字の後ろが空になって落ちる。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('~/utils/api', () => ({
  currentAccessToken: vi.fn(() => 'dummy-token'),
}))

import ExtractPage from '~/pages/vehicle-settings/index.vue'
import UnconfirmedPage from '~/pages/vehicle-settings/unconfirmed.vue'

const realFetch = globalThis.fetch

/** 本番と同じ形の応答 (reason phrase 無し)。 */
function respond(status: number, body: string) {
  globalThis.fetch = (async () => new Response(body, {
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

/** `requireAuth` (`@ippoan/auth-client/src/server/auth.mjs`) が実際に投げる本文。
 * `statusMessage` は `'Unauthorized'` 固定 — **日本語の理由は最初から無い**ので、
 * 本文を正しく読むだけでは「何をすればいいか」は 1 文字も出ない。 */
const UNAUTHORIZED_BODY = JSON.stringify({
  error: true,
  url: '/api/vehicle-settings/extract',
  statusCode: 401,
  statusMessage: 'Unauthorized',
  message: 'Unauthorized',
})

/** エラー枠 (`bg-red-50`) の文字列。 */
function errorText(w: ReturnType<typeof mount>): string {
  const box = w.findAll('div').find(d => d.classes().includes('bg-red-50'))
  expect(box, 'エラー枠 (bg-red-50) が出ていない').toBeDefined()
  return box!.text()
}

describe('/vehicle-settings の抽出失敗の 1 文 (Refs #996)', () => {
  afterEach(() => { globalThis.fetch = realFetch })

  /** zip を選ばないと `submit` が走らないので、ドロップで `file` を入れる。 */
  async function submitWith(status: number, body: string) {
    const w = mount(ExtractPage, {
      global: { stubs: { NuxtLink: true, VehicleSettingsDisplay: true } },
    })
    respond(status, body)
    const drop = w.findAll('div').find(d => d.classes().includes('border-dashed'))
    expect(drop, 'ドロップ領域が見つからない').toBeDefined()
    await drop!.trigger('drop', {
      dataTransfer: { files: [new File(['zip'], 'dump.zip', { type: 'application/zip' })] },
    })
    const btn = w.findAll('button').find(b => b.text() === '設定を抽出')
    expect(btn, '「設定を抽出」ボタンが見つからない').toBeDefined()
    await btn!.trigger('click')
    await flushPromises()
    return w
  }

  it('401 — 本文の JSON を貼らず、再ログインを案内する', async () => {
    const w = await submitWith(401, UNAUTHORIZED_BODY)
    expect(errorText(w)).toBe(
      '抽出失敗: 401 Unauthorized — ログインが切れています。'
      + '再ログインしてからもう一度「設定を抽出」を押してください'
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)',
    )
  })

  /** **陰性対照** — 直す前の画面はここが `{"error":true,…}` 丸ごとだった。 */
  it('401 — 応答本文の JSON が 1 文字も出ない (陰性対照)', async () => {
    const w = await submitWith(401, UNAUTHORIZED_BODY)
    const t = errorText(w)
    expect(t).not.toContain('"error":true')
    expect(t).not.toContain('statusCode')
    expect(t).not.toContain('/api/vehicle-settings/extract')
  })

  /** 503 は**設定・障害**の話。**権限の話にしない** (`kyuyo-access.ts` と同じ判断)。 */
  it('503 — 設定・障害だと書き、権限の話にしない', async () => {
    const w = await submitWith(503, JSON.stringify({
      error: true,
      statusCode: 503,
      statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です',
      message: 'INTERNAL_SHARED_SECRET binding が未設定です',
    }))
    const t = errorText(w)
    expect(t).toBe(
      '抽出失敗: 503 INTERNAL_SHARED_SECRET binding が未設定です — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してからもう一度「設定を抽出」を押してください',
    )
    expect(t).not.toContain('再ログイン')
  })

  /** 400 (`cfg extract failed`) は**送った zip の話**。ログインの話にしない。 */
  it('400 — 送った内容の話にする', async () => {
    const w = await submitWith(400, JSON.stringify({
      error: true,
      statusCode: 400,
      message: 'cfg extract failed: no .cfg in archive',
    }))
    const t = errorText(w)
    expect(t).toBe(
      '抽出失敗: 400 cfg extract failed: no .cfg in archive — '
      + '送った内容をサーバが受け付けませんでした。'
      + '上の理由のとおりに直してからもう一度「設定を抽出」を押してください',
    )
    expect(t).not.toContain('再ログイン')
  })

  /** 413 は 5MB 上限 (`MAX_BYTES`)。ファイルの大きさの話にする。 */
  it('413 — ファイルの大きさの話にする', async () => {
    const w = await submitWith(413, JSON.stringify({
      error: true,
      statusCode: 413,
      message: 'zip が大きすぎます (6000000 bytes, max 5242880)',
    }))
    expect(errorText(w)).toBe(
      '抽出失敗: 413 zip が大きすぎます (6000000 bytes, max 5242880) — '
      + '送ったファイルがサーバの上限を超えています。'
      + '小さいファイルにしてからもう一度「設定を抽出」を押してください',
    )
  })

  /** 本文が空でも**区切り文字の後ろが空にならない** (本番は reason phrase が無い)。 */
  it('本文が空の 500 でも「空だった」と言う', async () => {
    const w = await submitWith(500, '')
    expect(errorText(w)).toBe(
      '抽出失敗: 500 (応答本文が空でした) — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してからもう一度「設定を抽出」を押してください',
    )
  })
})

describe('/vehicle-settings/unconfirmed の取得失敗の 1 文 (Refs #996)', () => {
  beforeEach(() => { globalThis.fetch = realFetch })
  afterEach(() => { globalThis.fetch = realFetch })

  async function loadWith(status: number, body: string) {
    respond(status, body)
    const w = mount(UnconfirmedPage, { global: { stubs: { NuxtLink: true } } })
    await flushPromises()
    return w
  }

  /** この口の 503 は `R2 binding (DTAKO_R2) not available` (英語)。
   * **理由が英語でも「次に何をすればいいか」は日本語で出る**のが要点。 */
  it('503 (R2 binding 無し) — 設定・障害だと書く', async () => {
    const w = await loadWith(503, JSON.stringify({
      error: true,
      statusCode: 503,
      statusMessage: 'R2 binding (DTAKO_R2) not available',
      message: 'R2 binding (DTAKO_R2) not available',
    }))
    const t = errorText(w)
    expect(t).toBe(
      '未確認車輛の取得に失敗しました: 503 R2 binding (DTAKO_R2) not available — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してから「再取得」を押してください',
    )
    expect(t).not.toContain('再ログイン')
  })

  /** upstream の status をそのまま中継するので 401 も来る (兄弟 PR で `requireAuth`
   * が付けば自前の口からも来る)。**やり直し方はこの画面のボタン**で書く。 */
  it('401 — 再ログインと「再取得」を案内する', async () => {
    const w = await loadWith(401, UNAUTHORIZED_BODY)
    const t = errorText(w)
    expect(t).toBe(
      '未確認車輛の取得に失敗しました: 401 Unauthorized — ログインが切れています。'
      + '再ログインしてから「再取得」を押してください'
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)',
    )
    expect(t).not.toContain('"error":true')
  })

  /**
   * ★ **この口の 401 は出どころが 2 つある** (#p760-c988-3 の実測 + 実読で確認)。
   *
   * | 出どころ | 経路 | `statusMessage` |
   * | --- | --- | --- |
   * | **上流** | `alcProxyFetch` → auth-worker `/alc-proxy` が fail-closed で 401 | `backend /api/dtako/vehicles エラー: {"error":"Unauthorized"}` |
   * | **自前** | `unconfirmed.get.ts` の `requireAuth` (#p760-c988-3 が追加予定) | `Unauthorized` |
   *
   * 上流の本文は auth-worker の `jsonError(401, "Unauthorized")` = `{"error":"Unauthorized"}`
   * (`ohishi-exp/auth-worker` の `src/handlers/alc-proxy.ts:81-86` / `:139,145,155,158`。
   * clone は `dd220b2` 時点)。`unconfirmed.get.ts` はそれを
   * `backend /api/dtako/vehicles エラー: ${text}` に包んで投げ直す。
   *
   * **理由の文字列は別物になるが、次の一手は同じでなければならない** — 人がすべきこと
   * (再ログイン) は出どころに依らないのに、片方だけ案内が出ないと
   * 「同じ 401 なのに画面が違う」になる。**ここで両方を固定する。**
   *
   * ★ なお**上流由来の側は、理由の中に `{"error":"Unauthorized"}` が残る**。これを
   * 貼っているのは**画面ではなく server route** (`unconfirmed.get.ts` の
   * `text || vehiclesRes.statusText`) なので、**この PR の担当範囲では消せない**
   * (`server/api/vehicle-settings/**` は兄弟タスクの持ち物)。**次の一手が出ること**は
   * 下で固定してあるので、残った JSON 片は別 PR の課題として報告済み。
   */
  it('401 は出どころが 2 つあっても同じ「次の一手」を出す', async () => {
    // ① 上流 (auth-worker /alc-proxy) 由来 — route が包み直した形
    const upstream = errorText(await loadWith(401, JSON.stringify({
      error: true,
      statusCode: 401,
      statusMessage: 'backend /api/dtako/vehicles エラー: {"error":"Unauthorized"}',
      message: 'backend /api/dtako/vehicles エラー: {"error":"Unauthorized"}',
    })))
    expect(upstream).toBe(
      '未確認車輛の取得に失敗しました: '
      + '401 backend /api/dtako/vehicles エラー: {"error":"Unauthorized"} — '
      + 'ログインが切れています。再ログインしてから「再取得」を押してください'
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)',
    )

    // ② 自前の `requireAuth` 由来 (#p760-c988-3 のマージ後に出る形)
    const own = errorText(await loadWith(401, UNAUTHORIZED_BODY))

    // **理由は別物・次の一手は同一。**` — ` の後ろを取り出して突き合わせる。
    expect(upstream.split(' — ')[0]).not.toBe(own.split(' — ')[0])
    expect(upstream.split(' — ')[1]).toBe(own.split(' — ')[1])
    expect(upstream.split(' — ')[1]).toContain('再ログイン')
  })

  /** `alcProxyFetch` 自身が投げる 503 (`INTERNAL_SHARED_SECRET binding が未設定です`)。
   * R2 binding 無しの 503 とは**別の 503** だが、人がすべきことは同じ。 */
  it('503 (INTERNAL_SHARED_SECRET 未設定) — R2 の 503 と同じ「次の一手」', async () => {
    expect(errorText(await loadWith(503, JSON.stringify({
      error: true,
      statusCode: 503,
      statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です',
      message: 'INTERNAL_SHARED_SECRET binding が未設定です',
    })))).toBe(
      '未確認車輛の取得に失敗しました: 503 INTERNAL_SHARED_SECRET binding が未設定です — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してから「再取得」を押してください',
    )
  })

  /** backend の理由を中継する 502 (`backend /api/dtako/vehicles エラー: …`)。 */
  it('502 (upstream の理由つき) — 理由を残したまま次の一手を足す', async () => {
    const w = await loadWith(502, JSON.stringify({
      error: true,
      statusCode: 502,
      statusMessage: 'backend /api/dtako/vehicles エラー: upstream timeout',
      message: 'backend /api/dtako/vehicles エラー: upstream timeout',
    }))
    expect(errorText(w)).toBe(
      '未確認車輛の取得に失敗しました: 502 backend /api/dtako/vehicles エラー: upstream timeout — '
      + 'サーバ側の設定か障害です (権限の問題ではありません)。'
      + '復旧してから「再取得」を押してください',
    )
  })
})
