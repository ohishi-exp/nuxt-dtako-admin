import { describe, it, expect } from 'vitest'
import {
  operationTrackNote,
  operationRouteMapTitle,
  net780ZipAvailability,
  net780ZipFileName,
} from '~/utils/operation-detail-view'

describe('operationTrackNote', () => {
  it('NET780 が引けて軌跡が出たら NET780 を採る', () => {
    expect(operationTrackNote({ status: 'ready', net780Segments: 3, eventSegments: 5 }))
      .toEqual({ source: 'net780', text: '軌跡: NET780 の道なり GPS' })
  })

  it('NET780 が未アーカイブならイベント軌跡に落ち、理由を言う', () => {
    const note = operationTrackNote({ status: 'not-found', net780Segments: 0, eventSegments: 4 })
    expect(note.source).toBe('event')
    // **「無い」と「読めなかった」を同じ文言にしない** (Refs #873)。
    expect(note.text).toBe('軌跡: イベント行の GPS (重ね掛け行も含む) — この運行の NET780 はまだアーカイブされていません')
  })

  it('NET780 の取得に失敗したときは未アーカイブと別の文言になる', () => {
    const failed = operationTrackNote({ status: 'error', net780Segments: 0, eventSegments: 4 })
    const missing = operationTrackNote({ status: 'not-found', net780Segments: 0, eventSegments: 4 })
    expect(failed.text).toBe('軌跡: イベント行の GPS (重ね掛け行も含む) — NET780 の取得に失敗しました')
    expect(failed.text).not.toBe(missing.text)
  })

  it('まだ読み込んでいない / 確認中も別の文言になる', () => {
    expect(operationTrackNote({ status: 'idle', net780Segments: 0, eventSegments: 2 }).text)
      .toBe('軌跡: イベント行の GPS (重ね掛け行も含む) — NET780 はまだ読み込んでいません')
    expect(operationTrackNote({ status: 'loading', net780Segments: 0, eventSegments: 2 }).text)
      .toBe('軌跡: イベント行の GPS (重ね掛け行も含む) — NET780 を確認中')
  })

  it('NET780 はあるが便の時間帯に GPS が無いときは、それを言う', () => {
    // アーカイブ済み (`ready`) でも `splitTrackByWindows` が 0 本になることはある
    // (便の時間窓に入る有効な GPS が無い運行)。「未アーカイブ」と混ぜない。
    const note = operationTrackNote({ status: 'ready', net780Segments: 0, eventSegments: 3 })
    expect(note.source).toBe('event')
    expect(note.text).toBe('軌跡: イベント行の GPS (重ね掛け行も含む) — NET780 はありますが、便の時間帯に有効な GPS がありません')
  })

  it('どちらの軌跡も無いときは「軌跡なし」と言い切る (黙って線を消さない)', () => {
    const note = operationTrackNote({ status: 'not-found', net780Segments: 0, eventSegments: 0 })
    expect(note).toEqual({
      source: 'none',
      text: '軌跡なし — この運行の NET780 はまだアーカイブされていません',
    })
  })

  it('軌跡なしのときも理由は状態ごとに違う', () => {
    expect(operationTrackNote({ status: 'ready', net780Segments: 0, eventSegments: 0 }).text)
      .toBe('軌跡なし — NET780 はありますが、便の時間帯に有効な GPS がありません')
    expect(operationTrackNote({ status: 'error', net780Segments: 0, eventSegments: 0 }).text)
      .toBe('軌跡なし — NET780 の取得に失敗しました')
  })
})

describe('operationRouteMapTitle', () => {
  const base = { unkoNo: '2607010121120000001318', readingDate: '2026-07-01' }

  it('便を数えられたときだけ本数を出す', () => {
    expect(operationRouteMapTitle({ ...base, legCount: 2 }))
      .toBe('運行 2607010121120000001318 (読取日 2026-07-01) — 便 2 本')
  })

  it('★ GPS 列が無い CSV (legCount 0) で「便 0 本」と名乗らない', () => {
    // `buildOperationRoute` は GPS 列が無いと `emptyRoute()` = legCount 0 を返す。
    // そのまま出すと「便が 1 本も無い運行」に読めるが、実際は**数えられなかった**だけ。
    const title = operationRouteMapTitle({ ...base, legCount: 0 })
    expect(title).toBe('運行 2607010121120000001318 (読取日 2026-07-01)')
    expect(title).not.toContain('便')
  })

  it('CSV をまだ読んでいない (null) ときも本数を出さない', () => {
    expect(operationRouteMapTitle({ ...base, legCount: null }))
      .toBe('運行 2607010121120000001318 (読取日 2026-07-01)')
  })

  it('読取日が無ければ - にする (空欄で詰めない)', () => {
    expect(operationRouteMapTitle({ ...base, readingDate: null, legCount: 3 }))
      .toBe('運行 2607010121120000001318 (読取日 -) — 便 3 本')
    expect(operationRouteMapTitle({ ...base, readingDate: undefined, legCount: 3 }))
      .toBe('運行 2607010121120000001318 (読取日 -) — 便 3 本')
  })

  it('便が多い運行でも本数はそのまま出る (5 で回さない)', () => {
    // イベント表の便の色は 5 色循環 (`LEG_COLOR_COUNT`) だが、**地図側は色で便を
    // 表さない** (色は 種別、便は数字)。本数・便番号は循環させない。
    expect(operationRouteMapTitle({ ...base, legCount: 12 })).toContain('便 12 本')
  })
})

describe('net780ZipAvailability', () => {
  it('アーカイブ済み (ready) のときだけ出せる', () => {
    expect(net780ZipAvailability('ready')).toEqual({ canDownload: true, reason: null, tone: 'muted' })
  })

  it('未アーカイブは「出せない」と語で言い、検索へ誘導する', () => {
    const a = net780ZipAvailability('not-found')
    expect(a.canDownload).toBe(false)
    expect(a.reason).toBe('この運行の NET780 はまだアーカイブされていないため、zip を出せません (下の検索から取得してください)')
  })

  it('5 状態が 1 つも同じ文言にならない', () => {
    // 「まだ読み込んでいない」/「アーカイブされていない」/「取得に失敗した」を
    // 同じ見た目にしないことがこの機能の要件そのもの (Refs #873)。
    const statuses = ['idle', 'loading', 'ready', 'not-found', 'error'] as const
    const reasons = statuses.map(s => net780ZipAvailability(s).reason)
    expect(new Set(reasons).size).toBe(statuses.length)
    expect(reasons.filter(r => r === null)).toHaveLength(1)
  })

  it('取得に失敗したときだけ赤字 (tone: error)', () => {
    expect(net780ZipAvailability('error').tone).toBe('error')
    expect(net780ZipAvailability('not-found').tone).toBe('muted')
    expect(net780ZipAvailability('idle').tone).toBe('muted')
    expect(net780ZipAvailability('loading').tone).toBe('muted')
  })
})

describe('net780ZipFileName', () => {
  it('運行NO がそのまま読めるファイル名になる', () => {
    expect(net780ZipFileName('2607010121120000001318')).toBe('net780-2607010121120000001318.zip')
  })
})
