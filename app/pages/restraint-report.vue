<script setup lang="ts">
import { getDrivers, getRestraintReport, downloadRestraintReportPdfStream, downloadRestraintReportPdfSingle, recalculateStream, recalculateDriverStream } from '~/utils/api'
import type { PdfProgressEvent, RecalcProgressEvent } from '~/utils/api'
import type { Driver, RestraintReportResponse, RestraintDayRow } from '~/types'

const drivers = ref<Driver[]>([])
// 乗務員一覧が**取得できなかった**理由 (Refs #920)。**空配列だけでは「0 人」と
// 区別が付かない**ので、「読めなかった」ことを状態として持つ。
const driversError = ref<string | null>(null)
const selectedDriverId = ref('')
const selectedMonth = ref('')
const report = ref<RestraintReportResponse | null>(null)
const loading = ref(false)
const error = ref('')

async function fetchReport() {
  if (!selectedDriverId.value || !selectedMonth.value) return
  loading.value = true
  error.value = ''
  try {
    const [y = 0, m = 0] = selectedMonth.value.split('-').map(Number)
    report.value = await getRestraintReport({
      driver_id: selectedDriverId.value,
      year: y,
      month: m,
    })
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'データ取得に失敗しました'
    report.value = null
  } finally {
    loading.value = false
  }
}

/**
 * 一覧の取得失敗を 1 行にする (Refs #920。**正本は #911 / PR #915 の `upload.vue`**)。
 *
 * ## ★ `describeApiError` を当てていない — **当て忘れではない** (Refs #890 / #904)
 *
 * `getDrivers` は `app/utils/api.ts` の `request()` → `@ippoan/auth-client` の
 * `createAuthFetch` 経由で、そこは非 2xx を
 * `new Error(`API エラー (${status}): ${body || statusText}`)` に組んで投げる。
 * **ofetch の `FetchError` ではない**ので `statusCode` も `data` も持たず、
 * `describeApiError` は `err.message` をそのまま返すだけになる ⇒ **当てても
 * 1 文字も変わらない** (#910 が (B) 経路 28 箇所で実測済み)。機械的に当てると
 * 「理由が良くなった」と誤読させるだけなので当てない。
 * **理由を 1 行に畳むのは #904 (`api.ts` 側) の担当。**
 *
 * ## いま実際に出る 1 文 (2026-08-25 実測)
 *
 * **「status しか出ない」ではない** — `createAuthFetch` は本文を読むので
 * **status + 応答本文まるごと**が出る。測定条件は
 * **nuxt dev (:3001) が配信する本物の画面 + CDP の `Fetch.fulfillRequest` で
 * `/api/proxy/api/drivers` だけを 503 `{"error":"DB に繋がりません"}` に差し替え**:
 *
 * ```
 * 乗務員一覧を取得できませんでした (API エラー (503): {"error":"DB に繋がりません"})
 * ```
 *
 * ## ★ ここでは塞げない穴 (#904 に申し送り、未測定)
 *
 * 本番は HTTP/3 で reason phrase が空 (`res.statusText === ''`) なので、**本文が空の
 * 非 2xx では `e.message` が `API エラー (503): ` (コロンの後ろが空)** になる。
 * `api.ts` / `createAuthFetch` に触らずには塞げない。
 */
function describeListFailure(e: unknown): string {
  return e instanceof Error ? e.message : '理由を読めませんでした'
}

onMounted(async () => {
  try {
    drivers.value = await getDrivers()
  }
  catch (e) {
    // 一覧は空に戻す。**ただし空にした理由を必ず持つ** — 空配列だけだと選択肢が
    // 出ないのを「乗務員が 0 人」と読まれ、API が落ちて読めなかっただけの回と
    // 区別が付かない (Refs #920)。以前は `.catch(() => {})` で例外オブジェクトを
    // **束縛すらしていなかった**ので、理由は 100% 失われていた。
    drivers.value = []
    driversError.value = describeListFailure(e)
  }
})

watch([selectedDriverId, selectedMonth], () => {
  if (selectedDriverId.value && selectedMonth.value) fetchReport()
})

/**
 * 分 → `h:mm`。**「実測して 0 分」と「データが無い」を同じ見た目にしない** (Refs #918)。
 *
 * - `0` → **`0:00`** (記録を読んだ結果が 0)
 * - `null` / `undefined` → **`-`** (記録が無い / 取得できなかった。0 分だったかも分からない)
 *
 * ## なぜ `-` なのか
 *
 * 以前は `val == null || val === 0` で**どちらも空欄**にしていた。空欄は
 * 「そこに何も無い」とも「読まなかった」とも読めるので、とくに **`break_minutes` は
 * 「休憩 0 分」(拘束基準の判断材料) と「休憩データ無し」(欠測) が区別できなかった。**
 *
 * `-` は `app/utils/restraint-wage-view.ts` の **`fmtMinutes(null)` が既に採っている
 * 書き方**で、そちらが正本。**新しい流儀を作らずそこに揃える** (書式そのものは
 * この表の既存の `h:mm` を維持する — `fmtMinutes` は `h00m` 形式で別物)。
 * repo の「欠測を 0 分に倒さない」「データが無いときだけ項を落とす。実測して 0 の項は
 * 残す」とも一致する。
 *
 * ## 記号の意味は画面にも出す
 *
 * **区別できるようにしただけでは、見る人が `-` の意味を知らない。**表の下に凡例を
 * 1 行置いてある (`<!-- 凡例 -->`)。片方だけ直すと嘘になるので、ここを変えるときは
 * 凡例も一緒に見ること。
 *
 * ## `fmtOrDash` は消した
 *
 * `fmt(val) || '-'` という**呼び出し元 0 件**の関数が並んで残っていた
 * (「空欄では区別が付かない」と気づいた誰かが道具だけ書いて結線しなかった痕跡)。
 * `fmt` 自身が `-` を返すようになった以上 `|| '-'` は**到達しない枝**で、
 * 同じ挙動に名前が 2 つある状態にしかならないので削除した。
 */
function fmt(val: number | null | undefined): string {
  if (val == null) return '-'
  const h = Math.floor(val / 60)
  const m = val % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

function isWeekSubtotalAfter(day: RestraintDayRow, index: number, days: RestraintDayRow[]): boolean {
  if (!report.value) return false
  return report.value.weekly_subtotals.some(ws => ws.week_end_date === day.date)
}

function getWeekSubtotal(date: string) {
  return report.value?.weekly_subtotals.find(ws => ws.week_end_date === date)
}

const driverName = computed(() => {
  if (report.value) return report.value.driver_name
  const d = drivers.value.find(d => d.id === selectedDriverId.value)
  return d?.driver_name || ''
})

const pdfLoading = ref(false)
const pdfError = ref('')
const pdfProgress = ref('')

async function downloadPdf() {
  if (!selectedMonth.value) return
  pdfLoading.value = true
  pdfError.value = ''
  pdfProgress.value = '準備中...'
  try {
    const [y = 0, m = 0] = selectedMonth.value.split('-').map(Number)
    await downloadRestraintReportPdfStream(y, m, (evt: PdfProgressEvent) => {
      if (evt.event === 'progress') {
        if (evt.step === 'fetch') {
          pdfProgress.value = `データ取得中 (${evt.current}/${evt.total}) ${evt.driver_name || ''}`
        } else if (evt.step === 'render') {
          pdfProgress.value = 'PDF生成中...'
        }
      } else if (evt.event === 'done') {
        pdfProgress.value = 'ダウンロード完了'
      } else if (evt.event === 'error') {
        pdfError.value = evt.message || 'PDF出力に失敗しました'
      }
    })
  } catch (e: unknown) {
    pdfError.value = e instanceof Error ? e.message : 'PDF出力に失敗しました'
  } finally {
    pdfLoading.value = false
    setTimeout(() => { pdfProgress.value = '' }, 3000)
  }
}

const singlePdfLoading = ref(false)

async function downloadSinglePdf() {
  if (!selectedDriverId.value || !selectedMonth.value) return
  singlePdfLoading.value = true
  try {
    const [y = 0, m = 0] = selectedMonth.value.split('-').map(Number)
    await downloadRestraintReportPdfSingle(y, m, selectedDriverId.value, driverName.value)
  } catch (e: unknown) {
    pdfError.value = e instanceof Error ? e.message : 'PDF出力に失敗しました'
  } finally {
    singlePdfLoading.value = false
  }
}

const recalcLoading = ref(false)
const recalcResult = ref('')
const recalcError = ref('')

/**
 * 再計算ストリームが**例外で終わった**ときに人に見せる 1 文 (Refs #890)。
 *
 * 以前は `catch` が例外を丸ごと握り潰して `'バックグラウンドで処理中...完了までお待ち
 * ください'` と出していた。**再計算が始まってすらいない回でも「処理中」と読める**ので、
 * 失敗した人はそのまま待ち続ける。握り潰しではなく**嘘**なのでやめる。
 *
 * **逆方向の誤読も同時に潰す** — 進捗イベントを 1 つでも受け取っていれば、
 * **切れたのは接続だけで、サーバ側は走り続けている**ことがある。断定できないので
 * 「判らない」と書き、確かめ方まで出す。
 *
 * `recalculateStream` / `recalculateDriverStream` は生 `fetch` なので `e` は素の `Error`。
 * **`describeApiError` を通しても 1 文字も変わらない** (#890 の分類 (B))。理由が
 * `再計算に失敗: 503` と status だけになるのは `app/utils/api.ts` が非 2xx の本文を
 * 読んでいないためで、そちらは別 issue。
 */
function recalcStreamFailure(e: unknown, gotAnyEvent: boolean): string {
  const reason = e instanceof Error ? e.message : String(e)
  return gotAnyEvent
    ? `再計算の途中で接続が切れました (${reason})。サーバ側で続いているかどうかはこの画面では判りません — しばらく後に月を選び直して結果を確認してください`
    : `再計算を開始できませんでした (${reason})`
}

async function runRecalculate() {
  if (!selectedMonth.value) return
  const [y = 0, m = 0] = selectedMonth.value.split('-').map(Number)
  if (!confirm(`${y}年${m}月のデータを再計算します。よろしいですか？`)) return
  recalcLoading.value = true
  recalcResult.value = '準備中...'
  recalcError.value = ''
  let gotDone = false
  /** 進捗を 1 つでも受け取ったか (= 再計算が始まってはいた)。 */
  let gotAnyEvent = false
  try {
    await recalculateStream(y, m, (evt: RecalcProgressEvent) => {
      gotAnyEvent = true
      if (evt.event === 'progress') {
        const stepLabel = evt.step === 'download' ? 'DL' : evt.step === 'save' ? '保存' : '処理'
        recalcResult.value = `再計算中 (${evt.current}/${evt.total}) ${stepLabel}中...`
      } else if (evt.event === 'done') {
        gotDone = true
        recalcResult.value = `完了: ${evt.success}/${evt.total} 成功${evt.failed && evt.failed > 0 ? `, ${evt.failed} 失敗` : ''}`
      } else if (evt.event === 'error') {
        gotDone = true
        recalcResult.value = evt.message || '再計算に失敗しました'
        recalcError.value = evt.message || '再計算に失敗しました'
      }
    })
    if (!gotDone) {
      recalcResult.value = 'バックグラウンドで処理中...完了までお待ちください'
    }
  } catch (e: unknown) {
    if (!gotDone) {
      // 進捗の途中経過 (「再計算中 (3/10) 処理中...」) が残っていると、それ自体が
      // 「動いている」と読める。消してから理由を出す。
      recalcResult.value = ''
      recalcError.value = recalcStreamFailure(e, gotAnyEvent)
    }
  } finally {
    recalcLoading.value = false
    if (gotDone) {
      setTimeout(() => { recalcResult.value = '' }, 10000)
    }
  }
}

const driverRecalcLoading = ref(false)

async function runDriverRecalculate() {
  if (!selectedMonth.value || !selectedDriverId.value) return
  const [y = 0, m = 0] = selectedMonth.value.split('-').map(Number)
  const driverName = drivers.value.find(d => d.id === selectedDriverId.value)?.driver_name || ''
  if (!confirm(`${driverName} の ${y}年${m}月を再計算します。よろしいですか？`)) return
  driverRecalcLoading.value = true
  recalcResult.value = '準備中...'
  recalcError.value = ''
  let gotDone = false
  /** 進捗を 1 つでも受け取ったか (= 再計算が始まってはいた)。 */
  let gotAnyEvent = false
  try {
    await recalculateDriverStream(y, m, selectedDriverId.value, (evt: RecalcProgressEvent) => {
      gotAnyEvent = true
      if (evt.event === 'progress') {
        const stepLabel = evt.step === 'download' ? 'DL' : evt.step === 'save' ? '保存' : '処理'
        recalcResult.value = `再計算中 (${evt.current}/${evt.total}) ${stepLabel}中...`
      } else if (evt.event === 'done') {
        gotDone = true
        recalcResult.value = `${driverName} 再計算完了`
      } else if (evt.event === 'error') {
        gotDone = true
        recalcResult.value = evt.message || '再計算に失敗しました'
        recalcError.value = evt.message || '再計算に失敗しました'
      }
    })
    if (gotDone && !recalcError.value) {
      await fetchReport()
    }
  } catch (e: unknown) {
    if (!gotDone) {
      // 以前は理由を捨てて `'エラーが発生しました'` だけを出していた。
      recalcResult.value = ''
      recalcError.value = recalcStreamFailure(e, gotAnyEvent)
    }
  } finally {
    driverRecalcLoading.value = false
    if (gotDone) {
      setTimeout(() => { recalcResult.value = '' }, 10000)
    }
  }
}

const monthLabel = computed(() => {
  if (!selectedMonth.value) return ''
  const [y = 0, m = 0] = selectedMonth.value.split('-').map(Number)
  return `令和${y - 2018}年${m}月分`
})
</script>

<template>
  <div class="space-y-4">
    <h2 class="text-xl font-bold">拘束時間管理表</h2>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3 items-end">
      <div>
        <label class="text-xs text-gray-500 block mb-1">ドライバー</label>
        <DriverSearchSelect v-model="selectedDriverId" :drivers="drivers" placeholder="選択してください" />
      </div>
      <div>
        <label class="text-xs text-gray-500 block mb-1">月</label>
        <input v-model="selectedMonth" type="month" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
      </div>
      <UButton label="表示" icon="i-lucide-search" size="sm" :loading="loading" :disabled="!selectedDriverId || !selectedMonth" @click="fetchReport" />
      <UButton label="PDF" icon="i-lucide-file-down" size="sm" color="neutral" variant="outline" :loading="singlePdfLoading" :disabled="!selectedDriverId || !selectedMonth" @click="downloadSinglePdf" />
      <UButton label="全員PDF" icon="i-lucide-files" size="sm" color="neutral" variant="outline" :loading="pdfLoading" :disabled="!selectedMonth" @click="downloadPdf" />
      <span v-if="pdfProgress" class="text-xs text-gray-500 self-center">{{ pdfProgress }}</span>
      <UButton label="再計算" icon="i-lucide-refresh-cw" size="sm" color="warning" variant="outline" :loading="driverRecalcLoading" :disabled="!selectedDriverId || !selectedMonth" @click="runDriverRecalculate" />
      <UButton label="全員再計算" icon="i-lucide-refresh-cw" size="sm" color="warning" variant="outline" :loading="recalcLoading" :disabled="!selectedMonth" @click="runRecalculate" />
      <span v-if="recalcResult" class="text-xs text-gray-500 self-center">{{ recalcResult }}</span>
    </div>

    <!-- ★ 「読めなかった」と「0 人」を別の文にする (Refs #920)。理由だけ出すと
         **本当に 0 人の回**まで異常に見えるので、失敗した回にだけ出し、
         **判らないと言って確かめ方まで出す** (#911 / #915 と同じ形)。
         乗務員一覧を取りに行くのは `onMounted` の 1 回だけなので、
         やり直す手段は**ページの再読み込み**しかない。 -->
    <UAlert
      v-if="driversError"
      :title="`乗務員一覧を取得できませんでした (${driversError})`"
      description="0 人なのか読めなかっただけなのかは、この画面では判りません — ページを再読み込みして確かめてください"
      color="error"
      icon="i-lucide-circle-x"
      variant="subtle"
    />
    <UAlert v-if="error" :title="error" color="error" icon="i-lucide-circle-x" variant="subtle" />
    <UAlert v-if="pdfError" :title="pdfError" color="error" icon="i-lucide-circle-x" variant="subtle" />
    <UAlert v-if="recalcError" :title="recalcError" color="error" icon="i-lucide-circle-x" variant="subtle" />

    <!-- Empty state -->
    <div v-if="!report && !loading && !error" class="text-center text-gray-400 py-12">
      ドライバーと月を選択してください
    </div>

    <!-- Loading -->
    <div v-if="loading" class="text-center py-12 text-gray-400">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
      読み込み中...
    </div>

    <!-- Report -->
    <div v-if="report && !loading" class="space-y-4">
      <!-- Header -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
        <div class="flex justify-between items-center">
          <div>
            <span class="text-lg font-bold">拘束時間管理表</span>
            <span class="ml-4 text-gray-500">{{ monthLabel }}</span>
          </div>
          <div class="text-sm text-gray-500">
            当月最大拘束時間: <span class="font-medium text-gray-900 dark:text-white">{{ fmt(report.max_restraint_minutes) }}</span>
          </div>
        </div>
        <div class="mt-1 text-sm">
          氏名: <span class="font-medium">{{ report.driver_name }}</span>
        </div>
      </div>

      <!-- Table -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-x-auto">
        <table class="w-full text-xs whitespace-nowrap">
          <thead class="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">日付</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" colspan="2">始業終業時刻</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" colspan="4">拘束時間</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">合計</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">拘束<br>累計</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">運転<br>平均</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center border-r border-gray-200 dark:border-gray-700" rowspan="2">休息<br>時間</th>
              <th class="px-2 py-2 font-medium text-gray-500 text-center" rowspan="2">摘要</th>
            </tr>
            <tr>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">始業</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">終業</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">運転</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">荷役</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">休憩</th>
              <th class="px-2 py-1 font-medium text-gray-400 text-center border-r border-gray-200 dark:border-gray-700">小計</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(day, idx) in report.days" :key="day.date">
              <!-- Holiday row -->
              <tr v-if="day.is_holiday" class="border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30">
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700">{{ day.date.slice(8) }}</td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700 text-red-500 font-medium" colspan="6">休</td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700"></td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700"></td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700"></td>
                <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700"></td>
                <td class="px-2 py-1.5"></td>
              </tr>

              <!-- Working day -->
              <template v-else>
                <!-- First operation row (with start/end time and totals) -->
                <tr class="border-t border-gray-100 dark:border-gray-800">
                  <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ day.date.slice(8) }}
                  </td>
                  <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ day.start_time || '' }}
                  </td>
                  <td class="px-2 py-1.5 text-center border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ day.end_time || '' }}
                  </td>
                  <!-- First operation breakdown -->
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700">
                    {{ fmt(day.operations[0]?.drive_minutes) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700">
                    {{ fmt(day.operations[0]?.cargo_minutes) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700">
                    {{ fmt(day.operations[0]?.break_minutes) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700">
                    {{ fmt(day.operations[0]?.restraint_minutes) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700 font-medium" :rowspan="day.operations.length || 1">
                    {{ fmt(day.restraint_total_minutes) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ fmt(day.restraint_cumulative_minutes) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ day.drive_average_minutes == null ? '-' : fmt(Math.round(day.drive_average_minutes)) }}
                  </td>
                  <td class="px-2 py-1.5 text-right border-r border-gray-200 dark:border-gray-700" :rowspan="day.operations.length || 1">
                    {{ fmt(day.rest_period_minutes) }}
                  </td>
                  <td class="px-2 py-1.5 text-xs" :rowspan="day.operations.length || 1">
                    {{ day.remarks }}
                  </td>
                </tr>

                <!-- Additional operation rows (stacked) -->
                <tr
                  v-for="(op, opIdx) in day.operations.slice(1)"
                  :key="`${day.date}-${opIdx}`"
                  class="border-t border-gray-50 dark:border-gray-800/50"
                >
                  <td class="px-2 py-1 text-right border-r border-gray-200 dark:border-gray-700 text-gray-500">
                    {{ fmt(op.drive_minutes) }}
                  </td>
                  <td class="px-2 py-1 text-right border-r border-gray-200 dark:border-gray-700 text-gray-500">
                    {{ fmt(op.cargo_minutes) }}
                  </td>
                  <td class="px-2 py-1 text-right border-r border-gray-200 dark:border-gray-700 text-gray-500">
                    {{ fmt(op.break_minutes) }}
                  </td>
                  <td class="px-2 py-1 text-right border-r border-gray-200 dark:border-gray-700 text-gray-500">
                    {{ fmt(op.restraint_minutes) }}
                  </td>
                </tr>
              </template>

              <!-- Weekly subtotal row -->
              <tr v-if="getWeekSubtotal(day.date)" class="border-t-2 border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/30">
                <td class="px-2 py-1.5 text-center font-medium text-blue-600 dark:text-blue-400 border-r border-gray-200 dark:border-gray-700" colspan="3">
                  小計
                </td>
                <td class="px-2 py-1.5 text-right font-medium border-r border-gray-200 dark:border-gray-700">
                  {{ fmt(getWeekSubtotal(day.date)!.drive_minutes) }}
                </td>
                <td class="px-2 py-1.5 text-right font-medium border-r border-gray-200 dark:border-gray-700">
                  {{ fmt(getWeekSubtotal(day.date)!.cargo_minutes) }}
                </td>
                <td class="px-2 py-1.5 text-right font-medium border-r border-gray-200 dark:border-gray-700">
                  {{ fmt(getWeekSubtotal(day.date)!.break_minutes) }}
                </td>
                <td class="px-2 py-1.5 text-right font-medium border-r border-gray-200 dark:border-gray-700">
                  {{ fmt(getWeekSubtotal(day.date)!.restraint_minutes) }}
                </td>
                <td colspan="5"></td>
              </tr>
            </template>

            <!-- Monthly total -->
            <tr class="border-t-2 border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 font-medium">
              <td class="px-2 py-2 text-center border-r border-gray-200 dark:border-gray-700" colspan="3">合計</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700">{{ fmt(report.monthly_total.drive_minutes) }}</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700">{{ fmt(report.monthly_total.cargo_minutes) }}</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700">{{ fmt(report.monthly_total.break_minutes) }}</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700">{{ fmt(report.monthly_total.restraint_minutes) }}</td>
              <td class="px-2 py-2 text-right border-r border-gray-200 dark:border-gray-700" colspan="5"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!--
        凡例 (Refs #918)。**記号を増やしただけでは意味が伝わらない**ので、表のすぐ下に
        1 行置く。言いたいのは **「読んだ結果が 0」と「そもそも読めていない」は違う**
        ということ — `fmt()` の doc コメントと対。片方だけ直すと画面が嘘になる。
        「休」に触れているのは、**日ごとの行で時間欄がまるごと空になるのはそこだけ**で、
        `-` を 1 日分並べたのと紛らわしいから。小計行 / 月合計行の空欄は `colspan` の
        埋めで、そもそもその列のセルが無い (`fmt()` を通っていない)。
      -->
      <p class="px-1 text-xs text-gray-500 dark:text-gray-400">
        時間列の見かた:
        <span class="font-medium text-gray-700 dark:text-gray-300">0:00</span>
        は<span class="font-medium">実測して 0 分</span> (記録を読んだ結果が 0)、
        <span class="font-medium text-gray-700 dark:text-gray-300">-</span>
        は<span class="font-medium">データ無し</span> (記録が無い、または取得できなかった
        — 0 分だったのかどうかも分かりません)。「休」の行は稼働の無い日です。
      </p>

      <!-- Footer summary -->
      <div class="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 text-sm space-y-1">
        <div class="flex gap-8">
          <div>
            4月〜前月 累計拘束時間:
            <span class="font-medium">{{ fmt(report.monthly_total.fiscal_year_cumulative_minutes) }}</span>
          </div>
          <div>
            当月拘束時間:
            <span class="font-medium">{{ fmt(report.monthly_total.restraint_minutes) }}</span>
          </div>
          <div>
            年度合計:
            <span class="font-bold">{{ fmt(report.monthly_total.fiscal_year_total_minutes) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
