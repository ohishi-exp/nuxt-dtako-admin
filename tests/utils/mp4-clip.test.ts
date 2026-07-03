/**
 * `app/utils/mp4-clip.ts` の構造検証テスト。
 *
 * この環境 (vitest/happy-dom) では実際の H.264 デコードは検証できないため、
 * 出力 Blob を mp4box.js 自身で再パースし、box 構造 (ftyp/moov が有効、
 * トラック数・duration が妥当) をアサートすることで正当性を担保する。
 * 実 H.264 デコードによる最終確認は ffmpeg (CLI) で別途実施済み
 * (`Refs ohishi-exp/dtako-scraper#20`)。
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFile } from 'mp4box'
import type { Movie } from 'mp4box'
import { extractMp4TimeRange } from '../../app/utils/mp4-clip'

const FIXTURE_PATH = resolve(__dirname, '../fixtures/mp4-clip-sample.mp4')

/** fixture: 2秒 / 64x64 / 5fps (video, GOP=5) + AAC 32kbps (audio) の最小 MP4。 */
let sourceBytes: ArrayBuffer

beforeAll(() => {
  const buf = readFileSync(FIXTURE_PATH)
  sourceBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
})

function cloneSource(): ArrayBuffer {
  return sourceBytes.slice(0)
}

/** mp4box.js で再パースし、有効な moov (トラック情報) が読めることを確認する。 */
function parseStructure(blob: Blob): Promise<Movie> {
  return blob.arrayBuffer().then(ab => new Promise<Movie>((resolve, reject) => {
    const file = createFile()
    file.onError = (module: string, msg: string) => reject(new Error(`${module}: ${msg}`))
    file.onReady = (info: Movie) => resolve(info)
    const buf = ab as ArrayBuffer & { fileStart: number }
    buf.fileStart = 0
    file.appendBuffer(buf)
    file.flush()
  }))
}

/** 各トラックの先頭サンプルの dts (トラック timescale 単位) を返す。 */
function firstSampleDts(blob: Blob): Promise<Map<number, number>> {
  return blob.arrayBuffer().then(ab => new Promise<Map<number, number>>((resolve, reject) => {
    const file = createFile()
    file.onError = (module: string, msg: string) => reject(new Error(`${module}: ${msg}`))
    file.onReady = (info: Movie) => {
      const result = new Map<number, number>()
      for (const track of info.tracks) {
        const samples = file.getTrackSamplesInfo(track.id)
        if (samples.length > 0) result.set(track.id, samples[0]!.dts)
      }
      resolve(result)
    }
    const buf = ab as ArrayBuffer & { fileStart: number }
    buf.fileStart = 0
    file.appendBuffer(buf)
    file.flush()
  }))
}

describe('extractMp4TimeRange', () => {
  it('中間区間を切り出すと video/audio 両トラックを含む有効な MP4 になる', async () => {
    const blob = extractMp4TimeRange(cloneSource(), 0.5, 1.5)
    expect(blob.type).toBe('video/mp4')
    expect(blob.size).toBeGreaterThan(0)

    const info = await parseStructure(blob)
    expect(info.tracks.length).toBe(2)
    expect(info.tracks.map(t => t.type).sort()).toEqual(['audio', 'video'])
  })

  it('先頭 (0秒) からの範囲でも有効な MP4 になる', async () => {
    const blob = extractMp4TimeRange(cloneSource(), 0, 1)
    const info = await parseStructure(blob)
    expect(info.tracks.length).toBe(2)
  })

  it('末尾を超える終了時刻を指定しても最終サンプルまでで有効な MP4 になる', async () => {
    const blob = extractMp4TimeRange(cloneSource(), 1, 999)
    const info = await parseStructure(blob)
    expect(info.tracks.length).toBe(2)
  })

  it('ファイル全体を指定すると元データとほぼ同等のトラック構成になる', async () => {
    const blob = extractMp4TimeRange(cloneSource(), 0, 999)
    const info = await parseStructure(blob)
    expect(info.tracks.length).toBe(2)
  })

  it('先頭以外の区間を切り出しても各トラックの先頭サンプルの dts が 0 起点になる (tfdt rebase)', async () => {
    // fixture は 2s/5fps/GOP=5 (video) なのでキーフレームは t=0s と t=1s。
    // 1.2〜1.9s を切り出すと元動画では先頭サンプルの dts は t=1s 相当 (非ゼロ) になるが、
    // これをそのまま出力すると tfdt が絶対時刻のままになり、Chrome の <video> が
    // 再生開始位置 (t=0) に対応フレームが無いとみなして何も表示しない不具合になる
    // (実機の破損クリップで確認済み)。rebase 後は先頭サンプルの dts が 0 になるはず。
    const blob = extractMp4TimeRange(cloneSource(), 1.2, 1.9)
    const dtsByTrack = await firstSampleDts(blob)
    expect(dtsByTrack.size).toBeGreaterThan(0)
    for (const dts of dtsByTrack.values()) {
      expect(dts).toBe(0)
    }
  })

  it('duration が 0 のままにならず、切り出した実際の長さを反映する (シークバーが動くために必要)', async () => {
    // duration=0 のままだと Chrome の <video controls> のシークバーが「総尺不明」として
    // 動かなくなる (実機で確認済み)。mvhd/tkhd/mdhd に実際の長さを書き込んでいるはず。
    const blob = extractMp4TimeRange(cloneSource(), 0.5, 1.5)
    const info = await parseStructure(blob)
    expect(info.duration).toBeGreaterThan(0)
    expect(info.duration / info.timescale).toBeGreaterThan(0.5)
    for (const track of info.tracks) {
      expect(track.duration).toBeGreaterThan(0)
    }
  })

  it('MP4 として解釈できないデータには例外を投げる (呼び出し側のフォールバック契機)', () => {
    const garbage = new Uint8Array(64).buffer
    expect(() => extractMp4TimeRange(garbage, 0, 1)).toThrow()
  })

  it('end <= start のような無効な範囲でも例外を投げる', () => {
    expect(() => extractMp4TimeRange(cloneSource(), 1, 1)).toThrow()
  })
})
