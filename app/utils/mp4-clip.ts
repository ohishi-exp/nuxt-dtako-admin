/**
 * mp4box.js でデコード済み MP4 (front/rearMp4) から時間範囲を無劣化で切り出す。
 *
 * 前方/後方映像は既に `Blob` として保持されている完全な MP4 バイト列なので、
 * 実時間で録画し直す ({@link ../pages/vid-check.vue} の `clipAndDownload` 旧実装)
 * 必要はなく、コンテナレベルでフラグメント化して該当区間だけ抜き出せる。
 *
 * 実装メモ (ffmpeg でフルデコードして正当性を検証済み):
 * - サンプル番号は 0-index。`getTrackSamplesInfo()` で全サンプルの cts/is_sync を取得できる
 * - 開始点は `startSec` 以前の直近の同期サンプル (キーフレーム) に丸める (その手前から
 *   デコードしないと復号できないため)。終了点は `endSec` 以降の最初のサンプルまで含める
 * - `initializeSegmentation()` (combined モード) が返す init segment (ftyp+moov) は
 *   fragmented 用に用意された特別な moov であり、`ISOFile.moov` を生の状態で使うと
 *   壊れたファイルになる (実際に検証して確認した失敗パターン)
 * - `onSegment(id, user, buffer, nextSample)` の `nextSample` はこのフラグメントの
 *   「次の」サンプル境界。1つ前の呼び出しの `nextSample` から今回の `nextSample` 未満が
 *   実際にこのフラグメントに含まれるサンプル範囲になる (`nbSamples: 1` を指定しても
 *   映像トラックは GOP 単位でしかフラグメント化されない)
 * - `appendBuffer()` に完全なバッファを一度に渡せば `onReady`/`onSegment` は
 *   すべて同期的に完了する (非同期待ちは不要)
 */

import { createFile, MP4BoxBuffer } from 'mp4box'
import type { Movie } from 'mp4box'

interface TrackBounds { startNum: number, endNum: number }

/**
 * `startSec`〜`endSec` (秒) の範囲を含む MP4 Blob を返す。
 * 対応できない構造 (トラックなし、フラグメント化失敗等) の場合は例外を投げる —
 * 呼び出し側で実時間録画へのフォールバックを想定している。
 */
export function extractMp4TimeRange(source: ArrayBuffer, startSec: number, endSec: number): Blob {
  if (!(endSec > startSec)) throw new Error(`mp4box: invalid time range [${startSec}, ${endSec}]`)

  const mp4boxFile = createFile()

  const segmentsByTrack = new Map<number, { order: number, buffer: ArrayBuffer }[]>()
  const prevBoundaryByTrack = new Map<number, number>()
  const boundsByTrack = new Map<number, TrackBounds>()
  let order = 0
  let initBuffer: ArrayBuffer | null = null
  let parseError: string | null = null

  mp4boxFile.onError = (module: string, msg: string) => {
    parseError = `mp4box (${module}): ${msg}`
  }

  mp4boxFile.onReady = (info: Movie) => {
    for (const track of info.tracks) {
      const samples = mp4boxFile.getTrackSamplesInfo(track.id)
      if (samples.length === 0) continue

      let startNum = 0
      for (const s of samples) {
        if (!s.is_sync) continue
        if (s.cts / s.timescale <= startSec) startNum = s.number
        else break
      }
      let endNum = samples.length - 1
      for (const s of samples) {
        if (s.cts / s.timescale >= endSec) {
          endNum = s.number
          break
        }
      }

      boundsByTrack.set(track.id, { startNum, endNum })
      prevBoundaryByTrack.set(track.id, 0)
      segmentsByTrack.set(track.id, [])
      mp4boxFile.setSegmentOptions(track.id, track.id, { nbSamples: 1 })
    }

    if (boundsByTrack.size === 0) return

    const initSeg = mp4boxFile.initializeSegmentation()
    initBuffer = initSeg.buffer

    mp4boxFile.onSegment = (id: number, _user: unknown, buffer: ArrayBuffer, nextSample: number) => {
      const prev = prevBoundaryByTrack.get(id) ?? 0
      const bounds = boundsByTrack.get(id)
      prevBoundaryByTrack.set(id, nextSample)
      if (!bounds) return
      // [prev, nextSample) が希望範囲 [startNum, endNum] と重なるフラグメントだけ採用
      if (nextSample > bounds.startNum && prev <= bounds.endNum) {
        segmentsByTrack.get(id)!.push({ order: order++, buffer })
      }
    }

    mp4boxFile.start()
  }

  const mp4Buffer = MP4BoxBuffer.fromArrayBuffer(source, 0)
  mp4boxFile.appendBuffer(mp4Buffer)
  mp4boxFile.flush()

  if (parseError) throw new Error(parseError)
  if (!initBuffer) throw new Error('mp4box: moov の解析に失敗しました (トラックが見つかりません)')

  const all: { order: number, buffer: ArrayBuffer }[] = []
  for (const chunks of segmentsByTrack.values()) all.push(...chunks)
  if (all.length === 0) throw new Error('mp4box: 指定範囲に対応するフラグメントが生成できませんでした')
  all.sort((a, b) => a.order - b.order)

  return new Blob([initBuffer, ...all.map(c => c.buffer)], { type: 'video/mp4' })
}
