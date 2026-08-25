import { describe, expect, it } from 'vitest'
import { CronConfigError } from '../src/cron'
import {
  sendLineworksTextViaAlcInternalProxy,
  type FetchLike,
  type LineworksDestination,
} from '../src/lineworks-notify'
import {
  buildNetprintErrorNotification,
  buildNetprintNotification,
  buildNetprintOperationFailureNotification,
  buildNoOperationsNotification,
  describeOperation,
  formatDateSlash,
  formatMonthDay,
  netprintPdfFileName,
  normalizeBranchCd,
  parseNetprintTargets,
  planNetprintRun,
  resolveBranchDisplayName,
  resolveNetprintDestination,
  runNetprintTargets,
  summarizeOperations,
  validateNetprintTargetsPayload,
  type NetprintCronDeps,
  type NetprintReportRow,
  type NetprintTarget,
} from '../src/netprint-cron'

// `channel_id` は DB `lineworks_channels` の行 id (Uuid) — LINE WORKS の
// channelId そのものではない (Refs #874 の 8)。
const CH_HONSHA = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const CH_OBIHIRO = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const CH_TEST = '00000000-0000-4000-8000-000000000001'
// `recipient_id` は DB `notify_recipients` の行 id (個人宛)。実運用ではトークルームが
// 1 件も登録されておらず、こちら (本多 優鷹) が通知先になる (Refs #874 の 10)。
const RCP_HONDA = 'e553efc9-4dff-4171-a06d-d3c127b14b94'

const TARGET: NetprintTarget = { branch_cd: '1', channel_id: CH_HONSHA }
const TARGET_RCP: NetprintTarget = { branch_cd: '1', recipient_id: RCP_HONDA }

const OPE_HAYASHIDA = '2608240638160000003821'
const OPE_MATSUO = '2608240612340000006572'

function row(
  branchCd: string | null,
  branchName: string | null = null,
  overrides: Partial<NetprintReportRow> = {},
): NetprintReportRow {
  return {
    operationNo: OPE_HAYASHIDA,
    branchCd,
    branchName,
    driverName1: '林田 隆則',
    vehicleName: '長崎100か3821',
    ...overrides,
  }
}

describe('parseNetprintTargets', () => {
  it('未設定 (undefined / 空文字) は空配列', () => {
    expect(parseNetprintTargets(undefined)).toEqual([])
    expect(parseNetprintTargets('')).toEqual([])
  })

  it('JSON 配列をパースする', () => {
    const targets = parseNetprintTargets(`[{"branch_cd":"1","channel_id":"${CH_HONSHA}"}]`)
    expect(targets).toEqual([{ branch_cd: '1', channel_id: CH_HONSHA }])
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

  it('netprintPdfFileName は ASCII 固定 + 運行No で 1 運行 1 ファイルを区別する', () => {
    expect(netprintPdfFileName('2026-08-24', OPE_HAYASHIDA)).toBe(
      `nippo_20260824_${OPE_HAYASHIDA}.pdf`,
    )
  })

  it('describeOperation は乗務員 / 車輌、取れなければ運行No で代用する', () => {
    expect(describeOperation(row('1'))).toBe('林田 隆則 / 長崎100か3821')
    expect(describeOperation(row('1', null, { vehicleName: null }))).toBe('林田 隆則')
    expect(describeOperation(row('1', null, { driverName1: null }))).toBe('長崎100か3821')
    // どちらも無い行を無言の空欄にすると「誰の日報か分からない通知」になる。
    expect(describeOperation(row('1', null, { driverName1: null, vehicleName: null }))).toBe(
      `運行No ${OPE_HAYASHIDA}`,
    )
  })
})

describe('通知文', () => {
  it('予約番号の通知文は 1 行目に乗務員 / 車輌を置く (9 通届いても仕分けられるように)', () => {
    const text = buildNetprintNotification('本社営業所', '2026-08-24', row('1'), {
      printId: 'J5JZPEQJ',
      endDate: '2026/08/26 23:59',
      page: 2,
    })
    expect(text).toBe(
      [
        '【運転日報】林田 隆則 / 長崎100か3821',
        '本社営業所 2026/08/24分',
        'プリント予約番号: J5JZPEQJ',
        '有効期限: 2026/08/26 23:59',
        '(2ページ / A4)',
        'セブンイレブンのマルチコピー機 →「プリント」→「ネットプリント」で番号を入力すると印刷できます。',
      ].join('\n'),
    )
  })

  it('運行ごとの失敗は 1 通にまとめ、誰の日報が出なかったかを名指しする', () => {
    expect(
      buildNetprintOperationFailureNotification('本社営業所', '2026-08-24', [
        { label: '林田 隆則 / 長崎100か3821', detail: 'Error: netprint down' },
        { label: '松尾 等 / 佐賀100あ6572', detail: 'Error: timeout' },
      ]),
    ).toBe(
      [
        '【運転日報】本社営業所 2026/08/24分のうち 2 件を登録できませんでした',
        '・林田 隆則 / 長崎100か3821: Error: netprint down',
        '・松尾 等 / 佐賀100あ6572: Error: timeout',
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
    { branch_cd: '1', channel_id: CH_HONSHA },
    { branch_cd: '2', channel_id: CH_OBIHIRO },
  ])

  it('全部省略なら前日 (呼び出し側が渡す既定日) + NETPRINT_TARGETS 全件 = cron と同じ', () => {
    expect(planNetprintRun({}, CONFIGURED, '2026-08-24')).toEqual({
      date: '2026-08-24',
      targets: [
        { branch_cd: '1', channel_id: CH_HONSHA },
        { branch_cd: '2', channel_id: CH_OBIHIRO },
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

  it('branch_cd + recipient_id を揃えて渡すと個人宛の 1 件だけ (#874-10)', () => {
    expect(
      planNetprintRun(
        { branch_cd: ' 1 ', recipient_id: ` ${RCP_HONDA} ` },
        CONFIGURED,
        '2026-08-24',
      ),
    ).toEqual({
      date: '2026-08-24',
      // 指定しなかった側のキーは立てない (「両方指定」に見せない)。
      targets: [{ branch_cd: '1', recipient_id: RCP_HONDA, branch_name: undefined }],
    })
  })

  it('channel_id と recipient_id の両方指定は 400 相当の error (rust も 400)', () => {
    expect(
      planNetprintRun(
        { branch_cd: '1', channel_id: CH_TEST, recipient_id: RCP_HONDA },
        CONFIGURED,
        '2026-08-24',
      ),
    ).toEqual({ error: 'channel_id と recipient_id はどちらか一方だけ指定してください' })
  })

  it('recipient_id が Uuid でなければ notify_recipients を名指しした error', () => {
    expect(
      planNetprintRun({ branch_cd: '1', recipient_id: '本多 優鷹' }, CONFIGURED, '2026-08-24'),
    ).toEqual({
      error: 'recipient_id が UUID 形式ではありません (notify_recipients の行 id を指定してください)',
    })
  })

  it('branch_cd + channel_id を揃えて渡すとその 1 件だけ (NETPRINT_TARGETS は使わない)', () => {
    expect(
      planNetprintRun(
        { branch_cd: ' 1 ', channel_id: ` ${CH_TEST} `, branch_name: '本社営業所' },
        CONFIGURED,
        '2026-08-24',
      ),
    ).toEqual({
      date: '2026-08-24',
      targets: [{ branch_cd: '1', channel_id: CH_TEST, branch_name: '本社営業所' }],
    })
  })

  it('既存の channel_id 指定はそのまま動く (後方互換)', () => {
    expect(
      planNetprintRun({ branch_cd: '2', channel_id: CH_OBIHIRO }, CONFIGURED, '2026-08-24'),
    ).toEqual({
      date: '2026-08-24',
      targets: [{ branch_cd: '2', channel_id: CH_OBIHIRO, branch_name: undefined }],
    })
  })

  it('branch_name 省略 / 空文字は undefined (行から引くフォールバックに任せる)', () => {
    const plan = planNetprintRun(
      { branch_cd: '1', channel_id: CH_TEST, branch_name: '' },
      CONFIGURED,
      '2026-08-24',
    )
    expect(plan).toEqual({
      date: '2026-08-24',
      targets: [{ branch_cd: '1', channel_id: CH_TEST, branch_name: undefined }],
    })
  })

  it('channel_id が Uuid でなければ 400 相当の error (LINE WORKS の channelId 直貼りを弾く)', () => {
    const expected = {
      error: 'channel_id が UUID 形式ではありません (lineworks_channels の行 id を指定してください)',
    }
    expect(
      planNetprintRun({ branch_cd: '1', channel_id: 'ch-honsha' }, CONFIGURED, '2026-08-24'),
    ).toEqual(expected)
    // 桁の足りない / 区切りの無い Uuid もどきも通さない。
    expect(
      planNetprintRun(
        { branch_cd: '1', channel_id: '3f2504e04f8941d39a0c0305e82c3301' },
        CONFIGURED,
        '2026-08-24',
      ),
    ).toEqual(expected)
  })

  it('片方だけの指定は受け付けない (設定側の宛先と混ざるのを防ぐ)', () => {
    const expected = {
      error: 'branch_cd と宛先 (channel_id か recipient_id) は両方まとめて指定してください',
    }
    expect(planNetprintRun({ branch_cd: '1' }, CONFIGURED, '2026-08-24')).toEqual(expected)
    expect(planNetprintRun({ channel_id: CH_TEST }, CONFIGURED, '2026-08-24')).toEqual(expected)
    expect(planNetprintRun({ recipient_id: RCP_HONDA }, CONFIGURED, '2026-08-24')).toEqual(expected)
  })

  it('NETPRINT_TARGETS 未設定 + 指定なしは error (黙って何もしないにしない)', () => {
    expect(planNetprintRun({}, undefined, '2026-08-24')).toEqual({
      error:
        'NETPRINT_TARGETS が未設定です — branch_cd と channel_id (または recipient_id) を body で指定してください',
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
  destination: LineworksDestination
  text: string
}

describe('resolveNetprintDestination', () => {
  it('channel_id だけなら channel 宛 / recipient_id だけなら recipient 宛', () => {
    expect(resolveNetprintDestination({ branch_cd: '1', channel_id: ` ${CH_HONSHA} ` })).toEqual({
      ok: true,
      destination: { kind: 'channel', id: CH_HONSHA },
    })
    expect(resolveNetprintDestination({ branch_cd: '1', recipient_id: RCP_HONDA })).toEqual({
      ok: true,
      destination: { kind: 'recipient', id: RCP_HONDA },
    })
  })

  it('両方指定 / 両方無しは運用者が直せる文言で落とす', () => {
    expect(
      resolveNetprintDestination({ branch_cd: '1', channel_id: CH_HONSHA, recipient_id: RCP_HONDA }),
    ).toEqual({ ok: false, error: 'channel_id と recipient_id はどちらか一方だけ指定してください' })
    expect(resolveNetprintDestination({ branch_cd: '1' })).toEqual({
      ok: false,
      error: 'channel_id と recipient_id のどちらか一方を指定してください',
    })
  })

  it('設定 JSON は素通しなので非文字列は「無い」に倒す', () => {
    // parseNetprintTargets は `as NetprintTarget[]` で型を付け替えるだけ。
    expect(
      resolveNetprintDestination({ branch_cd: '1', channel_id: 42 } as unknown as NetprintTarget),
    ).toMatchObject({ ok: false })
    expect(
      resolveNetprintDestination({ branch_cd: '1', recipient_id: null } as unknown as NetprintTarget),
    ).toMatchObject({ ok: false })
  })

  it('Uuid でない id は「どの表の行 id か」まで書いて落とす', () => {
    expect(resolveNetprintDestination({ branch_cd: '1', channel_id: 'ch-honsha' })).toEqual({
      ok: false,
      error: 'channel_id が UUID 形式ではありません (lineworks_channels の行 id を指定してください)',
    })
    expect(resolveNetprintDestination({ branch_cd: '1', recipient_id: 'honda' })).toEqual({
      ok: false,
      error: 'recipient_id が UUID 形式ではありません (notify_recipients の行 id を指定してください)',
    })
  })
})

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
    sendText: async (destination, text) => {
      sent.push({ destination, text })
    },
    ...overrides,
  }
  return { deps, sent, fetched }
}

describe('summarizeOperations', () => {
  // relay (`cron.ts`) が応答本文を 200 字で切るので、**並び順そのものが仕様**。
  // 人が次に動く必要がある情報 (件数 → 失敗した運行) を先に、番号を最後に置く
  // (番号は LINE WORKS に 1 運行 1 通で届いており、画面が唯一の経路ではない)。
  const ok = (printId: string, label: string) => ({
    operation_no: OPE_HAYASHIDA, label, ok: true, print_id: printId, detail: '',
  })
  const ng = (label: string, detail: string) => ({
    operation_no: OPE_MATSUO, label, ok: false, print_id: null, detail,
  })

  it('全件成功なら件数のあとに予約番号を並べる', () => {
    expect(summarizeOperations([ok('AAAA1111', '林田'), ok('BBBB2222', '松尾')])).toBe(
      '成功 2 / 失敗 0 (全 2 運行) 予約番号 AAAA1111 / BBBB2222',
    )
  })

  it('失敗があれば予約番号より前に「誰が失敗したか」を出す', () => {
    expect(summarizeOperations([ok('AAAA1111', '林田'), ng('松尾', 'Error: boom')])).toBe(
      '成功 1 / 失敗 1 (全 2 運行) 失敗 松尾: Error: boom 予約番号 AAAA1111',
    )
  })

  it('全件失敗なら予約番号の欄自体を出さない', () => {
    expect(summarizeOperations([ng('松尾', 'Error: boom')])).toBe(
      '成功 0 / 失敗 1 (全 1 運行) 失敗 松尾: Error: boom',
    )
  })
})

describe('runNetprintTargets', () => {
  it('1 運行 = 1 PDF = 1 予約番号 = 通知 1 通 (generatePdf には行 1 件を渡す)', async () => {
    const pdfCalls: string[] = []
    const base = makeDeps()
    const deps: NetprintCronDeps = {
      ...base.deps,
      generatePdf: async (operation) => {
        pdfCalls.push(operation.operationNo)
        return new Uint8Array([0x25])
      },
    }
    const { sent } = base
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    expect(pdfCalls).toEqual([OPE_HAYASHIDA])
    expect(results).toEqual([
      {
        detail: '成功 1 / 失敗 0 (全 1 運行) 予約番号 J5JZPEQJ',
        branch_cd: '1',
        channel_id: CH_HONSHA,
        recipient_id: null,
        ok: true,
        rows: 1,
        operations: [
          {
            operation_no: OPE_HAYASHIDA,
            label: '林田 隆則 / 長崎100か3821',
            ok: true,
            print_id: 'J5JZPEQJ',
            detail: '',
          },
        ],
      },
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0].destination).toEqual({ kind: 'channel', id: CH_HONSHA })
    expect(sent[0].text).toContain('プリント予約番号: J5JZPEQJ')
    expect(sent[0].text).toContain('林田 隆則 / 長崎100か3821')
  })

  it('運行が複数なら運行ごとに登録して通知も 1 通ずつ出す', async () => {
    const registered: string[] = []
    const { deps, sent } = makeDeps({
      fetchReport: async () => ({
        rows: [
          row('1', '本社営業所'),
          row('1', '本社営業所', {
            operationNo: OPE_MATSUO,
            driverName1: '松尾　等',
            vehicleName: '佐賀100あ6572',
          }),
        ],
      }),
      registerPdf: async (_pdf, fileName) => {
        registered.push(fileName)
        return { printId: `J5JZPEQ${registered.length}`, endDate: '2026/08/26 23:59', page: 2 }
      },
    })
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    // ファイル名は運行ごとに変わる (netprint の登録一覧で見分けるため)。
    expect(registered).toEqual([
      `nippo_20260824_${OPE_HAYASHIDA}.pdf`,
      `nippo_20260824_${OPE_MATSUO}.pdf`,
    ])
    expect(results[0]).toMatchObject({ ok: true, rows: 2 })
    expect(results[0].detail).toBe('成功 2 / 失敗 0 (全 2 運行) 予約番号 J5JZPEQ1 / J5JZPEQ2')
    expect(sent).toHaveLength(2)
    expect(sent[0].text).toContain('林田 隆則')
    expect(sent[1].text).toContain('松尾　等')
    expect(sent[1].text).toContain('プリント予約番号: J5JZPEQ2')
  })

  it('branchCd はゼロ埋め表記を正規化してから fetchRows へ渡す (設定 "00000001" → "1")', async () => {
    const { deps, sent, fetched } = makeDeps()
    const results = await runNetprintTargets(
      deps,
      [{ branch_cd: '00000001', channel_id: CH_HONSHA }],
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
    expect(results[0]).toMatchObject({ ok: true, rows: 0, operations: [] })
    expect(sent).toEqual([
      {
        destination: { kind: 'channel', id: CH_HONSHA },
        text: '営業所コード1 8/4分の運行はありませんでした',
      },
    ])
  })

  it('運行 1 件の失敗は他の運行を止めず、target は ok のまま (失敗はまとめて 1 通)', async () => {
    let call = 0
    const { deps, sent } = makeDeps({
      fetchReport: async () => ({
        rows: [
          row('1', '本社営業所'),
          row('1', '本社営業所', { operationNo: OPE_MATSUO, driverName1: '松尾　等' }),
        ],
      }),
      generatePdf: async () => {
        call += 1
        if (call === 1) throw new Error('theearth preview timeout')
        return new Uint8Array([0x25])
      },
    })
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    // 1 件でも届いていれば「営業所ぜんぶ失敗」とは報告しない。
    expect(results[0].ok).toBe(true)
    expect(results[0].operations.map((o) => o.ok)).toEqual([false, true])
    expect(results[0].detail).toBe(
      '成功 1 / 失敗 1 (全 2 運行) 失敗 林田 隆則 / 長崎100か3821: Error: theearth preview timeout 予約番号 J5JZPEQJ',
    )
    // 成功ぶんの通知 1 通 + 失敗のまとめ 1 通 (失敗の数だけは送らない)。
    expect(sent).toHaveLength(2)
    expect(sent[0].text).toContain('プリント予約番号: J5JZPEQJ')
    expect(sent[1].text).toContain('1 件を登録できませんでした')
    expect(sent[1].text).toContain('林田 隆則 / 長崎100か3821: Error: theearth preview timeout')
  })

  it('全運行が失敗したら target を ok: false にする', async () => {
    const { deps, sent } = makeDeps({
      registerPdf: async () => {
        throw new Error('netprint 受付エラー code=11202')
      },
    })
    const second: NetprintTarget = { branch_cd: '2', channel_id: CH_OBIHIRO }
    const results = await runNetprintTargets(deps, [TARGET, second], '2026-08-24')
    expect(results[0].ok).toBe(false)
    expect(results[0].rows).toBe(1)
    expect(results[0].detail).toContain('netprint 受付エラー code=11202')
    // 1 つ目の失敗後も 2 つ目 (branch 2 は 0 行 → 「運行なし」通知で成功) まで
    // 処理される — target 間独立。
    expect(results).toHaveLength(2)
    expect(results[1]).toMatchObject({ ok: true, rows: 0 })
    expect(sent[0].text).toContain('1 件を登録できませんでした')
  })

  it('登録は済んだのに通知が落ちたら、番号を残したまま失敗にする', async () => {
    // 「番号が出たのに誰にも届いていない」を成功に倒さない。番号は結果から拾えば
    // 人が手で伝えられるので捨てない。
    const { deps } = makeDeps({
      sendText: async () => {
        throw new Error('lineworks down')
      },
    })
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    expect(results[0].ok).toBe(false)
    expect(results[0].operations[0]).toMatchObject({ ok: false, print_id: 'J5JZPEQJ' })
    expect(results[0].operations[0].detail).toBe(
      '予約番号 J5JZPEQJ は発行済みだが通知に失敗: Error: lineworks down',
    )
    // 失敗のまとめ通知も同じ壊れた経路なので、併記して飲み込む。
    expect(results[0].detail).toContain('失敗のまとめ通知も失敗')
    expect(results[0].detail).toContain('lineworks down')
  })

  it('0 行の通知が落ちたら rows: 0 のまま ok: false (harvest は済んでいるので null にしない)', async () => {
    const { deps } = makeDeps({
      fetchReport: async () => ({ rows: [] }),
      sendText: async () => {
        throw new Error('lineworks down')
      },
    })
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    expect(results[0]).toMatchObject({ ok: false, rows: 0, operations: [] })
    expect(results[0].detail).toContain('lineworks down')
    expect(results[0].detail).toContain('エラー通知も失敗')
  })

  it('harvest 自体の失敗は rows: null / operations 空、エラー通知の宛先名はコード代用', async () => {
    const { deps, sent } = makeDeps({
      fetchReport: async () => {
        throw new Error('theearth login failed')
      },
    })
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    expect(results[0]).toMatchObject({ ok: false, rows: null, operations: [] })
    expect(results[0].detail).toContain('theearth login failed')
    expect(sent[0].text).toContain('営業所コード1')
    expect(sent[0].text).toContain('自動登録に失敗しました')
  })

  it('recipient_id 指定の target は個人宛で送る (channel_id は結果に null で残る)', async () => {
    const { deps, sent, fetched } = makeDeps()
    const results = await runNetprintTargets(deps, [TARGET_RCP], '2026-08-24')
    expect(fetched).toEqual([{ dateYmd: '2026-08-24', branchCd: '1' }])
    expect(results[0]).toMatchObject({
      branch_cd: '1',
      // 応答のフィールド名は変えない (画面 #874-5 が読む形を保つ)。
      channel_id: null,
      recipient_id: RCP_HONDA,
      ok: true,
      rows: 1,
    })
    expect(results[0].operations[0].print_id).toBe('J5JZPEQJ')
    expect(sent).toHaveLength(1)
    expect(sent[0].destination).toEqual({ kind: 'recipient', id: RCP_HONDA })
    expect(sent[0].text).toContain('プリント予約番号: J5JZPEQJ')
  })

  it('channel_id と recipient_id の両方を持つ target はその 1 件だけ ok: false', async () => {
    const { deps, sent, fetched } = makeDeps()
    const both: NetprintTarget = { branch_cd: '1', channel_id: CH_HONSHA, recipient_id: RCP_HONDA }
    const second: NetprintTarget = { branch_cd: '2', recipient_id: RCP_HONDA }
    const results = await runNetprintTargets(deps, [both, second], '2026-08-24')
    expect(results[0]).toEqual({
      detail: 'channel_id と recipient_id はどちらか一方だけ指定してください',
      branch_cd: '1',
      channel_id: CH_HONSHA,
      recipient_id: RCP_HONDA,
      ok: false,
      rows: null,
      operations: [],
    })
    // 他の target は止めない (branch 2 は 0 行 → 「運行なし」通知で成功)。
    expect(fetched).toEqual([{ dateYmd: '2026-08-24', branchCd: '2' }])
    expect(results[1]).toMatchObject({ ok: true, rows: 0 })
    expect(sent).toHaveLength(1)
  })

  it('recipient_id が Uuid でない target も harvest せず ok: false', async () => {
    const { deps, fetched } = makeDeps()
    const results = await runNetprintTargets(
      deps,
      [{ branch_cd: '1', recipient_id: 'honda' }],
      '2026-08-24',
    )
    expect(results[0]).toMatchObject({
      channel_id: null,
      recipient_id: 'honda',
      ok: false,
      detail: 'recipient_id が UUID 形式ではありません (notify_recipients の行 id を指定してください)',
    })
    expect(fetched).toEqual([])
  })

  it('channel_id が Uuid でない target は harvest せず ok: false — 他の target は止めない', async () => {
    const { deps, sent, fetched } = makeDeps()
    const broken: NetprintTarget = { branch_cd: '1', channel_id: 'ch-honsha' }
    const second: NetprintTarget = { branch_cd: '2', channel_id: CH_OBIHIRO }
    const results = await runNetprintTargets(deps, [broken, second], '2026-08-24')
    expect(results[0]).toEqual({
      detail: 'channel_id が UUID 形式ではありません (lineworks_channels の行 id を指定してください)',
      branch_cd: '1',
      channel_id: 'ch-honsha',
      recipient_id: null,
      ok: false,
      rows: null,
      operations: [],
    })
    // 宛先が無い以上 harvest も PDF 登録もエラー通知もしない (確実に失敗する送信を試さない)。
    expect(fetched).toEqual([{ dateYmd: '2026-08-24', branchCd: '2' }])
    expect(sent.map((m) => m.destination.id)).toEqual([CH_OBIHIRO])
    expect(results[1]).toMatchObject({ ok: true, rows: 0 })
  })

  it('channel_id 欠落 (設定 JSON は素通しなので型どおりとは限らない) も同じく ok: false', async () => {
    const { deps, fetched } = makeDeps()
    const results = await runNetprintTargets(
      deps,
      [{ branch_cd: '1' } as unknown as NetprintTarget],
      '2026-08-24',
    )
    expect(results[0]).toMatchObject({ ok: false, rows: null, operations: [] })
    expect(fetched).toEqual([])
  })

  it('alc からの非 2xx は status と本文の先頭を落とさず detail に載せる (画面が理由を出せる)', async () => {
    // #874-6 の migration が本番に当たるまでは送信が失敗しうる。そのとき Tail と
    // `/kintai-relay/netprint-run` の応答から「何が起きたか」が読めることを固定する
    // (画面 #874-5 は results[].detail を表示する)。実物の通知経路を deps に挿す。
    const alcFetch: FetchLike = (async () =>
      new Response('{"error":"relation lineworks_channels does not exist"}', {
        status: 500,
      })) as FetchLike
    const { deps } = makeDeps({
      sendText: (destination, text) =>
        sendLineworksTextViaAlcInternalProxy(
          { sharedSecret: 'shared-1', destination, text },
          alcFetch,
        ),
    })
    const results = await runNetprintTargets(deps, [TARGET], '2026-08-24')
    expect(results[0]).toMatchObject({ ok: false, rows: 1 })
    expect(results[0].detail).toContain('HTTP 500')
    expect(results[0].detail).toContain('relation lineworks_channels does not exist')
    expect(results[0].detail).toContain(CH_HONSHA)
    // 予約番号の通知が失敗 → 失敗のまとめ通知も同じ壊れた経路なので併記して飲み込む。
    expect(results[0].detail).toContain('失敗のまとめ通知も失敗')
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

// 画面 (`/scraper` の「日報netprint」タブ) から保存される設定の検証 (Refs #874 の 12)。
// **cron 経路と同じ部品**を使うことが要点 — 通す/落とすの規則が割れると
// 「画面では保存できたのに cron が落とす」設定が作れる。
describe('validateNetprintTargetsPayload', () => {
  it('正しい設定は正規化して通す (知らないキーは落とし、空白は trim)', () => {
    const raw = JSON.stringify([
      { branch_cd: ' 1 ', channel_id: ` ${CH_HONSHA} `, branch_name: ' 本社営業所 ', junk: 'x' },
      { branch_cd: '8', recipient_id: RCP_HONDA },
    ])
    const result = validateNetprintTargetsPayload(raw)
    expect(result).toEqual({
      ok: true,
      targets: [
        { branch_cd: '1', channel_id: CH_HONSHA, branch_name: '本社営業所' },
        { branch_cd: '8', recipient_id: RCP_HONDA },
      ],
    })
  })

  it('空文字 / 空配列は「設定なし」として通す (全部消す操作ができる)', () => {
    expect(validateNetprintTargetsPayload('')).toEqual({ ok: true, targets: [] })
    expect(validateNetprintTargetsPayload('[]')).toEqual({ ok: true, targets: [] })
  })

  it('空の branch_name は入れない (KV に空文字を溜めない)', () => {
    const raw = JSON.stringify([{ branch_cd: '1', channel_id: CH_HONSHA, branch_name: '  ' }])
    const result = validateNetprintTargetsPayload(raw)
    expect(result).toEqual({ ok: true, targets: [{ branch_cd: '1', channel_id: CH_HONSHA }] })
    // 非文字列の branch_name も同じく落ちる (型が言うほど string とは限らない)。
    const numeric = JSON.stringify([{ branch_cd: '1', channel_id: CH_HONSHA, branch_name: 7 }])
    expect(validateNetprintTargetsPayload(numeric)).toEqual({
      ok: true,
      targets: [{ branch_cd: '1', channel_id: CH_HONSHA }],
    })
  })

  it('JSON として読めない / 配列でないものは parseNetprintTargets の文言で落とす', () => {
    expect(validateNetprintTargetsPayload('{')).toEqual({
      ok: false,
      error: 'NETPRINT_TARGETS が JSON としてパースできません',
    })
    expect(validateNetprintTargetsPayload('{"branch_cd":"1"}')).toEqual({
      ok: false,
      error: 'NETPRINT_TARGETS は JSON 配列である必要があります',
    })
  })

  it('要素がオブジェクトでなければ何件目かを添えて落とす', () => {
    for (const bad of ['"x"', 'null', '[]', '3']) {
      const result = validateNetprintTargetsPayload(`[{"branch_cd":"1","channel_id":"${CH_HONSHA}"},${bad}]`)
      expect(result).toEqual({ ok: false, error: '2 件目: JSON オブジェクトで指定してください' })
    }
  })

  it('branch_cd が無い / 空白だけ / 文字列でない行は落とす', () => {
    for (const bad of ['{}', '{"branch_cd":"   "}', '{"branch_cd":9}']) {
      expect(validateNetprintTargetsPayload(`[${bad}]`)).toEqual({
        ok: false,
        error: '1 件目: branch_cd (営業所コード) は必須です',
      })
    }
  })

  it('宛先の規則は cron 経路と同じ (resolveNetprintDestination の文言をそのまま運ぶ)', () => {
    const both = JSON.stringify([
      { branch_cd: '1', channel_id: CH_HONSHA, recipient_id: RCP_HONDA },
    ])
    expect(validateNetprintTargetsPayload(both)).toEqual({
      ok: false,
      error: '1 件目 (営業所 1): channel_id と recipient_id はどちらか一方だけ指定してください',
    })
    const none = JSON.stringify([{ branch_cd: '1' }])
    expect(validateNetprintTargetsPayload(none)).toEqual({
      ok: false,
      error: '1 件目 (営業所 1): channel_id と recipient_id のどちらか一方を指定してください',
    })
    // LINE WORKS の channelId をそのまま貼った (Uuid でない) 事故もここで止まる。
    const notUuid = JSON.stringify([{ branch_cd: '1', channel_id: 'abcdefg' }])
    expect(validateNetprintTargetsPayload(notUuid)).toEqual({
      ok: false,
      error:
        '1 件目 (営業所 1): channel_id が UUID 形式ではありません (lineworks_channels の行 id を指定してください)',
    })
    const badRcp = JSON.stringify([{ branch_cd: '2', recipient_id: 'nope' }])
    expect(validateNetprintTargetsPayload(badRcp)).toEqual({
      ok: false,
      error:
        '1 件目 (営業所 2): recipient_id が UUID 形式ではありません (notify_recipients の行 id を指定してください)',
    })
  })

  it('通した設定はそのまま cron が走らせられる (parseNetprintTargets と往復する)', () => {
    const result = validateNetprintTargetsPayload(
      JSON.stringify([{ branch_cd: '1', recipient_id: RCP_HONDA, branch_name: '本社営業所' }]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // KV に入るのは正規化後の JSON。それを cron 経路が読み直しても同じ target になる。
    const roundTrip = parseNetprintTargets(JSON.stringify(result.targets))
    expect(roundTrip).toEqual(result.targets)
    expect(resolveNetprintDestination(roundTrip[0]!)).toEqual({
      ok: true,
      destination: { kind: 'recipient', id: RCP_HONDA },
    })
  })
})
