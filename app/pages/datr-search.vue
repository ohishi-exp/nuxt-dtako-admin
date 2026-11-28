<script setup lang="ts">
import type { IchibanLeaveEmployeeRow } from '~/utils/employee-master'
import { clearDatrFiles, loadDatrFiles, saveDatrFiles, type StoredImage, type StoredLog } from '~/utils/datr-store'
import { alcoholDayCountUntil, alcoholDaysByCode, buildEmployeeInfoMap, DEFAULT_EXCLUDED_CODES, DatrIndex, hasAlcohol, isDatrLogFile, parseCodeList, searchDatr, type DatrRecord, type EmployeeInfo } from '~/utils/datr-log'

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

function resetView() {
  for (const url of images.value.values()) URL.revokeObjectURL(url)
  images.value = new Map()
  index = new DatrIndex()
  loadedLogs = new Set()
  flush()
}
// 画面を離れるときは表示だけ片付ける (保存したファイルは残し、開き直したら戻す)
onBeforeUnmount(resetView)

// 読み込んだファイルはこの端末のブラウザ (IndexedDB) に取っておき、F5 や開き直しで自動で戻す。
// 保存に失敗しても検索はできるので、注記だけ出す
const storeNote = ref<string | null>(null)

// 「クリア」は保存したファイルも消す
async function clearAll() {
  resetView()
  storeNote.value = null
  try {
    await clearDatrFiles()
  }
  catch {
    // 保存できない環境では消すものも無い
  }
}


// 一番星 社員ﾏｽﾀ: コード (= 社員C) → 氏名・入社日・退職日。取れなくても検索はできるので、失敗は注記だけ出す。
// proxy の base に `/api` が含まれないため `/api/ichiban/api/leave/employees` と二重に書く
const employees = shallowRef(new Map<string, EmployeeInfo>())
const employeeError = ref<string | null>(null)
onMounted(async () => {
  try {
    const res = await $fetch<{ data: IchibanLeaveEmployeeRow[] }>('/api/ichiban/api/leave/employees')
    employees.value = buildEmployeeInfoMap(res.data ?? [])
  }
  catch (err) {
    employeeError.value = err instanceof Error ? err.message : String(err)
  }
})

const codeText = ref('')
const from = ref('')
const to = ref('')
const alcoholOnly = ref(false)
const excludeDefault = ref(true)

const codes = computed(() => parseCodeList(codeText.value))
const result = computed(() => searchDatr(records.value, { codes: codes.value, from: from.value, to: to.value, alcoholOnly: alcoholOnly.value, excludeCodes: excludeDefault.value ? DEFAULT_EXCLUDED_CODES : [] }))
// 通算回数: 読み込んだ全ログでアルコール検知のあった日 (同じ日は 1 回。絞り込みに関係なく数える)
const alcoholDays = computed(() => alcoholDaysByCode(records.value))
const missing = computed(() => result.value.perCode.filter(c => c.count === 0).map(c => c.code))
// jpg は 1 年しか残らないので、古い行は写真が無いのが普通
const noImage = computed(() => images.value.size === 0 ? 0 : result.value.hits.filter(r => !images.value.has(r.image)).length)
const shown = computed(() => result.value.hits.slice(0, MAX_ROWS))

// 紙の向き: 粗利・拘束×賃金・訴訟の画面は非 scoped の `@page { size: A4 landscape }` を持ち、SPA では
// 一度開くとこの画面の印刷にも残って横になる。この画面を開いている間だけ <head> の最後に縦の指定を置き、
// 後から書いた @page が勝つことで縦にする (離れるときに外すので、他の画面の横向きは壊さない)。
// 後から <head> に stylesheet が足されると負けるので、足されるたびと印刷の直前に最後へ置き直す
let portraitStyle: HTMLStyleElement | null = null
let headObserver: MutationObserver | null = null
function placePortraitLast() {
  if (portraitStyle && document.head.lastElementChild !== portraitStyle) document.head.appendChild(portraitStyle)
}
onMounted(() => {
  portraitStyle = document.createElement('style')
  portraitStyle.textContent = '@media print { @page { size: A4 portrait; } }'
  placePortraitLast()
  headObserver = new MutationObserver(placePortraitLast)
  headObserver.observe(document.head, { childList: true })
  window.addEventListener('beforeprint', placePortraitLast)
})
onBeforeUnmount(() => {
  headObserver?.disconnect()
  window.removeEventListener('beforeprint', placePortraitLast)
  portraitStyle?.remove()
})

// 写真は loading="lazy" なので、画面外の行は読み込まれないまま紙に出ることがある。
// 印刷の前に全部読み込ませてから印刷ダイアログを開く
async function printPage() {
  const imgs = [...document.querySelectorAll<HTMLImageElement>('.datr-table img')]
  for (const img of imgs) img.loading = 'eager'
  await Promise.all(imgs.map(img => img.decode().catch(() => {})))
  placePortraitLast()
  window.print()
}

/**
 * ログと写真を画面に足す。ファイル選択と、保存しておいた分の復元の両方が通る。
 * `save` が true なら読み込んだ分を IndexedDB に取っておく
 */
async function ingest(logFiles: { name: string, read: () => Promise<string> }[], imageFiles: StoredImage[], save: boolean) {
  const next = new Map(images.value)
  for (const f of imageFiles) {
    const old = next.get(f.name)
    if (old) URL.revokeObjectURL(old)
    next.set(f.name, URL.createObjectURL(f.blob))
  }
  images.value = next

  // 読み込み済みと同名のログは飛ばす (二重に足すと「ファイル」列が重複するため)
  const logs = logFiles.filter(f => !loadedLogs.has(f.name))
  const added: StoredLog[] = []
  let last = performance.now()
  for (let i = 0; i < logs.length; i++) {
    const f = logs[i]!
    const text = await f.read()
    index.add({ name: f.name, text })
    loadedLogs.add(f.name)
    added.push({ name: f.name, text })
    if (performance.now() - last >= FLUSH_MS) {
      progress.value = `${i + 1} / ${logs.length} ファイル読み込み中…`
      flush()
      // 描画させてから続きを読む
      await new Promise(r => setTimeout(r, 0))
      last = performance.now()
    }
  }
  flush()

  if (save && (added.length > 0 || imageFiles.length > 0)) {
    try {
      await saveDatrFiles(added, imageFiles)
    }
    catch (err) {
      storeNote.value = `読み込んだファイルをこのブラウザに保存できませんでした。開き直すと選び直しになります (${err instanceof Error ? err.message : String(err)})`
    }
  }
}

// 保存しておいたファイルを戻す
onMounted(async () => {
  let stored: Awaited<ReturnType<typeof loadDatrFiles>>
  try {
    stored = await loadDatrFiles()
  }
  catch {
    return
  }
  if (stored.logs.length === 0 && stored.images.length === 0) return
  loading.value = true
  try {
    await ingest(stored.logs.map(l => ({ name: l.name, read: async () => l.text })), stored.images, false)
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    flush()
  }
  finally {
    loading.value = false
    progress.value = ''
  }
})

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
    await ingest(
      files.filter(f => isDatrLogFile(f.name)).map(f => ({ name: f.name, read: () => f.text() })),
      files.filter(isImage).map(f => ({ name: f.name, blob: f })),
      true,
    )
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
  <div class="max-w-7xl datr-search">
    <div class="flex items-center justify-between gap-3 mb-1">
      <h1 class="text-2xl font-bold">
        datr 一括検索
      </h1>
      <UButton
        v-if="result.hits.length > 0"
        label="印刷 (A4 縦)"
        icon="i-lucide-printer"
        color="neutral"
        variant="outline"
        class="print:hidden"
        @click="printPage"
      />
    </div>
    <p class="text-sm text-gray-500 mb-6 print:hidden">
      測定ログ (<code>.dat</code> / <code>.bak</code>、2017 年ごろは <code>.datr</code> / <code>.bakr</code>) と画像 <code>.jpg</code> をまとめて読み込み、
      コード (複数可)・期間・アルコール値の有無で検索します。アルコール値が 0 でない行は赤字です。
      「その他の列」は意味の分かっていない列をそのまま出したものです。
      氏名・入社日・退職日は一番星の社員マスタから、通算回数は読み込んだログ全体で、そのコードがアルコール検知 (値が 0 でない行) をした日数です。同じ日に何回検知しても 1 回と数え、表の各行にはその日までの回数を出します (期間などの絞り込みに関係なく数えます)。
      同じ行が複数ファイルにある場合 (<code>.bak</code> は <code>.dat</code> の控え) は 1 件に畳みます。
      画像 (jpg フォルダはフォルダごと選べます) も読み込むと、ログの画像ファイル名と一致する写真を各行に表示します。
      ログと画像は別々に何回かに分けて選んでも足し込まれます。
      読み込みはブラウザ内で完結し、ファイルはサーバーに送信されません。
      読み込んだファイルはこのブラウザに保存され、開き直したり更新したりしても自動で戻ります (消すときは「クリア」)。
    </p>

    <UCard class="mb-4 print:hidden">
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
      <div v-if="storeNote" class="mt-3 text-sm text-amber-700 dark:text-amber-300">
        {{ storeNote }}
      </div>
      <div v-if="employeeError" class="mt-3 text-sm text-amber-700 dark:text-amber-300">
        一番星の社員マスタを読めなかったため、氏名・入社日・退職日は出ません ({{ employeeError }})。
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

    <UCard v-if="records.length > 0" class="mb-4 print:hidden">
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
        <div class="md:col-span-2 flex flex-wrap gap-6">
          <UCheckbox v-model="alcoholOnly" label="アルコール値が 0 でない行だけ" />
          <UCheckbox v-model="excludeDefault" :label="`コード ${DEFAULT_EXCLUDED_CODES.join(', ')} を除外`" />
        </div>
      </div>
    </UCard>

    <template v-if="records.length > 0">
      <!-- 紙では入力欄が消えるので、何で絞った結果かを文字で残す -->
      <div class="hidden print:block text-xs mb-2">
        条件: コード {{ codes.length > 0 ? codes.join(', ') : '全件' }} / 期間 {{ from || '指定なし' }} 〜 {{ to || '指定なし' }}<template v-if="alcoholOnly"> / アルコール値が 0 でない行だけ</template><template v-if="excludeDefault"> / コード {{ DEFAULT_EXCLUDED_CODES.join(', ') }} を除外</template>
      </div>
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
          >{{ [c.code, employees.get(c.code)?.name].filter(Boolean).join(' ') }}: {{ c.count }}
            <span class="text-gray-500">(アルコール検知 通算 {{ alcoholDays.get(c.code)?.length ?? 0 }} 回<template v-if="employees.get(c.code)?.hireDate">・入社 {{ employees.get(c.code)!.hireDate }}</template><template v-if="employees.get(c.code)?.retireDate">・退職 {{ employees.get(c.code)!.retireDate }}</template>)</span></span>
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
      <div class="overflow-x-auto print:overflow-visible">
        <table class="min-w-full text-sm datr-table">
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
                氏名 (一番星)
              </th>
              <th class="py-1 pr-4">
                検知 通算回数
              </th>
              <th class="py-1 pr-4">
                入社日
              </th>
              <th class="py-1 pr-4">
                退職日
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
              <td class="py-1 pr-4">
                {{ employees.get(r.code)?.name ?? '' }}
              </td>
              <td class="py-1 pr-4 font-mono text-right">
                {{ alcoholDayCountUntil(alcoholDays, r.code, r.date) }}
              </td>
              <td class="py-1 pr-4 font-mono">
                {{ employees.get(r.code)?.hireDate ?? '' }}
              </td>
              <td class="py-1 pr-4 font-mono">
                {{ employees.get(r.code)?.retireDate ?? '' }}
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

<style>
/* A4 縦 (印字幅 約 718px) に表が収まるよう詰める。**ここに `@page` は書かない** — 素の `@page` は SPA で他の画面の
   印刷にも残り、粗利・拘束×賃金の `@page { size: A4 landscape }` を壊す。縦の指定は script の onMounted で
   この画面を開いている間だけ足す。`aside` (サイドバー) は scoped では効かないので非 scoped */
@media print {
  aside { display: none !important; }
  main:has(> .datr-search) { padding: 0 !important; }
  .datr-search { max-width: none; }
  .datr-search .datr-table { font-size: 9px; }
  .datr-search .datr-table th,
  .datr-search .datr-table td { padding: 1px 4px 1px 0 !important; }
  .datr-search .datr-table tr { break-inside: avoid; }
  .datr-search .datr-table img { height: 2rem; }
}
</style>
