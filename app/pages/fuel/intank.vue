<script setup lang="ts">
/**
 * インタンク燃料確認 (CakePHP の /fuel-intank の置き換え、Refs yhonda-ohishi/nginx#814)。
 * データは rust-fuel-worker の `/api/fuel/*` (alc-proxy 経由)。表の文字列と判定は
 * `app/utils/fuel-intank.ts` が組み、ここは並べるだけ。
 */
import {
  getFuelStarts, getFuelIntank, getFuelUnregisteredCards, getFuelCars, getFuelCards,
  createFuelCard, updateFuelIntankDtakoRow, deleteFuelIntank, uploadFuelCsv, downloadFuelUpload, recheckFuelIntank,
  currentAccessToken,
} from '~/utils/api'
import {
  startLabel, formatShortDatetime, formatQuantity, dtakoRowOptions, quantityDiff,
  isDiffHighlighted, isOverTolerance, linkCandidates, dailyReportEditQuery, dvrMapQuery, vehicleStateMarkerIndex, totalQuantity, uploadResultText, sha256FromKey, describeCsvError,
  createRowsCache,
} from '~/utils/fuel-intank'
import { carOptions } from '~/utils/fuel-cards'
import { ignoreKey } from '~/utils/fuel-intank-ignore'
import { canRecheck, describeManualError } from '~/utils/fuel-manual'
import { describeCaughtError, describeListFailure } from '~/utils/api-error'
import { ONPREM_DTAKO_COMP_ID } from '~/utils/dtako-comps'
import { b64urlUtf8 } from '~/composables/useTheearthSession'
import type { FuelStart, FuelIntankRow, FuelCar } from '~/types'
import type { DvrMapMarker } from '~/components/DvrMap.vue'

/** start を選ばないとき (最新 100 行) の選択肢の値。reka の Select は空文字の値を持てない */
const LATEST = '__latest__'
/**
 * 画面を開いたら先に読んでおく start の数と、同時に読む本数。start の突き合わせは 1 件 6〜9 秒かかるので
 * (2026-11-18 に本番で実測)、よく選ぶ新しい start は選ぶ前に読み終えておく
 */
const PREFETCH_STARTS = 5
const PREFETCH_CONCURRENCY = 2

/** 表 (最新 100 行と start ごと) を覚えておく。選び直しても読み直さない。書き込みと「再読み込み」で捨てる */
const rowsCache = createRowsCache(key => getFuelIntank(key === LATEST ? undefined : key))

const starts = ref<FuelStart[]>([])
const selected = ref<string>(LATEST)
const rows = ref<FuelIntankRow[]>([])
const loading = ref(false)
const listError = ref<string | null>(null)

const cars = ref<FuelCar[]>([])
/** fuel_card_id → 車番 (最新 100 行の表は応答に car を持たないので card の一覧から引く) */
const carNameByCard = ref<Record<number, string>>({})
const unregistered = ref<number[]>([])
/**
 * 車両を選んでいる未登録カード (1 行ずつ) とその車両。★ 選択欄を全行に置かない — Reka UI の Select は
 * 閉じていても全選択肢を文書の外に描画して持つので、行数 × 車両数 ぶん重くなる (551 件 × 20 行で
 * 11.6 秒・ヒープ 565MB をスタブで実測。`/fuel/cards` が固まったのと同じ原因、Refs yhonda-ohishi/nginx#814)
 */
const choosingId = ref<number | null>(null)
const carChoice = ref<string | undefined>(undefined)
const registering = ref<number | null>(null)
const registerError = ref<string | null>(null)

const isDragging = ref(false)
const uploading = ref(false)
const uploadMessage = ref<string | null>(null)
const uploadError = ref<string | null>(null)
const uploadedSha = ref<string | null>(null)
const downloadError = ref<string | null>(null)

const editingKey = ref<string | null>(null)
const editValue = ref('')
const saving = ref(false)
const rowError = ref<string | null>(null)
const deleteTarget = ref<FuelIntankRow | null>(null)
const deleting = ref(false)
/** 再照合中の行 (rowKey)。押した行のボタンだけ回す */
const rechecking = ref<string | null>(null)
const recheckMessage = ref<string | null>(null)

const isMatching = computed(() => selected.value !== LATEST)
const selectedStart = computed(() => starts.value.find(s => s.datetime === selected.value) ?? null)
const startItems = computed(() => [
  { label: '(最新 100 行)', value: LATEST },
  ...starts.value.map(s => ({ label: startLabel(s), value: s.datetime })),
])
/**
 * 「最新 start」「一個前」「一個後」のボタン。`starts` は新しい順。「一個前」は選んでいる start の 1 つ古い start
 * (最新 100 行を見ているときは最新 start を起点にする = 2 番目に新しい start)。一番古い start では押せない。
 * 「一個後」は 1 つ新しい start。最新 start と最新 100 行を見ているときは押せない
 */
const latestStart = computed(() => starts.value[0]?.datetime ?? null)
const previousStart = computed(() => {
  const i = isMatching.value ? starts.value.findIndex(s => s.datetime === selected.value) : 0
  return i >= 0 ? starts.value[i + 1]?.datetime ?? null : null
})
const nextStart = computed(() => {
  const i = isMatching.value ? starts.value.findIndex(s => s.datetime === selected.value) : -1
  return i > 0 ? starts.value[i - 1]?.datetime ?? null : null
})
function selectStart(datetime: string | null) {
  if (datetime) selected.value = datetime // watch が表を読み直す
}
const carItems = computed(() => carOptions(cars.value))
const total = computed(() => totalQuantity(rows.value))

function rowKey(r: FuelIntankRow): string {
  return `${r.datetime};${r.fuel_card_id}`
}

function carName(r: FuelIntankRow): string {
  return r.car?.name ?? carNameByCard.value[r.fuel_card_id] ?? ''
}

/** 選んでいる表を出す。`force` でなければ覚えた表を使う。読み終える前に選び直されたら、古い結果は捨てる */
async function loadRows(force = false) {
  const key = selected.value
  loading.value = true
  listError.value = null
  try {
    const res = await rowsCache.get(key, force)
    if (selected.value !== key) return
    rows.value = res.rows
  }
  catch (e) {
    if (selected.value !== key) return
    rows.value = []
    listError.value = describeListFailure(e, 'start を選び直すか「再読み込み」を押してください')
  }
  finally {
    if (selected.value === key) loading.value = false
  }
}

async function loadStarts() {
  starts.value = (await getFuelStarts()).rows
  // 裏で読むだけ (失敗は覚えず、選んだときに読み直す)
  void rowsCache.prefetch(starts.value.slice(0, PREFETCH_STARTS).map(s => s.datetime), PREFETCH_CONCURRENCY)
}

async function loadCardsAndCars() {
  const [carsRes, cardsRes, unregRes] = await Promise.all([getFuelCars(), getFuelCards(), getFuelUnregisteredCards()])
  cars.value = carsRes.cars
  carNameByCard.value = Object.fromEntries(cardsRes.cards.filter(c => c.car?.name).map(c => [c.id, c.car!.name!]))
  unregistered.value = unregRes.fuel_card_ids
}

const masterError = ref<string | null>(null)
async function loadMasters() {
  masterError.value = null
  try {
    await Promise.all([loadStarts(), loadCardsAndCars()])
  }
  catch (e) {
    masterError.value = describeListFailure(e, '再読み込みしてください')
  }
}

watch(selected, () => {
  editingKey.value = null
  loadRows()
})

/** 書き込みの後: 覚えた表は古いので捨て、いま出している表を読み直す */
async function reloadRowsAfterWrite() {
  rowsCache.clear()
  await loadRows(true)
}

/**
 * 「再読み込み」: 選んでいる start のまま、表と start・車両・カードの一覧を読み直す
 * (USB アップローダーが取り込んだ新しい start・未登録カードもここで出る)
 */
const refreshing = ref(false)
async function refresh() {
  refreshing.value = true
  rowsCache.clear()
  try {
    await Promise.all([loadMasters(), loadRows(true)])
  }
  finally {
    refreshing.value = false
  }
}

// --- アップロード (upload.vue のドラッグ&ドロップの形) ---

function onDragOver(e: DragEvent) {
  e.preventDefault()
  isDragging.value = true
}
function onDragLeave() {
  isDragging.value = false
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  const file = e.dataTransfer?.files[0]
  if (file) handleUpload(file)
}
function onFileSelect(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) handleUpload(file)
  input.value = ''
}

async function handleUpload(file: File) {
  uploadMessage.value = null
  uploadError.value = null
  uploadedSha.value = null
  downloadError.value = null
  if (!/\.csv$/i.test(file.name)) {
    uploadError.value = 'CSV ファイル (UTRAN.CSV) を選択してください'
    return
  }
  uploading.value = true
  try {
    const res = await uploadFuelCsv(await file.arrayBuffer())
    uploadMessage.value = uploadResultText(res)
    uploadedSha.value = sha256FromKey(res.key)
    rowsCache.clear()
    await loadMasters()
    if (res.latest_start && selected.value !== res.latest_start.datetime) {
      selected.value = res.latest_start.datetime // watch が表を読み直す
    }
    else {
      await loadRows(true)
    }
  }
  catch (e) {
    uploadError.value = (e instanceof Error ? describeCsvError(e.message) : null)
      ?? describeCaughtError(e, 'もう一度アップロードしてください')
  }
  finally {
    uploading.value = false
  }
}

async function downloadUploaded() {
  if (!uploadedSha.value) return
  downloadError.value = null
  try {
    await downloadFuelUpload(uploadedSha.value, '取り込み直後 (1 日以内) にもう一度押してください')
  }
  catch (e) {
    downloadError.value = e instanceof Error ? e.message : String(e)
  }
}

// --- 社内 dtako の取り込み口に残っている CSV を取り込む (旧 CakePHP の /dtako-events/autoload を zip 無しで) ---

const AUTOLOAD_CONFIRM = '社内 dtako の取り込み口に残っている CSV を取り込みます (旧画面の dtako-events/autoload と同じ)。よろしいですか？'
const AUTOLOAD_UNCERTAIN = '送れたか分かりません。取り込まれていることがあるので、表 (D数量) を確かめてから必要ならもう一度押してください'
const autoloading = ref(false)
const autoloadMessage = ref<string | null>(null)
const autoloadError = ref<string | null>(null)

/**
 * relay の `POST /restraint-api/kintai/autoload-pending` → 勤怠 Worker → 社内 CakePHP。社内側に届くのは
 * 勤怠 Worker だけなので、ブラウザから社内のホストは叩かない。この画面は theearth ログインを持たないので
 * 閲覧者のヘッダ (ログインの JWT + 会社) で呼ぶ。会社は社内 dtako の会社に固定 (他の会社は relay が 403)。
 * 応答の status は取り込みの成否の証明にならない (307 でも取り込みは走る) ので、成功とは書かない。
 */
async function runAutoload() {
  if (autoloading.value || !window.confirm(AUTOLOAD_CONFIRM)) return
  autoloadMessage.value = null
  autoloadError.value = null
  const token = currentAccessToken()
  if (!token) {
    autoloadError.value = 'ログインの情報がありません。ページを読み込み直してからもう一度押してください'
    return
  }
  autoloading.value = true
  try {
    const res = await $fetch<{ status?: unknown }>('/restraint-api/kintai/autoload-pending', {
      method: 'POST',
      headers: {
        'X-Theearth-Comp-Id': ONPREM_DTAKO_COMP_ID,
        'X-Theearth-User-B64': b64urlUtf8('viewer'),
        'Authorization': `Bearer ${token}`,
      },
    })
    autoloadMessage.value = `取り込み口を実行しました (社内の応答 ${String(res?.status ?? '不明')})。取り込めたかは表の D数量で確かめてください`
    await reloadRowsAfterWrite()
  }
  catch (e) {
    const uncertain = (e as { data?: { uncertain?: unknown } } | null)?.data?.uncertain === true
    autoloadError.value = uncertain ? AUTOLOAD_UNCERTAIN : describeCaughtError(e, 'もう一度押してください')
  }
  finally {
    autoloading.value = false
  }
}

// --- 未登録カードの登録 ---

function startChoose(id: number) {
  choosingId.value = id
  carChoice.value = undefined
  registerError.value = null
}

async function registerCard(id: number) {
  const carId = carChoice.value
  if (!carId) return
  registering.value = id
  registerError.value = null
  try {
    await createFuelCard(id, carId)
    choosingId.value = null
    await loadCardsAndCars()
    await reloadRowsAfterWrite()
  }
  catch (e) {
    registerError.value = `card ${id}: ${describeCaughtError(e, 'もう一度「登録」を押してください')}`
  }
  finally {
    registering.value = null
  }
}

// --- dtako_row_id の付け替え・削除 ---

function startEdit(r: FuelIntankRow) {
  editingKey.value = rowKey(r)
  editValue.value = r.dtako_row_id ?? ''
  rowError.value = null
}

async function saveEdit(r: FuelIntankRow) {
  saving.value = true
  rowError.value = null
  try {
    await updateFuelIntankDtakoRow(r.datetime, r.fuel_card_id, editValue.value === '' ? null : editValue.value)
    editingKey.value = null
    await reloadRowsAfterWrite()
  }
  catch (e) {
    rowError.value = describeCaughtError(e, 'もう一度「保存」を押してください')
  }
  finally {
    saving.value = false
  }
}

async function confirmDelete() {
  const r = deleteTarget.value
  if (!r) return
  deleting.value = true
  rowError.value = null
  try {
    await deleteFuelIntank(r.datetime, r.fuel_card_id)
    deleteTarget.value = null
    await reloadRowsAfterWrite()
  }
  catch (e) {
    deleteTarget.value = null
    rowError.value = describeCaughtError(e, 'もう一度「削除」を押してください')
  }
  finally {
    deleting.value = false
  }
}

// --- 再照合 (dtako_row_id が空の行を照合し直し、manual を外す。CakePHP の recheck) ---

async function recheck(r: FuelIntankRow) {
  rechecking.value = rowKey(r)
  rowError.value = null
  recheckMessage.value = null
  try {
    const res = await recheckFuelIntank(r.datetime, r.fuel_card_id)
    const what = `${formatShortDatetime(r.datetime)} / card ${r.fuel_card_id}`
    const result = res.row.dtako_row_id ? `運行 ${res.row.dtako_row_id} に紐づけました` : '照合できる運行がありませんでした'
    // 上流の recheck は manual を外すので、手入力の行は以後 削除も手入力での上書きもできなくなる (409 not_manual)
    const unmarked = r.manual && !res.row.manual ? ' — 手入力の印を外したので、この行は削除も手入力での上書きもできなくなりました' : ''
    recheckMessage.value = `${what}: ${result}${unmarked}`
    await reloadRowsAfterWrite()
  }
  catch (e) {
    rowError.value = (e instanceof Error ? describeManualError(e.message) : null)
      ?? describeCaughtError(e, 'もう一度「再照合」を押してください')
  }
  finally {
    rechecking.value = null
  }
}

// --- 直近 30 start の誤差一覧 (差異の絶対値が 0.05 を超える行と集計なし。0.05 までは無視) ---

const DIFF_LIST_STARTS = 30
const DIFF_TOLERANCE = 0.05
/** 誤差一覧に載せないカード (ユーザーの依頼で 99 番と 100 番を除く) */
const DIFF_LIST_EXCLUDED_CARDS: ReadonlySet<number> = new Set([99, 100])
/** 一覧を作るときの同時読み込み数 (2 本だと 30 start で約 2 分かかるので 6 本にして 1 分弱に) */
const DIFF_LIST_CONCURRENCY = 6
interface DiffListEntry { start: FuelStart, row: FuelIntankRow }
const diffList = ref<DiffListEntry[] | null>(null)
const diffListLoading = ref(false)
/** 読み終えた start の数 (失敗も数える) と、読めなかった start の表示 */
const diffListDone = ref(0)
const diffListTargets = ref(0)
const diffListFailed = ref<string[]>([])
/** 車番で絞る (空文字 = すべて)。選択肢は一覧に出ている車番だけ。車番の無い行は「(車番なし)」 */
const NO_CAR = '(車番なし)'
const diffCarFilter = ref('')
const diffCarOptions = computed(() => [...new Set((diffList.value ?? []).map(e => carName(e.row) || NO_CAR))].sort())
/**
 * 「無視」にした給油行 (D1 `fuel_intank_ignores` を全員で共有。鍵は `ignoreKey`)。一覧からは消し、
 * 「無視した行も表示」のときだけ薄く出して戻せるようにする
 */
const ignoredKeys = ref<Set<string>>(new Set())
const showIgnored = ref(false)
const ignoreError = ref<string | null>(null)
const ignoringKey = ref<string | null>(null)
function isIgnored(r: FuelIntankRow): boolean {
  return ignoredKeys.value.has(ignoreKey(r))
}
const ignoredCount = computed(() => (diffList.value ?? []).filter(e => isIgnored(e.row)).length)
const shownDiffList = computed(() => (diffList.value ?? []).filter(e =>
  (!diffCarFilter.value || (carName(e.row) || NO_CAR) === diffCarFilter.value)
  && (showIgnored.value || !isIgnored(e.row))))

async function loadIgnores() {
  try {
    const res = await $fetch<{ ignores: { datetime: string, fuel_card_id: number }[] }>('/api/fuel/intank-ignores')
    ignoredKeys.value = new Set(res.ignores.map(ignoreKey))
  }
  catch (err) {
    ignoreError.value = `無視の一覧を読めませんでした (無視した行も出ています): ${describeCaughtError(err, '「作り直す」を押してください')}`
  }
}

/** 1 行だけ無視にする / 戻す。画面は先に変え、失敗したら元に戻す */
async function setIgnored(r: FuelIntankRow, ignored: boolean) {
  const key = ignoreKey(r)
  ignoringKey.value = key
  ignoreError.value = null
  const next = new Set(ignoredKeys.value)
  if (ignored) next.add(key)
  else next.delete(key)
  const before = ignoredKeys.value
  ignoredKeys.value = next
  try {
    await $fetch('/api/fuel/intank-ignores', { method: 'PUT', body: { datetime: r.datetime, fuel_card_id: r.fuel_card_id, ignored } })
  }
  catch (err) {
    ignoredKeys.value = before
    ignoreError.value = `${formatShortDatetime(r.datetime)} / card ${r.fuel_card_id}: ${describeCaughtError(err, 'もう一度押してください')}`
  }
  finally {
    ignoringKey.value = null
  }
}

/**
 * 新しい順に 30 start を読み (1 件 6〜9 秒かかるので DIFF_LIST_CONCURRENCY 本ずつ)、誤差のある行を集める。
 * 表は rowsCache に覚えるので、一覧から start を開くときは読み直さない。並びは start の新しい順・start 内は応答の順。
 * 読み終えた start から順に表へ足す (全部を待たない)
 */
/** 一覧の対象 start と、start ごとの誤差行 (紐づけた後に 1 start だけ差し替えるため関数の外に持つ) */
let diffTargets: FuelStart[] = []
const diffFound = new Map<string, FuelIntankRow[]>()
/**
 * start の突き合わせ (上流の BY_START_SQL) は伝票番号 (slip_num_parent) だけで集めるので、番号が一周すると
 * 去年の同じ番号の行も入ってくる。一覧には start の日時より前の行を載せない (日時は `YYYY-MM-DD HH:MM:SS` で文字列比較できる)
 */
function setDiffRows(start: FuelStart, rows: FuelIntankRow[]) {
  diffFound.set(start.datetime, rows.filter(r => r.datetime >= start.datetime
    && !DIFF_LIST_EXCLUDED_CARDS.has(r.fuel_card_id) && isOverTolerance(r, DIFF_TOLERANCE)))
  diffList.value = diffTargets.flatMap(t => (diffFound.get(t.datetime) ?? []).map(row => ({ start: t, row })))
}

/**
 * 紐づけ候補の選択 (行ごと。既定は先頭の候補)・行ごとの状態・失敗。押した行だけ止め、他の行は続けて押せる
 * (`saving` = 書き込み中、`linked` = 書けた・その start の読み直し待ち)
 */
const linkChoice = ref<Record<string, string>>({})
const linkState = ref<Record<string, 'saving' | 'linked'>>({})
const linkErrors = ref<string[]>([])
function diffEntryKey(e: DiffListEntry): string {
  return `${e.start.datetime}|${rowKey(e.row)}`
}
function chosenLink(e: DiffListEntry): string {
  return linkChoice.value[diffEntryKey(e)] ?? linkCandidates(e.row)[0]?.value ?? ''
}

/**
 * 一覧の行を選んだ候補の運行に紐づける (上の表の「編集」→「保存」と同じ PATCH)。
 * 終わったらその start だけ読み直して一覧を差し替える (誤差が消えれば行も消える)。上の表がその start なら読み直す
 */
async function linkFromDiffList(e: DiffListEntry) {
  const target = chosenLink(e)
  const key = diffEntryKey(e)
  if (!target || linkState.value[key]) return
  linkState.value[key] = 'saving'
  try {
    await updateFuelIntankDtakoRow(e.row.datetime, e.row.fuel_card_id, target)
    linkState.value[key] = 'linked'
    reloadStartAfterLink(e.start)
  }
  catch (err) {
    delete linkState.value[key]
    linkErrors.value.push(`${formatShortDatetime(e.row.datetime)} / card ${e.row.fuel_card_id}: ${describeCaughtError(err, 'もう一度「紐づけ」を押してください')}`)
  }
}

/**
 * 紐づけの後の読み直し (1 start 6〜9 秒) は待たずに裏で回す。同じ start の読み直し中にまた紐づけたら、
 * 終わってからもう 1 回だけ読む (何度押しても読み直しは重ならない)。読み終えたらその start の行の状態を消す
 */
const reloadingStarts = new Set<string>()
const reloadAgain = new Set<string>()
function reloadStartAfterLink(start: FuelStart) {
  const k = start.datetime
  if (reloadingStarts.has(k)) {
    reloadAgain.add(k)
    return
  }
  reloadingStarts.add(k)
  void (async () => {
    try {
      do {
        reloadAgain.delete(k)
        setDiffRows(start, (await rowsCache.get(k, true)).rows)
      } while (reloadAgain.has(k))
      for (const key of Object.keys(linkState.value)) {
        if (key.startsWith(`${k}|`) && linkState.value[key] === 'linked') delete linkState.value[key]
      }
      if (selected.value === k) await loadRows(true)
    }
    catch (err) {
      linkErrors.value.push(`${startLabel(start)} を読み直せませんでした: ${describeCaughtError(err, '「作り直す」を押してください')}`)
    }
    finally {
      reloadingStarts.delete(k)
    }
  })()
}

async function buildDiffList() {
  // 「作り直す」(2 回目以降) は覚えた表を使わず読み直す (再取り込み・紐づけなど裏で変わった分を拾う)
  const force = diffList.value !== null
  const targets = starts.value.slice(0, DIFF_LIST_STARTS)
  diffListLoading.value = true
  diffListDone.value = 0
  diffListTargets.value = targets.length
  diffListFailed.value = []
  diffList.value = []
  diffTargets = targets
  ignoreError.value = null
  void loadIgnores()
  diffFound.clear()
  const queue = [...targets]
  const worker = async () => {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      try {
        setDiffRows(s, (await rowsCache.get(s.datetime, force)).rows)
      }
      catch {
        diffListFailed.value.push(startLabel(s))
      }
      finally {
        diffListDone.value++
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: DIFF_LIST_CONCURRENCY }, worker))
  }
  finally {
    diffListLoading.value = false
  }
}

function printPage() {
  window.print()
}

// --- 車両の現在地 (theearth の車輌現在地、/dvr-map の現在地タブと同じ /dvr-api/vehicle-states) ---

/** 車輌現在地 1 台のうちモーダルで使う列 (型の正本は dvr-map.vue の VehicleStatePoint)。 */
interface LocationVehicleState {
  vehicleCd: string | null
  driverName: string | null
  latitude: number | null
  longitude: number | null
  dataDatetime: string | null
  speed: number | null
  address: string | null
}

const { session: dvrSession, authHeaders: dvrAuthHeaders, restoreSession: restoreDvrSession, expireSession: expireDvrSession } = useDvrSession()
const locationTarget = ref<FuelIntankRow | null>(null)
const locationLoading = ref(false)
const locationError = ref<string | null>(null)
const locationPoint = ref<LocationVehicleState | null>(null)
const locationMarkers = computed<DvrMapMarker[]>(() => {
  const p = locationPoint.value
  return p ? [{ lat: p.latitude!, lng: p.longitude!, lines: [p.dataDatetime ?? '', p.address ?? ''].filter(Boolean) }] : []
})

function openLocation(r: FuelIntankRow) {
  locationTarget.value = r
  void loadLocation()
}

/** 全事業所の車輌現在地を読み、その行の車両を選ぶ。theearth のログインは /dvr-map と共有 (localStorage)。 */
async function loadLocation() {
  const r = locationTarget.value
  const q = r ? dvrMapQuery(r) : null
  if (!q) return
  locationError.value = null
  locationPoint.value = null
  // 未ログインならモーダルにログインフォームを出す (ログインできたら @login でここに戻る)
  restoreDvrSession()
  if (!dvrSession.value) return
  locationLoading.value = true
  try {
    const res = await $fetch<{ vehicles: LocationVehicleState[] }>('/dvr-api/vehicle-states', {
      headers: dvrAuthHeaders(),
      query: { branch: '00000000' },
    })
    if (locationTarget.value !== r) return
    const withGps = res.vehicles.filter(v => v.latitude != null && v.longitude != null)
    const idx = vehicleStateMarkerIndex(withGps, q.vehicle)
    if (idx == null) locationError.value = `車両 ${q.vehicle} の現在地 (GPS) が見つかりません`
    else locationPoint.value = withGps[idx]!
  }
  catch (e) {
    if (locationTarget.value !== r) return
    if (dvrErrorStatus(e) === 401) {
      expireDvrSession(dvrErrorMessage(e))
      return
    }
    locationError.value = dvrErrorMessage(e)
  }
  finally {
    locationLoading.value = false
  }
}

/**
 * 開いたときは最新 start を出す。start の一覧を読んでから選ぶ (選べば watch が表を読む)。start が無い・読めない
 * ときは最新 100 行。読み終える前に利用者が選び直していたら、その選択を上書きしない
 */
onMounted(async () => {
  await loadMasters()
  // 誤差一覧は開いたら自動で作る (ユーザーの依頼)。上の表の読み込みと並べて走らせる (rowsCache が同じ start の読み込みをまとめる)
  if (starts.value.length > 0) void buildDiffList()
  if (selected.value !== LATEST) return
  const latest = starts.value[0]?.datetime
  if (latest) selected.value = latest
  else await loadRows()
})
</script>

<template>
  <div class="fuel-intank space-y-4">
    <div class="flex flex-wrap items-center gap-3 fuel-no-print">
      <h2 class="text-xl font-bold mr-auto">インタンク燃料確認</h2>
      <!-- ★ USelect にしない — 閉じていても start (約 1000 件) の選択肢を全部描画し、開くのに 2.9 秒かかった
           (2026-11-18 に本番で実測)。USelectMenu の virtualize で見えている分だけ描く -->
      <USelectMenu
        v-model="selected" :items="startItems" value-key="value" virtualize
        :search-input="{ placeholder: 'D番号・日付 (yyMMdd) で検索' }" class="w-64"
      />
      <UButton
        icon="i-lucide-arrow-up-to-line" variant="outline" label="最新 start"
        :disabled="!latestStart || selected === latestStart" @click="selectStart(latestStart)"
      />
      <UButton
        icon="i-lucide-chevron-down" variant="outline" label="一個前"
        :disabled="!previousStart" @click="selectStart(previousStart)"
      />
      <UButton
        icon="i-lucide-chevron-up" variant="outline" label="一個後"
        :disabled="!nextStart" @click="selectStart(nextStart)"
      />
      <UButton icon="i-lucide-refresh-cw" variant="outline" label="再読み込み" :loading="refreshing" :disabled="refreshing" @click="refresh" />
      <UButton icon="i-lucide-database-zap" variant="outline" label="dtako 取り込み (autoload)" :loading="autoloading" :disabled="autoloading" @click="runAutoload" />
      <UButton to="/fuel/manual" icon="i-lucide-pencil" variant="outline" label="手入力" />
      <UButton to="/fuel/cards" icon="i-lucide-credit-card" variant="outline" label="カード" />
      <UButton to="/fuel/credentials" icon="i-lucide-key-round" variant="outline" label="アップローダーの資格情報" />
      <UButton icon="i-lucide-printer" variant="outline" label="印刷" @click="printPage" />
    </div>

    <!-- CSV アップロード -->
    <div
      class="fuel-no-print border-2 border-dashed rounded-xl p-4 text-center transition-colors cursor-pointer"
      :class="isDragging
        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
        : 'border-gray-300 dark:border-gray-700 hover:border-gray-400'"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @click="($refs.fileInput as HTMLInputElement).click()"
    >
      <p class="text-sm text-gray-600 dark:text-gray-400">
        <UIcon name="i-lucide-upload-cloud" class="size-5 align-middle mr-1" />
        UTRAN.CSV をドラッグ＆ドロップ、またはクリックして選択
      </p>
      <input ref="fileInput" type="file" accept=".csv,.CSV" class="hidden" @change="onFileSelect">
    </div>
    <div v-if="uploading" class="flex items-center gap-2 text-sm fuel-no-print">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />アップロード中...
    </div>
    <UAlert v-if="uploadMessage" class="fuel-no-print" color="success" variant="subtle" icon="i-lucide-check-circle" :title="uploadMessage">
      <template v-if="uploadedSha" #description>
        <UButton size="xs" variant="link" icon="i-lucide-download" label="取り込んだ CSV をダウンロード (1 日以内)" class="px-0" @click="downloadUploaded" />
        <span v-if="downloadError" class="block text-red-600">{{ downloadError }}</span>
      </template>
    </UAlert>
    <UAlert v-if="uploadError" class="fuel-no-print" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="アップロードに失敗しました" :description="uploadError" />
    <UAlert v-if="autoloadMessage" class="fuel-no-print" color="info" variant="subtle" icon="i-lucide-info" :title="autoloadMessage" />
    <UAlert v-if="autoloadError" class="fuel-no-print" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="dtako の取り込み口を実行できませんでした" :description="autoloadError" />
    <UAlert v-if="masterError" class="fuel-no-print" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="start・車両・カードの一覧を読めませんでした" :description="masterError" />

    <!-- 未登録カード -->
    <!-- 普段は閉じておく (ユーザーの依頼)。開くと今までどおり車両を選んで登録できる -->
    <details v-if="unregistered.length > 0" class="fuel-no-print">
      <summary class="font-medium mb-1 cursor-pointer">未登録のカード ({{ unregistered.length }} 件)</summary>
      <table class="fuel-table">
        <thead>
          <tr><th>card_id</th><th>車両</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="id in unregistered" :key="id">
            <td class="text-right">{{ id }}</td>
            <template v-if="choosingId === id">
              <td>
                <USelectMenu v-model="carChoice" :items="carItems" value-key="value" :search-input="{ placeholder: '車番・id で検索' }" placeholder="車両を選択" class="w-64" size="sm" />
              </td>
              <td class="whitespace-nowrap">
                <UButton size="sm" label="登録" :disabled="!carChoice" :loading="registering === id" @click="registerCard(id)" />
                <UButton size="sm" variant="outline" label="取消" class="ml-1" @click="choosingId = null" />
              </td>
            </template>
            <template v-else>
              <td class="text-gray-500">(未登録)</td>
              <td><UButton size="sm" variant="outline" label="車両を選ぶ" @click="startChoose(id)" /></td>
            </template>
          </tr>
        </tbody>
      </table>
      <p v-if="registerError" class="text-sm text-red-600 mt-1">{{ registerError }}</p>
    </details>

    <!-- 直近 30 start の誤差一覧 -->
    <div class="fuel-no-print">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="font-medium">直近 {{ DIFF_LIST_STARTS }} start の誤差一覧</h3>
        <UButton
          size="sm" variant="outline" icon="i-lucide-list-checks"
          :label="diffList ? '作り直す' : '一覧を作る'"
          :loading="diffListLoading" :disabled="diffListLoading || starts.length === 0" @click="buildDiffList"
        />
        <span v-if="diffList" class="text-sm text-gray-600 dark:text-gray-400">
          <template v-if="diffListLoading">{{ diffListDone }} / {{ diffListTargets }} start を読みました (読めた分から出します) — </template>
          差異 ±{{ DIFF_TOLERANCE }} を超える行と集計なし (card {{ [...DIFF_LIST_EXCLUDED_CARDS].join('・') }} を除く): {{ diffList.length - ignoredCount }} 行<template v-if="diffCarFilter"> (うち表示 {{ shownDiffList.length }} 行)</template>
        </span>
        <label v-if="ignoredCount > 0" class="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1">
          <input v-model="showIgnored" type="checkbox">無視した {{ ignoredCount }} 行も表示
        </label>
        <!-- ★ USelect にしない (閉じていても全選択肢を描画して重い。上の start 選択と同じ理由)。素の select で足りる -->
        <select v-if="diffList && diffList.length > 0" v-model="diffCarFilter" class="border rounded px-1 py-0.5 text-sm bg-white dark:bg-gray-900">
          <option value="">車番: すべて</option>
          <option v-for="c in diffCarOptions" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <UAlert
        v-if="!diffListLoading && diffListFailed.length > 0" color="error" variant="subtle" icon="i-lucide-alert-triangle" class="my-2"
        :title="`${diffListFailed.length} 件の start を読めませんでした (一覧に入っていません)`"
        :description="`${diffListFailed.join(' / ')} — 「作り直す」を押してください`"
      />
      <UAlert v-if="ignoreError" color="error" variant="subtle" icon="i-lucide-alert-triangle" class="my-2" :description="ignoreError" />
      <UAlert
        v-if="linkErrors.length > 0" color="error" variant="subtle" icon="i-lucide-alert-triangle" class="my-2"
        :description="linkErrors.join(' / ')"
        :close="true" @update:open="linkErrors = []"
      />
      <div v-if="shownDiffList.length > 0" class="overflow-x-auto mt-1">
        <table class="fuel-table">
          <thead>
            <tr><th>start</th><th>D番号</th><th>card_id</th><th>車番</th><th>日時</th><th>数量</th><th>D数量</th><th>差異</th><th>乗務員</th><th title="同じ車両の運行のうち給油の後に帰庫したもの (運転手は見ない)。0 件なら dtako のデータがまだ届いていない">給油後の運行終了</th><th>紐づけ候補</th><th /></tr>
          </thead>
          <tbody>
            <tr v-for="e in shownDiffList" :key="diffEntryKey(e)" :class="{ 'opacity-50': isIgnored(e.row) }">
              <td>{{ startLabel(e.start) }}</td>
              <td class="text-right">{{ e.row.slip_num }}</td>
              <td class="text-right">{{ e.row.fuel_card_id }}</td>
              <td>
                <!-- 押すとその車番で絞る。絞っているときに押すと解除 -->
                <button
                  type="button" class="text-primary underline-offset-2 hover:underline"
                  :title="diffCarFilter ? '絞り込みを解除' : 'この車番で絞る'"
                  @click="diffCarFilter = diffCarFilter ? '' : (carName(e.row) || NO_CAR)"
                >
                  {{ carName(e.row) || NO_CAR }}
                </button>
              </td>
              <td>{{ formatShortDatetime(e.row.datetime) }}</td>
              <td class="text-right">{{ e.row.qt == null ? '' : formatQuantity(e.row.qt) }}</td>
              <td class="text-right">{{ e.row.dtako_fuel_sum == null ? '' : formatQuantity(e.row.dtako_fuel_sum) }}</td>
              <td class="text-right">{{ quantityDiff(e.row) == null ? '集計なし' : formatQuantity(quantityDiff(e.row)!) }}</td>
              <td>{{ e.row.dtako_row?.driver_name ?? '' }}</td>
              <td class="text-right">
                <template v-if="e.row.dtako_rows_after == null" />
                <span v-else-if="e.row.dtako_rows_after === 0" class="text-gray-500">0 件 (未着)</span>
                <span v-else>{{ e.row.dtako_rows_after }} 件</span>
              </td>
              <td>
                <div v-if="linkCandidates(e.row).length > 0" class="flex items-center gap-1">
                  <select
                    :value="chosenLink(e)" class="border rounded px-1 py-0.5 text-sm bg-white dark:bg-gray-900 max-w-[28rem]"
                    @change="linkChoice[diffEntryKey(e)] = ($event.target as HTMLSelectElement).value"
                  >
                    <option v-for="o in linkCandidates(e.row)" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                  <UButton
                    size="xs" :label="linkState[diffEntryKey(e)] === 'linked' ? '紐づけ済み (読み直し中)' : '紐づけ'"
                    :loading="linkState[diffEntryKey(e)] === 'saving'" :disabled="!!linkState[diffEntryKey(e)]"
                    @click="linkFromDiffList(e)"
                  />
                </div>
                <span v-else class="text-gray-500">候補なし</span>
              </td>
              <td class="whitespace-nowrap">
                <UButton
                  size="xs" :color="isIgnored(e.row) ? 'neutral' : 'warning'" variant="outline" class="mr-1"
                  :label="isIgnored(e.row) ? '無視を戻す' : '無視'" :loading="ignoringKey === ignoreKey(e.row)"
                  @click="setIgnored(e.row, !isIgnored(e.row))"
                />
                <UButton size="xs" variant="outline" label="この start を開く" :disabled="selected === e.start.datetime" @click="selectStart(e.start.datetime)" />
                <UButton
                  size="xs" variant="outline" label="日報を直す" class="ml-1" icon="i-lucide-external-link" target="_blank"
                  :to="{ path: '/daily-report-edit', query: dailyReportEditQuery(e.row) }"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 給油の表 -->
    <div>
      <template v-if="selectedStart">
        <h3 class="text-lg font-bold">スタートデータNO {{ selectedStart.slip_num }}</h3>
        <p class="text-sm text-gray-600 dark:text-gray-400">計算は、対象運行NOの、給油日当日に入力されたデータのみ集計する。</p>
      </template>
      <p v-else class="text-sm text-gray-600 dark:text-gray-400 fuel-no-print">最新 100 行を新しい順に出しています。start を選ぶと dtako との突き合わせを出します。</p>
      <UAlert v-if="listError" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="給油の一覧を読めませんでした" :description="listError" class="my-2" />
      <UAlert v-if="rowError" color="error" variant="subtle" icon="i-lucide-alert-triangle" :description="rowError" class="my-2 fuel-no-print" />
      <UAlert v-if="recheckMessage" color="success" variant="subtle" icon="i-lucide-check-circle" :description="recheckMessage" class="my-2 fuel-no-print" />
      <div v-if="loading" class="flex items-center gap-2 text-sm my-2">
        <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />読み込み中...
      </div>
      <div v-else class="overflow-x-auto">
        <table class="fuel-table">
          <thead>
            <tr>
              <th>D番号</th><th>card_id</th><th>車番</th><th>日時</th><th>数量</th>
              <template v-if="isMatching">
                <th>D数量</th><th>差異</th><th>乗務員</th><th>dtako_row_id</th><th>車番</th><th>出庫日時</th><th>帰庫日時</th>
              </template>
              <th class="fuel-no-print" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="rowKey(r)" :class="{ 'fuel-diff-row [&>td]:bg-amber-200 dark:[&>td]:bg-amber-900 dark:[&>td]:text-amber-50': isMatching && isDiffHighlighted(r) }">
              <td class="text-right">{{ r.slip_num }}</td>
              <td class="text-right">{{ r.fuel_card_id }}</td>
              <td>{{ carName(r) }}</td>
              <td>{{ formatShortDatetime(r.datetime) }}</td>
              <td class="text-right">{{ r.qt == null ? '' : formatQuantity(r.qt) }}</td>
              <template v-if="isMatching">
                <td class="text-right">{{ r.dtako_fuel_sum == null ? '' : formatQuantity(r.dtako_fuel_sum) }}</td>
                <td class="text-right">
                  {{ quantityDiff(r) == null ? '集計なし' : formatQuantity(quantityDiff(r)!) }}
                </td>
                <td>{{ r.dtako_row?.driver_name ?? '' }}</td>
                <td>
                  <div v-if="editingKey === rowKey(r)" class="flex items-center gap-1 fuel-no-print">
                    <select v-model="editValue" class="border rounded px-1 py-0.5 text-sm bg-white dark:bg-gray-900">
                      <option value="">(紐づけを外す)</option>
                      <option v-for="(o, i) in dtakoRowOptions(r.dtako_fuel_array, r.dtako_row_id, r.dtako_row_times)" :key="i" :value="o.value">{{ o.label }}</option>
                    </select>
                    <UButton size="xs" label="保存" :loading="saving" @click="saveEdit(r)" />
                    <UButton size="xs" variant="outline" label="取消" @click="editingKey = null" />
                  </div>
                  <span v-else>{{ r.dtako_row_id ?? '' }}</span>
                </td>
                <td>{{ r.dtako_row?.car_name ?? '' }}</td>
                <td>{{ formatShortDatetime(r.dtako_row?.departed_at) }}</td>
                <td>{{ formatShortDatetime(r.dtako_row?.returned_at) }}</td>
              </template>
              <td class="fuel-no-print whitespace-nowrap">
                <UButton v-if="isMatching && editingKey !== rowKey(r)" size="xs" variant="outline" label="編集" @click="startEdit(r)" />
                <UButton
                  v-if="isMatching && isDiffHighlighted(r)" size="xs" variant="outline" label="日報を直す" class="ml-1"
                  icon="i-lucide-external-link" target="_blank"
                  :to="{ path: '/daily-report-edit', query: dailyReportEditQuery(r) }"
                />
                <UButton
                  v-if="isMatching && dvrMapQuery(r)" size="xs" variant="outline" label="位置を見る" class="ml-1"
                  icon="i-lucide-map-pin" target="_blank"
                  :to="{ path: '/dvr-map', query: dvrMapQuery(r)! }"
                />
                <UButton
                  v-if="isMatching && dvrMapQuery(r)" size="xs" variant="outline" label="現在地" class="ml-1"
                  icon="i-lucide-locate" @click="openLocation(r)"
                />
                <UButton v-if="canRecheck(r)" size="xs" variant="outline" label="再照合" class="ml-1" :loading="rechecking === rowKey(r)" :disabled="rechecking !== null" @click="recheck(r)" />
                <UButton v-if="r.manual" size="xs" color="error" variant="outline" label="削除" class="ml-1" @click="deleteTarget = r" />
              </td>
            </tr>
            <tr v-if="rows.length === 0 && !listError">
              <td :colspan="isMatching ? 13 : 6" class="text-center text-gray-500">給油の行がありません</td>
            </tr>
            <tr class="font-medium">
              <td colspan="4" class="text-right">合計</td>
              <td class="text-right">{{ formatQuantity(total) }}</td>
              <td :colspan="isMatching ? 8 : 1" />
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <UModal
      :open="locationTarget !== null" :ui="{ content: 'sm:max-w-3xl' }"
      @update:open="(v: boolean) => { if (!v) locationTarget = null }"
    >
      <template #content>
        <div class="p-6 space-y-3">
          <h3 class="text-lg font-bold">車両の現在地</h3>
          <p v-if="locationTarget" class="text-sm text-gray-600 dark:text-gray-400">
            {{ locationTarget.car?.name ?? '' }}
          </p>
          <template v-if="!dvrSession">
            <p class="text-sm text-gray-600 dark:text-gray-400">theearth (web地球号) にログインすると現在地を読みます</p>
            <TheearthLoginForm api-prefix="/dvr-api" @login="loadLocation" />
          </template>
          <p v-else-if="locationLoading" class="text-sm text-gray-500">現在地を読んでいます…</p>
          <p v-else-if="locationError" class="text-sm text-red-600">{{ locationError }}</p>
          <template v-else-if="locationPoint">
            <p class="text-base font-medium">{{ locationPoint.address || '(住所なし)' }}</p>
            <p class="text-sm text-gray-600 dark:text-gray-400">
              {{ locationPoint.dataDatetime }}
              <template v-if="locationPoint.driverName"> / {{ locationPoint.driverName }}</template>
              <template v-if="locationPoint.speed != null"> / {{ locationPoint.speed }} km/h</template>
            </p>
            <DvrMap :markers="locationMarkers" :current="{ lat: locationPoint.latitude!, lng: locationPoint.longitude! }" />
          </template>
          <div class="flex justify-end gap-2">
            <UButton
              v-if="locationTarget && dvrMapQuery(locationTarget)" variant="outline" icon="i-lucide-external-link"
              label="位置情報で開く" target="_blank" :to="{ path: '/dvr-map', query: { vehicle: dvrMapQuery(locationTarget)!.vehicle } }"
            />
            <UButton v-if="locationError" variant="outline" label="もう一度" :loading="locationLoading" @click="loadLocation" />
            <UButton label="閉じる" @click="locationTarget = null" />
          </div>
        </div>
      </template>
    </UModal>

    <UModal :open="deleteTarget !== null" @update:open="(v: boolean) => { if (!v) deleteTarget = null }">
      <template #content>
        <div class="p-6 space-y-4">
          <h3 class="text-lg font-bold">給油の行の削除</h3>
          <p v-if="deleteTarget" class="text-gray-600 dark:text-gray-400">
            {{ formatShortDatetime(deleteTarget.datetime) }} / card {{ deleteTarget.fuel_card_id }} の行を削除しますか？この操作は取り消せません。
          </p>
          <div class="flex justify-end gap-2">
            <UButton label="キャンセル" variant="outline" @click="deleteTarget = null" />
            <UButton label="削除" color="error" :loading="deleting" @click="confirmDelete" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.fuel-table {
  border-collapse: collapse;
  font-size: 0.875rem;
}
.fuel-table th,
.fuel-table td {
  border: 1px solid var(--ui-border);
  padding: 2px 4px;
  white-space: nowrap;
}
/* Dtako とずれている行 (差異 ≠ 0 か集計なし) の色は <tr> の Tailwind class (`[&>td]:bg-amber-200`
   と dark variant) で付ける。印刷では main.css が dark variant を無効にするので紙はライトの色になる。
   ここで背景色を書かないこと — scoped CSS は layer 外なので @layer utilities の dark: を上書きする。
   また `:global(.dark) .x` は Vue が `.dark` 単体に潰す (#814 で本番の html 全体が茶色になった)。
   印刷は既定で背景色を落とすので、この強調だけは紙に残す */
.fuel-diff-row td {
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}
</style>

<style>
/* CakePHP の @media print と同じ: 操作を隠し、A4 に収まるよう文字を小さくする。`aside` は scoped では
   効かないので非 scoped。**`@page` は書かない** — 素の `@page` は SPA で他の画面の印刷にも残り、
   粗利・拘束×賃金の `@page { size: A4 landscape }` とぶつかる。名前付き page (`page: …`) は、この画面が
   layouts の flex (サイドバーと横並び) の中にあるので効かない (headless Chrome の printToPDF で実測)。
   代わりに表を詰めて、A4 縦の既定の余白 (印字幅 約 718px) でも 1 行に収まる大きさにする。 */
@media print {
  aside { display: none !important; }
  .fuel-intank .fuel-no-print { display: none !important; }
  /* scoped の `.fuel-table td[data-v-…]` に詳細度で負けるので !important */
  .fuel-intank th,
  .fuel-intank td { font-size: 9px; padding: 1px 2px !important; }
  /* layouts の <main> の p-6 は紙では余白の二重取りになる。この画面を載せた <main> だけ外す
     (`:has` で絞るので、他の画面の印刷には効かない) */
  main:has(> .fuel-intank) { padding: 0 !important; }
}
</style>
