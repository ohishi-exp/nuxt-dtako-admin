<script setup lang="ts">
import { useAuth } from '@ippoan/auth-client'
import { getDrivers, getYTimePreview, currentAccessToken } from '~/utils/api'
import { describeApiError } from '~/utils/api-error'
import type { Driver, YTimeExportResponse } from '~/types'

const drivers = ref<Driver[]>([])
const selectedDriverCd = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const templateKey = ref('templates/kyoto-soft/base.xlsx')
const loading = ref(false)
const error = ref('')
const lastWarnings = ref<string[]>([])

// localStorage 永続化 — フォーム入力値を reload/HMR 後も保持
const STORAGE_KEY = 'y-time-export-form-vars-v1'
interface PersistedVars {
  driverCd?: string
  dateFrom?: string
  dateTo?: string
  templateKey?: string
}
function loadPersistedVars(): PersistedVars | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PersistedVars) : null
  } catch {
    return null
  }
}
function savePersistedVars() {
  if (typeof localStorage === 'undefined') return
  try {
    const v: PersistedVars = {
      driverCd: selectedDriverCd.value,
      dateFrom: dateFrom.value,
      dateTo: dateTo.value,
      templateKey: templateKey.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v))
  } catch {
    // quota / private mode 等で失敗しても無視
  }
}
// 任意の input 変更で書き戻し
watch([selectedDriverCd, dateFrom, dateTo, templateKey], savePersistedVars)

// 計算結果プレビュー
const previewing = ref(false)
const previewData = ref<YTimeExportResponse | null>(null)

// テンプレ R2 存在確認
type TemplateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'exists'; size: number; uploaded: string }
  | { state: 'missing' }
  | { state: 'error'; message: string }
const templateStatus = ref<TemplateStatus>({ state: 'idle' })

// テンプレ upload 用 (dev 補助)
const templateFile = ref<File | null>(null)
const templateFileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadStatus = ref('')

const { token } = useAuth()

/** 分数を `H:MM` または `HH:MM` 形式に整形 (24h 越えも `30:00` 等そのまま 2 桁以上で表示) */
function fmtMinutes(m: number | null | undefined): string {
  if (m == null) return ''
  const sign = m < 0 ? '-' : ''
  const abs = Math.abs(m)
  const h = Math.floor(abs / 60)
  const mm = abs % 60
  return `${sign}${h.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`
}

/** 0 を空文字に置換した分→時刻表示 */
function fmtMinOrBlank(m: number): string {
  return m > 0 ? fmtMinutes(m) : ''
}

/** YTimeRow の rest 7 cell の合計 */
function totalRestMinutes(r: import('~/types').YTimeRow): number {
  return (
    r.rest_prev_5_22
    + r.rest_prev_22_0
    + r.rest_today_0_5
    + r.rest_today_5_22
    + r.rest_today_22_0
    + r.rest_next_0_5
    + r.rest_next_5_22
  )
}

/** yyyy-mm-dd を Date に */
function ymdToDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** Date を yyyy-mm-dd に */
function dateToYmd(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Date を 曜 (日月火...) に */
function dateToWeekday(d: Date): string {
  return ['日', '月', '火', '水', '木', '金', '土'][d.getDay()] ?? ''
}

/**
 * preview rows を 期間内の全暦日に展開。勤務がない日は row=null で空行表示。
 * 戻り値の date 順は from → to。
 */
const previewRowsWithGaps = computed<Array<{ date: string; weekday: string; row: import('~/types').YTimeRow | null }>>(() => {
  if (!previewData.value) return []
  const map = new Map<string, import('~/types').YTimeRow>()
  for (const r of previewData.value.rows) map.set(r.date, r)

  const start = ymdToDate(previewData.value.period.from)
  const end = ymdToDate(previewData.value.period.to)
  if (!start || !end) return []

  const out: Array<{ date: string; weekday: string; row: import('~/types').YTimeRow | null }> = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ymd = dateToYmd(d)
    out.push({
      date: ymd,
      weekday: dateToWeekday(d),
      row: map.get(ymd) ?? null,
    })
  }
  return out
})

function onTemplateFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  templateFile.value = input.files && input.files[0] ? input.files[0] : null
}

/** `describeApiError` が理由として拾える文字列が本文にあるか。無いまま渡すと
 * `String(e)` に倒れて `[object Object]` が画面に出るので、先に判定して生本文を出す。 */
function hasStringReason(data: unknown): boolean {
  if (typeof data === 'string') return data !== ''
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  return [d.error, d.message, d.statusMessage].some(v => typeof v === 'string')
}

/**
 * 非 2xx の `Response` から**人が読める理由**を作る (Refs #890)。
 *
 * **この画面の 3 つの口 (`R2 確認` / `テンプレ保存` / `xlsx ダウンロード`) で共用する。**
 * 直す前はそれぞれ
 *
 * ```
 * `${res.status} ${res.statusText}`                    ← 本文を一度も読んでいない
 * `${res.status}: ${text || res.statusText}`           ← 本文が空だと statusText に落ちる
 * `xlsx 生成失敗 (${res.status}): ${text || res.statusText}`   ← 同上
 * ```
 *
 * で、**本番は HTTP/3 で reason phrase が存在しない** (`statusText === ''`) ため
 * `✗ 確認エラー: 503 ` / `502: ` / `xlsx 生成失敗 (502): ` のように
 * **区切り文字の後ろが空**になっていた。理由が化けていたのではない —
 * これらは自前の server route なので、理由は本文
 * (`{ error: true, statusCode, statusMessage, message }`) の側に無傷で残っている。
 *
 * **「理由が無い」と「理由を読めなかった」を同じ見た目にしない。**本文が空 / JSON でない /
 * 文字列の理由を持たない、の 3 つは別々の文にし、生本文の先頭も添える。空文字で埋めると
 * 「サーバは何も言っていない」と誤読される。**区切り文字だけが残る形は作らない。**
 *
 * `$fetch` ではなく生 `fetch` なので、`describeApiError` に渡す `e` は ofetch の
 * `FetchError` と同じ形 (`{ statusCode, data }`) に自分で組む。**理由の拾い順は
 * `app/utils/api-error.ts` が正** — ここでは順序を持たない。
 */
async function describeApiFailure(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (text === '') return `${res.status} (応答本文が空でした)`
  let data: unknown
  try {
    data = JSON.parse(text)
  }
  catch {
    return `${res.status} (応答が JSON ではありません: ${text.slice(0, 120)})`
  }
  return hasStringReason(data)
    ? describeApiError({ statusCode: res.status, data })
    : `${res.status} (本文に理由の文字列がありません: ${text.slice(0, 120)})`
}

/** R2 上のテンプレ存在確認 */
async function checkTemplate() {
  const key = templateKey.value.trim()
  if (!key) {
    templateStatus.value = { state: 'idle' }
    return
  }
  templateStatus.value = { state: 'checking' }
  try {
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — 読み口も
    // `requireAuth` を通すようになった (Refs #988)。上書きの口 (PUT) と同じ扱い。
    const token = currentAccessToken()
    const res = await fetch(`/api/y-time-template?key=${encodeURIComponent(key)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      templateStatus.value = {
        state: 'error',
        message: await describeApiFailure(res),
      }
      return
    }
    const json = (await res.json()) as
      | { exists: false; key: string }
      | { exists: true; key: string; size: number; uploaded: string; etag: string }
    if (!json.exists) {
      templateStatus.value = { state: 'missing' }
    } else {
      templateStatus.value = {
        state: 'exists',
        size: json.size,
        uploaded: json.uploaded,
      }
    }
  } catch (e: unknown) {
    templateStatus.value = {
      state: 'error',
      message: e instanceof Error ? e.message : 'チェックに失敗しました',
    }
  }
}

/** templateKey を変更したら状態を idle に戻す (再チェック促す) */
watch(templateKey, () => {
  templateStatus.value = { state: 'idle' }
})

async function uploadTemplate() {
  if (!templateFile.value) {
    uploadStatus.value = 'ファイルを選択してください'
    return
  }
  uploading.value = true
  uploadStatus.value = ''
  try {
    const buf = await templateFile.value.arrayBuffer()
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — 上書きの口が
    // `requireAuth` を通すようになった (Refs #988)。`postNet780Archive` と同じ扱い。
    const token = currentAccessToken()
    const headers: Record<string, string> = {
      'content-type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(`/api/y-time-template?key=${encodeURIComponent(templateKey.value)}`, {
      method: 'PUT',
      headers,
      body: buf,
    })
    // 本文が空だと `res.statusText` に落ち、本番 (HTTP/3) は `502: ` と
    // **コロンの後ろが空**になっていた (Refs #890)。`R2 確認` と同じ形に揃える。
    if (!res.ok) throw new Error(await describeApiFailure(res))
    const json = await res.json() as { key: string; size: number }
    uploadStatus.value = `✓ R2 に保存: ${json.key} (${(json.size / 1024).toFixed(1)} KB)`
  } catch (e: unknown) {
    uploadStatus.value = e instanceof Error ? `✗ ${e.message}` : '✗ アップロードに失敗'
  } finally {
    uploading.value = false
  }
}

onMounted(async () => {
  // 1. localStorage からフォーム値を復元
  const persisted = loadPersistedVars()
  if (persisted) {
    if (persisted.driverCd) selectedDriverCd.value = persisted.driverCd
    if (persisted.dateFrom) dateFrom.value = persisted.dateFrom
    if (persisted.dateTo) dateTo.value = persisted.dateTo
    if (persisted.templateKey) templateKey.value = persisted.templateKey
  }

  // 2. file input がブラウザによって状態保持されている場合に ref へ同期
  // (HMR / リロード後に @change が発火しないケースの救済)
  const el = templateFileInput.value
  if (el?.files && el.files.length > 0) {
    templateFile.value = el.files[0] ?? null
  }

  // 3. ドライバー一覧取得
  try {
    drivers.value = await getDrivers()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'ドライバー一覧の取得に失敗しました'
  }
})

async function previewYTime() {
  if (!selectedDriverCd.value || !dateFrom.value || !dateTo.value) {
    error.value = 'ドライバー / 期間 を入力してください'
    return
  }
  previewing.value = true
  error.value = ''
  previewData.value = null
  lastWarnings.value = []
  try {
    const data = await getYTimePreview(
      selectedDriverCd.value,
      dateFrom.value,
      dateTo.value,
    )
    previewData.value = data
    lastWarnings.value = data.warnings ?? []
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'プレビュー取得に失敗しました'
  } finally {
    previewing.value = false
  }
}

async function downloadXlsx() {
  if (!selectedDriverCd.value || !dateFrom.value || !dateTo.value) {
    error.value = 'ドライバー / 期間 を入力してください'
    return
  }

  loading.value = true
  error.value = ''
  lastWarnings.value = []

  try {
    // #434 step 2: X-Tenant-ID は手で載せない (server route が introspect で
    // 検証済み tenant を注入)。Authorization は introspect 対象として渡す。
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (token.value) headers['authorization'] = `Bearer ${token.value}`

    const res = await fetch('/api/y-time-export', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        driver_cd: selectedDriverCd.value,
        from: dateFrom.value,
        to: dateTo.value,
        template_key: templateKey.value,
      }),
    })

    // 同上。`xlsx 生成失敗 (502): ` と括弧の後ろが空になるのを止める (Refs #890)。
    // **どの操作が落ちたか**は残したいので、ラベルは前置きのまま保つ。
    if (!res.ok) throw new Error(`xlsx 生成失敗: ${await describeApiFailure(res)}`)

    const warnings = res.headers.get('x-y-time-warnings')
    if (warnings) {
      lastWarnings.value = decodeURIComponent(warnings).split(' / ')
    }
    const missing = res.headers.get('x-y-time-missing-dates')
    if (missing) {
      lastWarnings.value.push(`テンプレに日付が無い: ${missing}`)
    }

    await downloadBlobResponse(res, `y_time_${selectedDriverCd.value}_${dateFrom.value}_${dateTo.value}.xlsx`)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'ダウンロードに失敗しました'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-2xl font-bold">Y時間 エクスポート</h2>

    <p class="text-sm text-gray-600 dark:text-gray-400">
      京都ソフト案件 等の証拠書類用 Excel テンプレ (Y時間 シート) に、KUDGIVT
      由来の日別 始業/終業/休憩 を自動追記してダウンロードします。テンプレは
      Cloudflare R2 (<code>dtako-uploads</code>) に配置されたものを参照します。
    </p>

    <div class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-1">ドライバー</label>
          <select
            v-model="selectedDriverCd"
            class="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800"
          >
            <option value="">— 選択 —</option>
            <option v-for="d in drivers" :key="d.id" :value="d.driver_cd">
              {{ d.driver_cd }} : {{ d.driver_name }}
            </option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">テンプレ Key (R2)</label>
          <div class="flex gap-2">
            <input
              v-model="templateKey"
              type="text"
              class="flex-1 border rounded px-3 py-2 bg-white dark:bg-gray-800 font-mono text-sm"
              placeholder="templates/kyoto-soft/base.xlsx"
            >
            <button
              type="button"
              class="px-2 py-1 text-xs bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
              :disabled="templateStatus.state === 'checking' || !templateKey"
              @click="checkTemplate"
            >
              R2 確認
            </button>
          </div>
          <div class="mt-1 text-xs">
            <span v-if="templateStatus.state === 'idle'" class="text-gray-500 dark:text-gray-400">
              未確認 — 「R2 確認」をクリック
            </span>
            <span v-else-if="templateStatus.state === 'checking'" class="text-gray-500 dark:text-gray-400">
              確認中...
            </span>
            <span v-else-if="templateStatus.state === 'exists'" class="text-green-700 dark:text-green-400">
              ✓ あり ({{ (templateStatus.size / 1024).toFixed(1) }} KB,
              {{ new Date(templateStatus.uploaded).toLocaleString('ja-JP') }})
            </span>
            <span v-else-if="templateStatus.state === 'missing'" class="text-red-700 dark:text-red-400">
              ✗ なし — 下の「テンプレ xlsx を R2 に保存」から先に upload してください
            </span>
            <span v-else-if="templateStatus.state === 'error'" class="text-red-700 dark:text-red-400">
              ✗ 確認エラー: {{ templateStatus.message }}
            </span>
          </div>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-sm font-medium mb-1">開始日</label>
          <input
            v-model="dateFrom"
            type="date"
            class="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800"
          >
        </div>
        <div>
          <label class="block text-sm font-medium mb-1">終了日</label>
          <input
            v-model="dateTo"
            type="date"
            class="w-full border rounded px-3 py-2 bg-white dark:bg-gray-800"
          >
        </div>
      </div>
      <div class="flex justify-end gap-2">
        <button
          class="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50"
          :disabled="previewing || !selectedDriverCd || !dateFrom || !dateTo"
          @click="previewYTime"
        >
          <span v-if="previewing">計算中...</span>
          <span v-else>計算プレビュー</span>
        </button>
        <button
          class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          :disabled="loading || !selectedDriverCd || !dateFrom || !dateTo"
          @click="downloadXlsx"
        >
          <span v-if="loading">生成中...</span>
          <span v-else>ダウンロード</span>
        </button>
      </div>
    </div>

    <!-- 計算結果プレビュー -->
    <div
      v-if="previewData"
      class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow space-y-2 text-sm"
    >
      <div class="flex justify-between items-baseline">
        <h3 class="font-semibold">
          計算結果プレビュー
          <span class="text-gray-500 dark:text-gray-400 font-normal text-xs ml-2">
            {{ previewData.driver.cd }} : {{ previewData.driver.name }} /
            {{ previewData.period.from }} 〜 {{ previewData.period.to }} /
            {{ previewData.rows.length }} 行 (勤務日)
            / {{ previewRowsWithGaps.length }} 暦日
          </span>
        </h3>
      </div>
      <div v-if="previewRowsWithGaps.length === 0" class="text-gray-500 dark:text-gray-400">
        期間が無効です。
      </div>
      <div v-else class="overflow-x-auto">
        <table class="min-w-full border-collapse text-xs">
          <thead class="bg-gray-100 dark:bg-gray-800">
            <tr>
              <th class="border px-2 py-1 text-left" rowspan="3">日付 (A)</th>
              <th class="border px-1 py-1 text-center" rowspan="3">曜 (B)</th>
              <th class="border px-2 py-1 text-left" rowspan="3">備考 (C)</th>
              <th class="border px-2 py-1 text-center" rowspan="3">前日 (F)</th>
              <th class="border px-2 py-1 text-right" rowspan="3">始業 (G)</th>
              <th class="border px-2 py-1 text-right" rowspan="3">終業 (H)</th>
              <th class="border px-2 py-1 text-center" colspan="7">休憩 (I-O)</th>
              <th class="border px-2 py-1 text-right" rowspan="3">休憩計</th>
            </tr>
            <tr>
              <th class="border px-2 py-1 text-center" colspan="2">前日</th>
              <th class="border px-2 py-1 text-center" colspan="3">当日</th>
              <th class="border px-2 py-1 text-center" colspan="2">翌日</th>
            </tr>
            <tr>
              <th class="border px-1 py-1 text-center font-normal text-[10px]">5-22</th>
              <th class="border px-1 py-1 text-center font-normal text-[10px]">22-0</th>
              <th class="border px-1 py-1 text-center font-normal text-[10px]">0-5</th>
              <th class="border px-1 py-1 text-center font-normal text-[10px]">5-22</th>
              <th class="border px-1 py-1 text-center font-normal text-[10px]">22-0</th>
              <th class="border px-1 py-1 text-center font-normal text-[10px]">0-5</th>
              <th class="border px-1 py-1 text-center font-normal text-[10px]">5-22</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in previewRowsWithGaps"
              :key="entry.date"
              :class="[
                'hover:bg-gray-50 dark:hover:bg-gray-800/50',
                !entry.row && 'text-gray-400 dark:text-gray-600',
                entry.weekday === '日' && 'bg-red-50 dark:bg-red-900/20',
                entry.weekday === '土' && 'bg-blue-50 dark:bg-blue-900/20',
              ]"
            >
              <td class="border px-2 py-1 font-mono">{{ entry.date }}</td>
              <td class="border px-1 py-1 text-center">{{ entry.weekday }}</td>
              <td class="border px-2 py-1">{{ entry.row?.note ?? '' }}</td>
              <td class="border px-2 py-1 text-center">{{ entry.row?.previous_day_start ? '1' : '' }}</td>
              <td class="border px-2 py-1 text-right font-mono">{{ entry.row ? fmtMinutes(entry.row.start_minutes_of_day) : '' }}</td>
              <td class="border px-2 py-1 text-right font-mono">{{ entry.row ? fmtMinutes(entry.row.end_minutes_from_bucket_date) : '' }}</td>
              <td class="border px-1 py-1 text-right font-mono text-[11px]">{{ entry.row ? fmtMinOrBlank(entry.row.rest_prev_5_22) : '' }}</td>
              <td class="border px-1 py-1 text-right font-mono text-[11px]">{{ entry.row ? fmtMinOrBlank(entry.row.rest_prev_22_0) : '' }}</td>
              <td class="border px-1 py-1 text-right font-mono text-[11px]">{{ entry.row ? fmtMinOrBlank(entry.row.rest_today_0_5) : '' }}</td>
              <td class="border px-1 py-1 text-right font-mono text-[11px]">{{ entry.row ? fmtMinOrBlank(entry.row.rest_today_5_22) : '' }}</td>
              <td class="border px-1 py-1 text-right font-mono text-[11px]">{{ entry.row ? fmtMinOrBlank(entry.row.rest_today_22_0) : '' }}</td>
              <td class="border px-1 py-1 text-right font-mono text-[11px]">{{ entry.row ? fmtMinOrBlank(entry.row.rest_next_0_5) : '' }}</td>
              <td class="border px-1 py-1 text-right font-mono text-[11px]">{{ entry.row ? fmtMinOrBlank(entry.row.rest_next_5_22) : '' }}</td>
              <td class="border px-2 py-1 text-right font-mono">{{ entry.row ? fmtMinutes(totalRestMinutes(entry.row)) : '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="error" class="bg-red-50 border border-red-200 text-red-800 p-3 rounded text-sm">
      {{ error }}
    </div>

    <div v-if="lastWarnings.length > 0" class="bg-yellow-50 border border-yellow-200 text-yellow-900 p-3 rounded text-sm space-y-1">
      <div class="font-semibold">⚠ 警告:</div>
      <ul class="list-disc list-inside">
        <li v-for="(w, i) in lastWarnings" :key="i">{{ w }}</li>
      </ul>
    </div>

    <!-- dev 補助: テンプレ xlsx を R2 にアップロード -->
    <details class="bg-white dark:bg-gray-900 p-4 rounded-lg shadow text-sm">
      <summary class="cursor-pointer font-medium">テンプレ xlsx を R2 に保存 (dev 補助)</summary>
      <div class="mt-3 space-y-2">
        <p class="text-gray-600 dark:text-gray-400">
          上記「テンプレ Key (R2)」の場所に xlsx ファイルを書き込みます。本番テンプレと
          被らない key (例: <code>templates/kyoto-soft/dev-test.xlsx</code>) を使うこと推奨。
        </p>
        <input
          ref="templateFileInput"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          class="block w-full text-sm"
          @change="onTemplateFileChange"
        >
        <button
          class="px-3 py-1.5 bg-gray-700 text-white rounded text-sm hover:bg-gray-800 disabled:opacity-50"
          :disabled="uploading || !templateFile"
          @click="uploadTemplate"
        >
          <span v-if="uploading">アップロード中...</span>
          <span v-else>R2 に保存</span>
        </button>
        <div v-if="uploadStatus" class="text-xs">{{ uploadStatus }}</div>
      </div>
    </details>
  </div>
</template>
