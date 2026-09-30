<script setup lang="ts">
/**
 * 単価マスタを最低賃金で作る (「単価マスタ = 最低賃金」運用、Refs #1133)。
 *
 * relay `POST /restraint-api/min-wage/apply-to-wage-master` の driverCds / until を叩く。
 * **まず dryRun で入る行を見せ、「この内容で登録」で確定する** (2 段)。単価が既にある乗務員は
 * relay が keep にする (overwrite は送らない)。単価マスタ全体を画面から PUT しない。
 * body の組み立てと応答の要約は `app/utils/min-wage-fix.ts`。
 */
import { describeCaughtError } from '~/utils/api-error'
import {
  buildRateMasterApplyBody,
  describeRateMasterApply,
  rateMasterApplyLines,
  type RateMasterApplyLine,
  type RateMasterApplyResponse,
} from '~/utils/min-wage-fix'

const props = defineProps<{
  driverCds: readonly string[]
  /** 期間 (勤務月 `YYYY-MM`、両端を含む) */
  from: string
  to: string
  /** relay の認証ヘッダ (画面ごとの authHeaders) */
  headers: () => Record<string, string>
  /** ボタンの対象の表示 (例 `架空 太郎 (9001)`)。無ければ乗務員CD を並べる */
  targetLabel?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ applied: [res: RateMasterApplyResponse] }>()

const busy = ref(false)
const preview = ref<RateMasterApplyLine[] | null>(null)
const previewAdds = ref(0)
const message = ref('')

const periodLabel = computed(() => props.from === props.to ? props.from : `${props.from}〜${props.to}`)
const target = computed(() => props.targetLabel ?? props.driverCds.join('・'))

async function post(dryRun: boolean): Promise<RateMasterApplyResponse> {
  return $fetch<RateMasterApplyResponse>('/restraint-api/min-wage/apply-to-wage-master', {
    method: 'POST',
    headers: props.headers(),
    body: buildRateMasterApplyBody({ driverCds: props.driverCds, from: props.from, to: props.to, dryRun }),
  })
}

async function runPreview() {
  busy.value = true
  message.value = ''
  try {
    const res = await post(true)
    preview.value = rateMasterApplyLines(res)
    previewAdds.value = res.added
  }
  catch (e) {
    preview.value = null
    message.value = `単価マスタの見込みを出せませんでした: ${describeCaughtError(e, 'もう一度押してください')}`
  }
  finally {
    busy.value = false
  }
}

async function confirm() {
  busy.value = true
  message.value = ''
  try {
    const res = await post(false)
    preview.value = null
    message.value = describeRateMasterApply(res)
    emit('applied', res)
  }
  catch (e) {
    message.value = `単価マスタに入れられませんでした: ${describeCaughtError(e, 'もう一度押してください')}`
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-1" data-testid="min-wage-rate-master">
    <UButton
      size="xs"
      icon="i-lucide-list-plus"
      :label="`${target} の単価を最低賃金で入れる (${periodLabel})`"
      :loading="busy && preview === null"
      :disabled="busy || disabled"
      data-testid="min-wage-rate-master-preview"
      @click="runPreview"
    />
    <div v-if="preview" class="rounded border border-gray-200 dark:border-gray-700 p-2 space-y-1" data-testid="min-wage-rate-master-lines">
      <div class="font-medium">入る内容 (まだ保存していません)</div>
      <div v-for="(l, i) in preview" :key="i" :class="l.willAdd ? '' : 'text-gray-500'" data-min-wage-line>{{ l.driverCd }}: {{ l.text }}</div>
      <div class="flex gap-2">
        <UButton
          size="xs"
          label="この内容で登録"
          :loading="busy"
          :disabled="busy || previewAdds === 0"
          data-testid="min-wage-rate-master-confirm"
          @click="confirm"
        />
        <UButton size="xs" variant="ghost" label="やめる" :disabled="busy" data-testid="min-wage-rate-master-cancel" @click="preview = null" />
      </div>
    </div>
    <div v-if="message" data-testid="min-wage-rate-master-message">{{ message }}</div>
  </div>
</template>
