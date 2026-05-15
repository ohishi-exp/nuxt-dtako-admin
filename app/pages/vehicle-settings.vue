<script setup lang="ts">
/**
 * 車輛設定 ビューア — NET780 デジタコ dump zip をアップロードして `.cfg` 内容を表示する。
 *
 * `POST /api/vehicle-settings/extract` に multipart で zip を投げると JSON が返るので
 * それをパネル + 検索付きテーブルで表示する (DB 保存等はせず、その場で投げて表示するだけ)。
 */

interface MachineInfo {
  machine_id?: string
  main_app?: string
  sub_app?: string
  etc?: string
  sound?: string
  u_boot?: string
  kernel?: string
  ramdisk?: string
  userdata?: string
}

interface ExtractResult {
  vehicle_cd: string
  dump_dir: string
  cfg_filename: string
  machine_info: MachineInfo
  settings: Record<string, string | number>
}

const file = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)
const loading = ref(false)
const error = ref('')
const result = ref<ExtractResult | null>(null)
const search = ref('')

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  file.value = input.files && input.files[0] ? input.files[0] : null
  result.value = null
  error.value = ''
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  dragOver.value = false
  const f = e.dataTransfer?.files?.[0]
  if (f) {
    file.value = f
    result.value = null
    error.value = ''
  }
}

async function submit() {
  if (!file.value) {
    error.value = 'zip ファイルを選択してください'
    return
  }
  loading.value = true
  error.value = ''
  result.value = null
  try {
    const form = new FormData()
    form.append('file', file.value)
    const res = await fetch('/api/vehicle-settings/extract', {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`抽出失敗 (${res.status}): ${text || res.statusText}`)
    }
    result.value = (await res.json()) as ExtractResult
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '抽出に失敗しました'
  } finally {
    loading.value = false
  }
}

// machine_info を `[label, value]` ペアに整形 (表示順を固定)
const machineRows = computed<Array<{ label: string; value: string }>>(() => {
  if (!result.value) return []
  const mi = result.value.machine_info
  const labels: Array<[keyof MachineInfo, string]> = [
    ['machine_id', 'MachineID'],
    ['main_app', 'Main App'],
    ['sub_app', 'Sub App'],
    ['etc', 'ETC'],
    ['sound', 'Sound'],
    ['u_boot', 'u-boot'],
    ['kernel', 'kernel'],
    ['ramdisk', 'ramdisk'],
    ['userdata', 'userdata'],
  ]
  return labels
    .filter(([k]) => mi[k] != null)
    .map(([k, label]) => ({ label, value: String(mi[k]) }))
})

// settings を prefix で section 分け (BASE_ / PULS_ / OPER_ / ...) + search filter
interface SettingRow {
  key: string
  value: string | number
}
interface SettingsSection {
  prefix: string
  rows: SettingRow[]
}
const settingsSections = computed<SettingsSection[]>(() => {
  if (!result.value) return []
  const q = search.value.trim().toLowerCase()
  const grouped = new Map<string, SettingRow[]>()
  for (const [key, value] of Object.entries(result.value.settings)) {
    if (q) {
      const hay = `${key} ${String(value)}`.toLowerCase()
      if (!hay.includes(q)) continue
    }
    const prefix = key.split('_')[0] ?? key
    if (!grouped.has(prefix)) grouped.set(prefix, [])
    grouped.get(prefix)!.push({ key, value })
  }
  return Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, rows]) => ({ prefix, rows }))
})

const totalShown = computed(() =>
  settingsSections.value.reduce((sum, s) => sum + s.rows.length, 0),
)
const totalAll = computed(() =>
  result.value ? Object.keys(result.value.settings).length : 0,
)

function copyJson() {
  if (!result.value) return
  navigator.clipboard.writeText(JSON.stringify(result.value, null, 2))
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-2xl font-bold">車輛設定 ビューア</h2>

    <p class="text-sm text-gray-600 dark:text-gray-400">
      NET780 デジタコ本体から吸い出した運行 dump zip
      (<code>&lt;vehicle_cd&gt;/&lt;YYYYMMDD_HHMMSS-...&gt;/*.cfg</code> を含むもの) を
      アップロードすると、車輛側の設定値を JSON で表示します。アップロードした zip は
      保存されません (その場で parse → 返却のみ)。
    </p>

    <!-- アップロード -->
    <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
      <div
        class="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors"
        :class="dragOver
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40'
          : 'border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-600'"
        @click="fileInput?.click()"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop="onDrop"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".zip,application/zip"
          class="hidden"
          @change="onFileChange"
        >
        <div v-if="!file" class="text-sm text-gray-600 dark:text-gray-400">
          zip をドラッグ&ドロップ または クリックで選択
        </div>
        <div v-else class="text-sm">
          <div class="font-mono">{{ file.name }}</div>
          <div class="text-xs text-gray-500 dark:text-gray-400">
            {{ (file.size / 1024).toFixed(1) }} KB
          </div>
        </div>
      </div>
      <div class="flex justify-end">
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          :disabled="loading || !file"
          @click="submit"
        >
          <span v-if="loading">抽出中...</span>
          <span v-else>設定を抽出</span>
        </button>
      </div>
    </div>

    <div v-if="error" class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
      {{ error }}
    </div>

    <!-- 結果 -->
    <div v-if="result" class="space-y-4">
      <!-- ヘッダー: vehicle_cd / dump_dir / コピー -->
      <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow flex justify-between items-start">
        <div class="space-y-1 text-sm">
          <div>
            <span class="text-gray-500 dark:text-gray-400">車輛 cd:</span>
            <span class="font-mono font-bold ml-2">{{ result.vehicle_cd || '(不明)' }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">dump dir:</span>
            <span class="font-mono ml-2">{{ result.dump_dir || '(不明)' }}</span>
          </div>
          <div>
            <span class="text-gray-500 dark:text-gray-400">cfg:</span>
            <span class="font-mono ml-2">{{ result.cfg_filename }}</span>
          </div>
        </div>
        <button
          class="px-3 py-1 text-xs bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600"
          @click="copyJson"
        >
          JSON をコピー
        </button>
      </div>

      <!-- Machine Info -->
      <div v-if="machineRows.length > 0" class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow">
        <h3 class="font-semibold mb-2">Machine Information</h3>
        <table class="text-sm w-full">
          <tbody>
            <tr
              v-for="row in machineRows"
              :key="row.label"
              class="border-b border-gray-100 dark:border-gray-800 last:border-0"
            >
              <td class="py-1 pr-4 text-gray-500 dark:text-gray-400 w-32">{{ row.label }}</td>
              <td class="py-1 font-mono">{{ row.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Settings (search + section) -->
      <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
        <div class="flex justify-between items-baseline">
          <h3 class="font-semibold">設定値</h3>
          <span class="text-xs text-gray-500 dark:text-gray-400">
            {{ totalShown }} / {{ totalAll }} 件
          </span>
        </div>
        <input
          v-model="search"
          type="text"
          placeholder="key / value で絞り込み (例: BUTT_, 副免許, 800)"
          class="w-full border rounded px-3 py-2 text-sm bg-white dark:bg-gray-800"
        >
        <div v-if="settingsSections.length === 0" class="text-sm text-gray-500 dark:text-gray-400">
          一致する設定がありません。
        </div>
        <div v-else class="space-y-4">
          <div v-for="section in settingsSections" :key="section.prefix">
            <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-1">
              {{ section.prefix }}_<span class="text-gray-400 font-normal text-xs ml-2">
                ({{ section.rows.length }})
              </span>
            </h4>
            <table class="w-full text-xs">
              <tbody>
                <tr
                  v-for="row in section.rows"
                  :key="row.key"
                  class="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40"
                >
                  <td class="py-1 pr-4 font-mono text-gray-700 dark:text-gray-300 w-64">
                    {{ row.key }}
                  </td>
                  <td class="py-1 font-mono">
                    <span v-if="typeof row.value === 'number'" class="text-blue-700 dark:text-blue-300">{{ row.value }}</span>
                    <span v-else class="text-green-700 dark:text-green-400">"{{ row.value }}"</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
