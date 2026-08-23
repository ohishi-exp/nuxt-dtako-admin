<script setup lang="ts">
/**
 * 粗利タブの「釧路積み (釧路営業所試算)」区画 (Refs #760 の 36)。
 *
 * **表示専用。** 数字は 1 つもここで作らない — `buildKushiroBranchView`
 * (`~/utils/kushiro-branch-view`) が畳んだ plain object を props で受けて並べるだけ。
 * `margin.vue` は 2200 行を超えているので、これ以上インラインで足さない。
 *
 * ## 「実在しない試算」バッジは条件分岐なしで固定表示 (オーナー要件)
 *
 * 釧路営業所は**存在しない**。この区画の数字は実績ではなく、道東卸しの便を釧路発の
 * 新しい運行として**組み直したらどうなるか**の試算。`v-if` を付けると「バッジが
 * 出ない状態」が生まれるので、テンプレートに直書きする。
 *
 * ## 欠測は 0 に倒さず「−」
 *
 * `fmtYen` / `fmtKm` / `fmtHours` / `fmtNum` はすべて `null` を `DASH` にする。
 * 0 で埋めると「回送が無い」「時給 0 円」という**実在しうる値**に化ける。
 */
import {
  DASH,
  MIN_WAGE_TONE_LABEL,
  amountTone,
  fmtHours,
  fmtKm,
  fmtNum,
  fmtSignedYen,
  fmtYen,
  minWageTone,
  type KushiroAssumptions,
  type KushiroBreakdownRow,
  type KushiroBranchSummary,
  type KushiroGridRow,
  type KushiroMinWage,
  type LegsPerDaySlider,
  type Tone,
} from '~/utils/kushiro-branch-view'
import type { DepotKey } from '~/utils/depot-distance'

defineProps<{
  /** 対象便が 1 本も無い。 */
  empty: boolean
  summary: KushiroBranchSummary
  slider: LegsPerDaySlider
  /** スライダーで選んでいる 便/日。 */
  legsPerDay: number
  /** 選んでいる 便/日 での 2 営業所。 */
  selected: KushiroGridRow
  /** 実測分布から作った候補の表。 */
  grid: KushiroGridRow[]
  routes: KushiroBreakdownRow[]
  drivers: KushiroBreakdownRow[]
  minWage: KushiroMinWage
  /** 最低賃金を満たす最小の 便/日 (営業所ごと)。 */
  minWageLegsPerDay: Record<DepotKey, number | null>
  /** 営業利益が 0 以上になる最小の候補 (営業所ごと)。 */
  breakEvenLegsPerDay: Record<DepotKey, number | null>
  assumptions: KushiroAssumptions
  /** 最低賃金マスタの取得に失敗した理由 (空なら出さない)。 */
  masterError: string
}>()

const emit = defineEmits<{
  /** つまみを動かした。 */
  'update:legsPerDay': [value: number]
  /** 「実測平均に戻す」。**平均値は親が持っている**ので、ここでは値を載せない
   * (`mean` が `null` になり得る分岐をコンポーネントに持ち込まないため)。 */
  'reset': []
}>()

function onSlide(event: Event) {
  emit('update:legsPerDay', Number((event.target as HTMLInputElement).value))
}

/** 良し悪しの色。`Tone` は util 側で決まっているので、ここは引くだけ。 */
const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  ng: 'text-red-600 dark:text-red-400 font-medium',
  unknown: 'text-gray-400',
}
</script>

<template>
  <div class="mt-6 p-3 rounded-lg border border-amber-300 dark:border-amber-800">
    <!-- ★ バッジは条件分岐なしで常に出す (オーナー要件「必須表示」)。
         釧路営業所は実在せず、この区画の数字は実績ではない -->
    <div class="kushiro-print-badge flex flex-wrap items-center gap-2 mb-2">
      <h2 class="text-sm font-semibold">
        釧路積み (釧路営業所試算)
      </h2>
      <span
        class="text-[11px] px-2 py-0.5 rounded-full bg-amber-500 text-white font-medium"
        title="釧路営業所は存在しません。この区画は「道東卸しの便を釧路発の新しい運行として組み直したら」の試算で、実績ではありません"
      >
        実在しない試算
      </span>
      <span class="text-[11px] text-gray-500">粗利タブの数字には 1 円も効きません</span>
    </div>

    <p v-if="empty" class="text-xs text-gray-400">
      積地 = 釧路 かつ 卸地 = 道東 の便がこの月にはありません
    </p>

    <template v-else>
      <!-- 読み方 — ここを読まずに数字だけ持ち出されると必ず誤読される -->
      <div class="kushiro-print-note text-[11px] text-gray-500 space-y-1 mb-3">
        <p>
          対象 <b>{{ summary.legs }}</b> 便 / 元の運行 <b>{{ summary.operations }}</b> 本
          (うち<b>道東卸しだけで閉じている運行 {{ summary.pureOperations }} 本</b> /
          十勝卸しと混ざった運行 {{ summary.mixedOperations }} 本)。
          <b>混在運行は既存の運行の営業所を差し替えても 1 便も動かせない</b>ので、
          これは<b>釧路発の新しい運行として組み直した姿</b>です。
        </p>
        <p>
          <b>現状の回送 {{ fmtKm(summary.measuredDeadheadKm) }} と組み直しの推定を引き算しないでください</b> —
          現状の道東卸しは運行の途中にあり、降ろした後は十勝へ戻っています。
          同じ方法どうしの引き算として成立するのは<b>営業所差 (帯広発 vs 釧路発)</b> だけです。
        </p>
        <p>
          <b>拘束は下限・換算時給は上限</b>です (荷役・待機の時間が入力にありません)。
          「上限でも割っている = 確実に割っている」向きで読んでください。
          距離は<b>直線 (haversine)</b> なので、実距離は必ずこれ以上になります。
        </p>
        <p>
          前提: 人件費 <b>{{ fmtYen(assumptions.monthlyLaborCostYen) }}/名·月</b> /
          燃費 <b>{{ assumptions.kmPerLiter }}km/L</b> / <b>{{ assumptions.yenPerLiter }}円/L</b> /
          1 名あたり <b>{{ assumptions.legsPerDriverMonth }}</b> 便·月 ·
          <b>{{ fmtNum(assumptions.runsPerDriverMonth, 1) }}</b> 運行·月。
          換算時給の分子は<b>対象便の手当合計 {{ fmtYen(assumptions.monthlyWageYen) }}</b> (実データ) です。
        </p>
        <p v-if="summary.missingLegs > 0" class="text-amber-600 dark:text-amber-400">
          座標が取れず推定に入れられなかった便が <b>{{ summary.missingLegs }}</b> 本あります
          (0km に倒さず母集団から外しています)。
        </p>
      </div>

      <!-- 実測の合計 -->
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs mb-3">
        <span>売上 <b>{{ fmtYen(summary.salesYen) }}</b></span>
        <span>手当 <b>{{ fmtYen(summary.allowanceYen) }}</b></span>
        <span>売上走行 <b>{{ fmtKm(summary.haulKm) }}</b></span>
        <span title="組み直し前の実測。推定と引き算しないこと">現状の回送 <b>{{ fmtKm(summary.measuredDeadheadKm) }}</b></span>
        <span class="text-gray-500">走行 {{ fmtNum(summary.haulSpeedKmh, 1) }}km/h · 回送 {{ fmtNum(summary.deadheadSpeedKmh, 1) }}km/h (実測)</span>
      </div>

      <!-- 便/日 を振る -->
      <div class="flex flex-wrap items-center gap-3 mb-3">
        <label class="kushiro-print-slider text-xs text-gray-500 flex items-center gap-2">
          1 日あたり便数
          <input
            type="range"
            class="w-56"
            :min="slider.min"
            :max="slider.max"
            :step="slider.step"
            :value="legsPerDay"
            :disabled="slider.disabled"
            @input="onSlide"
          >
        </label>
        <span class="text-sm font-semibold">{{ fmtNum(legsPerDay, 2) }} 便/日</span>
        <button
          class="kushiro-print-hide text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
          :title="`実測平均 ${fmtNum(slider.mean, 3)} 便/日 に戻します`"
          @click="emit('reset')"
        >
          実測平均に戻す
        </button>
        <span class="text-[11px] text-gray-500">
          上下限・既定は<b>実測の分布</b>から出しています
          (観測: {{ slider.min }}〜{{ slider.max }} 便/運行、平均 {{ fmtNum(slider.mean, 3) }})
        </span>
      </div>

      <!-- 選んだ 便/日 での 2 営業所 -->
      <div class="kushiro-print-depots grid gap-2 sm:grid-cols-2 mb-4">
        <div
          v-for="d in selected.depots"
          :key="d.depot"
          class="p-2 rounded border border-gray-200 dark:border-gray-800 text-xs"
        >
          <div class="font-semibold mb-1">
            {{ d.label }} <span class="text-gray-400 font-normal">({{ fmtNum(selected.legsPerDay, 2) }} 便/日)</span>
          </div>
          <div class="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <span class="text-gray-500">組み直し回送 (推定)</span><span class="text-right">{{ fmtKm(d.rebuiltDeadheadKm) }}</span>
            <span class="text-gray-500">拘束 (下限)</span><span class="text-right">{{ fmtHours(d.restraintHours) }}</span>
            <span class="text-gray-500">稼働日数 (運行)</span><span class="text-right">{{ fmtNum(d.runs, 1) }}</span>
            <span class="text-gray-500">必要乗務員</span><span class="text-right">{{ fmtNum(d.requiredDrivers, 0) }} 名</span>
            <span class="text-gray-500">1 名あたり拘束</span><span class="text-right">{{ fmtHours(d.restraintHoursPerDriver) }}</span>
            <span class="text-gray-500">換算時給 (上限)</span><span class="text-right font-medium">{{ fmtYen(d.hourlyYen) }}</span>
            <span class="text-gray-500">最低賃金差</span>
            <span class="text-right" :class="TONE_CLASS[minWageTone(d.belowMinWage)]">
              {{ fmtSignedYen(d.minWageDiffYen) }} ({{ MIN_WAGE_TONE_LABEL[minWageTone(d.belowMinWage)] }})
            </span>
            <span class="text-gray-500">燃料代 (試算)</span><span class="text-right">{{ fmtYen(d.fuelYen) }}</span>
            <span class="text-gray-500">粗利 (試算)</span><span class="text-right">{{ fmtYen(d.marginYen) }}</span>
            <span class="text-gray-500">人件費</span><span class="text-right">{{ fmtYen(d.laborCostYen) }}</span>
            <span class="text-gray-500">営業利益</span>
            <span class="text-right font-medium" :class="TONE_CLASS[amountTone(d.operatingMarginYen)]">{{ fmtYen(d.operatingMarginYen) }}</span>
          </div>
        </div>
      </div>

      <!-- 最低賃金の比較 -->
      <h3 class="text-xs font-semibold mb-1">
        最低賃金の比較 (帯広発 vs 釧路発)
      </h3>
      <p class="text-[11px] text-gray-500 mb-1">
        最低賃金 <b>{{ fmtYen(minWage.rate) }}/h</b>
        <span v-if="minWage.key !== null">
          (マスタのキー <b>{{ minWage.key }}</b> / 決め方 {{ minWage.source }} / 発効 {{ minWage.effectiveFrom }})
        </span>
        <span v-else class="text-amber-600 dark:text-amber-400">
          — 最低賃金マスタから額を引けませんでした (試したキー: {{ minWage.triedKeys.join(' / ') }})。
          <b>0 に倒さず「{{ DASH }}」のままにしています</b>
        </span>
      </p>
      <p v-if="masterError" class="text-[11px] text-amber-600 dark:text-amber-400 mb-1">
        {{ masterError }}
      </p>
      <div class="overflow-x-auto mb-2">
        <table class="text-xs w-full">
          <thead>
            <tr class="text-left text-gray-500 border-b border-gray-300 dark:border-gray-600">
              <th class="px-2 py-1">便/日</th>
              <th class="px-2 py-1">営業所</th>
              <th class="px-2 py-1 text-right">1 名あたり拘束</th>
              <th class="px-2 py-1 text-right">換算時給 (上限)</th>
              <th class="px-2 py-1 text-right">最低賃金差</th>
              <th class="px-2 py-1">判定</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in grid" :key="row.legsPerDay">
              <tr
                v-for="d in row.depots"
                :key="`${row.legsPerDay}-${d.depot}`"
                class="border-b border-gray-100 dark:border-gray-800"
              >
                <td class="px-2 py-1">
                  {{ fmtNum(row.legsPerDay, 2) }}
                  <span v-if="row.isMean" class="text-[10px] text-gray-400">実測平均</span>
                </td>
                <td class="px-2 py-1">{{ d.label }}</td>
                <td class="px-2 py-1 text-right">{{ fmtHours(d.restraintHoursPerDriver) }}</td>
                <td class="px-2 py-1 text-right">{{ fmtYen(d.hourlyYen) }}</td>
                <td class="px-2 py-1 text-right" :class="TONE_CLASS[minWageTone(d.belowMinWage)]">{{ fmtSignedYen(d.minWageDiffYen) }}</td>
                <td class="px-2 py-1" :class="TONE_CLASS[minWageTone(d.belowMinWage)]">{{ MIN_WAGE_TONE_LABEL[minWageTone(d.belowMinWage)] }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <p class="text-[11px] text-gray-500 mb-4">
        <span v-for="d in selected.depots" :key="d.depot" class="mr-3">
          {{ d.label }}: 最低賃金をちょうど満たす 便/日 <b>{{ fmtNum(minWageLegsPerDay[d.depot], 2) }}</b> ·
          営業利益 0 以上になる最小の候補 <b>{{ fmtNum(breakEvenLegsPerDay[d.depot], 3) }}</b>
        </span>
        <span class="block mt-0.5">
          損益分岐は<b>上の候補の中から</b>探しています (候補の外は測っていないので外挿しません)。
        </span>
      </p>

      <!-- 経路別 -->
      <h3 class="text-xs font-semibold mb-1">
        経路別 (積地 → 卸地)
      </h3>
      <div class="overflow-x-auto mb-4">
        <table class="text-xs w-full">
          <thead>
            <tr class="text-left text-gray-500 border-b border-gray-300 dark:border-gray-600">
              <th class="px-2 py-1">経路</th>
              <th class="px-2 py-1 text-right">便</th>
              <th class="px-2 py-1 text-right">売上</th>
              <th class="px-2 py-1 text-right">手当</th>
              <th class="px-2 py-1 text-right">売上走行</th>
              <th class="px-2 py-1 text-right" title="組み直し前の実測。推定と引き算しないこと">現状の回送</th>
              <th class="px-2 py-1 text-right">帯広発 回送 (推定)</th>
              <th class="px-2 py-1 text-right">釧路発 回送 (推定)</th>
              <th class="px-2 py-1 text-right" title="釧路発 − 帯広発。両側とも推定なので引き算してよい唯一の列">営業所差</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in routes" :key="r.key" class="border-b border-gray-100 dark:border-gray-800">
              <td class="px-2 py-1 whitespace-nowrap">
                {{ r.label }}
                <span v-if="r.missingLegs > 0" class="text-amber-600 dark:text-amber-400" :title="`座標が欠けて推定に入れられなかった便 ${r.missingLegs}`">*</span>
              </td>
              <td class="px-2 py-1 text-right">{{ r.legs }}</td>
              <td class="px-2 py-1 text-right">{{ fmtYen(r.salesYen) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtYen(r.allowanceYen) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtKm(r.haulKm) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtKm(r.measuredDeadheadKm) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtKm(r.rebuiltDeadheadKm.obihiro) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtKm(r.rebuiltDeadheadKm.kushiro) }}</td>
              <td class="px-2 py-1 text-right" :class="TONE_CLASS[amountTone(r.depotDiffKm)]">{{ fmtKm(r.depotDiffKm) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 乗務員別 -->
      <h3 class="text-xs font-semibold mb-1">
        乗務員別
      </h3>
      <div class="overflow-x-auto">
        <table class="text-xs w-full">
          <thead>
            <tr class="text-left text-gray-500 border-b border-gray-300 dark:border-gray-600">
              <th class="px-2 py-1">乗務員</th>
              <th class="px-2 py-1 text-right">便</th>
              <th class="px-2 py-1 text-right">売上</th>
              <th class="px-2 py-1 text-right">手当</th>
              <th class="px-2 py-1 text-right">売上走行</th>
              <th class="px-2 py-1 text-right" title="組み直し前の実測。推定と引き算しないこと">現状の回送</th>
              <th class="px-2 py-1 text-right">帯広発 回送 (推定)</th>
              <th class="px-2 py-1 text-right">釧路発 回送 (推定)</th>
              <th class="px-2 py-1 text-right" title="釧路発 − 帯広発。両側とも推定なので引き算してよい唯一の列">営業所差</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in drivers" :key="d.key" class="border-b border-gray-100 dark:border-gray-800">
              <td class="px-2 py-1 whitespace-nowrap">
                {{ d.label }}
                <span v-if="d.missingLegs > 0" class="text-amber-600 dark:text-amber-400" :title="`座標が欠けて推定に入れられなかった便 ${d.missingLegs}`">*</span>
              </td>
              <td class="px-2 py-1 text-right">{{ d.legs }}</td>
              <td class="px-2 py-1 text-right">{{ fmtYen(d.salesYen) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtYen(d.allowanceYen) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtKm(d.haulKm) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtKm(d.measuredDeadheadKm) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtKm(d.rebuiltDeadheadKm.obihiro) }}</td>
              <td class="px-2 py-1 text-right">{{ fmtKm(d.rebuiltDeadheadKm.kushiro) }}</td>
              <td class="px-2 py-1 text-right" :class="TONE_CLASS[amountTone(d.depotDiffKm)]">{{ fmtKm(d.depotDiffKm) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
