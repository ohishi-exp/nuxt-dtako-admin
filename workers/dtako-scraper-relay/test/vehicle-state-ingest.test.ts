import { describe, expect, it } from 'vitest'

import {
  DTAKO_LOGS_BULK_PATH,
  DTAKO_LOGS_DATETIME_FALLBACK,
  DEVICE_TOKEN_PATH,
  ingestVehicleStates,
  mintDtakoLogsDeviceToken,
  parseDtakoLogsBulkResponse,
  toDtakoLogsBulkRecords,
  toDtakoLogsDataDateTime,
  VEHICLE_STATE_ALL_BRANCHES,
  VehicleStateIngestError,
} from '../src/vehicle-state-ingest'

/**
 * 車輌動態 (`dtako_logs`) 取り込みの pure ロジック (Refs #1098)。
 *
 * ★ ここで測るのは「**旧 pipeline と同じ body を送る**」ことに尽きる。
 * 受け手 (`rust-alc-api` の `DtakologInput`) は 57 フィールドあり、PK は
 * `(tenant_id, data_date_time, vehicle_cd)`。値を組み直すと
 *
 * - 列が落ちる (画面が読む `AddressDispP` / `AllState` / `State2` …)
 * - 緯度経度が丸まる (DB は INTEGER、DDMM の生値を入れる列)
 * - PK がずれて upsert が当たらず行が二重になる
 *
 * のどれかが起きるが、**どれも 200 が返ったまま起きる**ので送信側からは見えない。
 * だから「触っていないこと」を対照で固定する。
 */

/** theearth の `VehicleStateTableForBranchEx` が返す 1 台ぶん (実データの形。
 * 値は架空)。**57 フィールド全部は書かない** — ここで見たいのは「触らずに通る」ことなので、
 * 触りうる型 (string / number / null / 真偽) を代表させれば足りる。 */
function vehicleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __type: 'VehicleSetStateData:#Venus',
    VehicleCD: 2131,
    VehicleName: '大型1号',
    BranchCD: 1,
    BranchName: '本社',
    DriverCD: 1078,
    DriverName: '運転 太郎',
    SubDriverCD: 0,
    // ★ DDMM の生値 (度×1e6 + 分×1e4 + 分の小数)。十進度に変換すると INTEGER 列で
    // 35 に落ちる — **変換されていないこと**がこの fixture の主役。
    GPSLatitude: 34733210,
    GPSLongitude: 137723450,
    GPSDirection: 180,
    GPSEnable: 1,
    Speed: 42.5,
    Revo: 1500,
    DataDateTime: '26/09/03 07:20',
    ComuDateTime: '26/09/03 07:21',
    CurrentWorkName: '運転',
    AddressDispP: '静岡県浜松市中央区',
    AddressDispC: '国道1号',
    AllState: '走行中',
    AllStateEx: null,
    State2: '積車',
    ReciveTypeColorName: 'Lime',
    AllStateFontColor: 'Black',
    ODOMeter: '123456',
    ...overrides,
  }
}

describe('toDtakoLogsDataDateTime — ★ 旧 pipeline とバイト等価', () => {
  it('"YY/MM/DD HH:mm" を RFC3339 (+09:00) に直す', () => {
    // 旧 pipeline (browser-render-rust の convert_data_date_time) が
    // chrono の to_rfc3339() で出していた形と 1 文字も違わないこと。
    expect(toDtakoLogsDataDateTime('26/09/03 07:20')).toBe('2026-09-03T07:20:00+09:00')
    expect(toDtakoLogsDataDateTime('24/11/28 10:37')).toBe('2024-11-28T10:37:00+09:00')
  })

  it('0 埋めされていない月日時分も受ける (chrono の %m/%d/%H/%M と同じ)', () => {
    expect(toDtakoLogsDataDateTime('26/9/3 7:20')).toBe('2026-09-03T07:20:00+09:00')
  })

  it('★ 空文字は rust 側の既定値と同じ値に落ちる (行を割らない)', () => {
    // rust の bulk_upsert が None に対して入れる値と同じ。ここがずれると
    // 「GPS 未捕捉」の行が 2 つに割れる。
    expect(toDtakoLogsDataDateTime('')).toBe(DTAKO_LOGS_DATETIME_FALLBACK)
    expect(DTAKO_LOGS_DATETIME_FALLBACK).toBe('2020-01-01T00:00:00+09:00')
  })

  it('★ 解釈できない値は捨てずに "20"+入力 で通す (旧 pipeline の fallback と同じ)', () => {
    expect(toDtakoLogsDataDateTime('09/03 07:20')).toBe('2009/03 07:20')
    expect(toDtakoLogsDataDateTime('not a date')).toBe('20not a date')
  })

  it('★ 存在しない日付は繰り上げずに fallback へ落とす (chrono と同じ範囲を落とす)', () => {
    // Date.UTC は 26/02/30 を 03/02 へ繰り上げる。繰り上げたまま通すと
    // 実在しない日の行が「正しい形」で入ってしまうので、fallback に倒す。
    expect(toDtakoLogsDataDateTime('26/02/30 10:00')).toBe('2026/02/30 10:00')
    expect(toDtakoLogsDataDateTime('26/13/01 10:00')).toBe('2026/13/01 10:00')
    expect(toDtakoLogsDataDateTime('26/09/03 24:00')).toBe('2026/09/03 24:00')
    expect(toDtakoLogsDataDateTime('26/09/03 10:60')).toBe('2026/09/03 10:60')
    expect(toDtakoLogsDataDateTime('26/00/03 10:00')).toBe('2026/00/03 10:00')
  })
})

describe('toDtakoLogsBulkRecords — ★ DataDateTime 以外を 1 つも触らない', () => {
  it('DataDateTime だけが差し替わり、残りは値も型も同一', () => {
    const row = vehicleRow()
    const [out] = toDtakoLogsBulkRecords([row])

    expect(out.DataDateTime).toBe('2026-09-03T07:20:00+09:00')

    // ★ 陰性対照の本体 — DataDateTime 以外の全キーが入力と `Object.is` で一致すること。
    // 「57 フィールドのうち 1 つを射影で落とした」を検出する。
    const untouched = Object.keys(row).filter((k) => k !== 'DataDateTime')
    expect(untouched.length).toBeGreaterThan(20)
    for (const key of untouched) {
      expect(out[key]).toBe(row[key])
    }
    expect(Object.keys(out).sort()).toEqual(Object.keys(row).sort())
  })

  it('★ 緯度経度は DDMM の生値のまま (十進度へ変換しない)', () => {
    // 変換すると 34.733… になり、DB の INTEGER 列で 34 に丸まって地図が壊れる。
    const [out] = toDtakoLogsBulkRecords([vehicleRow()])
    expect(out.GPSLatitude).toBe(34733210)
    expect(out.GPSLongitude).toBe(137723450)
  })

  it('★ ComuDateTime は変換しない (差し替えるのは DataDateTime だけ)', () => {
    const [out] = toDtakoLogsBulkRecords([vehicleRow()])
    expect(out.ComuDateTime).toBe('26/09/03 07:21')
  })

  it('DataDateTime が文字列でない (欠損 / null) 行は触らない', () => {
    const missing = vehicleRow()
    delete missing.DataDateTime
    const [a, b] = toDtakoLogsBulkRecords([missing, vehicleRow({ DataDateTime: null })])
    expect('DataDateTime' in a).toBe(false)
    expect(b.DataDateTime).toBeNull()
  })

  it('入力の配列は書き換えない (複製して返す)', () => {
    const row = vehicleRow()
    toDtakoLogsBulkRecords([row])
    expect(row.DataDateTime).toBe('26/09/03 07:20')
  })

  it('空配列はそのまま空配列', () => {
    expect(toDtakoLogsBulkRecords([])).toEqual([])
  })
})

describe('parseDtakoLogsBulkResponse', () => {
  it('rust の BulkUpsertResponse を読む', () => {
    expect(
      parseDtakoLogsBulkResponse(
        '{"success":true,"records_added":199,"total_records":199,"message":""}',
      ),
    ).toEqual({ success: true, recordsAdded: 199, totalRecords: 199 })
  })

  it('★ 読めない件数は null (0 に丸めない)', () => {
    // 「0 件だった」と「応答に無い = 不明」は別物。丸めると旧 alc 相手に嘘をつく
    // (parseAlcUploadResponse と同じ方針)。
    expect(parseDtakoLogsBulkResponse('{"success":true}')).toEqual({
      success: true,
      recordsAdded: null,
      totalRecords: null,
    })
    expect(parseDtakoLogsBulkResponse('{"success":true,"records_added":"199"}').recordsAdded).toBeNull()
    expect(parseDtakoLogsBulkResponse('{"success":true,"total_records":null}').totalRecords).toBeNull()
  })

  it('JSON でない / オブジェクトでない応答は success=false', () => {
    const unknownShape = { success: false, recordsAdded: null, totalRecords: null }
    expect(parseDtakoLogsBulkResponse('<html>502</html>')).toEqual(unknownShape)
    expect(parseDtakoLogsBulkResponse('null')).toEqual(unknownShape)
    expect(parseDtakoLogsBulkResponse('[1,2]')).toEqual({
      success: false,
      recordsAdded: null,
      totalRecords: null,
    })
  })

  it('success が true 以外は false に倒す', () => {
    expect(parseDtakoLogsBulkResponse('{"success":"true"}').success).toBe(false)
  })
})

// ★ **架空の値** (実物ではない)。device credential の実物はこの repo (public) の
// コードにもテストにも置かない — 正は auth-worker の device record 側。
const CRED = { deviceId: 'dummy-device-id', deviceSecret: 'dummy-device-secret' }

interface Call {
  url: string
  init: RequestInit | undefined
}

/** `AUTH_WORKER` service binding の fetch を差し替える。 */
function stubAuthWorker(responses: Response[]): {
  calls: Call[]
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
} {
  const calls: Call[] = []
  const queue = [...responses]
  return {
    calls,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init })
      const res = queue.shift()
      if (!res) throw new Error(`unexpected extra call (#${calls.length})`)
      return res
    },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('mintDtakoLogsDeviceToken', () => {
  it('device_id / device_secret を POST し access_token を返す', async () => {
    const { calls, fetchImpl } = stubAuthWorker([json({ access_token: 'jwt-1' })])
    expect(await mintDtakoLogsDeviceToken(CRED, fetchImpl)).toBe('jwt-1')
    expect(calls[0].url.endsWith(DEVICE_TOKEN_PATH)).toBe(true)
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      device_id: 'dummy-device-id',
      device_secret: 'dummy-device-secret',
    })
  })

  it('★ 非 2xx は本文付き loud fail (「送ったつもり」を作らない)', async () => {
    const { fetchImpl } = stubAuthWorker([json({ error: 'Unauthorized' }, 401)])
    await expect(mintDtakoLogsDeviceToken(CRED, fetchImpl)).rejects.toThrow(
      /\/device\/token failed \(401\): .*Unauthorized/,
    )
  })

  it('★ device_secret を例外メッセージに載せない', async () => {
    const { fetchImpl } = stubAuthWorker([json({ error: 'Unauthorized' }, 401)])
    const err = await mintDtakoLogsDeviceToken(CRED, fetchImpl).catch((e: unknown) => e)
    expect(String(err)).not.toContain('dummy-device-secret')
    expect(err).toBeInstanceOf(VehicleStateIngestError)
  })

  it('JSON でない / access_token が無い応答も loud fail', async () => {
    const a = stubAuthWorker([new Response('<html>', { status: 200 })])
    await expect(mintDtakoLogsDeviceToken(CRED, a.fetchImpl)).rejects.toThrow(/JSON ではありません/)
    const b = stubAuthWorker([json({})])
    await expect(mintDtakoLogsDeviceToken(CRED, b.fetchImpl)).rejects.toThrow(/access_token がありません/)
    const c = stubAuthWorker([json({ access_token: '' })])
    await expect(mintDtakoLogsDeviceToken(CRED, c.fetchImpl)).rejects.toThrow(/access_token がありません/)
    const d = stubAuthWorker([new Response('null', { status: 200 })])
    await expect(mintDtakoLogsDeviceToken(CRED, d.fetchImpl)).rejects.toThrow(/access_token がありません/)
  })
})

describe('ingestVehicleStates', () => {
  const OK = json({ success: true, records_added: 1, total_records: 1, message: '' })

  it('mint → device-data-proxy の順に叩き、Bearer と生レコードを載せる', async () => {
    const { calls, fetchImpl } = stubAuthWorker([json({ access_token: 'jwt-1' }), OK])
    const outcome = await ingestVehicleStates({ cred: CRED, rows: [vehicleRow()] }, fetchImpl)

    expect(outcome).toEqual({ success: true, recordsAdded: 1, totalRecords: 1 })
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      DEVICE_TOKEN_PATH,
      DTAKO_LOGS_BULK_PATH,
    ])

    const headers = calls[1].init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer jwt-1')
    expect(headers['Content-Type']).toBe('application/json')

    // ★ body は生レコードの配列そのもの (ラッパオブジェクトで包まない)。
    const sent = JSON.parse(String(calls[1].init?.body)) as Array<Record<string, unknown>>
    expect(sent).toHaveLength(1)
    expect(sent[0].GPSLatitude).toBe(34733210)
    expect(sent[0].AddressDispP).toBe('静岡県浜松市中央区')
    expect(sent[0].DataDateTime).toBe('2026-09-03T07:20:00+09:00')
  })

  it('★★ 空バッチを送らない — theearth が 0 台なら取得の失敗として落とす', async () => {
    // rust は空 body に 200 + records_added:0 を返してしまうので、ここで落とさないと
    // 「毎回成功しているのに画面が更新されない」無音故障になる (#1094 で踏んだ形)。
    const { calls, fetchImpl } = stubAuthWorker([])
    await expect(ingestVehicleStates({ cred: CRED, rows: [] }, fetchImpl)).rejects.toThrow(
      /車輌が 1 台も取れませんでした/,
    )
    // device token の mint すらしない (allowlist 外の path を叩く前に止めるのと同じ作法)。
    expect(calls).toEqual([])
  })

  it('★ 非 2xx は本文付き loud fail', async () => {
    const { fetchImpl } = stubAuthWorker([
      json({ access_token: 'jwt-1' }),
      json({ error: 'forbidden' }, 403),
    ])
    await expect(
      ingestVehicleStates({ cred: CRED, rows: [vehicleRow()] }, fetchImpl),
    ).rejects.toThrow(/dtako-logs\/bulk failed \(403\): .*forbidden/)
  })

  it('★ 200 でも success:true でなければ失敗として扱う', async () => {
    // 「200 が返った = 入った」ではない。success を見ないと、上流が形を変えた日に
    // 静かに 0 件になる。
    const { fetchImpl } = stubAuthWorker([
      json({ access_token: 'jwt-1' }),
      json({ success: false, message: 'nope' }),
    ])
    await expect(
      ingestVehicleStates({ cred: CRED, rows: [vehicleRow()] }, fetchImpl),
    ).rejects.toThrow(/success=true を返しませんでした/)
  })
})

describe('定数', () => {
  it('★ 事業所コードは全事業所 ("00000000") — 旧 pipeline と同じ 1 回の取得', () => {
    // getDvrMasters の branches[].code を 1 件ずつ回すと、同じ 199 台を事業所ぶん
    // 分割して取ることになり theearth への往復だけが増える。
    expect(VEHICLE_STATE_ALL_BRANCHES).toBe('00000000')
  })

  it('投入先は auth-worker の allowlist に載っている 1 本', () => {
    expect(DTAKO_LOGS_BULK_PATH).toBe('/device-data-proxy/api/dtako-logs/bulk')
    expect(DEVICE_TOKEN_PATH).toBe('/device/token')
  })
})
