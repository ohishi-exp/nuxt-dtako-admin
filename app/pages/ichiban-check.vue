<script setup lang="ts">
import { currentAccessToken } from '~/utils/api'
import { describeCaughtError } from '~/utils/api-error'
import { ONPREM_DTAKO_COMP_ID } from '~/utils/dtako-comps'
import { b64urlUtf8 } from '~/composables/useTheearthSession'
import {
  chunkIds,
  countMakecsv,
  describeMakecsvReason,
  flattenIchibanCheck,
  ICHIBAN_CHECK_CATEGORIES,
  idsOfRows,
  parseMakecsvResults,
  type IchibanCheckCategory,
  type IchibanCheckResponse,
  type IchibanCheckRow,
  type MakecsvResult,
} from '~/utils/ichiban-check'

/**
 * 社内 CakePHP の「一番星×デジタコ突合」(旧画面の dtako-ichizip-kintai/dtako-ichiban-check) を読み、合わない運行の
 * CSV を ichizip の取り込みフォルダへ書き出させる画面。経路は relay → 勤怠 Worker → 社内 CakePHP (ブラウザから
 * 社内のホストは叩かない)。この画面は theearth ログインを持たないので、閲覧者のヘッダ (ログインの JWT + 会社) で呼ぶ。
 * 会社は社内 dtako の会社に固定 (他の会社は relay が 403)。
 *
 * **粗利タブの月次突合とは別物で、数字は一致しない** (こちらは一番星へ取り込む CSV を出し直す運行を選ぶための差分)。
 */

function defaultMonth(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const month = ref(defaultMonth())
const loading = ref(false)
const loadError = ref<string | null>(null)
const loadedMonth = ref<string | null>(null)
const rows = ref<IchibanCheckRow[]>([])
const category = ref<IchibanCheckCategory | 'all'>('all')
const selected = ref<Set<string>>(new Set())

const writing = ref(false)
const writeError = ref<string | null>(null)
const results = ref<MakecsvResult[]>([])

const MAKECSV_UNCERTAIN = '書き出せたか分かりません。同じ運行を出し直しても同じファイルを上書きするだけなので、もう一度押してかまいません'

function viewerHeaders(): Record<string, string> | null {
  const token = currentAccessToken()
  if (!token) return null
  return {
    'X-Theearth-Comp-Id': ONPREM_DTAKO_COMP_ID,
    'X-Theearth-User-B64': b64urlUtf8('viewer'),
    'Authorization': `Bearer ${token}`,
  }
}

const counts = computed(() => {
  const n: Record<string, number> = {}
  for (const c of ICHIBAN_CHECK_CATEGORIES) n[c] = rows.value.filter(r => r.category === c).length
  return n
})

const shown = computed(() =>
  category.value === 'all' ? rows.value : rows.value.filter(r => r.category === category.value),
)

const selectableShown = computed(() => shown.value.filter(r => r.ids.length > 0))

const selectedIds = computed(() => idsOfRows(rows.value.filter(r => selected.value.has(r.key))))

const allShownSelected = computed(() =>
  selectableShown.value.length > 0 && selectableShown.value.every(r => selected.value.has(r.key)),
)

function toggleRow(row: IchibanCheckRow) {
  const next = new Set(selected.value)
  if (next.has(row.key)) next.delete(row.key)
  else next.add(row.key)
  selected.value = next
}

function toggleAllShown() {
  const next = new Set(selected.value)
  const on = !allShownSelected.value
  for (const r of selectableShown.value) {
    if (on) next.add(r.key)
    else next.delete(r.key)
  }
  selected.value = next
}

async function load() {
  if (loading.value) return
  const headers = viewerHeaders()
  if (!headers) {
    loadError.value = 'ログインの情報がありません。ページを読み込み直してからもう一度押してください'
    return
  }
  loading.value = true
  loadError.value = null
  results.value = []
  writeError.value = null
  try {
    // retry: 0 — ofetch は GET の 502 を既定で 1 回やり直す (dev で 2 回飛ぶのを実測)。突合は社内で 30〜40 秒かかる
    // 重い計算で、打ち切り (502) のあとにもう 1 回走らせると待ちも社内の負荷も倍になる。やり直しは人が押す
    const res = await $fetch<IchibanCheckResponse>('/restraint-api/kintai/ichiban-check', {
      query: { month: month.value },
      headers,
      retry: 0,
    })
    rows.value = flattenIchibanCheck(res)
    selected.value = new Set()
    loadedMonth.value = month.value
  }
  catch (e) {
    loadError.value = describeCaughtError(e, 'もう一度押してください')
  }
  finally {
    loading.value = false
  }
}

/** 選んだ運行の CSV を出す。勤怠 Worker の 1 回あたりの上限 (500 件) ごとに順に送る。 */
async function writeCsv() {
  const ids = selectedIds.value
  if (writing.value || ids.length === 0) return
  if (!window.confirm(`${ids.length} 件の運行の CSV を ichizip の取り込みフォルダへ書き出します (旧画面の make と同じ)。よろしいですか？`)) return
  const headers = viewerHeaders()
  if (!headers) {
    writeError.value = 'ログインの情報がありません。ページを読み込み直してからもう一度押してください'
    return
  }
  writing.value = true
  writeError.value = null
  results.value = []
  try {
    for (const chunk of chunkIds(ids)) {
      const body = await $fetch<unknown>('/restraint-api/kintai/ichiban-makecsv', {
        method: 'POST',
        headers,
        body: { ids: chunk },
      })
      results.value = [...results.value, ...parseMakecsvResults(body)]
    }
  }
  catch (e) {
    const uncertain = (e as { data?: { uncertain?: unknown } } | null)?.data?.uncertain === true
    writeError.value = uncertain ? MAKECSV_UNCERTAIN : describeCaughtError(e, 'もう一度押してください')
  }
  finally {
    writing.value = false
  }
}

const resultCounts = computed(() => countMakecsv(results.value))

const STATUS_LABEL: Record<MakecsvResult['status'], string> = { written: '書き出した', skipped: '飛ばした', error: '失敗' }
const STATUS_CLASS: Record<MakecsvResult['status'], string> = {
  written: 'text-green-700 dark:text-green-400',
  skipped: 'text-amber-700 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
}
</script>

<template>
  <div class="p-6">
    <h1 class="text-xl font-bold mb-1">
      一番星×デジタコ突合 (ichizip CSV)
    </h1>
    <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
      社内 dtako の突合 (旧画面の「dtako-ichiban-check」) を読み、一番星と合わない運行の CSV を ichizip の取り込みフォルダへ出し直します。
      粗利タブの月次突合とは別の計算なので、数字は一致しません。読み込みには 40 秒ほどかかります。
    </p>

    <div class="flex items-end gap-3 mb-4">
      <div>
        <label class="block text-xs text-gray-500 dark:text-gray-400 mb-1">対象月</label>
        <UInput v-model="month" type="month" :disabled="loading" />
      </div>
      <UButton icon="i-lucide-scale" :loading="loading" @click="load">
        突合を読む
      </UButton>
      <span v-if="loading" class="text-xs text-gray-500 dark:text-gray-400 pb-2">社内の突合を計算中 (40 秒ほど)…</span>
    </div>

    <p v-if="loadError" class="text-sm text-red-600 dark:text-red-400 mb-4">
      {{ loadError }}
    </p>

    <template v-if="loadedMonth && !loading">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <UButton size="xs" :variant="category === 'all' ? 'solid' : 'outline'" @click="category = 'all'">
          すべて ({{ rows.length }})
        </UButton>
        <UButton
          v-for="c in ICHIBAN_CHECK_CATEGORIES"
          :key="c"
          size="xs"
          :variant="category === c ? 'solid' : 'outline'"
          @click="category = c"
        >
          {{ c }} ({{ counts[c] }})
        </UButton>
      </div>

      <p v-if="rows.length === 0" class="text-sm text-gray-600 dark:text-gray-300 mb-4">
        {{ loadedMonth }} は一番星とデジタコの差がありません。
      </p>

      <template v-else>
        <div class="flex items-center gap-3 mb-2">
          <UButton
            icon="i-lucide-file-output"
            :loading="writing"
            :disabled="selectedIds.length === 0"
            @click="writeCsv"
          >
            選んだ運行の CSV を出す ({{ selectedIds.length }} 件)
          </UButton>
          <span class="text-xs text-gray-500 dark:text-gray-400">運行の無い行 (経費の未対応コード等) は選べません。黄色は ETC 連携を除外中の車両の運行です。</span>
        </div>

        <p v-if="writeError" class="text-sm text-red-600 dark:text-red-400 mb-2">
          {{ writeError }}
        </p>

        <div v-if="results.length > 0" class="mb-4 text-sm">
          <p class="mb-1">
            書き出した {{ resultCounts.written }} 件 / 飛ばした {{ resultCounts.skipped }} 件 / 失敗 {{ resultCounts.error }} 件。
            一番星への取り込み後に「突合を読む」を押し直すと、消えたかを確かめられます。
          </p>
          <ul class="text-xs space-y-0.5">
            <li v-for="r in results" :key="r.id" class="tabular-nums">
              <span :class="STATUS_CLASS[r.status]">{{ STATUS_LABEL[r.status] }}</span>
              {{ r.id }}
              <span v-if="r.written.length" class="text-gray-500 dark:text-gray-400">{{ r.written.join(', ') }}</span>
              <span v-if="r.reason" class="text-gray-500 dark:text-gray-400">{{ describeMakecsvReason(r.reason) }}</span>
              <span v-if="r.message" class="text-gray-500 dark:text-gray-400">({{ r.message }})</span>
            </li>
          </ul>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
                <th class="py-2 pr-2">
                  <input type="checkbox" :checked="allShownSelected" :disabled="selectableShown.length === 0" aria-label="表示中の行をすべて選ぶ" @change="toggleAllShown">
                </th>
                <th class="py-2 pr-3 font-medium">項目</th>
                <th class="py-2 pr-3 font-medium">乗務員</th>
                <th class="py-2 pr-3 font-medium">日付 / キー</th>
                <th class="py-2 pr-3 font-medium text-right">一番星</th>
                <th class="py-2 pr-3 font-medium text-right">差分</th>
                <th class="py-2 pr-3 font-medium">車両 / 部門</th>
                <th class="py-2 font-medium">運行</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in shown"
                :key="row.key"
                class="border-b border-gray-100 dark:border-gray-800"
                :class="row.etcExcluded ? 'bg-yellow-50 dark:bg-yellow-900/20' : ''"
              >
                <td class="py-1.5 pr-2">
                  <input
                    type="checkbox"
                    :checked="selected.has(row.key)"
                    :disabled="row.ids.length === 0"
                    :aria-label="`${row.category} ${row.driverCd} ${row.label} を選ぶ`"
                    @change="toggleRow(row)"
                  >
                </td>
                <td class="py-1.5 pr-3 whitespace-nowrap">{{ row.category }}<span v-if="row.item" class="text-gray-500 dark:text-gray-400"> / {{ row.item }}</span></td>
                <td class="py-1.5 pr-3 whitespace-nowrap">{{ row.driverCd }} {{ row.driverName }}</td>
                <td class="py-1.5 pr-3 tabular-nums">{{ row.label }}</td>
                <td class="py-1.5 pr-3 tabular-nums text-right">{{ row.value }}</td>
                <td class="py-1.5 pr-3 tabular-nums text-right">{{ row.diff }}</td>
                <td class="py-1.5 pr-3 tabular-nums whitespace-nowrap">{{ [row.vehicle, row.dept].filter(Boolean).join(' / ') }}</td>
                <td class="py-1.5 tabular-nums text-xs text-gray-500 dark:text-gray-400">{{ row.ids.length ? row.ids.join(' ') : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </div>
</template>
