import { describe, expect, it } from 'vitest'
import {
  AlcInternalUploadError,
  INTERNAL_PROXY_BASE,
  type FetchLike,
} from '../src/alc-internal-upload'
import {
  DVR_MAX_FILES_PER_RUN,
  DVR_NOTIFICATION_WINDOW_HOURS,
  DVR_NOTIFICATIONS_INGEST_PATH,
  DVR_STALE_ALERT_HOURS,
  DvrIngestError,
  dvrFileIngestPath,
  judgeDvrStaleness,
  parseDvrFileResponse,
  parseDvrNotificationsResponse,
  parseTheearthDatetimeJst,
  toDvrDatetimeRfc3339,
  planDvrFileWork,
  postDvrNotifications,
  putDvrFile,
  selectRecentDvrNotifications,
  toDvrIngestItems,
  type DvrPendingFile,
} from '../src/dvr-ingest'
import type { DvrNotification, DvrReceiveState } from '../src/theearth-venus-client'

/** `getDvrNotifications` が返す形。テストで動かす欄だけ指定して残りは埋める。 */
function notification(over: Partial<DvrNotification> = {}): DvrNotification {
  return {
    raw: {},
    vehicleCd: '2131',
    vehicleName: '大型1号',
    serialNo: 'SER-1',
    fileName: 'F1.vdf',
    filePath: 'notify/F1.vdf',
    eventType: '急ブレーキ',
    dvrDatetime: '2026/07/03 18:32:26',
    driverName: '運転 太郎',
    latitude: 32.7981,
    longitude: 130.1,
    receiveState: 'ready' as DvrReceiveState,
    ...over,
  }
}

function pending(over: Partial<DvrPendingFile> = {}): DvrPendingFile {
  return { id: 'id-1', serial_no: 'SER-1', file_name: 'F1.vdf', ...over }
}

describe('parseTheearthDatetimeJst', () => {
  it('reads both observed shapes as JST wall-clock', () => {
    // 2026/07/03 18:32:26 JST = 2026-07-03T09:32:26Z
    expect(parseTheearthDatetimeJst('2026/07/03 18:32:26')).toBe(Date.parse('2026-07-03T09:32:26Z'))
    // 実データで観測されたもう一方の形 (ISO 風。ただし JST 壁時計)
    expect(parseTheearthDatetimeJst('2026-07-01T23:00:59')).toBe(Date.parse('2026-07-01T14:00:59Z'))
  })

  it('accepts a missing seconds field', () => {
    expect(parseTheearthDatetimeJst('2026/07/03 18:32')).toBe(Date.parse('2026-07-03T09:32:00Z'))
  })

  it('trims surrounding whitespace', () => {
    expect(parseTheearthDatetimeJst('  2026/07/03 18:32:26  ')).toBe(
      Date.parse('2026-07-03T09:32:26Z'),
    )
  })

  it('returns null for absent / unreadable values', () => {
    expect(parseTheearthDatetimeJst(null)).toBeNull()
    expect(parseTheearthDatetimeJst('')).toBeNull()
    expect(parseTheearthDatetimeJst('2026年7月3日')).toBeNull()
  })
})

describe('toDvrDatetimeRfc3339', () => {
  it('★ 本番で 422 を出した生表記を RFC3339 (UTC) に直す', () => {
    // 本番の DVR cron が送っていた実データ由来の値。JST→UTC で **日付が前日に戻る**。
    // これを生のまま送ると rust の Option<DateTime<Utc>> が deserialize に失敗し、
    // items[0].dvr_datetime で body 全体が 422 になっていた (Refs #1094)。
    expect(toDvrDatetimeRfc3339('2026/09/03 08:49:12')).toBe('2026-09-02T23:49:12Z')
  })

  it('converts both observed theearth shapes', () => {
    expect(toDvrDatetimeRfc3339('2026/07/03 18:32:26')).toBe('2026-07-03T09:32:26Z')
    expect(toDvrDatetimeRfc3339('2026-07-01T23:00:59')).toBe('2026-07-01T14:00:59Z')
  })

  it('pads a missing seconds field to :00', () => {
    expect(toDvrDatetimeRfc3339('2026/07/03 18:32')).toBe('2026-07-03T09:32:00Z')
  })

  it('★ 空文字・欠落・読めない値はすべて null (空文字を送らない)', () => {
    // 空文字も RFC3339 として不正なので、生の文字列と同じく body 全体を 422 にする。
    expect(toDvrDatetimeRfc3339('')).toBeNull()
    expect(toDvrDatetimeRfc3339(null)).toBeNull()
    expect(toDvrDatetimeRfc3339('2026年7月3日')).toBeNull()
  })

  it('★ 桁溢れで西暦 5 桁になる値も null — 拡張表記を送って全件を落とさない', () => {
    // parseTheearthDatetimeJst は月日の繰り上げを Date.UTC に任せるので、
    // ここは epoch ms としては読めてしまう (= null ではない)。
    expect(parseTheearthDatetimeJst('9999/99/99 23:59:59')).not.toBeNull()
    // が、toISOString() は `+010008-…` を返す。それは RFC3339 ではないので捨てる。
    expect(toDvrDatetimeRfc3339('9999/99/99 23:59:59')).toBeNull()
  })
})

describe('selectRecentDvrNotifications', () => {
  const now = new Date('2026-07-03T10:00:00Z') // = 2026/07/03 19:00 JST

  it('drops rows older than the window and keeps the rest', () => {
    const fresh = notification({ dvrDatetime: '2026/07/03 18:32:26' }) // 28 分前
    const old = notification({ dvrDatetime: '2026/06/30 18:32:26' }) // 3 日前
    const result = selectRecentDvrNotifications([fresh, old], now, DVR_NOTIFICATION_WINDOW_HOURS)
    expect(result.recent).toEqual([fresh])
    expect(result.stale).toBe(1)
    expect(result.undated).toBe(0)
  })

  it('★ keeps rows whose datetime is unreadable (捨てると映像が静かに消える)', () => {
    const undated = notification({ dvrDatetime: null })
    const result = selectRecentDvrNotifications([undated], now, DVR_NOTIFICATION_WINDOW_HOURS)
    expect(result.recent).toEqual([undated])
    expect(result.undated).toBe(1)
    expect(result.stale).toBe(0)
  })

  it('keeps a row sitting exactly on the window edge', () => {
    // 48h ちょうど前 = 2026/07/01 19:00 JST
    const edge = notification({ dvrDatetime: '2026/07/01 19:00:00' })
    expect(
      selectRecentDvrNotifications([edge], now, DVR_NOTIFICATION_WINDOW_HOURS).recent,
    ).toEqual([edge])
  })
})

describe('toDvrIngestItems', () => {
  it('maps a full row to the rust-side snake_case shape', () => {
    expect(toDvrIngestItems([notification()])).toEqual({
      unusable: 0,
      items: [
        {
          serial_no: 'SER-1',
          file_name: 'F1.vdf',
          vehicle_cd: '2131',
          vehicle_name: '大型1号',
          driver_name: '運転 太郎',
          event_type: '急ブレーキ',
          dvr_datetime: '2026-07-03T09:32:26Z',
          source_url: 'notify/F1.vdf',
        },
      ],
    })
  })

  it('★ source_url は欠落と空文字を null の 1 通りに畳む', () => {
    // theearth は `FilePath: ""` を実際に返す (venus client の実データ)。空文字と null が
    // 混ざると「値が無かった」と「欄ごと無かった」を後から区別できない。
    expect(toDvrIngestItems([notification({ filePath: null })]).items[0]!.source_url).toBeNull()
    expect(toDvrIngestItems([notification({ filePath: '' })]).items[0]!.source_url).toBeNull()
    // 他の列は空文字のまま (rust 側が NOT NULL を期待している)
    const bare = toDvrIngestItems([notification({ filePath: '', vehicleCd: null })]).items[0]!
    expect(bare.vehicle_cd).toBe('')
  })

  it('falls back to empty strings for the display columns, null for the two nullable ones', () => {
    const bare = notification({
      vehicleCd: null,
      vehicleName: null,
      driverName: null,
      eventType: null,
      dvrDatetime: null,
      filePath: null,
    })
    expect(toDvrIngestItems([bare]).items[0]).toEqual({
      serial_no: 'SER-1',
      file_name: 'F1.vdf',
      vehicle_cd: '',
      vehicle_name: '',
      driver_name: '',
      event_type: '',
      // ★ 空文字ではなく null (source_url と同じ扱いの 2 欄目)
      dvr_datetime: null,
      source_url: null,
    })
  })

  it('★ counts rows missing the natural key instead of sending an empty one', () => {
    const noSerial = notification({ serialNo: null })
    const noFile = notification({ fileName: null })
    const result = toDvrIngestItems([noSerial, noFile, notification()])
    expect(result.items).toHaveLength(1)
    expect(result.unusable).toBe(2)
  })
})

describe('parseDvrNotificationsResponse', () => {
  it('reads inserted / skipped / pending', () => {
    expect(
      parseDvrNotificationsResponse(
        '{"inserted":2,"skipped":1,"pending":[{"id":"u1","serial_no":"S","file_name":"F.vdf"}]}',
      ),
    ).toEqual({
      inserted: 2,
      skipped: 1,
      pending: [{ id: 'u1', serial_no: 'S', file_name: 'F.vdf' }],
    })
  })

  it('keeps unreadable counters as null without failing the run', () => {
    expect(parseDvrNotificationsResponse('{"pending":[]}')).toEqual({
      inserted: null,
      skipped: null,
      pending: [],
    })
    expect(
      parseDvrNotificationsResponse('{"inserted":"2","skipped":1e999,"pending":[]}'),
    ).toEqual({ inserted: null, skipped: null, pending: [] })
  })

  it('★ loud-fails when pending is unreadable (空配列に倒すと静かに 1 件も保存しなくなる)', () => {
    expect(() => parseDvrNotificationsResponse('not json')).toThrow(DvrIngestError)
    expect(() => parseDvrNotificationsResponse('null')).toThrow(DvrIngestError)
    expect(() => parseDvrNotificationsResponse('[]')).toThrow(DvrIngestError)
    expect(() => parseDvrNotificationsResponse('{"inserted":0}')).toThrow(/pending 配列がありません/)
    expect(() => parseDvrNotificationsResponse('{"pending":["x"]}')).toThrow(
      /pending\[0\] がオブジェクトではありません/,
    )
    expect(() => parseDvrNotificationsResponse('{"pending":[null]}')).toThrow(
      /pending\[0\] がオブジェクトではありません/,
    )
    expect(() => parseDvrNotificationsResponse('{"pending":[[]]}')).toThrow(
      /pending\[0\] がオブジェクトではありません/,
    )
    expect(() =>
      parseDvrNotificationsResponse('{"pending":[{"serial_no":"S","file_name":"F"}]}'),
    ).toThrow(/pending\[0\] に id \/ serial_no \/ file_name/)
    expect(() =>
      parseDvrNotificationsResponse('{"pending":[{"id":"u","file_name":"F"}]}'),
    ).toThrow(/pending\[0\] に id \/ serial_no \/ file_name/)
    expect(() =>
      parseDvrNotificationsResponse('{"pending":[{"id":"u","serial_no":"S"}]}'),
    ).toThrow(/pending\[0\] に id \/ serial_no \/ file_name/)
  })
})

describe('parseDvrFileResponse', () => {
  it('reads the stored-file receipt', () => {
    expect(
      parseDvrFileResponse('{"id":"u1","file_status":"stored","size":384000,"r2_key":"dvr/u1.vdf"}'),
    ).toEqual({ id: 'u1', fileStatus: 'stored', size: 384000, r2Key: 'dvr/u1.vdf' })
  })

  it('falls back to all-null for unreadable bodies (保存の成否は status が答える)', () => {
    const allNull = { id: null, fileStatus: null, size: null, r2Key: null }
    expect(parseDvrFileResponse('not json')).toEqual(allNull)
    expect(parseDvrFileResponse('null')).toEqual(allNull)
    expect(parseDvrFileResponse('[]')).toEqual(allNull)
    expect(parseDvrFileResponse('{"id":"","file_status":7,"size":"1","r2_key":null}')).toEqual(
      allNull,
    )
  })
})

describe('planDvrFileWork', () => {
  it('★ splits by receiveState — ready を落とし、requestable だけ転送要求する', () => {
    const readyRow = pending({ id: 'a', serial_no: 'S1', file_name: 'A.vdf' })
    const requestableRow = pending({ id: 'b', serial_no: 'S2', file_name: 'B.vdf' })
    const inProgressRow = pending({ id: 'c', serial_no: 'S3', file_name: 'C.vdf' })
    const plan = planDvrFileWork(
      [readyRow, requestableRow, inProgressRow],
      [
        notification({ serialNo: 'S1', fileName: 'A.vdf', receiveState: 'ready' }),
        notification({ serialNo: 'S2', fileName: 'B.vdf', receiveState: 'requestable' }),
        notification({ serialNo: 'S3', fileName: 'C.vdf', receiveState: 'in_progress' }),
      ],
      DVR_MAX_FILES_PER_RUN,
    )
    expect(plan.ready).toEqual([readyRow])
    expect(plan.toRequest).toEqual([requestableRow])
    expect(plan.waiting).toEqual([inProgressRow])
  })

  it('defers a pending row that is not in the notification list at all', () => {
    const orphan = pending({ id: 'z', serial_no: 'S9', file_name: 'Z.vdf' })
    const plan = planDvrFileWork([orphan], [notification()], DVR_MAX_FILES_PER_RUN)
    expect(plan.ready).toEqual([])
    expect(plan.toRequest).toEqual([])
    expect(plan.waiting).toEqual([orphan])
  })

  it('★ caps each bucket at the limit and defers the overflow to the next run', () => {
    const rows = [1, 2, 3].map((n) =>
      pending({ id: `r${n}`, serial_no: `S${n}`, file_name: `R${n}.vdf` }),
    )
    const requestables = [1, 2, 3].map((n) =>
      pending({ id: `q${n}`, serial_no: `T${n}`, file_name: `Q${n}.vdf` }),
    )
    const notifications = [
      ...rows.map((r) =>
        notification({ serialNo: r.serial_no, fileName: r.file_name, receiveState: 'ready' }),
      ),
      ...requestables.map((r) =>
        notification({ serialNo: r.serial_no, fileName: r.file_name, receiveState: 'requestable' }),
      ),
    ]
    const plan = planDvrFileWork([...rows, ...requestables], notifications, 2)
    expect(plan.ready.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(plan.toRequest.map((r) => r.id)).toEqual(['q1', 'q2'])
    expect(plan.waiting.map((r) => r.id)).toEqual(['r3', 'q3'])
  })

  it('joins on serial_no + file_name (同じ file_name でも別 serial なら別物)', () => {
    const row = pending({ id: 'a', serial_no: 'S1', file_name: 'A.vdf' })
    const plan = planDvrFileWork(
      [row],
      [notification({ serialNo: 'S2', fileName: 'A.vdf', receiveState: 'ready' })],
      DVR_MAX_FILES_PER_RUN,
    )
    expect(plan.waiting).toEqual([row])
  })

  it('treats a notification with no serial / file name as a non-match', () => {
    const row = pending({ id: 'a', serial_no: 'S1', file_name: 'A.vdf' })
    const plan = planDvrFileWork(
      [row],
      [notification({ serialNo: null, fileName: null, receiveState: 'ready' })],
      DVR_MAX_FILES_PER_RUN,
    )
    expect(plan.waiting).toEqual([row])
  })
})

describe('dvrFileIngestPath', () => {
  it('puts the id in the path under the alc-internal-proxy prefix', () => {
    expect(dvrFileIngestPath('9f1c-uuid')).toBe('/alc-internal-proxy/api/dvr/files/9f1c-uuid')
  })

  it('escapes anything that would change the path shape', () => {
    expect(dvrFileIngestPath('a/../b')).toBe('/alc-internal-proxy/api/dvr/files/a%2F..%2Fb')
  })
})

describe('postDvrNotifications', () => {
  it('sends the shared-secret + tenant headers and a {items} body', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImpl: FetchLike = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response('{"inserted":1,"skipped":0,"pending":[]}', { status: 200 })
    }) as FetchLike

    const items = toDvrIngestItems([notification()]).items
    const result = await postDvrNotifications(
      { sharedSecret: 'shared-1', tenantId: 'tenant-a', items },
      fetchImpl,
    )

    expect(result).toEqual({ inserted: 1, skipped: 0, pending: [] })
    expect(capturedUrl).toBe(`${INTERNAL_PROXY_BASE}${DVR_NOTIFICATIONS_INGEST_PATH}`)
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['X-Alc-Proxy-Secret']).toBe('shared-1')
    expect(headers['X-Tenant-ID']).toBe('tenant-a')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ items })
  })

  it('loud-fails with the response body on non-2xx', async () => {
    const fetchImpl: FetchLike = (async () =>
      new Response('tenant mismatch', { status: 403 })) as FetchLike
    await expect(
      // ★ 空ではなく実物を送る — 空バッチは POST 自体を打たないので、
      // `items: []` のままだと **この陰性対照が rejects を測れなくなる**。
      postDvrNotifications(
        { sharedSecret: 's', tenantId: 't', items: toDvrIngestItems([notification()]).items },
        fetchImpl,
      ),
    ).rejects.toThrow(AlcInternalUploadError)
  })

  it('★ 空バッチは POST を打たない — rust は items: [] を 400 で弾く', async () => {
    // rust 側の doc は「items が空なら 400 (relay の bug を無言の 200 で隠さない)」。
    // sendViaAlcInternalProxy は非 2xx で throw するので、素で投げると
    // 「48h 窓に 1 件も無かった」だけで cron run 全体が失敗する。
    let calls = 0
    const fetchImpl: FetchLike = (async () => {
      calls += 1
      return new Response('{"inserted":0,"skipped":0,"pending":[]}', { status: 200 })
    }) as FetchLike

    const result = await postDvrNotifications(
      { sharedSecret: 's', tenantId: 't', items: [] },
      fetchImpl,
    )

    expect(calls).toBe(0)
    // ★ 観測性を落とさない — 0 件で埋める。`null` (「そこまで到達していない」) と混ぜない。
    expect(result).toEqual({ inserted: 0, skipped: 0, pending: [] })
  })
})

describe('putDvrFile', () => {
  // ★ 「end-to-end でストリームのまま流れる」とは書かない — auth-worker が forward 前に
  // `arrayBuffer()` でバッファする (2026-09-03 実読)。ここで測れるのは
  // **relay の DO がファイル全体を持たない**ことだけ。
  it('★ 1 ファイル 1 リクエストで、DO は body を読み切らずに渡す (octet-stream)', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x4e, 0x45, 0x54, 0x37, 0x38, 0x30]))
        controller.close()
      },
    })
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImpl: FetchLike = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response('{"id":"u1","file_status":"stored","size":6,"r2_key":"dvr/u1.vdf"}', {
        status: 200,
      })
    }) as FetchLike

    const result = await putDvrFile(
      { sharedSecret: 's', tenantId: 'tenant-a', id: 'u1', body },
      fetchImpl,
    )

    expect(result).toEqual({ id: 'u1', fileStatus: 'stored', size: 6, r2Key: 'dvr/u1.vdf' })
    expect(capturedUrl).toBe(`${INTERNAL_PROXY_BASE}/alc-internal-proxy/api/dvr/files/u1`)
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/octet-stream')
    expect(headers['X-Tenant-ID']).toBe('tenant-a')
    // **DO 側はバイト列に読み切っていない** — 受け取った stream をそのまま渡している
    // (この先の auth-worker で 1 度バッファされるが、それは relay の外)。
    expect(capturedInit?.body).toBe(body)
  })

  it('surfaces the 413 (32MB 超) body instead of swallowing it', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const fetchImpl: FetchLike = (async () =>
      new Response('file too large', { status: 413 })) as FetchLike
    await expect(
      putDvrFile({ sharedSecret: 's', tenantId: 't', id: 'u1', body }, fetchImpl),
    ).rejects.toThrow('file too large')
  })
})

describe('judgeDvrStaleness', () => {
  const now = new Date('2026-07-03T10:00:00Z')

  it('is not stale while the last success is recent', () => {
    expect(judgeDvrStaleness('2026-07-03T09:50:00Z', now, DVR_STALE_ALERT_HOURS)).toEqual({
      hoursSinceLastSuccess: 1 / 6,
      stale: false,
    })
  })

  it('★ goes stale at the threshold (10 分おきなので 3h = 18 回連続で失敗)', () => {
    expect(judgeDvrStaleness('2026-07-03T07:00:00Z', now, DVR_STALE_ALERT_HOURS)).toEqual({
      hoursSinceLastSuccess: 3,
      stale: true,
    })
    expect(judgeDvrStaleness('2026-07-03T04:00:00Z', now, DVR_STALE_ALERT_HOURS).stale).toBe(true)
  })

  it('reports null (not stale) when it has never succeeded or the stamp is unreadable', () => {
    expect(judgeDvrStaleness(null, now, DVR_STALE_ALERT_HOURS)).toEqual({
      hoursSinceLastSuccess: null,
      stale: false,
    })
    expect(judgeDvrStaleness('', now, DVR_STALE_ALERT_HOURS)).toEqual({
      hoursSinceLastSuccess: null,
      stale: false,
    })
    expect(judgeDvrStaleness('いつか', now, DVR_STALE_ALERT_HOURS)).toEqual({
      hoursSinceLastSuccess: null,
      stale: false,
    })
  })
})
