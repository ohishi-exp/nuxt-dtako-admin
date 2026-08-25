<script setup lang="ts">
import { getCalendar, triggerScrapeStream, getScrapeHistory, getPendingUploads, rerunUpload, getUploadDownloadUrl, saveScrapeHistory, buildScraperZipUrl, buildEtcCsvDownloadUrl, splitCsv, splitCsvAllStream, getDtakoEventsEtags, postNetprintRun } from '~/utils/api'
import { yesterdayJstYmd, viewNetprintRunResult, type NetprintRunOutcome } from '~/utils/netprint-run'
import type { ScrapeResult, ScrapeHistoryItem, PendingUpload, ScrapeStatusEntry } from '~/types'
import type { ScrapeProgressEvent } from '~/utils/api'
import {
  ETAGS_MAX_RANGE_DAYS,
  formatSplitAllDone,
  formatUnsplitTotal,
  initialSplitStatus,
  parseSplitCsvResponse,
  retriedSplitStatus,
  splitLineClass,
  splitRetryTarget,
  unsplitCheckRange,
  type SplitAllDoneEvent,
} from '~/utils/scrape-split'

/**
 * dtako-scraper-relay (front Worker + DO) から直接受け取った result イベントを
 * rust-alc-api に保存する。旧 `/api/scraper/trigger` (rust-alc-api 経由 SSE 中継)
 * は保存も兼ねていたが、front から直接 WS 接続する構成に変えたため、保存だけ
 * 別途 `/api/proxy` 経由でここから呼ぶ。
 */
function recordScrapeResult(targetDate: string, evt: ScrapeProgressEvent) {
  if (!evt.comp_id) return
  saveScrapeHistory({
    target_date: targetDate,
    comp_id: evt.comp_id,
    status: evt.status || 'error',
    message: evt.message,
  }).catch(() => {
    // 履歴保存の失敗はユーザー体験をブロックしない (スクレイプ自体は完了している)
  })
}

// 会社一覧は `app/utils/dtako-comps.ts` に集約 (拘束×賃金の社員マスタと共有、Refs #367)
const compIdOptions = [
  { label: '全企業', value: '' },
  ...DTAKO_COMPS.map(c => ({ label: dtakoCompDisplay(c.compId), value: c.compId })),
]

/** compIdOptions から「全企業」プレースホルダ (value: '') を除いた実 comp_id 一覧。 */
const realCompIds = compIdOptions.filter(o => o.value).map(o => o.value)

const compIdLabels: Record<string, string> = Object.fromEntries(
  DTAKO_COMPS.map(c => [c.compId, c.label]),
)

const selectedCompId = useState('scraper-compId', () => '')

// --- ETC 明細スクレイプ (管理タブ、Refs #134) ---
// ETC_ACCOUNTS 登録済みの全アカウントを一括実行する (`kind: 'etc-all'`)。
// user_id をフロントから知る手段が無い (dtako の compIdOptions のような
// ハードコードリストを持たない) 以上、個別 user_id を手入力させる意味が
// 無いため、一括実行のみを提供する。DO 側 (`etc-admin-all` ディスパッチャ)
// が ETC_ACCOUNTS を解決してアカウントごとに並列実行し、アカウント単位の
// result イベント (user_id 付き) をそのまま WS で中継する。

const activeTab = useState<'dtako' | 'etc' | 'netprint'>('scraper-active-tab', () => 'dtako')
const etcRunning = ref(false)
interface EtcLogLine {
  text: string
  level?: 'info' | 'error'
  /** 成功時のみ (R2 保存された CSV の `/api/etc-csv/download` URL)。 */
  downloadUrl?: string
}
const etcLog = ref<EtcLogLine[]>([])

/** 「今月実行」「先月実行」のどちらが走っているか (ボタンごとに loading 表示を
 * 分けるため、`etcRunning` とは別に保持する)。 */
const etcRunningMonth = ref<'current' | 'previous' | null>(null)

async function handleEtcRunAll(month: 'current' | 'previous') {
  if (etcRunning.value) return
  etcRunning.value = true
  etcRunningMonth.value = month
  etcLog.value = []
  try {
    await triggerScrapeStream(
      { kind: 'etc-all', month },
      (evt: ScrapeProgressEvent) => {
        if (evt.event === 'progress') {
          etcLog.value.push({
            text: `[進捗] ${evt.user_id ? `${evt.user_id} ` : ''}${evt.step ?? ''}${evt.message ? `: ${evt.message}` : ''}`,
          })
        }
        else if (evt.event === 'result') {
          etcLog.value.push({
            text: `[結果] ${evt.user_id ?? ''}: ${evt.status === 'success' ? '成功' : '失敗'} ${evt.message ?? ''}`,
            level: evt.status === 'success' ? 'info' : 'error',
            downloadUrl: evt.key ? buildEtcCsvDownloadUrl(evt.key) : undefined,
          })
        }
        else if (evt.event === 'error') {
          etcLog.value.push({ text: `[エラー] ${evt.message ?? ''}`, level: 'error' })
        }
      },
    )
  }
  catch (e) {
    etcLog.value.push({ text: `[エラー] ${e instanceof Error ? e.message : 'エラー'}`, level: 'error' })
  }
  finally {
    etcRunning.value = false
    etcRunningMonth.value = null
  }
}

// --- 運転日報 netprint 手動実行 (管理タブ、Refs #874 の 5) ---
// relay の `POST /kintai-relay/netprint-run` は service binding 専用で外から叩けないため、
// front の `POST /api/netprint/run` を経由する。cron (JST 6:30) と同じ道 (DO の
// `/cron/netprint`) を通るので、ここで通れば cron も通る。
// **応答は netprint の status poll 完了まで同期**で数分かかりうる。押した後に処理中である
// ことが分かるよう経過秒を出し、`netprintRunning` で二重送信を止める。

const netprintDate = ref(yesterdayJstYmd(new Date()))
const netprintRunning = ref(false)
/** 実行中の経過秒 (数分かかるので「止まっていない」ことを見せる)。 */
const netprintElapsed = ref(0)
/** fetch 自体が失敗した (ネットワーク断など)。route/relay の失敗は outcome 側に入る。 */
const netprintFetchError = ref('')
const netprintOutcome = ref<NetprintRunOutcome | null>(null)

/** 営業所ごとの表示行 (予約番号は relay の detail に畳まれた DO 応答から取り出す)。 */
const netprintViews = computed(() => (netprintOutcome.value?.results ?? []).map(viewNetprintRunResult))

async function handleNetprintRun() {
  if (netprintRunning.value) return
  netprintRunning.value = true
  netprintElapsed.value = 0
  netprintFetchError.value = ''
  netprintOutcome.value = null
  const timer = setInterval(() => { netprintElapsed.value += 1 }, 1000)
  try {
    netprintOutcome.value = await postNetprintRun({ date: netprintDate.value })
  }
  catch (e) {
    netprintFetchError.value = e instanceof Error ? e.message : '実行に失敗しました'
  }
  finally {
    clearInterval(timer)
    netprintRunning.value = false
  }
}

// Calendar state
const now = new Date()
const calYear = ref(now.getFullYear())
const calMonth = ref(now.getMonth() + 1)
const calLoading = ref(false)
interface FetchedDate {
  count: number
  scrapes: ScrapeStatusEntry[]
}
const fetchedDates = ref<Map<string, FetchedDate>>(new Map())
const selectedDates = ref<Set<string>>(new Set())

const weekDays = ['日', '月', '火', '水', '木', '金', '土']

interface CalendarCell {
  date: string // YYYY-MM-DD
  day: number
  inMonth: boolean
  count: number // 0 = no data
  scrapes: ScrapeStatusEntry[]
}

const calendarCells = computed<CalendarCell[]>(() => {
  const y = calYear.value
  const m = calMonth.value
  const firstDay = new Date(y, m - 1, 1)
  const startDow = firstDay.getDay() // 0=Sun
  const daysInMonth = new Date(y, m, 0).getDate()

  const cells: CalendarCell[] = []

  // Padding before
  for (let i = 0; i < startDow; i++) {
    const d = new Date(y, m - 1, -startDow + i + 1)
    cells.push({
      date: fmt(d),
      day: d.getDate(),
      inMonth: false,
      count: 0,
      scrapes: [],
    })
  }

  // Days in month
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(y, m - 1, day)
    const dateStr = fmt(d)
    const fetched = fetchedDates.value.get(dateStr)
    cells.push({
      date: dateStr,
      day,
      inMonth: true,
      count: fetched?.count || 0,
      scrapes: fetched?.scrapes || [],
    })
  }

  // Padding after (fill to complete week)
  while (cells.length % 7 !== 0) {
    const d = new Date(y, m - 1, daysInMonth + (cells.length - startDow - daysInMonth + 1))
    cells.push({
      date: fmt(d),
      day: d.getDate(),
      inMonth: false,
      count: 0,
      scrapes: [],
    })
  }

  return cells
})

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const calLabel = computed(() => `${calYear.value}年${calMonth.value}月`)

function prevMonth() {
  if (calMonth.value === 1) {
    calYear.value--
    calMonth.value = 12
  }
  else {
    calMonth.value--
  }
  loadCalendar()
}

function nextMonth() {
  if (calMonth.value === 12) {
    calYear.value++
    calMonth.value = 1
  }
  else {
    calMonth.value++
  }
  loadCalendar()
}

async function loadCalendar() {
  calLoading.value = true
  selectedDates.value.clear()
  try {
    const res = await getCalendar(calYear.value, calMonth.value)
    const map = new Map<string, FetchedDate>()
    for (const d of res.dates) {
      map.set(d.date, { count: d.count, scrapes: d.scrapes || [] })
    }
    fetchedDates.value = map
  }
  catch {
    fetchedDates.value = new Map()
  }
  finally {
    calLoading.value = false
  }
}

function toggleDate(cell: CalendarCell) {
  if (!cell.inMonth) return
  const s = selectedDates.value
  if (s.has(cell.date)) {
    s.delete(cell.date)
  }
  else {
    s.add(cell.date)
  }
  // trigger reactivity
  selectedDates.value = new Set(s)
}

function selectAllMissing() {
  const y = calYear.value
  const m = calMonth.value
  const daysInMonth = new Date(y, m, 0).getDate()
  const s = new Set<string>()
  for (let day = 1; day <= daysInMonth; day++) {
    const d = fmt(new Date(y, m - 1, day))
    if (!fetchedDates.value.has(d)) {
      s.add(d)
    }
  }
  selectedDates.value = s
}

function clearSelection() {
  selectedDates.value = new Set()
}

// Scraping (useState でページ遷移しても保持)
const isRunning = useState('scraper-running', () => false)

const stepLabels: Record<string, string> = {
  queued: '順番待ち... (同一企業の処理が進行中)',
  login: 'ログイン中...',
  download: 'ダウンロード中...',
  upload: 'アップロード中...',
}

interface DayTask {
  date: string
  status: 'pending' | 'running' | 'success' | 'error'
  step?: string
  results: ScrapeResult[]
  error?: string
}

const tasks = useState<DayTask[]>('scraper-tasks', () => [])

// --- CSV 分割の自動やり直し (Refs #205-40) ---
//
// スクレイプ = 取り込み (`POST /api/upload`) は成功しても、その直後に alc が走らせる
// CSV 分割が失敗すると、対象運行は `has_kudgivt = FALSE` のまま残る。読み取り側 3
// クエリが全部 `has_kudgivt = TRUE` で絞っているため、**入力からも欠け検知の母集団
// からも同時に消える** (2026-07-31 に実際に 1 運行が消えた)。背景と口の選び分けの
// 根拠は `app/utils/scrape-split.ts` の冒頭コメント。
//
// ここでは result を受けた時点で `split_failed > 0` を見て、その upload_id を
// 狙い撃ちで `POST /api/proxy/api/split-csv/{upload_id}` に投げ直す (冪等・上限なし・
// テナント跨ぎ可)。**取り込みの成否 (`status`) は書き換えない** — 取り込み自体は
// 成功しているので、分割の失敗は行内の別表示として出す。

/** 実行中の自動リトライ。スクレイプ完了時に await してからカレンダーを読み直す。 */
const pendingSplitRetries: Promise<void>[] = []

/** result イベントを task に積み、必要なら CSV 分割を自動でやり直す。
 * (4 箇所のスクレイプ経路 — 実行 / リラン / 全エラーリラン / 履歴リラン — で共用) */
function pushScrapeResult(task: DayTask, evt: ScrapeProgressEvent) {
  const result: ScrapeResult = reactive({
    comp_id: evt.comp_id || '',
    status: evt.status || 'error',
    message: evt.message || '',
    zipUrl: evt.zip_url,
    uploadId: evt.upload_id,
    // 取り込みが失敗している時は分割の話をしても仕方がないので出さない。
    split: (evt.status === 'success' ? initialSplitStatus(evt) : null) ?? undefined,
  })
  task.results.push(result)
  recordScrapeResult(task.date, evt)

  if (evt.status !== 'success') return
  const uploadId = splitRetryTarget(evt)
  if (!uploadId) return

  pendingSplitRetries.push(
    (async () => {
      try {
        result.split = retriedSplitStatus(parseSplitCsvResponse(await splitCsv(uploadId)))
      }
      catch (e) {
        result.split = retriedSplitStatus(null, e instanceof Error ? e.message : '不明なエラー')
      }
    })(),
  )
}

/** 実行中の自動リトライを全部待つ (取りこぼしたまま画面を「完了」にしないため)。 */
async function drainSplitRetries() {
  if (pendingSplitRetries.length === 0) return
  await Promise.all(pendingSplitRetries.splice(0))
}

// --- 取り込み後の答え合わせ (Refs #205-40) ---
//
// `split_failed === 0` は「分割済み」の十分条件ではない (alc の update_has_kudgivt が
// 当たらなかった unko_no は warn されるだけで Ok(0))。**本当に読み取り側に出るように
// なったか**は `GET /api/dtako/events/etags` の `unsplit_total` (= has_kudgivt = FALSE
// の実数、rust-alc-api#587) で確かめる。2026-07-31 に消えた 1 件に気づけたのは
// この値であって split_failed ではなかった。
//
// この確認は**取り込みの成否を左右しない** — 失敗しても警告行を 1 本出すだけ。

const unsplitLine = ref<{ level: 'info' | 'error', text: string } | null>(null)

async function checkUnsplit(dates: string[]) {
  const range = unsplitCheckRange(dates)
  if (!range) {
    // 期間が alc の上限 (40 日) を超えた。黙って飛ばすと「確認した」と誤読されるので出す。
    unsplitLine.value = dates.length
      ? { level: 'info', text: `未分割の確認は省略しました (対象期間が ${ETAGS_MAX_RANGE_DAYS} 日を超えています)` }
      : null
    return
  }
  try {
    const res = await getDtakoEventsEtags(range.from, range.to)
    unsplitLine.value = typeof res.unsplit_total === 'number'
      ? formatUnsplitTotal(range, res.unsplit_total)
      : { level: 'info', text: '未分割の件数を確認できませんでした (alc が unsplit_total を返していません)' }
  }
  catch (e) {
    unsplitLine.value = {
      level: 'error',
      text: `未分割の確認に失敗しました: ${e instanceof Error ? e.message : '不明なエラー'}`,
    }
  }
}

// --- 未分割をまとめて分割 (手動、Refs #205-40) ---
//
// 自動やり直しが拾えるのは「今回のスクレイプで取り込んだ upload」だけ。過去の
// 取り残し (旧 relay 経由 / upload_id 不明 / cron 実行分) はここで掃く。
// `split-csv-all` は**ログイン中のテナント**の候補しか見ず、**1 回 50 件で切る**
// (`SPLIT_CSV_ALL_LIMIT`) ので、`skipped` をそのまま画面に出す。

const splitAllRunning = ref(false)
const splitAllLog = ref<{ text: string, level: 'info' | 'error' }[]>([])

async function handleSplitAll() {
  if (splitAllRunning.value) return
  splitAllRunning.value = true
  splitAllLog.value = []
  try {
    await splitCsvAllStream((evt: SplitAllDoneEvent) => {
      if (evt.event === 'done') {
        splitAllLog.value.push({ text: formatSplitAllDone(evt), level: (evt.failed ?? 0) > 0 ? 'error' : 'info' })
      }
      else if (evt.event === 'error') {
        splitAllLog.value.push({ text: `エラー: ${evt.message ?? '不明'}`, level: 'error' })
      }
    })
    if (splitAllLog.value.length === 0) {
      // done も error も来ずにストリームが閉じた = 何が起きたか分からない。
      // 「黙って成功」にすると未分割が残ったまま完了に見えるので loud に出す。
      splitAllLog.value.push({ text: '応答が空でした (alc から done イベントが来ていません)', level: 'error' })
    }
  }
  catch (e) {
    splitAllLog.value.push({ text: e instanceof Error ? e.message : '分割に失敗しました', level: 'error' })
  }
  finally {
    splitAllRunning.value = false
  }
}

async function handleScrape() {
  const dates = [...selectedDates.value].sort()
  if (dates.length === 0) return

  tasks.value = dates.map(date => ({
    date,
    status: 'pending',
    results: [],
  }))
  isRunning.value = true

  // 「全企業」(selectedCompId が空) は SCRAPER_MODE=http (DO が comp_id 単位で
  // idFromName される設計、Refs ohishi-exp/dtako-scraper#22) では comp_id 必須の
  // ため 400 になる。フロント側で実 comp_id を明示指定して回す (DO 側の変更は不要)。
  const compIdsToRun = selectedCompId.value ? [selectedCompId.value] : realCompIds

  for (const task of tasks.value) {
    task.status = 'running'
    task.step = undefined
    // comp_id は別 DO (idFromName(scraper-comp-<id>)) + 別 theearth アカウント = 別セッション
    // なので **並列**に走らせて安全 (同一 comp_id への同時実行だけ DO 内キューで直列化される)。
    // 逐次 await にすると「1社目が done するまで2社目が始まらない/結果が出ない」ため並列化する。
    await Promise.all(
      compIdsToRun.map(async (compId) => {
        try {
          await triggerScrapeStream(
            {
              comp_id: compId,
              start_date: task.date,
              end_date: task.date,
            },
            (evt: ScrapeProgressEvent) => {
              if (evt.event === 'progress') {
                task.step = evt.step
              }
              else if (evt.event === 'result') {
                pushScrapeResult(task, evt)
              }
              else if (evt.event === 'error') {
                // result イベント無しで切断されるケース (account 未検出等の接続レベルエラー)。
                // result を push しないと done で誤って success 判定されてしまう。
                task.results.push({ comp_id: evt.comp_id || '', status: 'error', message: evt.message || 'エラーが発生しました' })
              }
              else if (evt.event === 'done') {
                task.step = undefined
              }
            },
          )
        }
        catch (e) {
          task.results.push({
            comp_id: compId,
            status: 'error',
            message: e instanceof Error ? e.message : 'エラー',
          })
        }
      }),
    )
    task.status = task.results.some(r => r.status === 'error') ? 'error' : 'success'
  }

  // 分割のやり直しが終わるまで「実行中」を解かない (残っているのに完了に見えるのを防ぐ)
  await drainSplitRetries()
  await checkUnsplit(tasks.value.map(t => t.date))
  isRunning.value = false
  await loadCalendar()
  await loadHistory()
}

// --- リラン ---

async function handleRerun(task: DayTask) {
  const failedIds = task.results
    .filter(r => r.status === 'error')
    .map(r => r.comp_id)
  if (failedIds.length === 0 && !task.error) return

  // エラー results を除去、成功は保持
  task.results = task.results.filter(r => r.status !== 'error')
  task.error = undefined
  task.status = 'running'
  task.step = undefined
  isRunning.value = true

  // failedIds が空（task-level error）の場合は元の comp_id 設定で再実行
  const idsToRetry = failedIds.length > 0 ? failedIds : [selectedCompId.value || undefined]

  // comp_id ごとに並列 (handleScrape と同じ理由)。
  await Promise.all(
    idsToRetry.map(async (compId) => {
      try {
        await triggerScrapeStream(
          {
            comp_id: compId || undefined,
            start_date: task.date,
            end_date: task.date,
          },
          (evt: ScrapeProgressEvent) => {
            if (evt.event === 'progress') {
              task.step = evt.step
            }
            else if (evt.event === 'result') {
              pushScrapeResult(task, evt)
            }
            else if (evt.event === 'error') {
              task.results.push({ comp_id: evt.comp_id || '', status: 'error', message: evt.message || 'エラーが発生しました' })
            }
            else if (evt.event === 'done') {
              task.step = undefined
            }
          },
        )
      }
      catch (e) {
        task.results.push({
          comp_id: compId || '',
          status: 'error',
          message: e instanceof Error ? e.message : 'エラー',
        })
      }
    }),
  )

  task.status = task.results.some(r => r.status === 'error') ? 'error' : 'success'
  // 分割のやり直しが終わるまで「実行中」を解かない (残っているのに完了に見えるのを防ぐ)
  await drainSplitRetries()
  await checkUnsplit(tasks.value.map(t => t.date))
  isRunning.value = false
  await loadCalendar()
  await loadHistory()
}

async function handleRerunAllErrors() {
  const errorTasks = tasks.value.filter(t => t.status === 'error')
  if (errorTasks.length === 0) return

  isRunning.value = true
  for (const task of errorTasks) {
    // handleRerun 内で isRunning を管理しないよう、直接ロジックを実行
    const failedIds = task.results
      .filter(r => r.status === 'error')
      .map(r => r.comp_id)

    task.results = task.results.filter(r => r.status !== 'error')
    task.error = undefined
    task.status = 'running'
    task.step = undefined

    const idsToRetry = failedIds.length > 0 ? failedIds : [selectedCompId.value || undefined]

    await Promise.all(
      idsToRetry.map(async (compId) => {
        try {
          await triggerScrapeStream(
            {
              comp_id: compId || undefined,
              start_date: task.date,
              end_date: task.date,
            },
            (evt: ScrapeProgressEvent) => {
              if (evt.event === 'progress') {
                task.step = evt.step
              }
              else if (evt.event === 'result') {
                pushScrapeResult(task, evt)
              }
              else if (evt.event === 'error') {
                task.results.push({ comp_id: evt.comp_id || '', status: 'error', message: evt.message || 'エラーが発生しました' })
              }
              else if (evt.event === 'done') {
                task.step = undefined
              }
            },
          )
        }
        catch (e) {
          task.results.push({
            comp_id: compId || '',
            status: 'error',
            message: e instanceof Error ? e.message : 'エラー',
          })
        }
      }),
    )

    task.status = task.results.some(r => r.status === 'error') ? 'error' : 'success'
  }

  // 分割のやり直しが終わるまで「実行中」を解かない (残っているのに完了に見えるのを防ぐ)
  await drainSplitRetries()
  await checkUnsplit(tasks.value.map(t => t.date))
  isRunning.value = false
  await loadCalendar()
  await loadHistory()
}

// --- 保留アップロード ---

const pendingUploads = ref<PendingUpload[]>([])
const pendingLoading = ref(false)
const pendingError = ref<string | null>(null)
const rerunningId = ref<string | null>(null)
const rerunResult = ref<{ id: string; success: boolean; message: string } | null>(null)

async function loadPending() {
  pendingLoading.value = true
  pendingError.value = null
  try {
    pendingUploads.value = await getPendingUploads()
  } catch (e) {
    pendingUploads.value = []
    pendingError.value = e instanceof Error ? e.message : '取得に失敗しました'
  } finally {
    pendingLoading.value = false
  }
}

async function handleUploadRerun(upload: PendingUpload, historyItem?: ScrapeHistoryItem) {
  rerunningId.value = upload.id
  rerunResult.value = null
  try {
    const res = await rerunUpload(upload.id)
    upload.status = res.status
    rerunResult.value = {
      id: upload.id,
      success: true,
      message: `${res.operations_count} 件取り込み完了`,
    }
    if (historyItem) {
      historyItem.message = `✅ リラン完了: ${res.operations_count} 件取り込み (upload_id: ${upload.id})`
    }
    await loadPending()
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'リランに失敗しました'
    rerunResult.value = {
      id: upload.id,
      success: false,
      message: msg,
    }
    if (historyItem) {
      historyItem.status = 'error'
      historyItem.message = `❌ リラン失敗: ${msg}`
    }
  } finally {
    rerunningId.value = null
  }
}

function uploadStatusColor(status: string) {
  switch (status) {
    case 'completed': return 'success' as const
    case 'pending_retry': return 'warning' as const
    case 'failed': return 'error' as const
    default: return 'neutral' as const
  }
}

function uploadStatusLabel(status: string) {
  switch (status) {
    case 'completed': return '完了'
    case 'pending_retry': return '保留中'
    case 'failed': return '失敗'
    default: return status
  }
}

// --- 履歴 ---

const history = ref<ScrapeHistoryItem[]>([])
const historyLoading = ref(false)

async function loadHistory() {
  historyLoading.value = true
  try {
    history.value = await getScrapeHistory(50)
  }
  catch {
    history.value = []
  }
  finally {
    historyLoading.value = false
  }
}

// 履歴からリラン
async function handleHistoryRerun(item: ScrapeHistoryItem) {
  isRunning.value = true

  // リアルタイムタスクとして追加
  tasks.value = [{
    date: item.target_date,
    status: 'running',
    results: [],
  }]
  const task = tasks.value[0]!  // リアクティブプロキシを参照

  try {
    await triggerScrapeStream(
      {
        comp_id: item.comp_id,
        start_date: item.target_date,
        end_date: item.target_date,
      },
      (evt: ScrapeProgressEvent) => {
        if (evt.event === 'progress') {
          task.step = evt.step
        }
        else if (evt.event === 'result') {
          // task.date === item.target_date (この task は item から組み立てている)
          pushScrapeResult(task, evt)
        }
        else if (evt.event === 'error') {
          task.results.push({ comp_id: evt.comp_id || '', status: 'error', message: evt.message || 'エラーが発生しました' })
        }
        else if (evt.event === 'done') {
          task.status = task.results.some(r => r.status === 'error') ? 'error' : 'success'
          task.step = undefined
        }
      },
    )
    if (task.status === 'running') {
      task.status = task.results.some(r => r.status === 'error') ? 'error' : 'success'
    }
  }
  catch (e) {
    task.error = e instanceof Error ? e.message : 'エラー'
    task.status = 'error'
  }

  // 分割のやり直しが終わるまで「実行中」を解かない (残っているのに完了に見えるのを防ぐ)
  await drainSplitRetries()
  await checkUnsplit(tasks.value.map(t => t.date))
  isRunning.value = false
  await loadCalendar()
  await loadHistory()
}

function extractUploadId(message: string | null): string | null {
  if (!message || !message.includes('STORED_FOR_RETRY')) return null
  const match = message.match(/"upload_id"\s*:\s*"([^"]+)"/)
  return match ? match[1] ?? null : null
}

function formatDatetime(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const completedCount = computed(() => tasks.value.filter(t => t.status === 'success' || t.status === 'error').length)
const successCount = computed(() => tasks.value.filter(t => t.status === 'success').length)
const errorCount = computed(() => tasks.value.filter(t => t.status === 'error').length)

onMounted(() => {
  loadCalendar()
  loadHistory()
  loadPending()
})
</script>

<template>
  <div class="max-w-3xl">
    <h1 class="text-2xl font-bold mb-6">
      スクレイプ
    </h1>

    <!-- 管理タブ (Refs #134): デジタコ (comp_id 単位) / ETC (user_id 単位、手動実行) -->
    <div class="flex gap-2 mb-4 border-b border-gray-200 dark:border-gray-800">
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium border-b-2 -mb-px"
        :class="activeTab === 'dtako' ? 'border-primary-500 text-primary-600 dark:text-primary-400' : 'border-transparent text-gray-500'"
        @click="activeTab = 'dtako'"
      >
        デジタコ
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium border-b-2 -mb-px"
        :class="activeTab === 'etc' ? 'border-primary-500 text-primary-600 dark:text-primary-400' : 'border-transparent text-gray-500'"
        @click="activeTab = 'etc'"
      >
        ETC
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium border-b-2 -mb-px"
        :class="activeTab === 'netprint' ? 'border-primary-500 text-primary-600 dark:text-primary-400' : 'border-transparent text-gray-500'"
        @click="activeTab = 'netprint'"
      >
        日報netprint
      </button>
    </div>

    <div v-show="activeTab === 'netprint'">
      <UCard>
        <h2 class="font-bold mb-1">
          運転日報を netprint に登録 (手動実行)
        </h2>
        <p class="text-xs text-gray-500 mb-3">
          対象日の運転日報を PDF にして かんたんnetprint に登録し、プリント予約番号を営業所へ通知します
          (毎朝 6:30 の cron と同じ経路)。対象営業所と通知先は relay の <code>NETPRINT_TARGETS</code> 設定に従います。
          <strong>netprint の変換完了まで待つので数分かかります</strong> — 押したままお待ちください。
        </p>
        <div class="flex flex-wrap gap-2 items-end mb-4">
          <div>
            <label class="block text-sm font-medium mb-1">対象日 (既定: 前日)</label>
            <UInput v-model="netprintDate" type="date" class="w-40" :disabled="netprintRunning" />
          </div>
          <UButton
            label="日報を netprint に登録"
            icon="i-lucide-printer"
            :loading="netprintRunning"
            :disabled="netprintRunning || !netprintDate"
            @click="handleNetprintRun"
          />
        </div>

        <div v-if="netprintRunning" class="text-sm text-gray-500 flex items-center gap-2">
          <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />
          実行中... ({{ netprintElapsed }} 秒経過 / theearth 取得 → PDF 生成 → netprint 登録 → 予約番号を通知)
        </div>

        <div v-if="netprintFetchError" class="text-sm text-red-500">
          [エラー] {{ netprintFetchError }}
        </div>

        <div v-if="netprintOutcome" class="space-y-2 text-sm">
          <div :class="netprintOutcome.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'">
            {{ netprintOutcome.ok ? '成功' : '失敗' }} (HTTP {{ netprintOutcome.status }})
            <span v-if="netprintOutcome.date">— 対象日 {{ netprintOutcome.date }}</span>
          </div>
          <div v-if="netprintOutcome.error" class="text-red-500 break-all">
            {{ netprintOutcome.error }}
          </div>
          <div
            v-if="netprintViews.length"
            class="space-y-2 bg-gray-50 dark:bg-gray-900 rounded-lg p-3 max-h-64 overflow-y-auto"
          >
            <div v-for="(view, i) in netprintViews" :key="i" class="font-mono text-xs break-all">
              <span :class="view.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'">
                [{{ view.ok ? '成功' : '失敗' }}] 営業所 {{ view.branchCd }}
              </span>
              <span v-if="view.printIds.length" class="ml-1 font-bold">
                予約番号 {{ view.printIds.join(' / ') }}
              </span>
              <div class="text-gray-500">
                {{ view.message }}
              </div>
            </div>
          </div>
          <p v-else-if="!netprintOutcome.error" class="text-gray-500">
            relay から営業所ごとの結果が返りませんでした。
          </p>
        </div>
      </UCard>
    </div>

    <div v-show="activeTab === 'etc'">
      <UCard>
        <h2 class="font-bold mb-1">
          ETC 明細スクレイプ (手動実行)
        </h2>
        <p class="text-xs text-gray-500 mb-3">
          ETC_ACCOUNTS に設定済みの全アカウントを、今すぐ一括でスクレイプ実行します (cron と同じ経路、結果は R2 に保存されます)。
          「今月実行」は今月1日〜本日、「先月実行」は先月1日〜末日の範囲で絞り込みます。
        </p>
        <div class="flex flex-wrap gap-2 items-end mb-4">
          <UButton
            label="今月実行"
            icon="i-lucide-play"
            :loading="etcRunningMonth === 'current'"
            :disabled="etcRunning"
            @click="handleEtcRunAll('current')"
          />
          <UButton
            label="先月実行"
            icon="i-lucide-play"
            color="neutral"
            :loading="etcRunningMonth === 'previous'"
            :disabled="etcRunning"
            @click="handleEtcRunAll('previous')"
          />
        </div>
        <div
          v-if="etcLog.length"
          class="space-y-1 text-sm font-mono bg-gray-50 dark:bg-gray-900 rounded-lg p-3 max-h-64 overflow-y-auto"
        >
          <div
            v-for="(line, i) in etcLog"
            :key="i"
            :class="line.level === 'error' ? 'text-red-500' : ''"
          >
            {{ line.text }}
            <a
              v-if="line.downloadUrl"
              :href="line.downloadUrl"
              class="text-primary-500 underline ml-1"
              target="_blank"
              rel="noopener"
            >
              CSVダウンロード
            </a>
          </div>
        </div>
      </UCard>
    </div>

    <div v-show="activeTab === 'dtako'">
    <!-- Settings -->
    <UCard class="mb-4">
      <div class="flex flex-wrap gap-4 items-end">
        <div>
          <label class="block text-sm font-medium mb-1">企業</label>
          <select v-model="selectedCompId" class="border rounded-lg px-3 py-1.5 text-sm dark:bg-gray-900 dark:border-gray-700">
            <option v-for="opt in compIdOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
      </div>
    </UCard>

    <!-- Calendar -->
    <UCard>
      <!-- Header -->
      <div class="flex items-center justify-between mb-4">
        <UButton icon="i-lucide-chevron-left" variant="ghost" size="sm" @click="prevMonth" />
        <span class="text-lg font-bold">{{ calLabel }}</span>
        <UButton icon="i-lucide-chevron-right" variant="ghost" size="sm" @click="nextMonth" />
      </div>

      <p class="text-xs text-gray-500 mb-2">読み取り日ベース</p>

      <!-- Legend -->
      <div class="flex gap-4 mb-3 text-xs text-gray-500">
        <span class="flex items-center gap-1">
          <span class="w-3 h-3 rounded bg-green-200 dark:bg-green-800 inline-block" /> 取得済み
        </span>
        <span class="flex items-center gap-1">
          <span class="w-3 h-3 rounded bg-gray-100 dark:bg-gray-800 inline-block" /> 未取得
        </span>
        <span class="flex items-center gap-1">
          <span class="w-3 h-3 rounded ring-2 ring-blue-500 inline-block" /> 選択中
        </span>
      </div>

      <!-- Week day headers -->
      <div class="grid grid-cols-7 text-center text-xs font-medium text-gray-500 mb-1">
        <div v-for="w in weekDays" :key="w" :class="w === '日' ? 'text-red-400' : w === '土' ? 'text-blue-400' : ''">
          {{ w }}
        </div>
      </div>

      <!-- Calendar grid -->
      <div v-if="calLoading" class="py-12 text-center text-gray-400">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
        読み込み中...
      </div>
      <div v-else class="grid grid-cols-7 gap-1">
        <button
          v-for="cell in calendarCells"
          :key="cell.date"
          :disabled="!cell.inMonth"
          class="aspect-square rounded-lg text-sm flex flex-col items-center justify-center transition-all relative"
          :class="[
            !cell.inMonth ? 'text-gray-300 dark:text-gray-700 cursor-default' : 'cursor-pointer hover:ring-2 hover:ring-blue-300',
            cell.inMonth && cell.count > 0 && !cell.scrapes.some(s => s.status !== 'success') ? 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300' : '',
            cell.inMonth && cell.count > 0 && cell.scrapes.some(s => s.status !== 'success') ? 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-300' : '',
            cell.inMonth && cell.count === 0 && cell.scrapes.some(s => s.status !== 'success') ? 'bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300' : '',
            cell.inMonth && cell.count === 0 && !cell.scrapes.some(s => s.status !== 'success') ? 'bg-gray-50 dark:bg-gray-800/50' : '',
            selectedDates.has(cell.date) ? 'ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-gray-900' : '',
          ]"
          @click="toggleDate(cell)"
        >
          <span class="font-medium">{{ cell.day }}</span>
          <span v-if="cell.inMonth && cell.count > 0" class="text-[10px] leading-none text-green-600 dark:text-green-400">
            {{ cell.count }}件
          </span>
          <!-- 企業別ステータスドット -->
          <div v-if="cell.inMonth && cell.scrapes.length > 0" class="flex gap-0.5 mt-0.5">
            <span
              v-for="s in cell.scrapes"
              :key="s.comp_id"
              class="w-1.5 h-1.5 rounded-full"
              :class="s.status === 'success' ? 'bg-green-500' : 'bg-red-500'"
              :title="`${compIdLabels[s.comp_id] || s.comp_id}: ${s.status}`"
            />
          </div>
        </button>
      </div>

      <!-- Actions -->
      <div class="flex flex-wrap gap-2 mt-4">
        <UButton
          label="未取得を全選択"
          icon="i-lucide-check-square"
          variant="outline"
          size="sm"
          @click="selectAllMissing"
        />
        <UButton
          label="選択解除"
          icon="i-lucide-x"
          variant="outline"
          size="sm"
          :disabled="selectedDates.size === 0"
          @click="clearSelection"
        />
        <div class="flex-1" />
        <UButton
          :label="`選択した ${selectedDates.size} 日をスクレイプ`"
          icon="i-lucide-play"
          :loading="isRunning"
          :disabled="isRunning || selectedDates.size === 0"
          @click="handleScrape"
        />
      </div>

      <!-- 未分割の掃除 (Refs #205-40)。スクレイプ直後の分割やり直しは自動で走るが、
           拾えるのは今回の upload だけ。過去の取り残し (cron 実行分・旧 relay 経由で
           upload_id が取れなかった分) はここで掃く。 -->
      <div class="mt-4 pt-3 border-t dark:border-gray-800">
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            label="未分割をまとめて分割"
            icon="i-lucide-scissors"
            variant="soft"
            size="sm"
            :loading="splitAllRunning"
            :disabled="splitAllRunning"
            @click="handleSplitAll"
          />
          <span class="text-xs text-gray-500 dark:text-gray-400">
            CSV 分割されていない運行は一覧にも欠け検知にも出てきません。1 回あたり最大 50 件。
          </span>
        </div>
        <div v-if="splitAllLog.length" class="mt-2 space-y-1">
          <div
            v-for="(line, i) in splitAllLog"
            :key="i"
            class="text-xs"
            :class="line.level === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'"
          >
            {{ line.text }}
          </div>
        </div>
      </div>
    </UCard>

    <!-- Task progress -->
    <div v-if="tasks.length" class="mt-4 space-y-3">
      <div class="flex items-center gap-3 text-sm text-gray-600 dark:text-gray-400">
        <span>{{ completedCount }} / {{ tasks.length }} 完了</span>
        <span v-if="successCount" class="text-green-600">{{ successCount }} 成功</span>
        <span v-if="errorCount" class="text-red-600">{{ errorCount }} エラー</span>
        <UButton
          v-if="errorCount > 0 && !isRunning"
          label="全エラーをリラン"
          icon="i-lucide-refresh-cw"
          variant="soft"
          color="warning"
          size="xs"
          @click="handleRerunAllErrors"
        />
      </div>

      <!-- 取り込み後の答え合わせ (Refs #205-40)。split_failed が 0 でも未分割が残る
           ことがあるので、has_kudgivt = FALSE の実数 (`unsplit_total`) で確かめる。 -->
      <div
        v-if="unsplitLine"
        class="text-xs"
        :class="unsplitLine.level === 'error'
          ? 'font-bold text-red-600 dark:text-red-400'
          : 'text-gray-500 dark:text-gray-400'"
      >
        {{ unsplitLine.text }}
      </div>

      <div class="space-y-2">
        <div
          v-for="task in tasks"
          :key="task.date"
          class="border rounded-lg p-3 text-sm"
          :class="{
            'border-gray-200 dark:border-gray-800': task.status === 'pending',
            'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950': task.status === 'running',
            'border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950': task.status === 'success',
            'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950': task.status === 'error',
          }"
        >
          <div class="flex items-center gap-2">
            <UIcon
              v-if="task.status === 'pending'"
              name="i-lucide-circle"
              class="size-4 text-gray-400"
            />
            <UIcon
              v-else-if="task.status === 'running'"
              name="i-lucide-loader-circle"
              class="size-4 text-blue-500 animate-spin"
            />
            <UIcon
              v-else-if="task.status === 'success'"
              name="i-lucide-check-circle"
              class="size-4 text-green-500"
            />
            <UIcon
              v-else
              name="i-lucide-alert-circle"
              class="size-4 text-red-500"
            />
            <span class="font-medium">{{ task.date }}</span>
            <span v-if="task.status === 'running'" class="text-blue-600 dark:text-blue-400">
              {{ task.step ? stepLabels[task.step] || task.step : '実行中...' }}
            </span>
            <div class="flex-1" />
            <UButton
              v-if="task.status === 'error' && !isRunning"
              label="リラン"
              icon="i-lucide-refresh-cw"
              variant="soft"
              color="warning"
              size="xs"
              @click="handleRerun(task)"
            />
          </div>

          <div v-if="task.results.length" class="mt-2 pl-6 space-y-1">
            <div
              v-for="r in task.results"
              :key="r.comp_id"
              class="text-xs"
              :class="r.status === 'success' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'"
            >
              [{{ r.comp_id }}] {{ r.message }}
              <a
                v-if="r.zipUrl"
                :href="buildScraperZipUrl(r.zipUrl)"
                class="ml-1 underline"
              >{{ r.status === 'success' ? 'zipダウンロード' : '応答をダウンロード' }}</a>
              <!-- CSV 分割は取り込みとは別建てで出す (Refs #205-40)。取り込みが
                   成功していても分割が失敗するとその運行は読み取り側から消えるため、
                   成功行の中に埋もれさせない。 -->
              <div v-if="r.split" :class="splitLineClass(r.split.state)">
                {{ r.split.message }}
              </div>
            </div>
          </div>
          <div v-if="task.error" class="mt-1 pl-6 text-xs text-red-600">
            {{ task.error }}
          </div>
        </div>
      </div>
    </div>

    <!-- Scrape History -->
    <UCard class="mt-6">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-bold">
          スクレイプ履歴
        </h2>
        <UButton
          icon="i-lucide-refresh-cw"
          variant="ghost"
          size="xs"
          :loading="historyLoading"
          @click="loadHistory"
        />
      </div>

      <div v-if="historyLoading && history.length === 0" class="py-8 text-center text-gray-400">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
        読み込み中...
      </div>

      <div v-else-if="history.length === 0" class="py-8 text-center text-gray-400 text-sm">
        履歴がありません
      </div>

      <div v-else class="space-y-1.5">
        <div
          v-for="item in history"
          :key="item.id"
          class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border"
          :class="{
            'border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/30': item.status === 'success',
            'border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/30': item.status === 'error',
            'border-gray-200 dark:border-gray-800': item.status !== 'success' && item.status !== 'error',
          }"
        >
          <UIcon
            v-if="item.status === 'success'"
            name="i-lucide-check-circle"
            class="size-4 text-green-500 shrink-0"
          />
          <UIcon
            v-else
            name="i-lucide-alert-circle"
            class="size-4 text-red-500 shrink-0"
          />
          <span class="text-xs text-gray-500 shrink-0">{{ formatDatetime(item.created_at) }}</span>
          <span class="font-medium shrink-0">{{ item.target_date }}</span>
          <span class="text-xs text-gray-500 shrink-0">[{{ item.comp_id }}] {{ compIdLabels[item.comp_id] || '' }}</span>
          <span
            v-if="item.message"
            class="text-xs truncate"
            :class="item.status === 'success' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'"
            :title="item.message"
          >
            {{ item.message }}
          </span>
          <div class="flex-1" />
          <span
            v-if="rerunResult && rerunResult.id === extractUploadId(item.message) && rerunResult.success"
            class="text-xs text-green-600"
          >
            {{ rerunResult.message }}
          </span>
          <span
            v-if="rerunResult && rerunResult.id === extractUploadId(item.message) && !rerunResult.success"
            class="text-xs text-red-600"
          >
            {{ rerunResult.message }}
          </span>
          <UButton
            v-if="extractUploadId(item.message)"
            icon="i-lucide-download"
            variant="soft"
            color="neutral"
            size="xs"
            :to="getUploadDownloadUrl(extractUploadId(item.message)!)"
            target="_blank"
          />
          <UButton
            v-if="extractUploadId(item.message) && !isRunning"
            label="リラン"
            icon="i-lucide-upload"
            variant="soft"
            color="warning"
            size="xs"
            :loading="rerunningId === extractUploadId(item.message)"
            @click="handleUploadRerun({ id: extractUploadId(item.message)!, status: 'pending_retry' } as PendingUpload, item)"
          />
          <UButton
            v-else-if="item.status === 'error' && !isRunning"
            label="リラン"
            icon="i-lucide-refresh-cw"
            variant="soft"
            color="warning"
            size="xs"
            @click="handleHistoryRerun(item)"
          />
        </div>
      </div>
    </UCard>

    <!-- Pending Uploads -->
    <UCard class="mt-6">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-bold">
          保留中のアップロード
        </h2>
        <UButton
          icon="i-lucide-refresh-cw"
          variant="ghost"
          size="xs"
          :loading="pendingLoading"
          @click="loadPending"
        />
      </div>

      <div v-if="pendingLoading && pendingUploads.length === 0" class="py-6 text-center text-gray-400">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-5 inline-block mr-2" />
        読み込み中...
      </div>

      <div v-else-if="pendingError" class="py-6 text-center text-red-500 text-sm">
        {{ pendingError }}
      </div>

      <div v-else-if="pendingUploads.length === 0" class="py-6 text-center text-gray-400 text-sm">
        保留中のアップロードはありません
      </div>

      <div v-else class="space-y-1.5">
        <div
          v-for="item in pendingUploads"
          :key="item.id"
          class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border"
          :class="{
            'border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/30': item.status === 'completed',
            'border-yellow-200 dark:border-yellow-800 bg-yellow-50/50 dark:bg-yellow-950/30': item.status === 'pending_retry',
            'border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/30': item.status === 'failed',
          }"
        >
          <UBadge :color="uploadStatusColor(item.status)" variant="subtle" size="sm">
            {{ uploadStatusLabel(item.status) }}
          </UBadge>
          <span class="font-medium truncate">{{ item.filename }}</span>
          <span class="text-xs text-gray-500 shrink-0">{{ formatDatetime(item.created_at) }}</span>
          <span
            v-if="item.error_message"
            class="text-xs text-red-700 dark:text-red-400 truncate"
            :title="item.error_message"
          >
            {{ item.error_message }}
          </span>
          <div class="flex-1" />
          <span
            v-if="rerunResult && rerunResult.id === item.id && rerunResult.success"
            class="text-xs text-green-600"
          >
            {{ rerunResult.message }}
          </span>
          <span
            v-if="rerunResult && rerunResult.id === item.id && !rerunResult.success"
            class="text-xs text-red-600"
          >
            {{ rerunResult.message }}
          </span>
          <UButton
            icon="i-lucide-download"
            variant="soft"
            color="neutral"
            size="xs"
            :to="getUploadDownloadUrl(item.id)"
            target="_blank"
          />
          <UButton
            v-if="item.status === 'pending_retry' || item.status === 'failed'"
            label="リラン"
            icon="i-lucide-refresh-cw"
            variant="soft"
            color="warning"
            size="xs"
            :loading="rerunningId === item.id"
            :disabled="rerunningId !== null"
            @click="handleUploadRerun(item)"
          />
        </div>
      </div>
    </UCard>
    </div>
  </div>
</template>
