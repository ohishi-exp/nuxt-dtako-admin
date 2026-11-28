<script setup lang="ts">
import { DatrIndex, hasAlcohol, isDatrLogFile, parseCodeList, searchDatr, type DatrRecord } from '~/utils/datr-log'

const MAX_ROWS = 2000
/** 読み込み中に画面へ途中結果を出す間隔 (ms) */
const FLUSH_MS = 400

const fileInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const progress = ref('')
const error = ref<string | null>(null)

// ログはファイル 1 本ずつ index に足し、FLUSH_MS ごとに records を差し替えて途中結果を出す。
// 数十万件になるので records は shallowRef (中身の深い監視をしない)
let index = new DatrIndex()
// 読み込み済みのログ名。1 本ごとに描画が走らないよう、画面へは flush で件数だけ渡す
let loadedLogs = new Set<string>()
const loadedCount = ref(0)
const records = shallowRef<DatrRecord[]>([])
const skipped = shallowRef<DatrIndex['skipped']>([])
function flush() {
  records.value = index.records()
  skipped.value = [...index.skipped]
  loadedCount.value = loadedLogs.size
}
// 画像ファイル名 → object URL (ログ行の「画像」列と突き合わせて表示する)
const images = shallowRef(new Map<string, string>())
const preview = ref<string | null>(null)

function clearAll() {
  for (const url of images.value.values()) URL.revokeObjectURL(url)
  images.value = new Map()
  index = new DatrIndex()
  loadedLogs = new Set()
  flush()
}
onBeforeUnmount(clearAll)

const codeText = ref('')
const from = ref('')
const to = ref('')
const alcoholOnly = ref(false)

const codes = computed(() => parseCodeList(codeText.value))
const result = computed(() => searchDatr(records.value, { codes: codes.value, from: from.value, to: to.value, alcoholOnly: alcoholOnly.value }))
const missing = computed(() => result.value.perCode.filter(c => c.count === 0).map(c => c.code))
// jpg は 1 年しか残らないので、古い行は写真が無いのが普通
const noImage = computed(() => images.value.size === 0 ? 0 : result.value.hits.filter(r => !images.value.has(r.image)).length)
const shown = computed(() => result.value.hits.slice(0, MAX_ROWS))

async function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files ? Array.from(input.files) : []
  input.value = ''
  if (files.length === 0) return
  loading.value = true
  error.value = null
  try {
    // 追加読み込み: ログと画像を別々に何回かに分けて選んでもよい。
    // フォルダ選択では関係ないファイルも来るので拡張子で振り分ける
    const isImage = (f: File) => /\.jpe?g$/i.test(f.name)

    const next = new Map(images.value)
    for (const f of files.filter(isImage)) {
      const old = next.get(f.name)
      if (old) URL.revokeObjectURL(old)
      next.set(f.name, URL.createObjectURL(f))
    }
    images.value = next

    // 読み込み済みと同名のログは飛ばす (二重に足すと「ファイル」列が重複するため)
    const logs = files.filter(f => isDatrLogFile(f.name) && !loadedLogs.has(f.name))
    let last = performance.now()
    for (let i = 0; i < logs.length; i++) {
      const f = logs[i]!
      index.add({ name: f.name, text: await f.text() })
      loadedLogs.add(f.name)
      if (performance.now() - last >= FLUSH_MS) {
        progress.value = `${i + 1} / ${logs.length} ファイル読み込み中…`
        flush()
        // 描画させてから続きを読む
        await new Promise(r => setTimeout(r, 0))
        last = performance.now()
      }
    }
    flush()
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    flush()
  }
  finally {
    loading.value = false
    progress.value = ''
  }
}
</script>

<template>
  <div class="max-w-7xl">
    <h1 class="text-2xl font-bold mb-1">
      datr 一括検索
    </h1>
    <p class="text-sm text-gray-500 mb-6">
      測定ログ (<code>.dat</code> / <code>.bak</code>、2017 年ごろは <code>.datr</code> / <code>.bakr</code>) と画像 <code>.jpg</code> をまとめて読み込み、
      コード (複数可)・期間・アルコール値の有無で検索します。アルコール値が 0 でない行は赤字です。
      「その他の列」は意味の分かっていない列をそのまま出したものです。
      同じ行が複数ファイルにある場合 (<code>.bak</code> は <code>.dat</code> の控え) は 1 件に畳みます。
      画像 (jpg フォルダはフォルダごと選べます) も読み込むと、ログの画像ファイル名と一致する写真を各行に表示します。
      ログと画像は別々に何回かに分けて選んでも足し込まれます。
      読み込みはブラウザ内で完結し、ファイルはサーバーに送信されません。
    </p>

    <UCard class="mb-4">
      <div class="flex flex-wrap items-center gap-3">
        <UButton
          label="ファイルを選択 (複数可)"
          icon="i-lucide-upload"
          :loading="loading"
          @click="fileInput?.click()"
        />
        <UButton
          label="フォルダを選択"
          icon="i-lucide-folder-open"
          color="neutral"
          variant="outline"
          :loading="loading"
          @click="folderInput?.click()"
        />
        <input
          ref="folderInput"
          type="file"
          webkitdirectory
          multiple
          class="hidden"
          @change="handleFileChange"
        >
        <input
          ref="fileInput"
          type="file"
          accept=".dat,.bak,.datr,.bakr,.jpg,.jpeg"
          multiple
          class="hidden"
          @change="handleFileChange"
        >
        <UButton
          v-if="loadedCount > 0 || images.size > 0"
          label="クリア"
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          @click="clearAll"
        />
        <span v-if="loadedCount > 0 || images.size > 0" class="text-sm text-gray-500">
          ログ {{ loadedCount }} ファイル / {{ records.length }} 件・画像 {{ images.size }} 枚
          <template v-if="skipped.length > 0">(読めない行 {{ skipped.length }})</template>
        </span>
        <span v-if="progress" class="text-sm text-gray-400">
          <UIcon name="i-lucide-loader-circle" class="animate-spin size-4 inline-block mr-1" />
          {{ progress }} (読み込んだ分から検索できます)
        </span>
      </div>
      <div v-if="error" class="mt-3 text-sm text-red-600 bg-red-50 dark:bg-red-950 rounded-lg p-3">
        <UIcon name="i-lucide-alert-circle" class="size-4 inline-block mr-1" />
        {{ error }}
      </div>
      <details v-if="skipped.length > 0" class="mt-3 text-xs text-gray-500">
        <summary class="cursor-pointer">
          読めない行
        </summary>
        <div v-for="s in skipped" :key="`${s.source}:${s.line}`" class="font-mono">
          {{ s.source }}:{{ s.line }} {{ s.text }}
        </div>
      </details>
    </UCard>

    <UCard v-if="records.length > 0" class="mb-4">
      <div class="grid gap-4 md:grid-cols-[1fr_auto]">
        <UFormField label="コード (改行・カンマ・空白区切りで複数。空なら全件)">
          <UTextarea v-model="codeText" :rows="4" class="w-full font-mono" placeholder="例: 1029, 1026 (改行区切りでも可)" />
        </UFormField>
        <div class="flex gap-3 items-start">
          <UFormField label="開始日">
            <UInput v-model="from" type="date" />
          </UFormField>
          <UFormField label="終了日">
            <UInput v-model="to" type="date" />
          </UFormField>
        </div>
        <UCheckbox
          v-model="alcoholOnly"
          class="md:col-span-2"
          label="アルコール値が 0 でない行だけ"
        />
      </div>
    </UCard>

    <template v-if="records.length > 0">
      <UCard v-if="result.perCode.length > 0" class="mb-4">
        <div class="text-sm font-semibold mb-2">
          コード別件数
        </div>
        <div class="flex flex-wrap gap-2 text-sm">
          <span
            v-for="c in result.perCode"
            :key="c.code"
            class="px-2 py-0.5 rounded font-mono"
            :class="c.count === 0 ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300' : 'bg-gray-100 dark:bg-gray-800'"
          >{{ c.code }}: {{ c.count }}</span>
        </div>
        <div v-if="missing.length > 0" class="mt-2 text-sm text-red-600">
          見つからなかったコード: {{ missing.join(', ') }}
        </div>
      </UCard>

      <div class="text-sm text-gray-500 mb-2">
        {{ result.hits.length }} 件
        <template v-if="noImage > 0">(うち写真なし {{ noImage }} 件 — jpg は約 1 年で消えます)</template>
        <template v-if="result.hits.length > MAX_ROWS">(先頭 {{ MAX_ROWS }} 件を表示。コードか期間で絞ってください)</template>
      </div>
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="text-left text-gray-500 border-b border-gray-200 dark:border-gray-700">
            <tr>
              <th class="py-1 pr-4">
                日付
              </th>
              <th class="py-1 pr-4">
                時刻
              </th>
              <th class="py-1 pr-4">
                コード
              </th>
              <th class="py-1 pr-4">
                画像
              </th>
              <th class="py-1 pr-4">
                アルコール
              </th>
              <th class="py-1 pr-4">
                その他の列
              </th>
              <th class="py-1 pr-4">
                ファイル
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in shown" :key="`${r.date}${r.time}${r.code}${r.image}`" class="border-b border-gray-100 dark:border-gray-800">
              <td class="py-1 pr-4 font-mono">
                {{ r.date }}
              </td>
              <td class="py-1 pr-4 font-mono">
                {{ r.time }}
              </td>
              <td class="py-1 pr-4 font-mono">
                {{ r.code }}
              </td>
              <td class="py-1 pr-4 font-mono">
                <div class="flex items-center gap-2">
                  <button v-if="images.get(r.image)" type="button" @click="preview = images.get(r.image)!">
                    <img :src="images.get(r.image)" :alt="r.image" class="h-12 w-auto rounded" loading="lazy">
                  </button>
                  <span>{{ r.image }}</span>
                </div>
              </td>
              <td class="py-1 pr-4 font-mono" :class="hasAlcohol(r) ? 'text-red-600 font-semibold' : 'text-gray-400'">
                {{ r.alcohol }}
              </td>
              <td class="py-1 pr-4 font-mono text-gray-400">
                {{ r.extra.join(',') }}
              </td>
              <td class="py-1 pr-4 text-gray-500">
                {{ r.sources.join(', ') }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div
      v-if="preview"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-zoom-out"
      @click="preview = null"
    >
      <img :src="preview" alt="" class="max-h-[90vh] max-w-[90vw] rounded">
    </div>
  </div>
</template>
