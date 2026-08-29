<script setup lang="ts">
/**
 * `/operations/[unko_no]` の「イベント」タブ: 選択した区間に入る**便**に、一番星の
 * 明細を結びつけるパネル (画面下中央)。EventSelectionSummaryPanel (デジタコ実績、
 * 画面左下) / EventSpeedMapPanel (速度カラーMap、画面右下) と並ぶ第3のフローティング
 * パネル。
 *
 * ## ★ 確定は①の強制突合になった (突合一本化 PR-2、Refs #848)
 *
 * 元はここで確認した伝票を**検証スナップショット**として R2 に保存していた
 * (`POST /api/profit/snapshot`)。突合が 2 系統あり、同じ運行に違う金額が出ていた
 * (#820)。**②はエンジンとしては廃止**し、人の確定は①の
 * `allowance-force-match.ts` (`dtako:allowance:force-match:v1`) に一本化する。
 *
 * - **保存の単位が「区間」から「便」に変わる。** 便は `extractAllowanceLegs` の
 *   積みイベントで、鍵は `forceMatchKey` (`app/utils/profit-panel-legs.ts`)
 * - **候補は `forceMatchCandidates`。** ここに突合ロジックを書かない
 * - **書き込みは `FORCE_MATCH_KEY` だけ。** スナップショットは**読みも書きもしない** —
 *   読んで初期値にすると「②の確定を①へ機械的に移植」したのと同じになり、
 *   ①が既に別の便へ当てた明細を指して**二重計上**を生む (#820 の明記)
 *
 * ## ★★ 候補は「空いている明細が分かるとき」しか出さない
 *
 * `forceMatchCandidates` の `usedRowIds` は**①が既にどこかの便へ当てた明細**で、
 * 粗利タブが書いた `OPERATION_LEG_SALES_KEY` から読む (`lookupUsedSlipIds`)。
 * **①を回し直さない** — `reconcileVehicles` はプールを順に消費するので、1 運行で
 * 回し直すと粗利タブと違う金額が出る。
 *
 * **読めないときに空の `Set` を渡してはいけない。** 空だと①が別の便へ当てた明細まで
 * 候補に並び、人がそれを結べば**同じ売上が 2 つの便に乗る**。読めないときは
 * **候補欄を出さず、理由を書く** (`usedSlipsNote`) — 空の一覧を「結べる明細が無い」と
 * 読ませない。
 *
 * ## 明細は**乗務員**で引く
 *
 * ①は乗務員CD で明細を引き、`resolveForceMatches` はその明細からしか `rowId` を
 * 解けない。車番で引いた明細を結ぶと、**別の乗務員の伝票なら①側で黙って解けず、
 * 結んだのに何も起きない**。乗務員CD が取れない運行では候補を出さない。
 */
import {
  fetchDriverDailySlips,
  vehicleDailyDateRange,
  calcProfitEfficiency,
  type VehicleDailySlip,
} from '~/utils/ichiban'
import type { SelectedRowsSummary, SelectedRowsLocationRange } from '~/utils/event-data-table'
import type { AllowanceLeg } from '~/utils/allowance-trips'
import { DATE_SLACK, tradableSlips } from '~/utils/allowance-ichiban'
import { describeCaughtError } from '~/utils/api-error'
import { transportSlips } from '~/utils/allowance-relay'
import { shiftYmd } from '~/utils/profit-compare'
import {
  FORCE_MATCH_KEY,
  parseForceMatch,
  serializeForceMatch,
  toggleForceMatch,
  forceMatchCandidates,
  type ForceMatchMap,
} from '~/utils/allowance-force-match'
import {
  OPERATION_LEG_SALES_KEY,
  lookupUsedSlipIds,
  usedSlipsNote,
  type UsedSlipsLookup,
} from '~/utils/operation-leg-sales'
import {
  legsInSelection,
  boundSlips,
  slipRows,
  sumAmount,
  slipMatch,
  slipSideNote,
  legMatchTarget,
  legDestKnown,
  legRouteLabel,
  badgeTargetNote,
  LEG_DEST_MISSING_NOTE,
  type SlipMatch,
  effectiveSlipIds,
  ownSlipIds,
  seedForceMatch,
  FORCE_MATCH_PANEL_NOTE,
  FORCE_MATCH_OVERRIDE_NOTE,
  FORCE_MATCH_ICHIBAN_NOTE,
  FORCE_MATCH_FROZEN_NOTE,
  type ProfitPanelLeg,
} from '~/utils/profit-panel-legs'

const props = defineProps<{
  unkoNo: string
  /** 運行の乗務員CD (`raw_data.対象乗務員CD` / `乗務員CD1`)。取れなければ null。 */
  driverCd: string | null
  range: { fromTs: number, toTs: number } | null
  /**
   * 選択区間の積地・卸地。**根拠バッジの相手ではない** (Refs #860) — バッジは
   * **その便の積地・卸地** (`legMatchTarget`) と突合する。ここで受けたものは
   * **「何と比べたのか」を画面に出す一言** (`badgeTargetNote`) にしか使わない。
   */
  location: SelectedRowsLocationRange | null
  summary: SelectedRowsSummary
  /** この運行の便 (`extractAllowanceLegs` の結果)。**便の切り方は①のもの。** */
  legs: AllowanceLeg[]
}>()

defineEmits<{ close: [] }>()

type FetchStatus = 'loading' | 'ready' | 'error' | 'no-driver'

/**
 * **この画面の「やり直し方」** (Refs #1008)。
 *
 * ★ **`「…」を押してください` の形にしていない** — このパネルに再試行ボタンは
 * 存在せず (`load` は `watch([driverCd, range])` からしか走らない)、
 * **無いボタンを案内すると、失敗した人が探して見つからない**。
 * 代わりに**本当にもう一度取りに行く操作**を書く: 親 (`/operations/[unko_no]` の
 * イベントタブ) で選択行を変えると `selectedEventRange` が変わり、この `watch` が
 * 発火して `load` が走る。
 *
 * ## ★ 括弧つきの補足を足さないこと (**合成後の 1 文**で決めている)
 *
 * 初稿は `'… (選び直すと自動で取り直します)'` だった。**単体では読めるが、
 * `nextStepForStatus(401, retry)` と合成すると括弧が 2 つ連続する** (実測):
 *
 * ```
 * 401 … 再ログインしてからイベントの行を選び直してください (選び直すと自動で取り直します)
 *      (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)
 * ```
 *
 * **描画させて読むまで気づけない** — ヘルパ 1 本を見て「読める」で済ませないこと。
 * `「…してください」` の命令形だけで「もう一度取りに行く」ことは伝わるので補足は消した。
 * **仕組みの説明はこの doc の役目**であって画面の役目ではない。
 */
const RETRY_RESELECT = 'イベントの行を選び直してください'

const status = ref<FetchStatus>('loading')
const errorMessage = ref<string | null>(null)
const slips = ref<VehicleDailySlip[]>([])
/** 便に結びつけた明細 (`FORCE_MATCH_KEY` の写し)。 */
const forceMatch = ref<ForceMatchMap>({})
/** ①が既に当てた明細。**`ready` のときだけ候補を出す。** */
const used = ref<UsedSlipsLookup>({ status: 'missing' })
/** 人が選んだ便。選択が変わって当たらなくなったら先頭に戻る (`activeKey`)。 */
const pickedLegKey = ref('')
/** 保存できなかったときの一言。**黙って握らない** (結んだつもりで残っていない事故を防ぐ)。 */
const saveNote = ref<string | null>(null)

const selection = computed(() => legsInSelection(props.unkoNo, props.legs, props.range))

/**
 * いま開いている便。選んでいない / 選択が変わって当たらなくなったら**先頭の便**。
 * **便が 1 本も無いときは読まれない** (`v-for` の中でしか参照しない)。
 */
const activeKey = computed(() => {
  const legs = selection.value.legs
  if (legs.some(leg => leg.key === pickedLegKey.value)) return pickedLegKey.value
  return legs[0]!.key
})

const byRowId = computed(() => new Map(slips.value.map(s => [s.rowId, s])))

/** 候補を出せない理由。出せるときは `null`。 */
const usedNote = computed(() => usedSlipsNote(used.value))

/**
 * **その便に①が当てた明細** (Refs #854)。読めていなければ空。
 *
 * **和集合 (`usedRowIds`) と同じ 1 回の厳格な読みから取る** — 別の (緩い) 読みと
 * 混ぜると、片方に居て片方に居ない明細が二重計上の口になる。
 */
function ichibanIdsOf(leg: ProfitPanelLeg): string[] {
  const usedLookup = used.value
  if (usedLookup.status !== 'ready') return []
  return usedLookup.slipIdsBySeq.get(leg.seq) ?? []
}

/** その便に**いま当たっている**明細 (人の上書き > ①の結果)。 */
function effectiveOf(leg: ProfitPanelLeg) {
  return effectiveSlipIds(forceMatch.value[leg.key], ichibanIdsOf(leg))
}

function boundOf(leg: ProfitPanelLeg) {
  return boundSlips(effectiveOf(leg).ids, byRowId.value)
}

/**
 * その便に並べる明細。**結んである明細が先、候補が後ろ。**
 * 候補は①の使用済みが分かるときだけ (`usedRowIds` を空で渡さない)。
 *
 * **`ownRowIds` には `ownSlipIds` を渡す** (Refs #854) — ①が当てた明細は `usedRowIds`
 * にも居るので、渡さないと**この便自身の明細が候補から消える**。**「いま当たっている」
 * (`effectiveOf`) を流用しない** — 人が外した瞬間に `own` から外れ、外した明細が
 * どこにも出なくなって**その場で戻せなくなる**。
 * **フィルタの条件は緩めない** (緩めると他の便の明細まで出て二重計上になる)。
 */
function rowsOf(leg: ProfitPanelLeg): VehicleDailySlip[] {
  const bound = boundOf(leg).slips
  const usedLookup = used.value
  if (usedLookup.status !== 'ready') return slipRows(bound, [])
  const candidates = forceMatchCandidates(
    { originCity: leg.originCity, date: leg.date },
    slips.value,
    usedLookup.usedRowIds,
    ownSlipIds(forceMatch.value[leg.key], ichibanIdsOf(leg)),
  )
  return slipRows(bound, candidates)
}

function boundYen(leg: ProfitPanelLeg): number {
  return sumAmount(boundOf(leg).slips)
}

/** 選択区間ぶんの結びつけ合計。効率指標 (円/km・円/時間) の分子。 */
const boundTotal = computed(() => selection.value.legs.reduce((sum, leg) => sum + boundYen(leg), 0))

const efficiency = computed(() => calcProfitEfficiency(
  boundTotal.value,
  props.summary.distanceKm,
  props.summary.durationMin,
  props.summary.byCategory.drive,
))

/** 保存済みの結びつけと①の使用済み明細を読み直す。**壊れていても投げない。** */
function readStored() {
  try {
    forceMatch.value = parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY))
    used.value = lookupUsedSlipIds(localStorage.getItem(OPERATION_LEG_SALES_KEY), props.unkoNo)
  }
  catch {
    // localStorage 自体が読めない環境。**空の Set に倒さず** 候補を出さない側へ。
    forceMatch.value = {}
    used.value = { status: 'missing' }
  }
}

async function load() {
  saveNote.value = null
  readStored()
  if (!props.driverCd || !props.range) {
    status.value = 'no-driver'
    slips.value = []
    return
  }
  status.value = 'loading'
  errorMessage.value = null
  try {
    // **候補の日付 ±`DATE_SLACK` 日ぶん広げて引く。** 区間ぴったりで引くと
    // `forceMatchCandidates` が許す前後 1 日の明細が手元に無く、出せる候補が減る。
    const base = vehicleDailyDateRange(props.range.fromTs, props.range.toTs)
    const fetched = await fetchDriverDailySlips(
      props.driverCd, shiftYmd(base.from, -DATE_SLACK), shiftYmd(base.to, DATE_SLACK))
    // **請求のみ (`請求K=1`) は候補に出さない。** 中継では脚とあわせて売上が二重に乗る。
    // 「休み」行も便ではない (①の `tradableSlips` と同じ)。
    slips.value = transportSlips(tradableSlips(fetched))
    status.value = 'ready'
  }
  catch (e) {
    // **このファイルに `$fetch` は無いが中身は自前の server route** (Refs #890)。
    // `fetchDriverDailySlips` → `utils/ichiban.ts` の
    // `$fetch('/api/ichiban/api/sales/vehicle-daily')` で、理由は JSON 本文にしか
    // 残らない。**`localStorage` の `:245` は触らない** (HTTP ではない)。
    // ★ **この画面には「再試行」ボタンが 1 つも無い** (`load` は props の
    //   乗務員CD / 区間を見る `watch` からしか走らない)。**無いボタンを案内しない**
    //   ので、`retry` は `「…」を押してください` の形にせず、**実際にもう一度
    //   取りに行く操作**を書く (Refs #1008)。イベント表の選択を変えると
    //   `selectedEventRange` が変わり、この `watch` が発火する。
    errorMessage.value = describeCaughtError(e, RETRY_RESELECT)
    status.value = 'error'
  }
}

watch([() => props.driverCd, () => props.range], load, { immediate: true })

/**
 * 結ぶ / 外す。**同じ明細をもう一度押せば外れる** (①の運行手当タブと同じ)。
 *
 * **①が当てている便は、触った瞬間にその結果を土台として書き起こす**
 * (`seedForceMatch`、Refs #854)。土台無しで 1 件足すと `applyForcedSales` の置き換えで
 * **①が当てていた売上が消える**。**書くのは人が触ったこの瞬間だけ** — 先回りして
 * 保存すると「人が確定した」ことになってしまう。
 */
function toggleBind(leg: ProfitPanelLeg, rowId: string) {
  const seeded = seedForceMatch(forceMatch.value, leg.key, ichibanIdsOf(leg))
  const next = toggleForceMatch(seeded, leg.key, rowId)
  forceMatch.value = next
  try {
    localStorage.setItem(FORCE_MATCH_KEY, serializeForceMatch(next))
    saveNote.value = null
  }
  catch (e) {
    saveNote.value = `結びつけを保存できませんでした — ${e instanceof Error ? e.message : String(e)}`
  }
}

/** チェックが付くのは**いま当たっている**明細 (①が当てたぶんも含む)。 */
function isBound(leg: ProfitPanelLeg, rowId: string): boolean {
  return effectiveOf(leg).ids.includes(rowId)
}

/**
 * 円。**`+ 0` は `Math.round` が返す `-0` を畳むためだけ** (Refs #843 / #928)。
 * 売上は一番星の `amount` の和なので負にもなり、`(-0).toLocaleString()` は `"-0"`。
 * **丸め方は 1 ミリも変えない。**
 */
function formatYen(v: number | null): string {
  return v === null ? '-' : (Math.round(v) + 0).toLocaleString('ja-JP')
}

/** 品名N/数量/単価をまとめて1列に表示するための整形。同一日でも複数明細で単価が
 * 異なりうることを一目で確認できるようにする (Refs #330 実データ検証)。 */
function formatItem(slip: VehicleDailySlip): string {
  if (!slip.itemName) return '-'
  const qty = slip.quantity > 0 ? `${slip.quantity}${slip.unit}` : ''
  const price = slip.unitPrice > 0 ? `@${formatYen(slip.unitPrice)}` : ''
  const detail = [qty, price].filter(Boolean).join(' ')
  return detail ? `${slip.itemName} (${detail})` : slip.itemName
}

const matchBadgeClass: Record<string, string> = {
  exact: 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300',
  partial: 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300',
  none: 'bg-gray-100 dark:bg-gray-800 text-gray-400',
}

const matchBadgeLabel: Record<string, string> = { exact: '完全一致', partial: '部分一致', none: '根拠なし' }

/**
 * 根拠。**その場で計算する** (Refs #858) — ②の `scoreVehicleDailySlips` を撤去して
 * `rowId` → スコアの `Map` を持つ必要が無くなった。**「完全一致」は積地・卸地の両方が
 * exact のときだけ** (`combinedMatchLevel` と同じ) で、`/profit/monthly` の保存済み一覧と
 * 同じ言葉が同じ意味になる。
 *
 * **バッジだけにしない** — `combinedMatchLevel` は片方でも `none` なら `none` に畳むので、
 * 「積地は合っている明細」と「何も合っていない明細」が同じ「根拠なし」になる。畳んだ側は
 * `slipSideNote` が一言で言う (本番 2026-07 では候補の約 3 割がこれに当たる)。
 *
 * ## ★ 相手は**その便**の積地・卸地 (`props.location` ではない、Refs #860)
 *
 * 候補は `forceMatchCandidates` が**便ごと**に出している (`leg.originCity` / `leg.date` で
 * 絞り、便の積地が一致する明細を先頭に並べる) のに、そこへ貼る根拠だけが選択区間を
 * 相手にしていた。**同じ表の中で並びとラベルの基準が違う**状態だった。
 * **選択がその便 1 本だけのときは変わらない** — 変わるのは複数の便をまたいで選んだとき。
 */
function matchOf(leg: ProfitPanelLeg, slip: VehicleDailySlip): SlipMatch {
  return slipMatch(legMatchTarget(leg), slip)
}

/**
 * 便の見出し (`便2 07-16 釧路市 → (卸地なし)`)。
 *
 * **区間の書き方は `legRouteLabel` に寄せてある** (Refs #860) — 同じ便が見出しと
 * `badgeTargetNote` で違う書き方 (`?` と `(積地なし)`) に見えないようにするため。
 */
function legLabel(leg: ProfitPanelLeg): string {
  return `便${leg.seq} ${leg.date.slice(5)} ${legRouteLabel(leg.originCity, leg.destCity)}`
}

/**
 * 件数の頭に付ける言葉。**誰が当てたのかを混ぜない** (Refs #854) —
 * ①が当てたぶんを「結び」と書くと、人が結んだ覚えが無いのに「結び 1 件」と出る。
 */
function boundLabel(leg: ProfitPanelLeg): string {
  return effectiveOf(leg).source === 'ichiban' ? '粗利タブが当てた' : '結び'
}

const panelNote = FORCE_MATCH_PANEL_NOTE
const overrideNote = FORCE_MATCH_OVERRIDE_NOTE
const legDestMissingNote = LEG_DEST_MISSING_NOTE

/**
 * その便に出す注記。**触る前と触った後で言うことが違う** (Refs #854)。
 *
 * - `ichiban` — 触るとどうなるか (①の追従をやめる / 全部外すと戻る)
 * - `forced` — **もう①には追従していない** (集計し直しても変わらない) / 戻し方
 * - `none` — 言うことは無い (①も当てていない便)
 */
function legNote(leg: ProfitPanelLeg): string {
  const { source } = effectiveOf(leg)
  if (source === 'ichiban') return FORCE_MATCH_ICHIBAN_NOTE
  if (source === 'forced') return FORCE_MATCH_FROZEN_NOTE
  return ''
}
</script>

<template>
  <div class="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[560px] max-w-[calc(100vw-2rem)] rounded-lg shadow-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 overflow-hidden">
    <div class="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-800">
      <span class="text-xs font-medium text-gray-600 dark:text-gray-300">便に一番星の明細を結ぶ (収支パネル)</span>
      <button class="text-gray-400 hover:text-gray-600" @click="$emit('close')">
        <UIcon name="i-lucide-x" class="size-4" />
      </button>
    </div>

    <p class="px-3 py-1.5 text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30">
      {{ panelNote }}
    </p>

    <div v-if="status === 'no-driver'" class="px-4 py-6 text-xs text-gray-400 text-center">
      乗務員CD が特定できないため、結べる候補を出せません (粗利タブは乗務員で一番星の明細を引くため、車番で引いた明細を結んでも集計に効きません)
    </div>
    <div v-else-if="status === 'loading'" class="px-4 py-6 text-xs text-gray-400 flex items-center justify-center gap-2">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />
      一番星の伝票を検索中...
    </div>
    <div v-else-if="status === 'error'" class="px-4 py-6 text-xs text-red-600 dark:text-red-400 text-center">
      {{ errorMessage }}
    </div>

    <template v-else>
      <p v-if="selection.undated > 0" class="px-3 py-1.5 text-[10px] text-gray-500">
        積みの開始日時が読めない便が {{ selection.undated }} 本あり、この区間に入るか判定できません (結び先には出していません)
      </p>

      <p v-if="selection.legs.length === 0" class="px-4 py-6 text-xs text-gray-400 text-center">
        選択した区間に便 (積みイベント) がありません。イベント表で積みの行を含めて選び直してください
      </p>

      <template v-else>
        <p class="px-3 py-1.5 text-[10px] text-gray-500">
          {{ overrideNote }} 候補は<b>乗務員CD {{ driverCd }}</b> の明細から出しています。
        </p>
        <div class="max-h-72 overflow-y-auto overflow-x-auto">
          <div v-for="leg in selection.legs" :key="leg.key" class="border-t border-gray-100 dark:border-gray-800">
            <button
              class="w-full px-3 py-1.5 flex items-center justify-between gap-2 text-[11px] text-left"
              :class="leg.key === activeKey ? 'bg-blue-50 dark:bg-blue-950/40 font-medium' : 'bg-gray-50 dark:bg-gray-800'"
              @click="pickedLegKey = leg.key"
            >
              <span>{{ legLabel(leg) }}</span>
              <span class="whitespace-nowrap text-gray-500">
                {{ boundLabel(leg) }} {{ effectiveOf(leg).ids.length }} 件 ・ {{ formatYen(boundYen(leg)) }} 円
              </span>
            </button>

            <template v-if="leg.key === activeKey">
              <p v-if="legNote(leg)" class="px-3 py-1.5 text-[10px] text-blue-700 dark:text-blue-400">
                {{ legNote(leg) }}
              </p>
              <p v-if="boundOf(leg).missing > 0" class="px-3 py-1 text-[10px] text-amber-700 dark:text-amber-400">
                この便に当たっている明細のうち {{ boundOf(leg).missing }} 件がこの検索結果に見当たりません (記録は残っています。日付の範囲外か、別の乗務員で引かれた明細です)
              </p>
              <p v-if="usedNote" class="px-3 py-2 text-[10px] text-amber-700 dark:text-amber-400">
                {{ usedNote }}
              </p>
              <p class="px-3 py-1 text-[10px] text-gray-500">
                {{ badgeTargetNote(location, leg) }}
              </p>
              <p v-if="!legDestKnown(leg)" class="px-3 py-1 text-[10px] text-amber-700 dark:text-amber-400">
                {{ legDestMissingNote }}
              </p>
              <table v-if="rowsOf(leg).length > 0" class="w-full text-xs min-w-[640px]">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="w-8" />
                    <th class="text-left px-2 py-1.5 font-medium text-gray-500">日付</th>
                    <th class="text-left px-2 py-1.5 font-medium text-gray-500">得意先</th>
                    <th class="text-left px-2 py-1.5 font-medium text-gray-500">積地→卸地</th>
                    <th class="text-left px-2 py-1.5 font-medium text-gray-500">品名 (数量@単価)</th>
                    <th class="text-right px-2 py-1.5 font-medium text-gray-500">金額</th>
                    <th class="text-center px-2 py-1.5 font-medium text-gray-500">根拠 (この便の積地・卸地)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="s in rowsOf(leg)"
                    :key="s.rowId"
                    class="border-t border-gray-100 dark:border-gray-800 cursor-pointer"
                    :class="isBound(leg, s.rowId) ? 'bg-emerald-50 dark:bg-emerald-950/40' : ''"
                    @click="toggleBind(leg, s.rowId)"
                  >
                    <td class="px-2 py-1.5" @click.stop="toggleBind(leg, s.rowId)">
                      <input type="checkbox" :checked="isBound(leg, s.rowId)" class="cursor-pointer" @click.stop="toggleBind(leg, s.rowId)">
                    </td>
                    <td class="px-2 py-1.5 whitespace-nowrap">{{ s.saleDate }}</td>
                    <td class="px-2 py-1.5">{{ s.customerName || '-' }}</td>
                    <td class="px-2 py-1.5">{{ s.originAreaName || s.origin || '?' }} → {{ s.destAreaName || s.dest || '?' }}</td>
                    <td class="px-2 py-1.5 whitespace-nowrap">{{ formatItem(s) }}</td>
                    <td class="px-2 py-1.5 text-right whitespace-nowrap">{{ formatYen(s.amount) }}</td>
                    <td class="px-2 py-1.5 text-center">
                      <span class="px-1.5 py-0.5 rounded text-[10px]" :class="matchBadgeClass[matchOf(leg, s).badge]">
                        {{ matchBadgeLabel[matchOf(leg, s).badge] }}
                      </span>
                      <span v-if="slipSideNote(matchOf(leg, s))" class="block mt-0.5 text-[10px] text-gray-400 whitespace-nowrap">
                        {{ slipSideNote(matchOf(leg, s)) }}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else-if="usedNote === null" class="px-4 py-4 text-xs text-gray-400 text-center">
                結べる明細がありません (日付 ±{{ DATE_SLACK }} 日に、まだどの便にも当たっていない明細が無い)
              </p>
            </template>
          </div>
        </div>

        <div class="px-3 py-2 border-t border-gray-100 dark:border-gray-800 grid grid-cols-2 gap-3 text-xs">
          <div>
            <span class="text-gray-500 block">結んだ売上 (税抜)</span>
            <span class="text-sm font-semibold">{{ formatYen(boundTotal) }} 円</span>
          </div>
          <div>
            <span class="text-gray-500 block">距離 / 時間 (拘束)</span>
            <span class="text-sm font-semibold">{{ summary.distanceKm.toFixed(1) }} km / {{ (summary.durationMin / 60).toFixed(1) }} h</span>
          </div>
          <div>
            <span class="text-gray-500 block">円/km</span>
            <span class="text-sm font-semibold">{{ formatYen(efficiency.yenPerKm) }}</span>
          </div>
          <div>
            <span class="text-gray-500 block">円/時間 (拘束 / 運転)</span>
            <span class="text-sm font-semibold">{{ formatYen(efficiency.yenPerHourBound) }} / {{ formatYen(efficiency.yenPerHourDrive) }}</span>
          </div>
        </div>

        <p v-if="saveNote" class="px-3 py-1.5 border-t border-gray-100 dark:border-gray-800 text-[10px] text-red-600 dark:text-red-400">
          {{ saveNote }}
        </p>
      </template>
    </template>
  </div>
</template>
