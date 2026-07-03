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
 * - **`moof/traf/tfdt.baseMediaDecodeTime` は元動画の絶対時刻のまま出力される。**
 *   `mvhd`/`tkhd` の duration は 0 (fragmented 前提) なので、これを再生する player は
 *   最終サンプルの絶対 dts を「動画長」とみなす。切り出し区間が動画の先頭でない場合
 *   (例: 17〜37 秒目を抜き出す)、`[0, 17s)` に対応するサンプルが存在しないまま
 *   duration だけ 37s 相当になり、Chrome の `<video>` は再生開始位置 (t=0) に
 *   フレームが無いため何も表示しない (実機で確認した実際の不具合、Refs 添付ファイルの
 *   ffprobe 解析結果と `tfdt` 実値)。出力する各フラグメントの `tfdt` を
 *   トラックごとに最初に採用したフラグメントの値を基準に 0 起点へ書き換えることで
 *   このギャップを解消する (バイト長が変わらないフィールドなので in-place 書き換えで済む)
 * - **`mvhd`/`tkhd`/`mdhd` の duration を 0 のままにすると、ネイティブの `<video controls>`
 *   のシークバーが動かない (総再生時間が不明/0 のため player がシーク不可と判断する)。**
 *   fragmented mp4 は本来ライブ配信等で総尺が未知な場合に duration=0 のままにする設計だが、
 *   このアプリでは切り出し区間の総サンプル数が既知なので、`getTrackSamplesInfo()` から
 *   実際の区間長を計算し、init segment の `mvhd`/`tkhd` (movie timescale) と各トラックの
 *   `mdhd` (track timescale) に書き込む。これらも FullBox の固定長フィールドなので
 *   version (0/1) を判定した上で in-place 書き換えで済む
 * - **複数ファイル (セグメント) をまたぐ範囲の切り出しも `extractMp4TimeRangeMulti` で
 *   無劣化のまま対応する。** 各セグメントは前方/後方それぞれ別の MP4 ファイル
 *   (別 `moov`/別 track_ID の可能性がある) なので、単純に moof/mdat を繋げただけでは
 *   再生できない。最初のセグメントの init segment (moov) を「代表」として全体で使い回し、
 *   2つ目以降のセグメントは track_ID が一致することを確認した上で、その fragment の
 *   tfdt をこのセグメント自身の 0 起点からさらに「それまでの累積長」だけシフトして
 *   連結する (時系列で途切れず連続する 1 本の timeline に見せかける)。track_ID が
 *   セグメント間で一致しない場合は結合を諦めて例外を投げる (呼び出し側でフォールバック)
 */

import { createFile, MP4BoxBuffer } from 'mp4box'
import type { Movie, Sample } from 'mp4box'

interface TrackBounds { startNum: number, endNum: number }
interface BoxLoc { headerSize: number, contentStart: number, contentEnd: number }

/** `start`〜`end` の範囲内で最初に見つかった fourcc の box 位置を返す (無ければ null) */
function findBox(view: DataView, start: number, end: number, fourcc: string): BoxLoc | null {
  let pos = start
  while (pos + 8 <= end) {
    let size = view.getUint32(pos, false)
    const type = String.fromCharCode(
      view.getUint8(pos + 4),
      view.getUint8(pos + 5),
      view.getUint8(pos + 6),
      view.getUint8(pos + 7),
    )
    let headerSize = 8
    if (size === 1) {
      // 64-bit extended size (largesize)
      const hi = view.getUint32(pos + 8, false)
      const lo = view.getUint32(pos + 12, false)
      size = hi * 2 ** 32 + lo
      headerSize = 16
    }
    else if (size === 0) {
      size = end - pos
    }
    if (size < headerSize || pos + size > end) break
    if (type === fourcc) {
      return { headerSize, contentStart: pos + headerSize, contentEnd: pos + size }
    }
    pos += size
  }
  return null
}

/** moof フラグメント内の traf/tfdt.baseMediaDecodeTime を読み取る (無ければ null) */
function readFragmentBaseDecodeTime(buf: ArrayBuffer): { view: DataView, tfdt: BoxLoc, value: number } | null {
  const view = new DataView(buf)
  const moof = findBox(view, 0, buf.byteLength, 'moof')
  if (!moof) return null
  const traf = findBox(view, moof.contentStart, moof.contentEnd, 'traf')
  if (!traf) return null
  const tfdt = findBox(view, traf.contentStart, traf.contentEnd, 'tfdt')
  if (!tfdt) return null
  const version = view.getUint8(tfdt.contentStart)
  const value = version === 1
    ? view.getUint32(tfdt.contentStart + 4, false) * 2 ** 32 + view.getUint32(tfdt.contentStart + 8, false)
    : view.getUint32(tfdt.contentStart + 4, false)
  return { view, tfdt, value }
}

/** 直前に `readFragmentBaseDecodeTime` で見つけた tfdt の値を書き換える (バイト長は不変) */
function writeFragmentBaseDecodeTime(view: DataView, tfdt: BoxLoc, newValue: number): void {
  const version = view.getUint8(tfdt.contentStart)
  if (version === 1) {
    view.setUint32(tfdt.contentStart + 4, Math.floor(newValue / 2 ** 32), false)
    view.setUint32(tfdt.contentStart + 8, newValue % 2 ** 32, false)
  }
  else {
    view.setUint32(tfdt.contentStart + 4, newValue, false)
  }
}

/** `start`〜`end` の範囲内に含まれる fourcc の box 位置を全て返す (moov 内の複数 trak 用) */
function findAllBoxes(view: DataView, start: number, end: number, fourcc: string): BoxLoc[] {
  const result: BoxLoc[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = view.getUint32(pos, false)
    const type = String.fromCharCode(
      view.getUint8(pos + 4),
      view.getUint8(pos + 5),
      view.getUint8(pos + 6),
      view.getUint8(pos + 7),
    )
    let headerSize = 8
    if (size === 1) {
      const hi = view.getUint32(pos + 8, false)
      const lo = view.getUint32(pos + 12, false)
      size = hi * 2 ** 32 + lo
      headerSize = 16
    }
    else if (size === 0) {
      size = end - pos
    }
    if (size < headerSize || pos + size > end) break
    if (type === fourcc) result.push({ headerSize, contentStart: pos + headerSize, contentEnd: pos + size })
    pos += size
  }
  return result
}

/**
 * mvhd/tkhd/mdhd (いずれも FullBox で `creation_time`/`modification_time`/(tkhd のみ
 * `track_ID`+`reserved`)/`timescale`(tkhd には無い)/`duration` の並び) の duration
 * フィールドを書き換える。`preDurationBytesV0`/`V1` は version+flags (4 bytes) の
 * 直後から duration 直前までのバイト数。
 */
function patchTimeBoxDuration(
  view: DataView,
  contentStart: number,
  preDurationBytesV0: number,
  preDurationBytesV1: number,
  newValue: number,
): void {
  const version = view.getUint8(contentStart)
  if (version === 1) {
    const offset = contentStart + 4 + preDurationBytesV1
    view.setUint32(offset, Math.floor(newValue / 2 ** 32), false)
    view.setUint32(offset + 4, newValue % 2 ** 32, false)
  }
  else {
    const offset = contentStart + 4 + preDurationBytesV0
    view.setUint32(offset, newValue, false)
  }
}

/** tkhd.track_ID を読み取る (version によらず 4 bytes 固定) */
function readTkhdTrackId(view: DataView, contentStart: number): number {
  const version = view.getUint8(contentStart)
  const offset = contentStart + 4 + (version === 1 ? 16 : 8)
  return view.getUint32(offset, false)
}

/**
 * init segment (ftyp+moov) の `mvhd`/`tkhd`/`mdhd` の duration を、実際に切り出した
 * サンプル範囲から計算した値へ書き換える。対応する box が見つからない場合は何もしない
 * (duration=0 のまま = 従来の fragmented mp4 として動作するだけで、致命的にはならない)。
 */
function patchInitSegmentDurations(
  initBuffer: ArrayBuffer,
  movieTimescale: number,
  durationByTrack: Map<number, { ticks: number, timescale: number }>,
): void {
  const view = new DataView(initBuffer)
  const moov = findBox(view, 0, initBuffer.byteLength, 'moov')
  if (!moov) return

  let movieDurationMovieTicks = 0
  for (const { ticks, timescale } of durationByTrack.values()) {
    const inMovieTicks = Math.round((ticks / timescale) * movieTimescale)
    movieDurationMovieTicks = Math.max(movieDurationMovieTicks, inMovieTicks)
  }

  const mvhd = findBox(view, moov.contentStart, moov.contentEnd, 'mvhd')
  if (mvhd) patchTimeBoxDuration(view, mvhd.contentStart, 12, 20, movieDurationMovieTicks)

  for (const trak of findAllBoxes(view, moov.contentStart, moov.contentEnd, 'trak')) {
    const tkhd = findBox(view, trak.contentStart, trak.contentEnd, 'tkhd')
    if (!tkhd) continue
    const trackId = readTkhdTrackId(view, tkhd.contentStart)
    const trackDuration = durationByTrack.get(trackId)
    if (!trackDuration) continue

    const inMovieTicks = Math.round((trackDuration.ticks / trackDuration.timescale) * movieTimescale)
    patchTimeBoxDuration(view, tkhd.contentStart, 16, 24, inMovieTicks)

    const mdia = findBox(view, trak.contentStart, trak.contentEnd, 'mdia')
    if (!mdia) continue
    const mdhd = findBox(view, mdia.contentStart, mdia.contentEnd, 'mdhd')
    if (!mdhd) continue
    patchTimeBoxDuration(view, mdhd.contentStart, 12, 20, trackDuration.ticks)
  }
}

interface SourceExtraction {
  /** ftyp+moov (fragmented 用)。トラックが1つも無ければ null */
  initBuffer: ArrayBuffer | null
  /** track_ID ごとの採用済みフラグメント (tfdt はこのソース自身の 0 起点に書き換え済み) */
  fragmentsByTrack: Map<number, { order: number, buffer: ArrayBuffer }[]>
  /** track_ID ごとのこのソース区間の長さ (このソース自身の track timescale 単位) */
  durationByTrack: Map<number, { ticks: number, timescale: number }>
  /** movie timescale (mvhd 由来)。durationByTrack の movie 単位への変換に使う */
  movieTimescale: number
}

/**
 * 1つの MP4 ソースから `startSec`〜`endSec` を切り出す共通ロジック。
 * tfdt は必ずこのソース自身の 0 起点に rebase 済みだが、init segment の
 * duration はまだ書き込んでいない (複数ソース結合時に合算してから書き込むため、
 * 単一ソースの `extractMp4TimeRange` はこの直後に自分で書き込む)。
 */
function extractSingleSource(source: ArrayBuffer, startSec: number, endSec: number): SourceExtraction {
  const mp4boxFile = createFile()

  const fragmentsByTrack = new Map<number, { order: number, buffer: ArrayBuffer }[]>()
  const prevBoundaryByTrack = new Map<number, number>()
  const boundsByTrack = new Map<number, TrackBounds>()
  const baselineByTrack = new Map<number, number>()
  const samplesByTrack = new Map<number, Sample[]>()
  const lastAcceptedNextByTrack = new Map<number, number>()
  let order = 0
  let initBuffer: ArrayBuffer | null = null
  let movieTimescale = 0
  let parseError: string | null = null

  mp4boxFile.onError = (module: string, msg: string) => {
    parseError = `mp4box (${module}): ${msg}`
  }

  mp4boxFile.onReady = (info: Movie) => {
    movieTimescale = info.timescale
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
      fragmentsByTrack.set(track.id, [])
      samplesByTrack.set(track.id, samples)
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
        // tfdt (絶対 decode time) をトラックごとに採用した最初のフラグメント基準で
        // 0 起点へ書き換える (書き換えないと再生開始位置に対応フレームが無く再生されない)
        const decodeTime = readFragmentBaseDecodeTime(buffer)
        if (decodeTime) {
          let baseline = baselineByTrack.get(id)
          if (baseline === undefined) {
            baseline = decodeTime.value
            baselineByTrack.set(id, baseline)
          }
          writeFragmentBaseDecodeTime(decodeTime.view, decodeTime.tfdt, Math.max(0, decodeTime.value - baseline))
        }
        // 実際に採用されたフラグメントの末尾サンプル番号を記録 (GOP 単位のため
        // 名目上の endNum より後ろのサンプルまで含まれることがあり、duration の
        // 計算は「実際に含んだ範囲」を基準にしないとズレる)
        lastAcceptedNextByTrack.set(id, nextSample)
        fragmentsByTrack.get(id)!.push({ order: order++, buffer })
      }
    }

    mp4boxFile.start()
  }

  const mp4Buffer = MP4BoxBuffer.fromArrayBuffer(source, 0)
  mp4boxFile.appendBuffer(mp4Buffer)
  mp4boxFile.flush()

  if (parseError) throw new Error(parseError)

  const durationByTrack = new Map<number, { ticks: number, timescale: number }>()
  for (const [id, samples] of samplesByTrack) {
    const baseline = baselineByTrack.get(id)
    const lastNext = lastAcceptedNextByTrack.get(id)
    if (baseline === undefined || lastNext === undefined) continue
    const lastSample = samples[lastNext - 1]
    if (!lastSample) continue
    const ticks = (lastSample.dts + lastSample.duration) - baseline
    durationByTrack.set(id, { ticks: Math.max(0, ticks), timescale: lastSample.timescale })
  }

  return { initBuffer, fragmentsByTrack, durationByTrack, movieTimescale }
}

/**
 * `startSec`〜`endSec` (秒) の範囲を含む MP4 Blob を返す。
 * 対応できない構造 (トラックなし、フラグメント化失敗等) の場合は例外を投げる —
 * 呼び出し側で実時間録画へのフォールバックを想定している。
 */
export function extractMp4TimeRange(source: ArrayBuffer, startSec: number, endSec: number): Blob {
  return extractMp4TimeRangeMulti([{ data: source, startSec, endSec }])
}

interface SourceRange { data: ArrayBuffer, startSec: number, endSec: number }

/**
 * 複数の MP4 ソース (前後半で別ファイルに分かれているセグメント境界をまたぐ場合) から
 * それぞれの区間を切り出し、1本の連続した timeline として無劣化で結合する。
 * `ranges` の順序がそのまま出力の時系列順になる。
 *
 * 最初のソースの init segment (moov) を全体で使い回すため、2つ目以降のソースの
 * track 構成 (track_ID の集合) が最初のソースと一致しない場合は例外を投げる
 * (呼び出し側で実時間録画へのフォールバックを想定している)。
 */
export function extractMp4TimeRangeMulti(ranges: SourceRange[]): Blob {
  if (ranges.length === 0) throw new Error('mp4box: no source ranges given')
  for (const r of ranges) {
    if (!(r.endSec > r.startSec)) throw new Error(`mp4box: invalid time range [${r.startSec}, ${r.endSec}]`)
  }

  let initBuffer: ArrayBuffer | null = null
  let movieTimescale = 0
  let canonicalTrackIds: number[] | null = null
  // track_ID ごとの最初のソースで観測した timescale。以降のソースがこれと異なる場合、
  // 共有する init segment (moov.mdhd.timescale) の解釈と食い違うため結合を諦める
  const canonicalTimescaleByTrack = new Map<number, number>()
  // track_ID ごとの「これまでの累積長 (秒、timescale 非依存)」。次のソースの
  // フラグメントを tfdt でこの秒数だけ後ろにシフトして連結する
  const accumulatedSeconds = new Map<number, number>()
  // track_ID ごとの最終的な duration (最初のソースで観測した timescale を単位に固定)
  const finalDurationByTrack = new Map<number, { ticks: number, timescale: number }>()
  const allFragments: { order: number, buffer: ArrayBuffer }[] = []
  let order = 0

  for (let i = 0; i < ranges.length; i++) {
    const { data, startSec, endSec } = ranges[i]!
    const extracted = extractSingleSource(data, startSec, endSec)
    if (extracted.durationByTrack.size === 0) {
      throw new Error(`mp4box: セグメント ${i} に対応するフラグメントが生成できませんでした`)
    }

    const theseIds = [...extracted.durationByTrack.keys()].sort((a, b) => a - b)
    if (i === 0) {
      if (!extracted.initBuffer) throw new Error('mp4box: moov の解析に失敗しました (トラックが見つかりません)')
      initBuffer = extracted.initBuffer
      movieTimescale = extracted.movieTimescale
      canonicalTrackIds = theseIds
      for (const [id, d] of extracted.durationByTrack) canonicalTimescaleByTrack.set(id, d.timescale)
    }
    else {
      if (!canonicalTrackIds || theseIds.length !== canonicalTrackIds.length
        || theseIds.some((id, idx) => id !== canonicalTrackIds![idx])) {
        throw new Error('mp4box: セグメント間でトラック構成 (track_ID) が一致しないため結合できません')
      }
      // 共有する init segment の mdhd.timescale は最初のソース基準で固定済みなので、
      // 以降のソースの timescale がこれと異なるフラグメントをそのまま繋げると
      // 再生側が誤った速度でサンプルを解釈してしまう
      for (const [id, d] of extracted.durationByTrack) {
        if (d.timescale !== canonicalTimescaleByTrack.get(id)) {
          throw new Error('mp4box: セグメント間で timescale が一致しないため結合できません')
        }
      }
    }

    for (const [trackId, fragments] of extracted.fragmentsByTrack) {
      const duration = extracted.durationByTrack.get(trackId)
      if (!duration || fragments.length === 0) continue

      const offsetSeconds = accumulatedSeconds.get(trackId) ?? 0
      const offsetTicks = Math.round(offsetSeconds * duration.timescale)

      for (const { buffer } of fragments) {
        // このソース自身の 0 起点 (extractSingleSource が既に rebase 済み) から
        // さらに「それまでの累積長」だけ後ろにシフトする
        if (offsetTicks > 0) {
          const decodeTime = readFragmentBaseDecodeTime(buffer)
          if (decodeTime) {
            writeFragmentBaseDecodeTime(decodeTime.view, decodeTime.tfdt, decodeTime.value + offsetTicks)
          }
        }
        allFragments.push({ order: order++, buffer })
      }

      accumulatedSeconds.set(trackId, offsetSeconds + duration.ticks / duration.timescale)

      // 最初に観測した timescale を単位に、累積秒数を ticks へ変換して保持
      const refTimescale = finalDurationByTrack.get(trackId)?.timescale ?? duration.timescale
      const totalSeconds = accumulatedSeconds.get(trackId)!
      finalDurationByTrack.set(trackId, { ticks: Math.round(totalSeconds * refTimescale), timescale: refTimescale })
    }
  }

  if (!initBuffer) throw new Error('mp4box: moov の解析に失敗しました (トラックが見つかりません)')
  if (allFragments.length === 0) throw new Error('mp4box: 指定範囲に対応するフラグメントが生成できませんでした')

  if (finalDurationByTrack.size > 0) {
    patchInitSegmentDurations(initBuffer, movieTimescale, finalDurationByTrack)
  }

  allFragments.sort((a, b) => a.order - b.order)
  return new Blob([initBuffer, ...allFragments.map(f => f.buffer)], { type: 'video/mp4' })
}
