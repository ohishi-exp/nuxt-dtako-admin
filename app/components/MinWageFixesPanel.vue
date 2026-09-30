<script setup lang="ts">
/**
 * 「判定できない」月の直し方パネル (Refs #1133)。訴訟準備・給与比較と拘束×賃金・最低賃金チェックの共通。
 *
 * 理由ごとに 件数・月範囲・その場で押せる手当てを実行順に並べる:
 * ① 最低賃金が引けない → 過去の最低賃金を取り込む / 県が引けない → 県を設定する手順
 * ② 単価マスタに単価が無い → 単価マスタを最低賃金で作る (`MinWageRateMasterButton`)
 * ③ 材料を取り直す — 中身は画面ごとに違うので `retake` イベントで呼び出し側に任せる
 * 集計は `minWageFixes` (`app/utils/min-wage-fix.ts`)。**最低賃金がマスタにあるかは判定しない**。
 */
import { describeCaughtError } from '~/utils/api-error'
import {
  describeMinWageImport,
  fmtMinWageFixGroup,
  hasMinWageFixes,
  importMinWageFromMhlw,
  minWageFixes,
  type MinWageFixInput,
  type RateMasterApplyResponse,
} from '~/utils/min-wage-fix'

const props = withDefaults(defineProps<{
  rows: readonly MinWageFixInput[]
  /** 単価マスタを作る期間 (勤務月 `YYYY-MM`) */
  from: string
  to: string
  headers: () => Record<string, string>
  /** ③ のボタン名と所要の注記 (画面ごと) */
  retakeLabel: string
  retakeNote?: string
  retaking?: boolean
  retakeDisabled?: boolean
  /** 判定できない月が 0 件でも出す (訴訟準備で属性を入れた直後など) */
  forceShow?: boolean
  /** 拘束×賃金へのリンクを出す (拘束×賃金の画面自身では出さない) */
  showLinks?: boolean
  /** 乗務員CD → 表示名 (単価マスタのボタンに使う) */
  driverLabel?: (driverCd: string) => string
}>(), { retakeNote: '', retaking: false, retakeDisabled: false, forceShow: false, showLinks: true, driverLabel: undefined })

const emit = defineEmits<{ retake: [], imported: [], applied: [res: RateMasterApplyResponse] }>()

const fixes = computed(() => minWageFixes(props.rows))
const shown = computed(() => props.forceShow || hasMinWageFixes(fixes.value))

const importing = ref(false)
const importMessage = ref('')
async function importHistory() {
  importing.value = true
  importMessage.value = ''
  try {
    importMessage.value = `${describeMinWageImport(await importMinWageFromMhlw(props.headers(), 'history'))} — 続けて ③ を押してください`
    emit('imported')
  }
  catch (e) {
    importMessage.value = `最低賃金を取り込めませんでした: ${describeCaughtError(e, 'もう一度押してください')}`
  }
  finally {
    importing.value = false
  }
}
</script>

<template>
  <div v-if="shown" class="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 space-y-2 text-xs text-gray-700 dark:text-gray-300 print:hidden" data-testid="min-wage-fixes">
    <div class="text-sm font-bold text-amber-800 dark:text-amber-300">直し方 (上から順に)</div>
    <slot />
    <div v-if="fixes.minWageMissing" class="flex items-center gap-2 flex-wrap" data-testid="min-wage-fix-minwage">
      <span>① 最低賃金が引けない月 {{ fmtMinWageFixGroup(fixes.minWageMissing) }}:</span>
      <UButton
        size="xs"
        icon="i-lucide-download"
        label="厚労省から過去の最低賃金を取り込む"
        :loading="importing"
        :disabled="importing || retaking"
        data-testid="min-wage-fix-import"
        @click="importHistory"
      />
      <span>→ 取り込んだら下の ③ を押す</span>
    </div>
    <div v-if="importMessage" data-testid="min-wage-fix-import-message">{{ importMessage }}</div>
    <div v-if="fixes.prefectureMissing" data-testid="min-wage-fix-prefecture">
      ① 所属から県が引けない月 {{ fmtMinWageFixGroup(fixes.prefectureMissing) }}: 拘束×賃金 → 最低賃金チェック → ▸ 最低賃金 で拠点の県を設定してから、下の ③ を押す
      <NuxtLink v-if="showLinks" to="/restraint-wage" class="underline text-primary-600 dark:text-primary-400">拘束×賃金を開く</NuxtLink>
    </div>
    <div v-if="fixes.rateMissing" class="space-y-1" data-testid="min-wage-fix-rate">
      <div>② 単価マスタに単価が無い月 {{ fmtMinWageFixGroup(fixes.rateMissing) }}: 最低賃金で単価を入れる (既に単価がある乗務員には触らない)。入れたら下の ③ を押す</div>
      <MinWageRateMasterButton
        v-for="cd in fixes.rateMissing.driverCds"
        :key="cd"
        :driver-cds="[cd]"
        :from="from"
        :to="to"
        :headers="headers"
        :target-label="driverLabel ? driverLabel(cd) : undefined"
        :disabled="retaking"
        @applied="res => emit('applied', res)"
      />
    </div>
    <div class="flex items-center gap-2 flex-wrap" data-testid="min-wage-fix-retake">
      <span>③</span>
      <UButton
        size="xs"
        icon="i-lucide-refresh-cw"
        :label="retakeLabel"
        :loading="retaking"
        :disabled="retaking || retakeDisabled"
        data-testid="min-wage-fix-retake-button"
        @click="emit('retake')"
      />
      <span v-if="retakeNote">{{ retakeNote }}</span>
    </div>
  </div>
</template>
