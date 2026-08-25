import { describe, expect, it } from 'vitest'
import { CronConfigError } from '../src/cron'
import {
  buildNetprintErrorNotification,
  buildNetprintNotification,
  buildNoOperationsNotification,
  formatDateSlash,
  formatMonthDay,
  netprintPdfFileName,
  normalizeBranchCd,
  parseNetprintTargets,
  planNetprintRun,
  resolveBranchDisplayName,
  runNetprintTargets,
  type NetprintCronDeps,
  type NetprintReportRow,
  type NetprintTarget,
} from '../src/netprint-cron'

const TARGET: NetprintTarget = { branch_cd: '1', channel_id: 'ch-honsha' }

function row(branchCd: string | null, branchName: string | null = null): NetprintReportRow {
  return { branchCd, branchName }
}

describe('parseNetprintTargets', () => {
  it('未設定 (undefined / 空文字) は空配列', () => {
    expect(parseNetprintTargets(undefined)).toEqual([])
    expect(parseNetprintTargets('')).toEqual([])
  })

  it('JSON 配列をパースする', () => {
    const targets = parseNetprintTargets('[{"branch_cd":"1","channel_id":"c1"}]')
    expect(targets).toEqual([{ branch_cd: '1', channel_id: 'c1' }])
  })

  it('JSON 不正 / 非配列は CronConfigError で loud fail する', () => {
    expect(() => parseNetprintTargets('not json')).toThrow(CronConfigError)
    expect(() => parseNetprintTargets('{"branch_cd":"1"}')).toThrow('JSON 配列')
  })
})

describe('normalizeBranchCd / 日付整形 / ファイル名', () => {
  it('先頭ゼロ埋めを落として比較できる形にする (マスタ 00000001 ⇔ 行 1)', () => {
    expect(normalizeBranchCd('00000001')).toBe('1')
    expect(normalizeBranchCd(' 1 ')).toBe('1')
    expect(normalizeBranchCd('0')).toBe('0')
    expect(normalizeBranchCd('10')).toBe('10')
  })

  it('formatDateSlash / formatMonthDay', () => {
    expect(formatDateSlash('2026-08-24')).toBe('2026/08/24')
    expect(formatMonthDay('2026-08-04')).toBe('8/4')
    expect(formatMonthDay('2026-12-31')).toBe('12/31')
  })

  it('netprintPdfFileName は ASCII 固定', () => {
    expect(netprintPdfFileName('2026-08-24')).toBe('nippo_20260824.pdf')
  })
})

describe('通知文', () => {
  it('予約番号の通知文 (Refs #874 の仕様どおり)', () => {
    const text = buildNetprintNotification('本社営業所', '2026-08-24', {
      printId: 'J5JZPEQJ',
      endDate: '2026/08/26 23:59',
      page: 2,
    })
    expect(text).toBe(
      [
        '【運転日報】本社営業所 2026/08/24分',
        'プリント予約番号: J5JZPEQJ',
        '有効期限: 2026/08/26 23:59',
        '(2ページ / A4)',
        'セブンイレブンのマルチコピー機 →「プリント」→「ネットプリント」で番号を入力すると印刷できます。',
      ].join('\n'),
    )
  })

  it('0 行の通知文は M/D (0 埋めなし)', () => {
    expect(buildNoOperationsNotification('本社営業所', '2026-08-04')).toBe(
      '本社営業所 8/4分の運行はありませんでした',
    )
  })

  it('エラー通知文', () => {
    expect(buildNetprintErrorNotification('本社営業所', '2026-08-24', 'boom')).toBe(
      '【運転日報】本社営業所 2026/08/24分の自動登録に失敗しました: boom',
    )
  })
})

describe('planNetprintRun (手動実行の body 解釈)', () => {
  const CONFIGURED = JSON.stringify([
    { branch_cd: '1', channel_id: 'ch-honsha' },
    { branch_cd: '2', channel_id: 'ch-obihiro' },
  ])

  it('全部省略なら前日 (呼び出し側が渡す既定日) + NETPRINT_TARGETS 全件 = cron と同じ', () => {
    expect(planNetprintRun({}, CONFIGURED, '2026-08-24')).toEqual({
      date: '2026-08-24',
      targets: [
        { branch_cd: '1', channel_id: 'ch-honsha' },
        { branch_cd: '2', channel_id: 'ch-obihiro' },
      ],
    })
  })

  it('date を指定するとその日を使う', () => {
    const plan = planNetprintRun({ date: '2026-08-20' }, CONFIGURED, '2026-08-24')
    expect(plan).toMatchObject({ date: '2026-08-20' })
  })

  it('date の形式違い / 非文字列は 400 相当の error', () => {
    expect(planNetprintRun({ date: '2026/08/20' }, CONFIGURED, '2026-08-24')).toEqual({
      error: 'date は YYYY-MM-DD で指定してください',
    })
    expect(planNetprintRun({ date: 20260820 }, CONFIGURED, '2026-08-24')).toEqual({
      error: 'date は YYYY-MM-DD で指定してください',
    })
  })

  it('branch_cd + channel_id を揃えて渡すとその 1 件だけ (NETPRINT_TARGETS は使わない)', () => {
    expect(
      planNetprintRun(
        { branch_cd: ' 1 ', channel_id: ' ch-test ', branch_name: '本社営業所' },
        CONFIGURED,
        '2026-08-24',
      ),
    ).toEqual({
      date: '2026-08-24',
      targets: [{ branch_cd: '1', channel_id: 'ch-test', branch_name: '本社営業所' }],
    })
  })

  it('branch_name 省略 / 空文字は undefined (行から引くフォールバックに任せる)', () => {
    const plan = planNetprintRun(
      { branch_cd: '1', channel_id: 'ch-test', branch_name: '' },
      CONFIGURED,
      '2026-08-24',
    )
    expect(plan).toEqual({
      date: '2026-08-24',
      targets: [{ branch_cd: '1', channel_id: 'ch-test', branch_name: undefined }],
    })
  })

  it('片方だけの指定は受け付けない (設定側の宛先と混ざるのを防ぐ)', () => {
    const expected = { error: 'branch_cd と channel_id は両方まとめて指定してください' }
    expect(planNetprintRun({ branch_cd: '1' }, CONFIGURED, '2026-08-24')).toEqual(expected)
    expect(planNetprintRun({ channel_id: 'ch-test' }, CONFIGURED, '2026-08-24')).toEqual(expected)
  })

  it('NETPRINT_TARGETS 未設定 + 指定なしは error (黙って何もしないにしない)', () => {
    expect(planNetprintRun({}, undefined, '2026-08-24')).toEqual({
      error: 'NETPRINT_TARGETS が未設定です — branch_cd と channel_id を body で指定してください',
    })
  })

  it('NETPRINT_TARGETS が不正 JSON なら throw する (呼び出し側が loud fail に落とす)', () => {
    expect(() => planNetprintRun({}, 'not json', '2026-08-24')).toThrow(CronConfigError)
  })
})

describe('resolveBranchDisplayName', () => {
  it('設定の branch_name が最優先', () => {
    expect(
      resolveBranchDisplayName({ ...TARGET, branch_name: '本社' }, [row('1', '本社営業所')]),
    ).toBe('本社')
  })

  it('無ければ行の branchName、それも無ければコードで代用', () => {
    expect(resolveBranchDisplayName(TARGET, [row('1', null), row('1', '本社営業所')])).toBe('本社営業所')
    expect(resolveBranchDisplayName(TARGET, [row('1', null)])).toBe('営業所コード1')
    expect(resolveBranchDisplayName(TARGET, [])).toBe('営業所コード1')
  })
})

interface SentMessage {
  channelId: string
  text: string
}

function makeDeps(overrides: Partial<NetprintCronDeps> = {}) {
  const sent: SentMessage[] = []
  const fetched: Array<{ dateYmd: string; branchCd: string }> = []
  const deps: NetprintCronDeps = {
    fetchReport: async (dateYmd, branchCd) => {
      fetched.push({ dateYmd, branchCd })
      return { rows: branchCd === '1' ? [row('1', '本社営業所')] : [] }
    },
    generatePdf: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    registerPdf: async () => ({ printId: 'J5JZPEQJ', endDate: '2026/08/26 23:59', page: 1 }),
    sendText: async (channelId, text) => {
      sent.push({ channelId, text })
    },
    ...overrides,
  }
  return { deps, sent, fetched }
}

describe('runNetprintTargets', () => {
  it('1 行以上: PDF 登録 → 予約番号を通知 (generatePdf には harvest 結果と営業所名を渡す)', async () => {
    const pdfCalls: Array<{ rows: number; branchName: string; dateYmd: string }> = []
    const base = makeDeps()
    const deps: NetprintCronDeps = {
      ...base.deps,
      generatePdf: async (report, branchName, dateYmd) => {
        pdfCalls.push({ rows: report.rows.length, branchName, dateYmd })
        return new Uint8Array([0x25])
      },
    }
    const { sent } = base
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    expect(pdfCalls).toEqual([{ rows: 1, branchName: '本社営業所', dateYmd: '2026-08-24' }])
    expect(results).toEqual([
      {
        branch_cd: '1',
        channel_id: 'ch-honsha',
        ok: true,
        rows: 1,
        print_id: 'J5JZPEQJ',
        detail: '1 行 / 1 ページを登録し予約番号を通知',
      },
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0].channelId).toBe('ch-honsha')
    expect(sent[0].text).toContain('プリント予約番号: J5JZPEQJ')
    expect(sent[0].text).toContain('本社営業所 2026/08/24分')
  })

  it('branchCd はゼロ埋め表記を正規化してから fetchRows へ渡す (設定 "00000001" → "1")', async () => {
    const { deps, sent, fetched } = makeDeps()
    const results = await runNetprintTargets(
      deps,
      [{ branch_cd: '00000001', channel_id: 'c1' }],
      '2026-08-24',
    )
    expect(fetched).toEqual([{ dateYmd: '2026-08-24', branchCd: '1' }])
    expect(results[0].ok).toBe(true)
    expect(results[0].rows).toBe(1)
    expect(sent[0].text).toContain('本社営業所')
  })

  it('0 行: 「運行はありませんでした」を通知して次へ (PDF は作らない)', async () => {
    const { deps, sent } = makeDeps({
      fetchReport: async () => ({ rows: [] }),
      generatePdf: async () => {
        throw new Error('呼ばれてはいけない')
      },
    })
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-04')
    expect(results[0]).toMatchObject({ ok: true, rows: 0, print_id: null })
    expect(sent).toEqual([
      { channelId: 'ch-honsha', text: '営業所コード1 8/4分の運行はありませんでした' },
    ])
  })

  it('途中失敗はその target に閉じ、エラー通知して次の target へ進む', async () => {
    const { deps, sent } = makeDeps({
      registerPdf: async () => {
        throw new Error('netprint 受付エラー code=11202')
      },
    })
    const second: NetprintTarget = { branch_cd: '2', channel_id: 'ch-obihiro' }
    const results = await runNetprintTargets(deps, [TARGET, second], '2026-08-24')
    expect(results[0].ok).toBe(false)
    expect(results[0].rows).toBe(1)
    expect(results[0].detail).toContain('netprint 受付エラー code=11202')
    // 1 つ目の失敗後も 2 つ目 (branch 2 は 0 行 → 「運行なし」通知で成功) まで
    // 処理される — target 間独立。
    expect(results).toHaveLength(2)
    expect(results[1]).toMatchObject({ ok: true, rows: 0 })
    // 失敗 target にはエラー通知が飛ぶ
    expect(sent[0].text).toContain('自動登録に失敗しました')
    expect(sent[0].text).toContain('本社営業所')
  })

  it('harvest 自体の失敗は rows: null、エラー通知の宛先名はコード代用', async () => {
    const { deps, sent } = makeDeps({
      fetchReport: async () => {
        throw new Error('theearth login failed')
      },
    })
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    expect(results[0]).toMatchObject({ ok: false, rows: null, print_id: null })
    expect(results[0].detail).toContain('theearth login failed')
    expect(sent[0].text).toContain('営業所コード1')
  })

  it('エラー通知まで失敗したら detail に併記して飲み込む (Error 以外の throw も文字列化)', async () => {
    const { deps } = makeDeps({
      fetchReport: async () => {
        throw 'not-an-error'
      },
      sendText: async () => {
        throw new Error('lineworks down')
      },
    })
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    expect(results[0].ok).toBe(false)
    expect(results[0].detail).toContain('not-an-error')
    expect(results[0].detail).toContain('エラー通知も失敗')
    expect(results[0].detail).toContain('lineworks down')
  })
})
