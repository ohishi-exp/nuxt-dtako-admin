/**
 * 日報 netprint の通知先設定 (`/scraper` の「日報netprint」タブ、Refs #874 の 12) の
 * **画面側 pure 部品**。KV `netprint_targets` の JSON ⇄ 画面の行、通知先 select の
 * 選択肢作りを持つ。
 *
 * ## なぜ select にするか
 *
 * `channel_id` / `recipient_id` は **rust-alc-api の DB の行 id (Uuid)** で、LINE WORKS
 * の channelId でも氏名でもない (#874-8 の方針転換)。手で貼ると取り違えても画面上は
 * それらしく見え、**間違った人に日報が届く** — 誤配は取り消せない。⇒ 候補は必ず
 * alc の一覧 (`/api/notify/recipients` / `/api/notify/lineworks/channels`) から出し、
 * 人が触るのは表示名だけにする。
 *
 * ## 検証は持たない
 *
 * 宛先の排他・Uuid・`branch_cd` 必須の判定は relay の `validateNetprintTargetsPayload`
 * (cron と同じ部品) が正。ここは「未選択なら宛先キーを立てない」までしかせず、
 * 落とすのは relay に任せて理由を表示する — 規則を 2 か所に持つと「画面では保存
 * できたのに cron が落とす」設定が作れる。
 */

/** USelect (reka-ui) は空文字 value の item を許可しない (実機で 500、Refs #420)
 * ため、「未選択」には sentinel を使う。Uuid とも `channel:`/`recipient:` とも
 * 衝突しない形にする。 */
export const NETPRINT_DESTINATION_NONE = '__none__'

/** 画面の 1 行 (営業所 1 件ぶん)。 */
export interface NetprintTargetRow {
  /** 営業所コード (theearth F-DES1010 の `lblBranchCD`)。手入力。 */
  branchCd: string
  /** 通知文の表示名。任意 (0 行の日の文面に使う)。手入力。 */
  branchName: string
  /** 通知先 select の値 (`channel:<uuid>` / `recipient:<uuid>` / 未選択 sentinel)。 */
  destination: string
}

/** 通知先 select の 1 項目。 */
export interface NetprintDestinationOption {
  label: string
  value: string
}

/** `notify_recipients` / `lineworks_channels` のどちらを指す値か。 */
export type NetprintDestinationKind = 'channel' | 'recipient'

/** select の値。`kind:id` の 1 文字列にまとめる (USelect は 1 値しか持てないため)。 */
export function netprintDestinationValue(kind: NetprintDestinationKind, id: string): string {
  return `${kind}:${id}`
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** 文字列プロパティを trim して取り出す (無い/文字列でないは空文字)。 */
function str(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 個人宛の候補 (`GET /api/notify/recipients`)。
 *
 * **`provider === 'lineworks'` の行だけ**を候補にする — LINE の受信者を選ぶと
 * 送信時 (alc の `POST /api/internal/lineworks/send`) に落ちるので、**選ばせない**
 * のが正しい。「選べたのに送れない」を画面で作らない。
 */
export function netprintRecipientOptions(recipients: unknown): NetprintDestinationOption[] {
  const options: NetprintDestinationOption[] = []
  for (const raw of asArray(recipients)) {
    const record = asRecord(raw)
    const id = str(record, 'id')
    if (id === '' || str(record, 'provider') !== 'lineworks') continue
    const name = str(record, 'name')
    options.push({
      label: `${name === '' ? id : name} (個人)`,
      value: netprintDestinationValue('recipient', id),
    })
  }
  return options
}

/**
 * トークルーム宛の候補 (`GET /api/notify/lineworks/channels`)。
 *
 * **現状 0 件でも実装しておく** — Bot をトークルームへ招待すると webhook 経由で
 * `lineworks_channels` に行が増えるので、その日から選べるようにしておく。
 */
export function netprintChannelOptions(channels: unknown): NetprintDestinationOption[] {
  const options: NetprintDestinationOption[] = []
  for (const raw of asArray(channels)) {
    const record = asRecord(raw)
    const id = str(record, 'id')
    if (id === '') continue
    // 表示名は title → LINE WORKS の channelId → 行 id の順。**行 id を人に見せる
    // のは最後の手段** (どのトークルームか読めないため)。
    const title = str(record, 'title')
    const channelId = str(record, 'channel_id')
    const label = title !== '' ? title : channelId !== '' ? channelId : id
    options.push({
      label: `${label} (トークルーム)`,
      value: netprintDestinationValue('channel', id),
    })
  }
  return options
}

/** 個人 + トークルームを 1 つの select に混ぜる (`(個人)` / `(トークルーム)` で
 * 区別が付く)。 */
export function netprintDestinationOptions(
  recipients: unknown,
  channels: unknown,
): NetprintDestinationOption[] {
  return [...netprintRecipientOptions(recipients), ...netprintChannelOptions(channels)]
}

/** 空の 1 行 (「行を追加」で足す形)。 */
export function emptyNetprintTargetRow(): NetprintTargetRow {
  return { branchCd: '', branchName: '', destination: NETPRINT_DESTINATION_NONE }
}

/**
 * `GET /api/netprint/targets` の応答 (KV の生 JSON 配列) を画面の行にする。
 *
 * **形が違う要素も落とさない** — 空欄の行として見えた方が、黙って消えるより良い
 * (「保存したはずの営業所が一覧から消えている」を作らない)。両方の宛先が入って
 * いる不正な行は**どちらも選択しない状態**で出す (保存時に relay が理由を返す)。
 */
export function netprintTargetRows(body: unknown): NetprintTargetRow[] {
  const rows: NetprintTargetRow[] = []
  for (const raw of asArray(body)) {
    const record = asRecord(raw)
    const channelId = str(record, 'channel_id')
    const recipientId = str(record, 'recipient_id')
    const both = channelId !== '' && recipientId !== ''
    const destination = both
      ? NETPRINT_DESTINATION_NONE
      : channelId !== ''
        ? netprintDestinationValue('channel', channelId)
        : recipientId !== ''
          ? netprintDestinationValue('recipient', recipientId)
          : NETPRINT_DESTINATION_NONE
    rows.push({
      branchCd: str(record, 'branch_cd'),
      branchName: str(record, 'branch_name'),
      destination,
    })
  }
  return rows
}

/** KV に入る 1 件の形 (relay の `NetprintTarget` と同じ)。 */
export interface NetprintTargetPayloadItem {
  branch_cd: string
  channel_id?: string
  recipient_id?: string
  branch_name?: string
}

/**
 * 画面の行を `PUT /api/netprint/targets` の body にする。
 *
 * 未選択の行は**宛先キーを立てない** (空文字を入れると relay 側で「指定あり」と
 * 読まれる)。空欄のまま保存すると relay が「どちらか一方を指定してください」を
 * 返す — 画面で握り潰さず、理由を出して直させる。
 */
export function netprintTargetsPayload(rows: readonly NetprintTargetRow[]): NetprintTargetPayloadItem[] {
  return rows.map((row) => {
    const item: NetprintTargetPayloadItem = { branch_cd: row.branchCd.trim() }
    const sep = row.destination.indexOf(':')
    const kind = sep < 0 ? '' : row.destination.slice(0, sep)
    const id = sep < 0 ? '' : row.destination.slice(sep + 1)
    if (kind === 'channel') item.channel_id = id
    if (kind === 'recipient') item.recipient_id = id
    const branchName = row.branchName.trim()
    if (branchName !== '') item.branch_name = branchName
    return item
  })
}

/**
 * 保存済みの宛先が候補一覧に無いときの注記 (空文字なら注記不要)。
 *
 * 一覧から消えた受信者 (alc 側で削除された等) を指したままだと、select は
 * **何も選ばれていないように見える**。黙って「未選択」に見せると保存で宛先ごと
 * 消えるので、元の値を画面に出して気づけるようにする。
 */
export function netprintUnknownDestinationNote(
  row: NetprintTargetRow,
  options: readonly NetprintDestinationOption[],
): string {
  if (row.destination === NETPRINT_DESTINATION_NONE) return ''
  if (options.some(option => option.value === row.destination)) return ''
  return `設定値 ${row.destination} は候補一覧にありません (alc 側で削除された可能性)`
}
