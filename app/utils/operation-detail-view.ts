/**
 * 運行詳細 (`/operations/[unko_no]`) が**画面に出す文言**のうち、状態で言い分けるもの
 * (Refs #873)。判断をここ (pure) に置いて、`.vue` 側は出すだけにする。
 *
 * この画面で扱う 2 つとも「**出ていないものが別の意味に読める**」型の欠陥を踏みやすい:
 *
 * - 経路地図の軌跡 — **黙って線が消えると「走っていない」に読める。**
 *   NET780 を重ねられなかった理由 (まだ読んでいない / 未アーカイブ / 取得に失敗 /
 *   アーカイブはあるが便の時間帯に GPS が無い) を**必ず言葉にする**
 * - NET780 生データ zip — **ボタンを黙って消さない。**未アーカイブ・取得失敗・
 *   読み込み前を**同じ見た目にしない** (`useNet780OperationData` の 5 状態に 1 対 1)
 *
 * **経路そのもの (便の切り方・色分け) は `operation-route-map.ts` が正で、ここでは
 * 作り直さない。** ここが持つのは「どちらの軌跡を採ったか」を人に言う 1 行だけ。
 */
import type { Net780DataStatus } from '~/composables/useNet780OperationData'

/** 地図に敷いた軌跡の出どころ。`none` = 軌跡なし (イベント線だけ)。 */
export type OperationTrackSource = 'net780' | 'event' | 'none'

export interface OperationTrackNote {
  source: OperationTrackSource
  /** 地図の見出しの横に出す 1 行。 */
  text: string
}

/**
 * NET780 の軌跡を**採れなかった**理由。`ready-empty` は「アーカイブはあるが、便の
 * 時間窓 (`OperationRoute.windows`) に入る有効な GPS が 1 点も無い」。
 *
 * **`not-found` (未アーカイブ) と `error` (取得に失敗) を同じ文言にしない** —
 * 前者は `/net780` で取りに行けば直り、後者は再読み込みの話で、人がやることが違う。
 */
const NET780_UNUSED_REASON: Readonly<Record<'idle' | 'loading' | 'ready-empty' | 'not-found' | 'error', string>> = Object.freeze({
  'idle': 'NET780 はまだ読み込んでいません',
  'loading': 'NET780 を確認中',
  'ready-empty': 'NET780 はありますが、便の時間帯に有効な GPS がありません',
  'not-found': 'この運行の NET780 はまだアーカイブされていません',
  'error': 'NET780 の取得に失敗しました',
})

/**
 * 地図に敷いた軌跡の出どころを 1 行にする (`OperationRouteMap` の `trackNote`)。
 *
 * **NET780 が優先** (`margin.vue` の地図と同じ順) — 道なりの実測があるところに
 * イベント行の点列をもう 1 本敷いても読めなくなるだけ。NET780 が採れなかったときだけ
 * イベント軌跡 (`buildOverlayTrack`) に落ち、**落ちた理由を必ず添える**。
 * どちらも無ければ `軌跡なし` と**言い切る** (黙って線が消えない)。
 */
export function operationTrackNote(input: {
  status: Net780DataStatus
  /** `splitTrackByWindows` が出した NET780 軌跡の区切り数。 */
  net780Segments: number
  /** 同じくイベント軌跡 (重ね掛け行も含む) の区切り数。 */
  eventSegments: number
}): OperationTrackNote {
  if (input.status === 'ready' && input.net780Segments > 0) {
    return { source: 'net780', text: '軌跡: NET780 の道なり GPS' }
  }
  const why = NET780_UNUSED_REASON[input.status === 'ready' ? 'ready-empty' : input.status]
  if (input.eventSegments > 0) {
    return { source: 'event', text: `軌跡: イベント行の GPS (重ね掛け行も含む) — ${why}` }
  }
  return { source: 'none', text: `軌跡なし — ${why}` }
}

/**
 * 経路地図モーダルの見出し (Refs #873)。
 *
 * **「便 0 本」と名乗らない。** `buildOperationRoute` は **GPS 列が無い CSV で
 * `emptyRoute()` (= `legCount 0`) を返す**ので、素直に出すと「便が 1 本も無い運行」に
 * 読める — 実際には**便の本数が分からなかった**だけで、この 2 つは別物
 * (この repo で最も多い欠陥の型)。**数えられたときだけ本数を出す。**
 *
 * 「なぜ地図が空なのか」は `OperationRouteMap.vue` の overlay が言う
 * (`GPS が有効な行がありません (GPS 無効の行 N)` / `イベントCSV に GPS 列が無いか、
 * 行がありません`)。見出しでは**嘘をつかない**ことだけを担う。
 */
export function operationRouteMapTitle(input: {
  unkoNo: string
  readingDate: string | null | undefined
  /** まだ CSV を読んでいなければ null。 */
  legCount: number | null
}): string {
  const head = `運行 ${input.unkoNo} (読取日 ${input.readingDate ?? '-'})`
  // 0 は「便が無い」ではなく「数えられなかった」でもあるので、本数を名乗らない。
  return input.legCount !== null && input.legCount > 0 ? `${head} — 便 ${input.legCount} 本` : head
}

/** NET780 生データ zip を出せるか / 出せないなら何と言うか。 */
export interface Net780ZipAvailability {
  canDownload: boolean
  /** 出せない理由 (出せるときは null)。 */
  reason: string | null
  /** 赤字で出すか (取得に失敗したときだけ)。 */
  tone: 'muted' | 'error'
}

/**
 * `useNet780OperationData` の 5 状態 → zip ダウンロードの可否と文言 (**5 状態を
 * 1 つも潰さない**)。`not-found` は「未アーカイブなので出せない」と**語で言う** —
 * NET780 タブの未アーカイブ表示 (`buildNet780SearchLink` の検索リンク) が同時に
 * 出ているので、そちらへ誘導できる。
 */
const NET780_ZIP_AVAILABILITY: Readonly<Record<Net780DataStatus, Net780ZipAvailability>> = Object.freeze({
  'idle': { canDownload: false, reason: 'NET780 データをまだ読み込んでいません', tone: 'muted' },
  'loading': { canDownload: false, reason: 'NET780 データを取得中です', tone: 'muted' },
  'ready': { canDownload: true, reason: null, tone: 'muted' },
  'not-found': {
    canDownload: false,
    reason: 'この運行の NET780 はまだアーカイブされていないため、zip を出せません (下の検索から取得してください)',
    tone: 'muted',
  },
  'error': { canDownload: false, reason: 'NET780 データの取得に失敗したため、zip を出せません', tone: 'error' },
})

export function net780ZipAvailability(status: Net780DataStatus): Net780ZipAvailability {
  return NET780_ZIP_AVAILABILITY[status]
}

/**
 * ダウンロードする zip のファイル名。**運行NO がそのまま読める**ようにする
 * (zip の中は `{車輌CD}/{運行開始日時}-{端末ID}-…/` で、運行NO はどこにも出てこない)。
 * 接頭辞は `/net780` ページの一括ダウンロード (`net780-{元ファイル名}.zip`) に合わせる。
 */
export function net780ZipFileName(operationNo: string): string {
  return `net780-${operationNo}.zip`
}
