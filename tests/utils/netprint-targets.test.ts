import { describe, expect, it } from 'vitest'
import {
  emptyNetprintTargetRow,
  netprintChannelOptions,
  netprintDestinationOptions,
  netprintDestinationValue,
  netprintRecipientOptions,
  netprintTargetRows,
  netprintTargetsPayload,
  netprintUnknownDestinationNote,
  NETPRINT_DESTINATION_NONE,
  type NetprintTargetRow,
} from '../../app/utils/netprint-targets'

// 宛先 id は alc の DB の行 id (Uuid)。LINE WORKS の channelId ではない (#874 の 8)。
const RCP_HONDA = 'e553efc9-4dff-4171-a06d-d3c127b14b94'
const RCP_LINE = '11111111-2222-4333-8444-555555555555'
const CH_HONSHA = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

describe('netprintDestinationValue', () => {
  it('select が持てる 1 値に kind と id をまとめる', () => {
    expect(netprintDestinationValue('recipient', RCP_HONDA)).toBe(`recipient:${RCP_HONDA}`)
    expect(netprintDestinationValue('channel', CH_HONSHA)).toBe(`channel:${CH_HONSHA}`)
  })
})

describe('netprintRecipientOptions', () => {
  it('provider が lineworks の行だけを候補にする (LINE の人は送信時に落ちるので選ばせない)', () => {
    const options = netprintRecipientOptions([
      { id: RCP_HONDA, name: '本多 優鷹', provider: 'lineworks' },
      { id: RCP_LINE, name: 'LINE の人', provider: 'line' },
    ])
    expect(options).toEqual([{ label: '本多 優鷹 (個人)', value: `recipient:${RCP_HONDA}` }])
  })

  it('氏名が無い行は id を表示に使い、id が無い行は候補にしない', () => {
    const options = netprintRecipientOptions([
      { id: RCP_HONDA, provider: 'lineworks' },
      { id: RCP_LINE, name: '  ', provider: 'lineworks' },
      { name: 'id なし', provider: 'lineworks' },
      { id: '  ', name: 'id 空白', provider: 'lineworks' },
    ])
    expect(options).toEqual([
      { label: `${RCP_HONDA} (個人)`, value: `recipient:${RCP_HONDA}` },
      { label: `${RCP_LINE} (個人)`, value: `recipient:${RCP_LINE}` },
    ])
  })

  it('配列でない応答 / オブジェクトでない要素は空扱い (画面を落とさない)', () => {
    expect(netprintRecipientOptions(null)).toEqual([])
    expect(netprintRecipientOptions({ recipients: [] })).toEqual([])
    expect(netprintRecipientOptions(['x', null, [], 3])).toEqual([])
  })
})

describe('netprintChannelOptions', () => {
  it('title → channel_id → 行 id の順で表示名を決める', () => {
    const options = netprintChannelOptions([
      { id: CH_HONSHA, title: '本社トークルーム', channel_id: 'lw-ch-1' },
      { id: RCP_LINE, title: '', channel_id: 'lw-ch-2' },
      { id: RCP_HONDA },
    ])
    expect(options).toEqual([
      { label: '本社トークルーム (トークルーム)', value: `channel:${CH_HONSHA}` },
      { label: 'lw-ch-2 (トークルーム)', value: `channel:${RCP_LINE}` },
      { label: `${RCP_HONDA} (トークルーム)`, value: `channel:${RCP_HONDA}` },
    ])
  })

  it('行 id が無い要素は候補にしない (保存できない値を選ばせない)', () => {
    expect(netprintChannelOptions([{ title: 'id なし' }, null])).toEqual([])
  })
})

describe('netprintDestinationOptions', () => {
  it('個人とトークルームを 1 つの select に混ぜる ((個人)/(トークルーム) で区別できる)', () => {
    const options = netprintDestinationOptions(
      [{ id: RCP_HONDA, name: '本多 優鷹', provider: 'lineworks' }],
      [{ id: CH_HONSHA, title: '本社トークルーム' }],
    )
    expect(options).toEqual([
      { label: '本多 優鷹 (個人)', value: `recipient:${RCP_HONDA}` },
      { label: '本社トークルーム (トークルーム)', value: `channel:${CH_HONSHA}` },
    ])
  })

  it('トークルームが 0 件でも個人だけで動く (Bot 招待前の実運用の形)', () => {
    const options = netprintDestinationOptions(
      [{ id: RCP_HONDA, name: '本多 優鷹', provider: 'lineworks' }],
      [],
    )
    expect(options).toHaveLength(1)
  })
})

describe('emptyNetprintTargetRow', () => {
  it('宛先は sentinel で始まる (USelect は空文字 value を拒む、Refs #420)', () => {
    expect(emptyNetprintTargetRow()).toEqual({
      branchCd: '',
      branchName: '',
      destination: NETPRINT_DESTINATION_NONE,
    })
  })
})

describe('netprintTargetRows', () => {
  it('KV の生 JSON を画面の行にする (個人 / トークルームの両方)', () => {
    const rows = netprintTargetRows([
      { branch_cd: '1', recipient_id: RCP_HONDA, branch_name: '本社営業所' },
      { branch_cd: '8', channel_id: CH_HONSHA },
    ])
    expect(rows).toEqual([
      { branchCd: '1', branchName: '本社営業所', destination: `recipient:${RCP_HONDA}` },
      { branchCd: '8', branchName: '', destination: `channel:${CH_HONSHA}` },
    ])
  })

  it('宛先が両方入った不正な行は「未選択」で出す (保存時に relay が理由を返す)', () => {
    const rows = netprintTargetRows([
      { branch_cd: '1', channel_id: CH_HONSHA, recipient_id: RCP_HONDA },
    ])
    expect(rows).toEqual([{ branchCd: '1', branchName: '', destination: NETPRINT_DESTINATION_NONE }])
  })

  it('宛先が無い行も落とさず空欄で出す (黙って消えるより見えた方が良い)', () => {
    expect(netprintTargetRows([{ branch_cd: '1' }, {}, null, 'x'])).toEqual([
      { branchCd: '1', branchName: '', destination: NETPRINT_DESTINATION_NONE },
      { branchCd: '', branchName: '', destination: NETPRINT_DESTINATION_NONE },
      { branchCd: '', branchName: '', destination: NETPRINT_DESTINATION_NONE },
      { branchCd: '', branchName: '', destination: NETPRINT_DESTINATION_NONE },
    ])
  })

  it('配列でない応答は 0 行 (未設定は [] が返る契約)', () => {
    expect(netprintTargetRows(null)).toEqual([])
    expect(netprintTargetRows({ targets: [] })).toEqual([])
    expect(netprintTargetRows([])).toEqual([])
  })

  it('空白だけの値は trim して空欄にする (relay の正規化と同じ結果になる)', () => {
    expect(netprintTargetRows([{ branch_cd: ' 1 ', branch_name: '  ', channel_id: ` ${CH_HONSHA} ` }])).toEqual([
      { branchCd: '1', branchName: '', destination: `channel:${CH_HONSHA}` },
    ])
  })
})

describe('netprintTargetsPayload', () => {
  it('選んだ側のキーだけを立てる (両方入れない、Refs #874 の 10 の契約)', () => {
    const rows: NetprintTargetRow[] = [
      { branchCd: ' 1 ', branchName: ' 本社営業所 ', destination: `recipient:${RCP_HONDA}` },
      { branchCd: '8', branchName: '', destination: `channel:${CH_HONSHA}` },
    ]
    expect(netprintTargetsPayload(rows)).toEqual([
      { branch_cd: '1', recipient_id: RCP_HONDA, branch_name: '本社営業所' },
      { branch_cd: '8', channel_id: CH_HONSHA },
    ])
  })

  it('未選択の行は宛先キーを立てない (空文字を送ると relay が「指定あり」と読む)', () => {
    const rows: NetprintTargetRow[] = [
      { branchCd: '1', branchName: '', destination: NETPRINT_DESTINATION_NONE },
    ]
    expect(netprintTargetsPayload(rows)).toEqual([{ branch_cd: '1' }])
  })

  it('見知らぬ kind の値も宛先にはしない (relay が「どちらか一方を」と返す)', () => {
    const rows: NetprintTargetRow[] = [
      { branchCd: '1', branchName: '', destination: `group:${RCP_HONDA}` },
    ]
    expect(netprintTargetsPayload(rows)).toEqual([{ branch_cd: '1' }])
  })

  it('0 行は空配列 = 「通知先を全部消す」操作になる', () => {
    expect(netprintTargetsPayload([])).toEqual([])
  })
})

describe('netprintUnknownDestinationNote', () => {
  const options = [{ label: '本多 優鷹 (個人)', value: `recipient:${RCP_HONDA}` }]

  it('候補一覧にある宛先には注記を出さない', () => {
    const row: NetprintTargetRow = { branchCd: '1', branchName: '', destination: `recipient:${RCP_HONDA}` }
    expect(netprintUnknownDestinationNote(row, options)).toBe('')
  })

  it('未選択にも注記は要らない', () => {
    const row: NetprintTargetRow = { branchCd: '1', branchName: '', destination: NETPRINT_DESTINATION_NONE }
    expect(netprintUnknownDestinationNote(row, options)).toBe('')
  })

  it('一覧から消えた宛先は元の値を見せる (黙って未選択に見せると保存で宛先が消える)', () => {
    const row: NetprintTargetRow = { branchCd: '1', branchName: '', destination: `channel:${CH_HONSHA}` }
    expect(netprintUnknownDestinationNote(row, options)).toContain(`channel:${CH_HONSHA}`)
    expect(netprintUnknownDestinationNote(row, options)).toContain('候補一覧にありません')
  })
})
