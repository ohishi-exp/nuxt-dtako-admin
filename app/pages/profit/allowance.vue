<script setup lang="ts">
/**
 * 運行手当 (デジタコ → 給与) ページ。
 *
 * 月を指定して運行を引き、各運行のイベントCSV から便を切り出して、料金・給与マスタから
 * 1 便あたりの手当を引く。**PDF の手当表を待たずにデジタコだけで給与を出す**のが狙い。
 *
 * 売上は**一番星の運転日報明細**から取る (デジタコに積載量が無いため)。便と明細を
 * 突合して `売上` を出し、`収支 = 売上 − 手当` を 3 段すべてに並べる。
 *
 * 表示は **乗務員 → 運行 → 便** の 3 段。上から順に開いて、最後は運行詳細へ飛べる。
 * 金額が決まらない便は合計に入れず、各段に件数を出す。**「未確定」は手当が 1 円も
 * 決まっていない便**で、確定 (マスタ)・暫定・強制突合のどれで決まっても数えない。
 * イベントCSV が引けない運行も、**突合できなかった便・明細・単価の食い違いも**、
 * 隠さず件数と一覧で残す。
 *
 * デジタコには**降しが 1 つも無い積み** (= 実在しない便) が混ざるので、
 * **その積みを「便ではない」と印を付けて集計から外せる** (`allowance-excluded.ts`)。
 * 外した便も**黙って消さず**、件数を出して一覧から戻せるようにする。
 *
 * **前回の検索 (月・車輌CD) は localStorage に残し、開いたらキャッシュから
 * そのまま出す** (通信しない)。毎回 月を選び直して `集計` を押す手間を無くす。
 *
 * **手当表PDF から起こした CSV を読み込むと、便単位で突き合わせる**
 * (`allowance-pdf-compare.ts`)。PDF は給与の正本なので、デジタコから出したこの画面の
 * 手当が合っているかを確かめられる唯一の外部の物差し。
 *
 * **売上 (一番星) は乗務員CD で引く** (rust-ichibanboshi#302 で `driver` が足りた)。
 * 車番で引くと**その日その乗務員が別の車番で走ったぶんが丸ごと見えない** —
 * 2026-07 の帯広5台の実測で ¥1,596,721 が画面の外にあった。
 *
 * **デジタコに運行が 1 件も無い日は、一番星の明細から便を起こす**
 * (`allowance-ichiban-legs.ts`)。デジタコが無いのだから、そこから取るしかない。
 * 起こしたぶんは**月の行・乗務員ごとの本表・手当表PDF との突合のどれにも同じように
 * 入れる**。基準が分かれると「結局どれを見ればいいのか」が分からなくなるため。
 * 内訳は「(デジタコ N ・ 一番星 M)」として併記する。
 *
 * **降しイベントが無い便には、一番星の明細を手で結べる** (強制突合、
 * `allowance-force-match.ts`)。運行終了の後に卸している運行がこれに当たる。
 * 結んで決まった卸地・手当は**集計 (`buildMonthlyAllowance`) に渡す前に便へ映す**
 * (`applyForcedLegs`)。ここが一番星から起こした便と違うところで、あちらは
 * デジタコに無い便を足すのに対し、こちらは**既にある便の欠けを埋める**ので、
 * 表示側で差し替えると経路だけ直って数え方が置き去りになる。
 */
import { getOperations, getOperationCsv, getDrivers } from '~/utils/api'
import { describeApiError } from '~/utils/api-error'
import { fetchAllPages } from '~/utils/paged-fetch'
import type { Driver, OperationListItem } from '~/types'
import { extractAllowanceLegs, extractCarryInUnloads, allowanceForLegs, addressToCity, cityToPlace } from '~/utils/allowance-trips'
import {
  parseTargets,
  serializeTargets,
  toggleTarget,
  driverLabel,
} from '~/utils/allowance-targets'
import {
  applyCarryOver,
  buildMonthlyAllowance,
  monthReadingRange,
  toReportRows,
  type OperationAllowance,
  type AllowanceReportRow,
  type DriverNode,
  type OperationNode,
} from '~/utils/allowance-report'
import { fetchVehicleDailySlips, fetchDriverDailySlips, type VehicleDailySlip } from '~/utils/ichiban'
import {
  PROVISIONAL_KEY,
  parseProvisional,
  serializeProvisional,
  setProvisional,
  provisionalFor,
  summarizeProvisional,
  provisionalRoutes,
  type ProvisionalMap,
} from '~/utils/allowance-provisional'
import {
  ALLOWANCE_OVERRIDE_SCHEMA_VERSION,
  allowanceOverrideMigrationNote,
  allowanceOverrideSaveNote,
  type AllowanceOverrideSavedValue,
  type AllowanceOverrideSaveResult,
} from '~/utils/allowance-overrides-r2'
import {
  EXCLUDED_KEY,
  parseExcluded,
  serializeExcluded,
  toggleExcluded,
  isExcluded,
  excludedKey,
  applyExclusions,
  staleExclusionKeys,
  unkoNoOfKey,
  type ExcludedMap,
} from '~/utils/allowance-excluded'
import {
  FORCE_MATCH_KEY,
  parseForceMatch,
  serializeForceMatch,
  toggleForceMatch,
  clearForceMatch,
  forceMatchKey,
  resolveForceMatches,
  applyForcedLegs,
  forceMatchCandidates,
  type ForceMatchMap,
} from '~/utils/allowance-force-match'
import {
  findRelayGroups,
  transportSlips,
  type RelayGroup,
} from '~/utils/allowance-relay'
import {
  MAX_LOAD_TONS,
  buildIchibanLegs,
  summarizeIchibanLegs,
  type IchibanLeg,
} from '~/utils/allowance-ichiban-legs'
import {
  PDF_TRIPS_KEY,
  decodeCsvBytes,
  parsePdfAllowanceCsv,
  parsePdfTripFile,
  serializePdfTripFile,
  comparePdfTrips,
  driverKey,
  routeText,
  type PdfTripFile,
  type PdfCompareEntry,
} from '~/utils/allowance-pdf-compare'
import {
  OVERPAID_KEY,
  parseOverpaid,
  serializeOverpaid,
  toggleOverpaid,
  staleOverpaidKeys,
  overpaidKeyText,
  type OverpaidMap,
} from '~/utils/allowance-pdf-overpaid'
import {
  LAST_SEARCH_KEY,
  parseLastSearch,
  serializeLastSearch,
} from '~/utils/allowance-last-search'
import {
  CACHE_KEY,
  parseCache,
  serializeCache,
  findMonth,
  putMonth,
  planOperationFetch,
  planSlipFetch,
  savedAtLabel,
  type CachedOperation,
  type MonthCache,
} from '~/utils/allowance-cache'
import {
  reconcileVehicles,
  reconcileCsvLines,
  summarizeSales,
  checkFares,
  checkLeftoverFares,
  tradableSlips,
  slipDateRange,
  vehicleCodeFromUnkoNo,
  legKey,
  margin,
  POOL_VEHICLE,
  type VehicleReconcileInput,
  type VehiclesReconcileResult,
  type LegReconcile,
} from '~/utils/allowance-ichiban'

/** イベントCSV を同時に引く本数。alc を叩きすぎないための上限。 */
const CSV_CONCURRENCY = 4
/** 対象乗務員 (乗務員CD) の保存先。ブラウザごとに残る。
 * **氏名で保存していた旧版とはキーを分ける** — 同じキーのまま意味を変えると、
 * 氏名が `driver_cd` として API に渡って 0 件になる (2026-08-21 に踏んだ)。 */
const TARGETS_KEY = 'dtako:allowance:driver-cds'


/**
 * 取得結果のキャッシュ (localStorage)。
 *
 * 集計はイベントCSV を運行の本数だけ引くので重い。**運行一覧で「引き直しが要るか」を
 * 見て、要らないものはキャッシュから復元する**。localStorage が使えない環境
 * (無効化・容量超過) でも集計そのものは動くので、失敗は握って理由だけ出す。
 */
const cacheNote = ref<string | null>(null)
const cachedMonth = ref<MonthCache | null>(null)
/** 前回の集計をキャッシュから出しているだけ (= 通信していない) か。画面に出す。 */
const restoredFromCache = ref(false)

/**
 * 検索条件 (月・車輌CD) を残す。**対象乗務員は別に保存済み** (`TARGETS_KEY`)。
 * 保存できなくても集計はできるので、失敗は握る。
 */
function saveLastSearch() {
  try {
    localStorage.setItem(LAST_SEARCH_KEY, serializeLastSearch({ ym: ym.value, vehicle: vehicle.value }))
  }
  catch {
    // localStorage が使えない環境。次に開いたとき今月に戻るだけで、集計は正しい。
  }
}

/**
 * マスタで手当が決まらない経路に入れる**暫定の手当** (経路キー → 円/便)。
 *
 * マスタ (xlsx) に穴があり (実例 `広尾 → 芽室`)、給与明細では金額が分かっている
 * ことがある。**合計には入れるが、必ず「うち暫定」を併記する**。
 */
const provisional = ref<ProvisionalMap>({})

function saveProvisional(key: string, yen: number) {
  provisional.value = setProvisional(provisional.value, key, yen)
  try {
    localStorage.setItem(PROVISIONAL_KEY, serializeProvisional(provisional.value))
  }
  catch (e) {
    cacheNote.value = `暫定手当を保存できませんでした — ${e instanceof Error ? e.message : String(e)}`
  }
  // **この端末の記録 (localStorage) が先で、R2 は後。** R2 が落ちても画面は今までどおり
  // 動く (`pushProvisionalOverride` は注記を出すだけで、集計のコードパスに入らない)。
  // 送るのは**いまこの鍵がどうなったか** 1 件だけ — 入力欄を空にした回は `null`
  // (= 消した) として送る。**全体マップは送らない** (2 台目が相手の確定を消すため)。
  void pushProvisionalOverride(key, provisional.value[key] ?? null)
}

/** 入力欄 (文字列) → 円。空・数でない値は「消す」扱いの 0 にする。 */
function onProvisionalInput(key: string, raw: string) {
  saveProvisional(key, Math.trunc(Number(raw)) || 0)
}

// --- 暫定手当を R2 (全員で共有) に残す (Refs #845) ---
// **端末依存をやめる**ための口。localStorage は**消さない** — 「この端末が最後に何を
// 選んだか」の記録として残し、**この画面の集計は今までどおりそちらから出す**
// (この PR ではロード時の自動 fetch を入れないので、R2 は共有の控え)。

/** R2 への保存の注記。**失敗を黙らせない** (黙ると「共有できている」と誤読する)。 */
const overrideNote = ref('')
/** 失敗と分かる色で出すため (`marginR2Failed` と同じ方針)。 */
const overrideFailed = ref(false)
/** 移行ボタンを押している間 (1 件ずつ直列に送るので、二重に押させない)。 */
const sendingOverrides = ref(false)

/**
 * この端末に残っている暫定手当の件数 (移行ボタンに出す)。
 *
 * **tombstone は含まれない** — 人が見るのは「送るものが何件あるか」で、`ProvisionalMap`
 * は消した鍵を `delete` する (`setProvisional`) ので、そもそも入りようが無い。
 * 「消した」を値として持つのは **R2 側だけ**の話。
 */
const provisionalEntryCount = computed(() => Object.keys(provisional.value).length)

/** **1 件の操作**を送る。全体マップを送る口はサーバー側にも無い。 */
function postProvisionalOverride(key: string, value: number | null) {
  return $fetch<AllowanceOverrideSaveResult>('/api/profit/allowance-override', {
    method: 'POST',
    body: { schemaVersion: ALLOWANCE_OVERRIDE_SCHEMA_VERSION, kind: 'provisional', key, value },
  })
}

/**
 * 入力のたびに 1 件だけ R2 へ送る。**投げっぱなしにしないが、致命傷にもしない** —
 * 失敗しても localStorage には入っているので、集計はそのまま続けられる。
 */
async function pushProvisionalOverride(key: string, value: number | null) {
  // 経路キーが空の行には暫定を当てられない (`setProvisional` も入れない)。
  if (!key) return
  try {
    overrideNote.value = allowanceOverrideSaveNote(await postProvisionalOverride(key, value), null)
    overrideFailed.value = false
  }
  catch (e) {
    // **`e.message` は使わない** (Refs #890)。`/api/profit/allowance-override` が
    // `createError` に載せた日本語は JSON 本文にしか残らない (本番は HTTP/3 で
    // reason phrase が無いため、`e.message` は `[POST] "…": 400` で終わる)。
    overrideNote.value = allowanceOverrideSaveNote(null, describeApiError(e))
    overrideFailed.value = true
  }
}

/**
 * **この端末のぶんを R2 へ送る** (移行の窓)。
 *
 * **日付を決めた一斉カットオーバーはしない** (押し忘れを検知する手段がコード側に無い)。
 * **既存の各エントリを 1 件ずつの操作として送る** ので、途中で失敗しても送れたぶんは
 * R2 に残り、もう一度押せば残りだけが通る。
 */
async function sendProvisionalToR2() {
  sendingOverrides.value = true
  let sent = 0
  let failed = 0
  let entries = 0
  let firstError = ''
  // **R2 が返した**鍵と値を貯める (送った値のエコーではない)。読む口が無いこの PR では、
  // 「移行が本当に入ったか」を確かめられるのがここだけになるため。
  const saved: AllowanceOverrideSavedValue[] = []
  // 送るのは**この端末に残っているぶん**。型を明示するのは、`Object.entries` の推論が
  // 落ちると `yen` が `unknown` になって「何を送るか」が読めなくなるため。
  // **tombstone は入らない** — localStorage の `ProvisionalMap` は消した鍵を
  // `delete` するので (`setProvisional`)、件数も一覧も「生きているぶん」だけになる。
  const local: [string, number][] = Object.entries(provisional.value)
  for (const [key, yen] of local) {
    try {
      const result = await postProvisionalOverride(key, yen)
      entries = result.entries
      saved.push({ key: result.key, value: result.value })
      sent += 1
    }
    catch (e) {
      failed += 1
      // 同じ口 (`postProvisionalOverride`) なので同じく本文から読む (Refs #890)。
      if (firstError === '') firstError = describeApiError(e)
    }
  }
  sendingOverrides.value = false
  overrideNote.value = allowanceOverrideMigrationNote({ sent, failed, entries, firstError, saved })
  overrideFailed.value = failed > 0
}

/**
 * **便ではない積み**に印を付けて集計から外す (キー → true)。
 *
 * デジタコには「実際には積んでいない積み」が混ざり、降しが 1 つも無い便として
 * 残り続ける (実例 `2607152258300000001318` の 便3)。**黙って消さない** —
 * 外した件数を出し、下の一覧から戻せるようにする。
 */
const excluded = ref<ExcludedMap>({})

/**
 * **手当表PDF 側が誤っている便**の印 (キー → 付けたときの経路・金額)。
 *
 * 手当表は給与の正本だが、正本が間違っていることがある (実例 `2026-07-27 佐竹 繁`
 * の 2 便目 — デジタコの GPS 住所も一番星の明細も 富士 ¥8,000 を指すのに、
 * 手当表は `広尾〜士幌 ¥9,000` で払っている)。**画面を PDF に寄せて直すのではなく、
 * 過払いとして別に数える**。
 */
const pdfOverpaid = ref<OverpaidMap>({})

function persistOverpaid(next: OverpaidMap) {
  pdfOverpaid.value = next
  try {
    localStorage.setItem(OVERPAID_KEY, serializeOverpaid(next))
  }
  catch (e) {
    cacheNote.value = `過払いの印を保存できませんでした — ${e instanceof Error ? e.message : String(e)}`
  }
}

/** 「過払いにする」/「戻す」。同じボタンで往復できる。 */
function onToggleOverpaid(entry: PdfCompareEntry) {
  persistOverpaid(toggleOverpaid(pdfOverpaid.value, entry))
}

/** 当たらなくなった印をキーで消す (`staleOverpaid` の行から呼ぶ)。 */
function onDropOverpaid(key: string) {
  const next = { ...pdfOverpaid.value }
  delete next[key]
  persistOverpaid(next)
}

function persistExcluded(next: ExcludedMap) {
  excluded.value = next
  try {
    localStorage.setItem(EXCLUDED_KEY, serializeExcluded(next))
  }
  catch (e) {
    cacheNote.value = `除外を保存できませんでした — ${e instanceof Error ? e.message : String(e)}`
  }
}

/**
 * **卸しイベントが無い便に、一番星の明細を手で結びつける** (強制突合)。
 *
 * 運行終了の後に卸している運行があり、その便には降しが 1 つも付かない。
 * `carryOverDest` も当たらないと卸地が永久に決まらない。一番星には卸地も金額も
 * あるので、人が「この便はこの明細」と決められれば全部決まる。
 */
const forceMatch = ref<ForceMatchMap>({})

function persistForceMatch(next: ForceMatchMap) {
  forceMatch.value = next
  try {
    localStorage.setItem(FORCE_MATCH_KEY, serializeForceMatch(next))
  }
  catch (e) {
    cacheNote.value = `強制突合を保存できませんでした — ${e instanceof Error ? e.message : String(e)}`
  }
}
function toggleForcedSlip(legKey: string, rowId: string) {
  persistForceMatch(toggleForceMatch(forceMatch.value, legKey, rowId))
}
function clearForcedLeg(legKey: string) {
  persistForceMatch(clearForceMatch(forceMatch.value, legKey))
}

/** 除外する / 戻すの両方。同じキーをもう一度渡せば戻る。 */
function toggleExclusion(key: string) {
  persistExcluded(toggleExcluded(excluded.value, key))
}
function toggleRowExclusion(r: AllowanceReportRow) {
  toggleExclusion(excludedKey(r))
}

// --- 手当表PDF との比較 ---
// **PDF は給与の正本**で、デジタコから出した手当が合っているかを確かめる唯一の
// 外部の物差し。CSV に起こしたものを読み込んで、便単位で突き合わせる。

const pdfFile = ref<PdfTripFile | null>(null)
const pdfNote = ref<string | null>(null)
const pdfWarnings = ref<string[]>([])

function setPdfFile(file: PdfTripFile | null) {
  pdfFile.value = file
  try {
    if (file) localStorage.setItem(PDF_TRIPS_KEY, serializePdfTripFile(file))
    else localStorage.removeItem(PDF_TRIPS_KEY)
  }
  catch (e) {
    pdfNote.value = `PDF の便を保存できませんでした (比較はこのまま続けられます) — ${e instanceof Error ? e.message : String(e)}`
  }
}

async function onPdfCsvChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  pdfNote.value = null
  pdfWarnings.value = []
  try {
    const text = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()))
    const parsed = parsePdfAllowanceCsv(text)
    setPdfFile(parsed.file)
    pdfWarnings.value = parsed.warnings
  }
  catch (err) {
    setPdfFile(null)
    pdfNote.value = err instanceof Error ? err.message : String(err)
  }
  // 同じファイルを選び直しても change が飛ぶようにする。
  input.value = ''
}

function readCache(): MonthCache | null {
  try {
    return findMonth(parseCache(localStorage.getItem(CACHE_KEY)), ym.value)
  }
  catch (e) {
    cacheNote.value = `キャッシュを読めませんでした — ${e instanceof Error ? e.message : String(e)}`
    return null
  }
}

function writeCache(month: MonthCache) {
  try {
    const file = putMonth(parseCache(localStorage.getItem(CACHE_KEY)), month)
    localStorage.setItem(CACHE_KEY, serializeCache(file))
    cachedMonth.value = month
  }
  catch (e) {
    // 容量超過が現実的な失敗。次回また全部引くだけで、画面の数字は正しい。
    cacheNote.value = `キャッシュを保存できませんでした (次回も取り直します) — ${e instanceof Error ? e.message : String(e)}`
  }
}

function currentYm(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

const ym = ref(currentYm())
const vehicle = ref('')

type Status = 'idle' | 'loading' | 'ready' | 'error'
const status = ref<Status>('idle')
const errorMessage = ref<string | null>(null)
const progress = ref('')
const operations = ref<OperationAllowance[]>([])
/** 集計を実行したときの月。表と入力欄がずれないように保持する。 */
const shownYm = ref('')

/** 未確定 (金額が決まらない便 / 便を取れなかった運行) だけに絞る。 */
const onlyIrregular = ref(false)

// --- 対象乗務員 ---
// 全乗務員を集計すると帯広のバルク車以外まで引き当てにいって未確定が数百件になるので、
// **対象を保存して、その乗務員の運行だけ `/api/operations` に引かせる**。
// 名前で全件取ってから絞る作りは誤り — `per_page` は 200 に丸められるため、
// 月の後ろ 200 件しか返らず前半がまるごと落ちる (2026-07 は全社 1142 運行)。
const targets = ref<string[]>([])
const drivers = ref<Driver[]>([])
const pendingDriver = ref('')

onMounted(async () => {
  targets.value = parseTargets(localStorage.getItem(TARGETS_KEY))
  // **条件を戻すのはキャッシュを読む前。** `readCache` は `ym.value` の月を探すので、
  // 順番を逆にすると今月のキャッシュ (たいてい無い) を見にいってしまう。
  const last = parseLastSearch(localStorage.getItem(LAST_SEARCH_KEY))
  if (last) {
    ym.value = last.ym
    vehicle.value = last.vehicle
  }
  provisional.value = parseProvisional(localStorage.getItem(PROVISIONAL_KEY))
  excluded.value = parseExcluded(localStorage.getItem(EXCLUDED_KEY))
  pdfOverpaid.value = parseOverpaid(localStorage.getItem(OVERPAID_KEY))
  forceMatch.value = parseForceMatch(localStorage.getItem(FORCE_MATCH_KEY))
  pdfFile.value = parsePdfTripFile(localStorage.getItem(PDF_TRIPS_KEY))
  // **乗務員マスタはキャッシュ復元より先に読む。** 一番星を乗務員で引いた月の
  // キャッシュは `driver:<CD>` を鍵にしているので、氏名→CD が引けないと
  // 復元した表の売上がまるごと空になる。
  try {
    drivers.value = await getDrivers()
  }
  catch {
    // 乗務員マスタが引けなくても CD だけで動く (表示が CD のままになるだけ)
  }
  cachedMonth.value = readCache()
  if (cachedMonth.value) restoreFromCache(cachedMonth.value)
})

function toggle(cd: string) {
  targets.value = toggleTarget(targets.value, cd)
  localStorage.setItem(TARGETS_KEY, serializeTargets(targets.value))
}

// 月を変えたら、その月のキャッシュがあるかを出し直す (押す前に分かる方が親切)。
watch(ym, () => {
  cachedMonth.value = readCache()
})

/** セレクタで選ばれたら対象に足して、次の選択に備えて空に戻す。 */
watch(pendingDriver, (cd) => {
  if (!cd) return
  toggle(cd)
  pendingDriver.value = ''
})

function labelOf(cd: string): string {
  return driverLabel(drivers.value, cd)
}

/** 乗務員マスタに無い CD。指定ミスか、マスタが引けていないかのどちらか。 */
function isUnknownDriver(cd: string): boolean {
  return drivers.value.length > 0 && !drivers.value.some(d => d.driver_cd.trim() === cd)
}

/** 1 乗務員ぶんの運行をページングで全部取る。 */
function fetchOperationsFor(range: { from: string, to: string }, driverCd?: string) {
  return fetchAllPages<OperationListItem>(async (page) => {
    const res = await getOperations({
      date_from: range.from,
      date_to: range.to,
      driver_cd: driverCd,
      vehicle_cd: vehicle.value.trim() || undefined,
      page,
      per_page: 200,
    })
    return { items: res.operations, total: res.total }
  })
}

/**
 * 金額。**`¥-0` だけを潰す** (Refs #843)。収支 (`margin()` = 売上 − 手当) と PDF との差
 * (`screenYen - pdfYen`) を出すので**負になり得る**列で、0 のときに `¥-0` と出ていた。
 * 「0 円」なのか「符号が化けた」のか読めないのが害。
 *
 * ## なぜ `Math.round` を足して直さないのか (Refs #843 の判断)
 *
 * 見本の `margin.vue` の `yen` は `(Math.round(v) + 0)` だが、**あちらは元から
 * `Math.round` があった**ので `+ 0` は `-0` を畳むだけで済む。ここは元々丸めていないので、
 * `Math.round` を足すと**丸め方そのものが変わる** (`¥1,234.5` → `¥1,235`、
 * `¥-1,234.5` → `¥-1,234`)。そして**この画面には小数が実際に入り得る** —
 * 手当表PDF の CSV (`parsePdfAllowanceCsv`) は `Number(rawYen)` と `Number.isFinite` しか
 * 見ておらず、**整数チェックが無い唯一の入口**だから (手当マスタ・暫定・上書きは
 * どれも整数を強制している)。**表示の丸め方を黙って変えない。**
 *
 * ⇒ **`toLocaleString` が `"-0"` を返した回だけ `"0"` に差し替える。**
 * `+ 0` では届かない `-0.0005 < v < 0` の端数つきの負も、`toLocaleString` の既定
 * (`maximumFractionDigits: 3`) がここで `"-0"` にするので**同じ 1 か所で捕まる**。
 * **`¥-0` 以外の出力は 1 文字も変わらない** — `-0.4` は `¥-0.4`、`-0.6` は `¥-0.6` のまま
 * (符号も小数も消さない)。正規表現は `^-0$` で全体一致なので `-0.4` には当たらない。
 */
const yen = (v: number | null) => (v === null ? '-' : `¥${v.toLocaleString().replace(/^-0$/, '0')}`)
const tons = (v: number) => `${Math.round(v * 100) / 100}t`

// --- 一番星の明細と、強制突合 (降しが無い便に明細を手で結ぶ) ---
// **集計より先に置く。** 強制突合で決まった卸地・手当を便へ映してから
// `buildMonthlyAllowance` に渡すので、経路の表示・経路キー (暫定手当・手当表PDF
// との突合)・便数・手当・未確定の数え方が全部そのまま追従する。
// (明細そのものの引き方は下の「売上 (一番星との突合)」にある)

/** 引いた一番星の明細 (鍵は `driver:<CD>` か 車番)。**便を起こすのに使う。** */
const slipsByKey = ref<Record<string, VehicleDailySlip[]>>({})

/** 一番星の明細を `rowId` で引く。強制突合が結んだ相手を取り出すのに使う。 */
const slipByRowId = computed(() => {
  const map = new Map<string, VehicleDailySlip>()
  for (const list of Object.values(slipsByKey.value)) {
    for (const slip of list) map.set(slip.rowId, slip)
  }
  return map
})

/**
 * 便のキー → 強制突合の結果。
 *
 * **対象月の外の便も含めて引く** (`toReportRows` をそのまま渡す)。月で切ってから
 * 引くと、月末の運行に結んだぶんが集計に映らない。
 */
const forcedLegs = computed(() => resolveForceMatches(
  toReportRows(operations.value),
  forceMatch.value,
  slipByRowId.value,
  provisional.value,
))

/** 除外を当てる**前**の集計。モーダル (外した便を戻す場所) と、当たらなくなった
 * 除外の検出はこちらを見る。 */
const monthlyAll = computed(() => buildMonthlyAllowance(
  applyForcedLegs(operations.value, forcedLegs.value),
  shownYm.value,
))
const exclusion = computed(() => applyExclusions(monthlyAll.value, excluded.value))
/** **除外を抜いた集計。** 表・合計・売上突合・CSV は全部こちらを読む。 */
const monthly = computed(() => exclusion.value.monthly)
/** 外した便そのもの (一覧に出して戻す)。 */
const excludedRows = computed(() => exclusion.value.rows)
/**
 * **当たらなくなった除外。** 同じ運行が集計に居るのに、その除外がどの便にも
 * 当たっていないもの = イベントCSV が変わって積みが動いた疑い。黙って効かなくしない。
 */
const staleExclusions = computed(() => staleExclusionKeys(monthlyAll.value, excluded.value))

// --- 売上 (一番星との突合) ---
// デジタコには積載量が無いので、売上は一番星の `amount` をそのまま使う。
// 一番星が引けなくても手当は出せるので、失敗は握りつぶさず別枠で出す。
const reconciled = ref<VehiclesReconcileResult | null>(null)
const salesError = ref<string | null>(null)
/**
 * 突合結果。**強制突合で結んだ便は上書きする。**
 *
 * ここで差し替えれば、売上・収支・未突合の数え方は全部そのまま追従する
 * (`summarizeSales` も `unmatchedLegs` もこの Map を読んでいる)。
 */
const byLeg = computed(() => {
  const base = reconciled.value?.byLeg ?? new Map<string, LegReconcile>()
  if (forcedLegs.value.size === 0) return base
  const out = new Map(base)
  for (const row of allRows()) {
    const forced = forcedLegs.value.get(forceMatchKey(row))
    if (forced === undefined) continue
    out.set(legKey(row), {
      key: legKey(row),
      status: 'matched',
      slips: forced.slips,
      quantity: forced.quantity,
      salesYen: forced.salesYen,
      split: false,
      fromPool: false,
    })
  }
  return out
})
const hasSales = computed(() => reconciled.value !== null)

function allRows(): AllowanceReportRow[] {
  return monthly.value.drivers.flatMap(d => d.operations.flatMap(op => op.rows))
}

/** 便を車輌ごとに分ける。**車輌CD は運行NO から取る** (一覧の応答に列が無いため)。 */
function groupRowsByVehicle(rows: AllowanceReportRow[]): Map<string, AllowanceReportRow[]> {
  const groups = new Map<string, AllowanceReportRow[]>()
  for (const row of rows) {
    const code = vehicleCodeFromUnkoNo(row.unkoNo)
    const list = groups.get(code) ?? []
    list.push(row)
    groups.set(code, list)
  }
  return groups
}

/** 便を車輌C ごとに分けて車輌C の昇順に並べる。突合の入力の順を固定する。 */
function orderedVehicleRows(rows: AllowanceReportRow[]): [string, AllowanceReportRow[]][] {
  return [...groupRowsByVehicle(rows)].sort((a, b) => (a[0] > b[0] ? 1 : -1))
}

/**
 * キャッシュの明細がどちらの鍵で入っているかを見て、突合の入力を組み直す。
 * **鍵は保存した時の引き方で決まる** (`driver:<CD>` なら乗務員引き、それ以外は車番)。
 */
function orderedForSlips(
  rows: AllowanceReportRow[],
  slips: Record<string, VehicleDailySlip[]>,
): [string, AllowanceReportRow[]][] {
  if (!Object.keys(slips).some(key => key.startsWith('driver:'))) return orderedVehicleRows(rows)
  return orderedDriverRows(rows).map(([cd, r]) => [driverSlipKey(cd), r])
}

/** 乗務員名 → 乗務員CD。一番星を乗務員で引くのに要る。 */
const driverCdByName = computed(() => {
  const map = new Map<string, string>()
  for (const d of drivers.value) map.set(d.driver_name.trim(), d.driver_cd.trim())
  return map
})

/**
 * **一番星を乗務員で引けるか。** 対象乗務員が指定されていて、乗務員マスタから
 * 全員の CD が引けるときだけ。どちらか欠けたら車番で引く旧経路に落ちる。
 */
const canFetchByDriver = computed(() => targets.value.length > 0
  && monthly.value.drivers.every(d => driverCdByName.value.has(d.driverName)))

/** キャッシュのキー。車番と混ざらないよう前置きを付ける。 */
function driverSlipKey(cd: string): string {
  return `driver:${cd}`
}

/** 便を乗務員ごとに分けて、乗務員CD の昇順に並べる。 */
function orderedDriverRows(rows: AllowanceReportRow[]): [string, AllowanceReportRow[]][] {
  const groups = new Map<string, AllowanceReportRow[]>()
  for (const row of rows) {
    const cd = driverCdByName.value.get(row.driverName) ?? ''
    const list = groups.get(cd) ?? []
    list.push(row)
    groups.set(cd, list)
  }
  return [...groups].sort((a, b) => (a[0] > b[0] ? 1 : -1))
}

/** **手元にある明細だけで突合する (通信しない)。** キャッシュからの復元と共用。 */
function applyReconcile(
  ordered: [string, AllowanceReportRow[]][],
  slips: Record<string, VehicleDailySlip[]>,
) {
  slipsByKey.value = slips
  const inputs: VehicleReconcileInput[] = ordered
    .map(([vehicle, vehicleRows]) => ({ vehicle, rows: vehicleRows, slips: slips[vehicle] ?? [] }))
  reconciled.value = reconcileVehicles(inputs, slips[POOL_VEHICLE] ?? [])
}

/**
 * 一番星の明細を引いて突合する。**キャッシュにある車輌C は引き直さない。**
 * 明細側には「変わったか」を判定する材料が無いので、取り直しは `force` に任せる。
 * 使った明細をそのまま返して、呼び出し側がキャッシュに残す。
 */
async function runReconcile(
  rows: AllowanceReportRow[],
  cachedSlips: Record<string, VehicleDailySlip[]>,
  force: boolean,
): Promise<Record<string, VehicleDailySlip[]>> {
  const range = slipDateRange(shownYm.value)
  if (canFetchByDriver.value) return runReconcileByDriver(rows, cachedSlips, force, range)

  const ordered = orderedVehicleRows(rows)
  const vehicles = [...ordered.map(([vehicle]) => vehicle), POOL_VEHICLE]
  const plan = planSlipFetch(vehicles, cachedSlips, force)
  const slips: Record<string, VehicleDailySlip[]> = { ...plan.reuse }
  for (const vehicle of plan.fetch) {
    progress.value = `一番星の明細を取得中 ${vehicle === POOL_VEHICLE ? `受け皿(${POOL_VEHICLE})` : `車輌${vehicle}`}`
    slips[vehicle] = tradableSlips(await fetchVehicleDailySlips(vehicle, range.from, range.to))
  }
  applyReconcile(ordered, slips)
  return slips
}

/**
 * **一番星を乗務員で引いて突合する** (rust-ichibanboshi#302 で `driver` が足りた)。
 *
 * 車番で引くと**その日その乗務員が別の車番で走ったぶんが丸ごと見えない**。
 * 2026-07 の帯広5台の実測で、車番引きでは **¥1,596,721 が画面の外**にあった
 * (西島は `0001-06` に 25 本・`0040-01` に 5 本、柳井は `0040-01` に 13 本)。
 *
 * **受け皿 (`POOL_VEHICLE`) は使わない。** 乗務員で引けば、その乗務員が乗った車番の
 * 明細は最初から全部入っているので、他人の売上を拾いにいく必要が無い。
 */
async function runReconcileByDriver(
  rows: AllowanceReportRow[],
  cachedSlips: Record<string, VehicleDailySlip[]>,
  force: boolean,
  range: { from: string, to: string },
): Promise<Record<string, VehicleDailySlip[]>> {
  const ordered = orderedDriverRows(rows)
  const plan = planSlipFetch(ordered.map(([cd]) => driverSlipKey(cd)), cachedSlips, force)
  const slips: Record<string, VehicleDailySlip[]> = { ...plan.reuse }
  for (const key of plan.fetch) {
    const cd = key.slice('driver:'.length)
    progress.value = `一番星の明細を取得中 ${labelOf(cd)}`
    slips[key] = tradableSlips(await fetchDriverDailySlips(cd, range.from, range.to))
  }
  applyReconcile(ordered.map(([cd, r]) => [driverSlipKey(cd), r]), slips)
  return slips
}

const monthSales = computed(() => summarizeSales(allRows(), byLeg.value))

// --- 手当 (確定 + 暫定) ---
// **表示する手当・収支は暫定込み。** ただし「うち暫定」を必ず併記して、
// 確定と混ざったまま読まれないようにする。

const monthProvisional = computed(() => summarizeProvisional(allRows(), provisional.value))
function driverProvisional(d: DriverNode) {
  return summarizeProvisional(d.operations.flatMap(op => op.rows), provisional.value)
}
function opProvisional(op: OperationNode) {
  return summarizeProvisional(op.rows, provisional.value)
}

/** 1 便の暫定手当。マスタで決まっている便には当たらない。 */
function legProvisionalYen(r: AllowanceReportRow): number | null {
  return provisionalFor(r, provisional.value)
}

/**
 * 1 便の「支払う手当」= 確定があればそれ、無ければ暫定。どちらも無ければ null。
 *
 * **強制突合をここで足さない。** 決まった卸地・手当は集計の**前**に便へ映してある
 * (`applyForcedLegs`) ので、マスタで引けた便は `r.allowanceYen` に入っていて、
 * 引けなかった便は経路キーがもう `釧路|駒場` なので `legProvisionalYen` が当たる。
 */
function legPayYen(r: AllowanceReportRow): number | null {
  return r.allowanceYen ?? legProvisionalYen(r)
}

/**
 * **未確定 = 手当が 1 円も決まっていない便。** 確定 (マスタ)・暫定・強制突合の
 * どれで決まっても未確定には数えない。
 *
 * `buildMonthlyAllowance` の `irregularTrips` は**マスタしか知らない**ので、
 * 暫定が当たった便まで未確定に数えてしまう (強制突合したぶんは `applyForcedLegs` で
 * 便に映してあるので、ここではマスタで決まった便と区別が要らない)。
 * `summarizeProvisional` の `missingTrips` がちょうどこの定義。
 *
 * **一番星から起こした便のぶんも足す。** 便数・手当・売上・収支は
 * デジタコ + 一番星 なのに未確定だけデジタコ由来を数えていると、
 * **手当が決まっていない便が居るのに `未確定 0 便` と出る** (2026-07 の
 * `07-17 西島 駒場 → ユナイテッド牧場` が実際にそうなった)。
 */
const monthUnresolvedTrips = computed(() =>
  monthProvisional.value.missingTrips + ichibanTotals.value.unknownTrips)
function driverUnresolvedTrips(d: DriverNode): number {
  return driverProvisional(d).missingTrips + driverIchiban(d).unknownTrips
}
function opUnresolvedTrips(op: OperationNode): number {
  return opProvisional(op).missingTrips
}

/** その便に結んだ明細の `rowId`。無ければ空。 */
function forcedRowIds(r: AllowanceReportRow): string[] {
  return forceMatch.value[forceMatchKey(r)] ?? []
}

/**
 * **卸しイベントが無くて卸地が決まらない便。** 運行終了の後に卸している運行がこれ。
 * 強制突合で一番星の明細を結べば、卸地・手当・売上がまとめて決まる。
 * 既に結んである便も (外せるように) 残す。
 *
 * **除外した便も出す** (`monthlyAll` を見る)。降しが無い便への答えは
 * 「除外 (実在しない)」と「強制突合 (実在するが卸地が取れていない)」の 2 つで、
 * 一方を選んだ後にもう一方へ移れないと詰む。実際 2026-07-16 の便は先に除外され、
 * 後から**運行終了後に卸していただけ**と分かった。
 */
const unresolvedDestRows = computed(() => monthlyAll.value.drivers
  .flatMap(d => d.operations.flatMap(op => op.rows))
  .filter(r => r.destCity.trim() === '' || forcedRowIds(r).length > 0))

/** その便が除外されているか (強制突合の一覧で印を出す)。 */
function isRowExcluded(r: AllowanceReportRow): boolean {
  return isExcluded(r, excluded.value)
}

/** 既にどこかの便に当たっている明細。同じ売上を 2 つの便に付けないため。 */
const usedSlipRowIds = computed(() => {
  const used = new Set<string>()
  for (const hit of byLeg.value.values()) {
    for (const slip of hit.slips) used.add(slip.rowId)
  }
  return used
})

/** その便に結べる候補の明細。 */
function candidatesFor(r: AllowanceReportRow): VehicleDailySlip[] {
  const cd = driverCdByName.value.get(r.driverName)
  if (cd === undefined) return []
  // **請求のみ (請求K=1) は候補に出さない。** 運送を伴わない請求行なので、結ぶと
  // 中継では脚とあわせて売上が二重に乗る (実例 07-16 の 通し ¥43,750 と
  // 脚 ¥21,750+¥22,000)。
  const slips = transportSlips(slipsByKey.value[driverSlipKey(cd)] ?? [])
  return forceMatchCandidates(r, slips, usedSlipRowIds.value, forcedRowIds(r))
}

/** 手当が決まらない経路の一覧 (暫定を入れる欄を並べる)。 */
const unresolvedRoutes = computed(() => provisionalRoutes(allRows(), provisional.value))
function driverSales(d: DriverNode) {
  return summarizeSales(d.operations.flatMap(op => op.rows), byLeg.value)
}
function opSales(op: OperationNode) {
  return summarizeSales(op.rows, byLeg.value)
}
function legHit(r: AllowanceReportRow): LegReconcile | undefined {
  return byLeg.value.get(legKey(r))
}
function legSalesYen(r: AllowanceReportRow): number | null {
  const hit = legHit(r)
  if (!hit) return null
  return hit.salesYen
}
function legMarginYen(r: AllowanceReportRow): number | null {
  const hit = legHit(r)
  if (!hit) return null
  return margin(hit.salesYen, legPayYen(r) ?? 0)
}

/**
 * **デジタコに運行が無い日の便を、一番星の明細から起こす** (`allowance-ichiban-legs.ts`)。
 *
 * デジタコを積んでいない車輌 (`0001`) や、その日の運行が alc に無い車番 (`0040`) で
 * 走った日は運行データが無く、便が作れない。それでも仕事はしていて売上も立っている。
 * 2026-07 の帯広5台では手当表PDF の **39 便 ¥344,000** がこれに当たり、合計から
 * 落ちていた。**一番星から起こすと便数がぴったり 39 で一致する** (金額もマスタに無い
 * 1 便を除いて一致)。
 *
 * **乗務員で引けているときだけ。** 車番引きでは、その乗務員が別の車番で走った日の
 * 明細を持っていないので、起こすべき便が見えない。
 *
 * **「デジタコの便が 1 つも無い日」に限らない。** どのデジタコ便にも当たらなかった
 * 明細から起こすので、一部だけ取れている日の欠けも埋まる。当たった明細は触らないので
 * 二重には載らない。
 */
const ichibanLegs = computed<IchibanLeg[]>(() => {
  if (!canFetchByDriver.value) return []
  const out: IchibanLeg[] = []
  // **デジタコ便に当たった明細だけを除く。** 日単位で避けると、一部だけ取れている日の
  // 起こし損ねた便が永久に埋まらない (2026-07 に残った 4 便が全部この形だった)。
  const used = new Set<string>()
  for (const hit of byLeg.value.values()) {
    for (const slip of hit.slips) used.add(slip.rowId)
  }
  for (const d of monthly.value.drivers) {
    const cd = driverCdByName.value.get(d.driverName)
    if (cd === undefined) continue
    // **請求のみ (請求K=1) からは便を起こさない。** 走っていない行なので、
    // 便にすると存在しない仕事に手当が付く。
    const slips = transportSlips(slipsByKey.value[driverSlipKey(cd)] ?? [])
    // **デジタコ便がある `日付|積地`。** その積地に残った明細は複数卸しの片割れ。
    const coveredOrigins = new Set(d.operations.flatMap(op => op.rows
      .map(r => `${r.date}|${cityToPlace(addressToCity(r.originCity))}`)))
    out.push(...buildIchibanLegs(d.driverName, slips, used, coveredOrigins, shownYm.value, provisional.value))
  }
  return out
})
const ichibanTotals = computed(() => summarizeIchibanLegs(ichibanLegs.value))

/**
 * **中継** — 1 つの荷を 2 台以上でつないだ運行。
 *
 * 一番星は伝票を「通しの請求 1 本 (`請求K=1`) + 車輌ごとの按分 N 本 (`請求K=2`)」に
 * 割る。通しは走っていないので便にせず、**手当と売上は脚それぞれが持つ**。
 * ここに出すのは、通しが「どの便にも当たらなかった明細」に紛れて
 * **取り込み漏れに見えるのを防ぐ**ため。
 */
const relayGroups = computed<RelayGroup[]>(() => {
  const seen = new Set<string>()
  const slips: VehicleDailySlip[] = []
  // 乗務員ごとに引いた明細をならす。**同じ明細が 2 人に出ることがある**ので rowId で畳む。
  for (const list of Object.values(slipsByKey.value)) {
    for (const slip of list) {
      if (seen.has(slip.rowId)) continue
      seen.add(slip.rowId)
      slips.push(slip)
    }
  }
  return findRelayGroups(slips)
})

/** 乗務員ごとの「一番星から起こした便」。**本表の行に足すため。** */
const ichibanByDriver = computed(() => {
  const map = new Map<string, IchibanLeg[]>()
  for (const leg of ichibanLegs.value) {
    const list = map.get(leg.driverName) ?? []
    list.push(leg)
    map.set(leg.driverName, list)
  }
  return map
})
function driverIchiban(d: DriverNode) {
  return summarizeIchibanLegs(ichibanByDriver.value.get(d.driverName) ?? [])
}

/**
 * **乗務員 1 人ぶんの「払う額」。デジタコ由来 + 暫定 + 一番星から起こした便。**
 *
 * 本表・合計行・手当表PDF との突合を**同じ基準**に揃えるためのただ 1 か所。
 * 基準が 3 通りあると「結局どれを見ればいいのか」が分からなくなる。
 */
function driverTotals(d: DriverNode) {
  const prov = driverProvisional(d)
  const ich = driverIchiban(d)
  const allowanceYen = d.totalYen + prov.yen + ich.allowanceYen
  const salesYen = driverSales(d).salesYen + ich.salesYen
  return {
    trips: d.trips + prov.trips + ich.trips,
    allowanceYen,
    provisionalYen: prov.yen + ich.provisionalYen,
    provisionalTrips: prov.trips + ich.provisionalTrips,
    salesYen,
    marginYen: margin(salesYen, allowanceYen),
    ichibanTrips: ich.trips,
    ichibanYen: ich.allowanceYen,
    ichibanSalesYen: ich.salesYen,
  }
}

/**
 * 一番星から起こした便を、デジタコ由来の便と同じ形にする (手当表PDF との突合用)。
 *
 * **運行NO は持てない** — 元になる運行がそもそも無いのがこの便の定義。空にして、
 * 突合結果から「運行を開く」が押せないことで区別が付くようにする。
 */
function ichibanLegAsRow(leg: IchibanLeg): AllowanceReportRow {
  return {
    unkoNo: '',
    date: leg.date,
    driverName: leg.driverName,
    vehicleName: leg.vehicleNumber,
    seq: 0,
    fromTs: null,
    originCity: leg.origin,
    destCity: leg.dest,
    viaCities: '',
    masterDest: leg.masterDest,
    allowanceYen: leg.allowanceYen,
    status: leg.status,
    destSource: 'event',
  }
}

/**
 * **この画面の基準。** デジタコ由来 + 暫定 + 一番星から起こしたぶん。
 *
 * 月の行・乗務員ごとの本表 (`driverTotals`)・手当表PDF との突合が**全部これ**を使う。
 * 基準が 3 通りあると「結局どれを見ればいいのか」が分からなくなる (オーナー指摘)。
 */
/** 暫定の合計 (デジタコ由来 + 一番星から起こしたぶん)。 */
const combinedProvisional = computed(() => ({
  trips: monthProvisional.value.trips + ichibanTotals.value.provisionalTrips,
  yen: monthProvisional.value.yen + ichibanTotals.value.provisionalYen,
}))

const combined = computed(() => {
  const allowanceYen = monthly.value.totalYen + monthProvisional.value.yen + ichibanTotals.value.allowanceYen
  const salesYen = monthSales.value.salesYen + ichibanTotals.value.salesYen
  return {
    trips: monthly.value.trips + monthProvisional.value.trips + ichibanTotals.value.trips,
    allowanceYen,
    salesYen,
    marginYen: margin(salesYen, allowanceYen),
  }
})

/**
 * 外した便が持っていた手当・売上。**「黙って消えた額」を出すため**に数える。
 * 実在しない便なら ¥0 のままなので、動かないことが正しい確認になる。
 */
const excludedTotals = computed(() => {
  let allowanceYen = 0
  let salesYen = 0
  for (const r of excludedRows.value) {
    allowanceYen += legPayYen(r) ?? 0
    salesYen += legSalesYen(r) ?? 0
  }
  return { allowanceYen, salesYen }
})

/**
 * 手当表PDF との突合。**読み込んだ PDF の月と、いま集計している月が違えば比べない**
 * (別の月どうしを並べると全部「PDF のみ」「画面のみ」になって読めない)。
 */
const pdfCompare = computed(() => {
  const file = pdfFile.value
  if (!file || file.ym !== shownYm.value) return null
  return comparePdfTrips(file, [
    ...allRows().map(row => ({ row, payYen: legPayYen(row) })),
    // **一番星から起こした便も比べる。** 入れないと、埋めたはずの便が
    // 「PDF にあって画面に無い便」に出続けて、直ったことが分からない。
    ...ichibanLegs.value.map(leg => ({ row: ichibanLegAsRow(leg), payYen: leg.allowanceYen })),
  ], pdfOverpaid.value)
})
/** PDF の月と集計中の月が違う。押す前に気付けるように出す。 */
const pdfMonthMismatch = computed(() =>
  pdfFile.value !== null && status.value === 'ready' && pdfFile.value.ym !== shownYm.value)

/**
 * 手当表PDF との突合を**社員番号 (乗務員CD) 順**に並べ直す。
 *
 * `comparePdfTrips` は氏名順で返す — あの層は乗務員CD を知らないため。本表と
 * 同じ並びにしないと、2 つの表を目で往復するときに行がずれる。
 * **キーは空白を落とした氏名** (`driverKey`) なので、乗務員マスタ側も同じ形に揃える。
 */
const driverCdByCompareKey = computed(() => {
  const map = new Map<string, string>()
  for (const d of drivers.value) map.set(driverKey(d.driver_name), d.driver_cd.trim())
  return map
})
const pdfCompareDrivers = computed(() => {
  const list = pdfCompare.value?.drivers ?? []
  const keyOf = (name: string) => {
    const cd = driverCdByCompareKey.value.get(name)
    return cd === undefined ? `9${name}` : `0${cd.padStart(8, '0')}`
  }
  return [...list].sort((a, b) => (keyOf(a.driverName) > keyOf(b.driverName) ? 1 : -1))
})

const pdfOnlyEntries = computed(() => (pdfCompare.value?.entries ?? []).filter(e => e.status === 'pdf_only'))
const screenOnlyEntries = computed(() => (pdfCompare.value?.entries ?? []).filter(e => e.status === 'screen_only'))
const pdfAmountDiffs = computed(() => (pdfCompare.value?.entries ?? [])
  .filter(e => e.status === 'matched' && e.diffYen !== null && e.diffYen !== 0 && !e.overpaid))
/** 手当表PDF 側が誤っていると確認した便。**黙って消さず、ここで数え続ける。** */
const pdfOverpaidEntries = computed(() => (pdfCompare.value?.entries ?? []).filter(e => e.overpaid))
const pdfOverpaidYen = computed(() => pdfOverpaidEntries.value.reduce((sum, e) => sum + (e.diffYen ?? 0), 0))
/**
 * **印は付いているのに中身が食い違う便。** CSV を起こし直して便番号がずれると起きる。
 * 黙って効かなくするのではなく画面に出す (除外の `staleExclusions` と同じ方針)。
 */
const staleOverpaid = computed(() =>
  staleOverpaidKeys(pdfOverpaid.value, pdfCompare.value?.entries ?? []))
const pdfLooseMatches = computed(() => (pdfCompare.value?.entries ?? [])
  .filter(e => e.status === 'matched' && (e.dateShift || e.routeDiff)))

/** 1 便の手当欄。**未確定は理由まで出す** — `unknown` と `ambiguous` は直し方が逆。 */
interface LegPayLabel {
  text: string
  /** 確定でないので色を変える。 */
  warn: boolean
  title: string
}
function legPayLabel(r: AllowanceReportRow): LegPayLabel {
  // **強制突合を先に見る。** 卸地・手当は集計の前に便へ映してあるので、
  // マスタで引けた便は `r.allowanceYen` が埋まっていて、後ろに置くと
  // 「人が結んで決めた」ことが画面から消える。
  const forced = forcedLegs.value.get(forceMatchKey(r))
  if (forced !== undefined && forced.allowanceYen !== null) {
    return {
      text: `${yen(forced.allowanceYen)} (強制突合${forced.isProvisional ? '・暫定' : ''})`,
      warn: true,
      title: `一番星の明細を手で結んで卸地を ${forced.dest} と決めた便`,
    }
  }
  if (r.allowanceYen !== null) return { text: yen(r.allowanceYen), warn: false, title: 'マスタで決まった手当' }
  const provisionalYen = legProvisionalYen(r)
  if (provisionalYen !== null) {
    return {
      text: `${yen(provisionalYen)} (暫定)`,
      warn: true,
      title: 'マスタに無いので手で入れた暫定額。合計に入っていますが「うち暫定」に数えています',
    }
  }
  if (r.status === 'ambiguous') {
    return { text: '未確定 (ambiguous)', warn: true, title: 'マスタに同じ経路で違う金額が複数あります。人が決めるしかありません' }
  }
  return { text: '未確定 (unknown)', warn: true, title: 'マスタにこの経路がありません。料金表に行を足すか、暫定額を入れてください' }
}
function legQuantityLabel(r: AllowanceReportRow): string {
  const hit = legHit(r)
  if (!hit) return '-'
  return tons(hit.quantity)
}

/** 便 1 行の「突合」欄。**テンプレートに `!` を書かずに済むよう、ここで形にする。** */
interface LegMatchLabel {
  text: string
  /** 日付ずれ / 推定 / 受け皿 のような但し書き。 */
  flags: string[]
  warn: boolean
}
function legMatchLabel(r: AllowanceReportRow): LegMatchLabel {
  const hit = legHit(r)
  if (!hit) return { text: '-', flags: [], warn: false }
  if (hit.status === 'no_slip') return { text: '一番星に無し', flags: [], warn: true }
  const flags: string[] = []
  if (hit.status === 'matched_date_shift') flags.push('日付ずれ')
  if (hit.split) flags.push('推定')
  if (hit.fromPool) flags.push('受け皿')
  return { text: `${hit.slips.length}明細`, flags, warn: false }
}

// --- 突合できなかったもの (黙って合計から抜かない) ---

/** 一番星に対応する明細が無かった便。 */
const unmatchedLegs = computed(() => (hasSales.value
  ? allRows().filter(r => byLeg.value.get(legKey(r))?.status === 'no_slip')
  : []))

/**
 * どの便にも当たらなかった一番星明細 (車輌ごと)。
 *
 * **多くは「デジタコ非搭載の車輌に乗った日」で、欠陥ではない** (2026-08-21 オーナー判断)。
 * その日の運行は alc に 1 件も無いので便が作れず、売上だけが一番星に残る。
 * **追いかける対象ではなく、この画面の収支の外にあるもの**として見せる。
 */
const leftoverSlips = computed(() => (reconciled.value?.leftovers ?? [])
  .flatMap(l => l.slips.map(slip => ({ vehicle: l.vehicle, slip })))
  .sort((a, b) => (a.slip.saleDate > b.slip.saleDate ? 1 : -1)))

/** 便に当たらなかった明細の売上合計。**この画面の収支に入っていない額**。 */
const leftoverYen = computed(() => leftoverSlips.value.reduce((sum, l) => sum + l.slip.amount, 0))

const fareChecks = computed(() => [
  ...checkFares(allRows(), byLeg.value),
  ...(reconciled.value?.leftovers ?? []).flatMap(l => checkLeftoverFares(l.slips)),
])
/** マスタの運賃と単価が食い違う明細。**料金改定の検知に使う。** */
const fareMismatches = computed(() => fareChecks.value.filter(f => f.status === 'mismatch'))
/** マスタに載っていない銘柄・経路。未確定ではなく「対象外」。 */
const outOfMaster = computed(() => fareChecks.value.filter(f => f.status === 'no_master'))

function opHasIssue(op: OperationNode): boolean {
  return opUnresolvedTrips(op) > 0 || op.error !== null
}
function driverHasIssue(d: DriverNode): boolean {
  return driverUnresolvedTrips(d) > 0 || d.failedOperations > 0
}

/**
 * 表示する乗務員。**社員番号 (乗務員CD) 順に並べる。**
 *
 * `allowance-report.ts` は氏名の文字コード順で返す — あの層は乗務員CD を持って
 * いないため (`localeCompare` は使わない、ICU の照合順が環境で入れ替わるので)。
 * 給与の画面としては**社員番号順が自然**なので、CD を持っているここで並べ直す。
 * **CD が引けない乗務員は後ろに回し、その中では氏名順**を保つ (順番が消えないように)。
 */
const visibleDrivers = computed(() => {
  const shown = onlyIrregular.value
    ? monthly.value.drivers.filter(driverHasIssue)
    : monthly.value.drivers
  const keyOf = (name: string) => {
    const cd = driverCdByName.value.get(name)
    return cd === undefined ? `9${name}` : `0${cd.padStart(8, '0')}`
  }
  return [...shown].sort((a, b) => (keyOf(a.driverName) > keyOf(b.driverName) ? 1 : -1))
})

function visibleOperations(d: DriverNode): OperationNode[] {
  return onlyIrregular.value ? d.operations.filter(opHasIssue) : d.operations
}
function visibleRows(op: OperationNode): AllowanceReportRow[] {
  // **「未確定だけ」は手当で絞る。** `status` はマスタの引き当てしか見ないので、
  // 暫定や強制突合で決まった便まで残って、上の件数と数が合わなくなる。
  return onlyIrregular.value ? op.rows.filter(r => legPayYen(r) === null) : op.rows
}

const csvRows = computed(() => visibleDrivers.value
  .flatMap(d => visibleOperations(d).flatMap(op => visibleRows(op))))

// --- 開閉 ---
const openDrivers = reactive<Record<string, boolean>>({})
const openOps = reactive<Record<string, boolean>>({})

/** 1 人だけなら最初から開いておく (毎回クリックさせない)。 */
function autoOpen() {
  for (const key of Object.keys(openDrivers)) delete openDrivers[key]
  for (const key of Object.keys(openOps)) delete openOps[key]
  const only = monthly.value.drivers
  if (only.length === 1) openDrivers[only[0]!.driverName] = true
}

/** 1 運行ぶんのイベントCSV を引いて便に切り出す。失敗は握りつぶさず error に残す。 */
async function resolveOperation(op: {
  unko_no: string
  reading_date: string
  operation_date: string | null
  driver_name: string | null
  vehicle_name: string | null
  has_kudgivt: boolean
}): Promise<OperationAllowance> {
  const base: OperationAllowance = {
    unkoNo: op.unko_no,
    readingDate: op.reading_date,
    operationDate: op.operation_date,
    driverName: op.driver_name,
    vehicleName: op.vehicle_name,
    legs: [],
    carryIn: { cities: [], toTs: null },
    error: null,
  }
  if (!op.has_kudgivt) return { ...base, error: 'イベントCSV が未取り込み (has_kudgivt=false)' }
  try {
    const csv = await getOperationCsv(op.unko_no, 'events')
    return {
      ...base,
      legs: allowanceForLegs(extractAllowanceLegs(csv.headers, csv.rows)),
      carryIn: extractCarryInUnloads(csv.headers, csv.rows),
    }
  }
  catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}

/** キャッシュに残す形 (引いた材料だけ)。**手当の金額は残さない** — マスタを直したのに
 * 画面が変わらない、という壊れ方をするため。読み込み時に引き直す。 */
function toCached(op: OperationAllowance, hasKudgivt: boolean): CachedOperation {
  return {
    unkoNo: op.unkoNo,
    readingDate: op.readingDate,
    operationDate: op.operationDate,
    driverName: op.driverName,
    vehicleName: op.vehicleName,
    hasKudgivt,
    legs: op.legs.map(item => item.leg),
    carryIn: op.carryIn,
    error: op.error,
  }
}

/** キャッシュから戻す。手当はここで引き直す。 */
function fromCached(op: CachedOperation): OperationAllowance {
  return {
    unkoNo: op.unkoNo,
    readingDate: op.readingDate,
    operationDate: op.operationDate,
    driverName: op.driverName,
    vehicleName: op.vehicleName,
    legs: allowanceForLegs(op.legs),
    carryIn: op.carryIn,
    error: op.error,
  }
}

/**
 * **前回の集計をキャッシュからそのまま出す (通信しない)。**
 *
 * 月と車輌CD を戻しただけでは白紙の画面が出るだけで、結局 `集計` を押し直すことになる。
 * その月の材料は `allowance-cache.ts` に残っているので、**開いた瞬間に前回の続きから
 * 見られる**ようにする。手当はキャッシュに入っていない (マスタを直したのに画面が
 * 変わらない壊れ方を避けるため) ので、`fromCached` が引き直す。
 *
 * **最新かどうかは保証しない。** キャッシュ以降に取り込み直しがあれば古いままなので、
 * 「キャッシュから出している」ことを画面に出し、`集計` で取り直せるようにしておく。
 */
function restoreFromCache(month: MonthCache) {
  operations.value = applyCarryOver(month.operations.map(fromCached))
  shownYm.value = month.ym
  autoOpen()
  status.value = 'ready'
  restoredFromCache.value = true
  // **明細を 1 車輌ぶんも持っていない月は突合しない。** 全部「一番星に無し」に見えて、
  // 売上ゼロの月と区別が付かなくなる (一番星が落ちていた回のキャッシュがこれ)。
  if (Object.keys(month.slips).length > 0) applyReconcile(orderedForSlips(allRows(), month.slips), month.slips)
}

async function run(force = false) {
  saveLastSearch()
  restoredFromCache.value = false
  status.value = 'loading'
  errorMessage.value = null
  salesError.value = null
  cacheNote.value = null
  operations.value = []
  reconciled.value = null
  progress.value = '運行を検索中...'
  try {
    const range = monthReadingRange(ym.value)
    const found: OperationListItem[] = []
    if (targets.value.length === 0) {
      found.push(...await fetchOperationsFor(range))
    }
    else {
      for (const cd of targets.value) {
        progress.value = `運行を検索中 ${labelOf(cd)}`
        found.push(...await fetchOperationsFor(range, cd))
      }
    }

    // **引き直しが要るかは運行一覧で決まる。** 運行NO と has_kudgivt が一致していれば
    // 前に切り出した便をそのまま使う (取り込み直しが走れば has_kudgivt が戻るので当たらない)。
    const cached = readCache()
    const plan = planOperationFetch(found, cached?.operations ?? [], force)
    const hasKudgivtOf = new Map(found.map(o => [o.unko_no, o.has_kudgivt]))
    const reused = plan.reuse.map(fromCached)
    const resolved: OperationAllowance[] = []
    for (let i = 0; i < plan.fetch.length; i += CSV_CONCURRENCY) {
      progress.value = `イベントCSV を取得中 ${resolved.length}/${plan.fetch.length}`
        + (plan.reuse.length > 0 ? ` (キャッシュから ${plan.reuse.length})` : '')
      const chunk = plan.fetch.slice(i, i + CSV_CONCURRENCY)
      resolved.push(...await Promise.all(chunk.map(resolveOperation)))
    }
    const all = [...reused, ...resolved]
    // 積んだまま帰庫した便の卸地は次の運行の先頭にある。全運行を引き終えてから当てる。
    operations.value = applyCarryOver(all)
    shownYm.value = ym.value
    autoOpen()
    status.value = 'ready'
    // 一番星が落ちていても手当は出せる。売上だけ諦めて理由を画面に残す。
    const slips: Record<string, VehicleDailySlip[]> = {}
    try {
      Object.assign(slips, await runReconcile(allRows(), cached?.slips ?? {}, force))
    }
    catch (e) {
      // 売上は `/api/ichiban/**` (自前の server route) 越し。理由は JSON 本文に
      // しか残らないので本文から読む (Refs #890)。
      salesError.value = describeApiError(e)
    }
    writeCache({
      ym: ym.value,
      savedAt: new Date().toISOString(),
      operations: all.map(op => toCached(op, hasKudgivtOf.get(op.unkoNo) ?? false)),
      slips,
    })
    progress.value = ''
  }
  catch (e) {
    errorMessage.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
  }
}

// --- 運行モーダル ---
// **ページ遷移にしない。** 集計はイベントCSV を運行の本数だけ引くので、
// `/operations/{運行NO}` へ飛んで戻ると作り直しになる (2026-07 の帯広5台で 90 本)。
const modalUnkoNo = ref<string | null>(null)

function openOperation(unkoNo: string) {
  modalUnkoNo.value = unkoNo
}

/** **除外した便もモーダルには出す** (`monthlyAll` を見る) — 外した便を戻す場所が
 * 一覧しか無いと、運行の中身を見ながら戻せない。 */
const modalTarget = computed(() => {
  const unkoNo = modalUnkoNo.value
  if (unkoNo === null) return null
  for (const d of monthlyAll.value.drivers) {
    const op = d.operations.find(o => o.unkoNo === unkoNo)
    if (!op) continue
    return {
      unkoNo,
      readingDate: op.readingDate,
      vehicleName: op.vehicleName,
      driverName: d.driverName,
      error: op.error,
      entries: op.rows.map(row => ({ row, hit: legHit(row) })),
    }
  }
  return null
})

function downloadCsv() {
  const blob = new Blob([`﻿${reconcileCsvLines(csvRows.value, byLeg.value, provisional.value).join('\r\n')}\r\n`],
    { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `運行手当収支${onlyIrregular.value ? '_未確定' : ''}_${shownYm.value}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

</script>

<template>
  <div class="p-6">
    <h1 class="text-lg font-semibold mb-1">
      運行手当 (デジタコ → 給与)
    </h1>
    <p class="text-xs text-gray-500 mb-4">
      デジタコの積み/降しから便を切り出し、料金・給与マスタで 1 便あたりの手当を引きます。
      売上はデジタコに無い (積載量を持たない) ので、<b>一番星の運転日報明細</b>と突合して
      その税抜売上をそのまま使い、<b>収支 = 売上 − 手当</b>を出します。
      乗務員 → 運行 → 便 の順に開けます。<b>手当が 1 円も決まらない便</b>は合計に入れず「未確定」に数えます
      (マスタ・暫定・強制突合のどれかで決まった便は入りません)。
      突合できなかった便・明細と、マスタの運賃と単価が食い違う明細は、下に件数と一覧で出します。
      <b>降しが 1 つも無い積み</b>のような実在しない便は、便の行 (または運行を開いたところ) の
      <b>除外</b>で集計から外せます。外した便は<b>下の「除外した便」から戻せます</b>。
      <b>手当表PDF から起こした CSV</b> を読み込むと、便単位で突き合わせて差分を出します。
      売上は<b>対象乗務員を指定していれば乗務員CD で引きます</b> — その乗務員が
      <b>別の車番で走った日</b>の売上も入ります (車番で引くと丸ごと落ちます)。
      <b>デジタコに運行が 1 件も無い日</b>は、一番星の明細から便を起こして
      合計に足します (内訳は「デジタコ N ・ 一番星 M」で併記)。
    </p>

    <div class="flex flex-wrap gap-3 items-end mb-4">
      <label class="text-xs text-gray-500">月
        <input v-model="ym" type="month" class="block text-sm border rounded px-2 py-1 dark:bg-gray-900">
      </label>
      <label class="text-xs text-gray-500">車輌CD
        <input v-model="vehicle" placeholder="1109" class="block text-sm border rounded px-2 py-1 w-28 dark:bg-gray-900">
      </label>
      <button
        class="text-sm px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
        :disabled="status === 'loading'"
        @click="run(false)"
      >
        {{ status === 'loading' ? '集計中...' : '集計' }}
      </button>
      <button
        class="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
        :disabled="status === 'loading'"
        title="キャッシュを使わず、イベントCSV と一番星の明細を全部取り直します"
        @click="run(true)"
      >
        全部取り直す
      </button>
      <button
        v-if="csvRows.length > 0"
        class="text-sm px-4 py-1.5 rounded bg-gray-600 hover:bg-gray-700 text-white"
        @click="downloadCsv"
      >
        CSV出力{{ onlyIrregular ? ' (未確定のみ)' : '' }}
      </button>
      <label class="text-xs text-gray-500">手当表PDF の CSV
        <input
          type="file"
          accept=".csv,text/csv"
          class="block text-sm border rounded px-2 py-1 dark:bg-gray-900"
          title="PDF から起こした手当表 CSV (driver_name / date / origin / dest / allowance_yen 列)"
          @change="onPdfCsvChange"
        >
      </label>
      <NuxtLink
        to="/remote-app"
        target="_blank"
        class="text-sm px-4 py-1.5 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
        title="社内の RemoteApp を別タブで開きます (この画面の集計は保たれます)"
      >
        リモートアプリ
      </NuxtLink>
    </div>

    <p class="text-xs text-gray-500 mb-3">
      <template v-if="cachedMonth">
        キャッシュ <b>{{ cachedMonth.ym }}</b> 運行 {{ cachedMonth.operations.length }} 本
        ({{ savedAtLabel(cachedMonth.savedAt) }} 保存) —
        <b>集計</b>は運行一覧を見て変わったぶんだけ取り直します。
      </template>
      <template v-else>
        この月のキャッシュはありません。<b>集計</b>で取ったぶんは次回から使い回します。
      </template>
    </p>
    <p v-if="pdfFile" class="text-xs text-gray-500 mb-3">
      手当表PDF <b>{{ pdfFile.ym }}</b> {{ pdfFile.trips.length }} 便
      = <b>{{ yen(pdfFile.trips.reduce((sum, t) => sum + t.allowanceYen, 0)) }}</b> を読み込み済み
      <button class="ml-2 text-blue-500 hover:text-blue-700 hover:underline" @click="setPdfFile(null)">外す</button>
      <span v-if="pdfMonthMismatch" class="ml-2 text-amber-600 dark:text-amber-400">
        — 集計中の <b>{{ shownYm }}</b> と月が違うので比べていません
      </span>
    </p>
    <p v-if="pdfNote" class="text-xs text-amber-600 dark:text-amber-400 mb-3">
      {{ pdfNote }}
    </p>
    <p v-if="pdfWarnings.length > 0" class="text-xs text-amber-600 dark:text-amber-400 mb-3">
      CSV の {{ pdfWarnings.length }} 行を読み飛ばしました — {{ pdfWarnings.slice(0, 3).join(' / ') }}
      <span v-if="pdfWarnings.length > 3">ほか</span>
    </p>
    <p v-if="restoredFromCache" class="text-xs text-sky-600 dark:text-sky-400 mb-3">
      前回の検索 (<b>{{ shownYm }}</b>) をキャッシュから<b>そのまま表示</b>しています —
      <b>通信していない</b>ので、キャッシュ保存後に取り込み直しがあれば古いままです。
      最新にするには <b>集計</b> を押してください。
    </p>
    <p v-if="cacheNote" class="text-xs text-amber-600 dark:text-amber-400 mb-3">
      {{ cacheNote }}
    </p>

    <div class="mb-4 text-xs">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-gray-500">対象乗務員</span>
        <DriverSearchSelect
          v-model="pendingDriver"
          :drivers="drivers"
          value-key="driver_cd"
          placeholder="乗務員を追加"
        />
        <span v-if="targets.length === 0" class="text-amber-600 dark:text-amber-400">
          未設定 — 全乗務員を集計します (時間がかかり、未確定が大量に出ます)
        </span>
        <button
          v-for="cd in targets"
          :key="cd"
          class="px-2 py-0.5 rounded-full hover:line-through"
          :class="isUnknownDriver(cd)
            ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
            : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'"
          :title="isUnknownDriver(cd) ? '乗務員マスタに無い CD です' : 'クリックで対象から外す'"
          @click="toggle(cd)"
        >
          {{ labelOf(cd) }} ✕
        </button>
      </div>
    </div>

    <!--
      暫定手当を R2 (全員で共有) へ送る (Refs #845)。**集計を回す前でも押せる** —
      暫定はこの画面を開いた時点で localStorage から読めていて、月にも紐づかないため。
    -->
    <div v-if="provisionalEntryCount > 0 || overrideNote" class="mb-4 text-xs space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="px-2 py-1 rounded border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          :disabled="sendingOverrides || provisionalEntryCount === 0"
          title="この端末に入っている暫定手当を 1 件ずつ R2 へ送ります。端末の記録は消しません"
          @click="sendProvisionalToR2"
        >
          {{ sendingOverrides ? '送信中…' : `この端末の暫定手当を R2 へ送る (${provisionalEntryCount} 件)` }}
        </button>
        <span class="text-gray-500">
          暫定手当は<b>この端末にしか無い</b>ので、他の人の画面には出ません。送ると<b>全員で共有</b>できます。
        </span>
      </div>
      <p v-if="overrideNote" :class="overrideFailed ? 'text-red-600 dark:text-red-400' : 'text-gray-500'">
        {{ overrideNote }}
      </p>
    </div>

    <p v-if="progress" class="text-xs text-gray-400 mb-3">
      {{ progress }}
    </p>
    <p v-if="status === 'error'" class="text-sm text-red-600 dark:text-red-400 mb-4">
      {{ errorMessage }}
    </p>
    <p v-if="salesError" class="text-sm text-red-600 dark:text-red-400 mb-4">
      売上 (一番星) が引けませんでした — {{ salesError }} (手当だけ表示しています)
    </p>

    <template v-if="status === 'ready'">
      <p v-if="monthly.drivers.length === 0" class="text-xs text-gray-400">
        {{ shownYm }} に該当する運行が見つかりませんでした
      </p>
      <template v-else>
        <div class="mb-3 flex flex-wrap gap-6 text-sm items-center">
          <span class="font-semibold">{{ shownYm }}</span>
          <span>
            便 <b>{{ combined.trips }}</b>
            <span
              v-if="ichibanTotals.trips > 0"
              class="text-gray-400"
              title="内訳。合計はデジタコ由来と一番星から起こしたぶんの両方です"
            >(デジタコ {{ monthly.trips + monthProvisional.trips }} ・ 一番星 {{ ichibanTotals.trips }})</span>
          </span>
          <span>
            手当 <b>{{ yen(combined.allowanceYen) }}</b>
            <span
              v-if="combinedProvisional.trips > 0"
              class="text-amber-600 dark:text-amber-400"
              title="マスタに無いので手で入れた暫定額。上の手当・収支に含まれています"
            >うち暫定 {{ yen(combinedProvisional.yen) }} ({{ combinedProvisional.trips }}便)</span>
          </span>
          <span>売上 <b>{{ hasSales ? yen(combined.salesYen) : '-' }}</b></span>
          <span>収支 <b :class="combined.marginYen < 0 ? 'text-red-600 dark:text-red-400' : ''">
            {{ hasSales ? yen(combined.marginYen) : '-' }}
          </b></span>
          <span
            :class="monthUnresolvedTrips > 0 ? 'text-amber-600 dark:text-amber-400' : ''"
            title="手当が 1 円も決まっていない便 (一番星から起こした便のぶんも含みます)。マスタ・暫定・強制突合のどれかで決まった便は入りません"
          >
            未確定 <b>{{ monthUnresolvedTrips }}</b> 便
          </span>
          <span
            v-if="excludedRows.length > 0"
            class="text-purple-600 dark:text-purple-400"
            title="「便ではない」と印を付けて外した便。上の便数・手当・売上・収支・未確定のどれにも入っていません。下の「除外した便」から戻せます"
          >
            除外 <b>{{ excludedRows.length }}</b> 便
            (手当 {{ yen(excludedTotals.allowanceYen) }} ・ 売上 {{ yen(excludedTotals.salesYen) }})
          </span>
          <span
            v-if="monthly.carriedTrips > 0"
            class="text-sky-600 dark:text-sky-400"
            title="卸地をその次の運行の先頭にある降しから引き継いだ便 (積んだまま帰庫して翌朝降ろす形)。金額は合計に入れています"
          >
            推定卸地 <b>{{ monthly.carriedTrips }}</b> 便
          </span>
          <span v-if="monthly.failedOperations > 0" class="text-amber-600 dark:text-amber-400">
            便を取れなかった運行 <b>{{ monthly.failedOperations }}</b>
          </span>
          <span v-if="monthly.outOfMonthTrips > 0" class="text-gray-400" title="月末の運行が翌月に食い込むぶん。この月の合計には入れていません">
            翌月にかかる便 {{ monthly.outOfMonthTrips }}
          </span>
          <span v-if="hasSales" class="text-gray-400" title="日付が1日ずれて当たった / 同日同卸地で明細を件数で分けた (内訳が推定) / 受け皿の車番から拾った">
            日付ずれ {{ monthSales.dateShiftTrips }} ・ 内訳推定 {{ monthSales.splitTrips }} ・ 受け皿 {{ monthSales.poolTrips }}
          </span>
          <span
            v-if="hasSales"
            :class="canFetchByDriver ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'"
            :title="canFetchByDriver
              ? '一番星を乗務員CD で引いています。その乗務員が別の車番で走った日の売上も入ります'
              : '一番星を車番で引いています。その日その乗務員が別の車番で走ったぶんは入りません (対象乗務員を指定し、乗務員マスタが引けると乗務員で引きます)'"
          >
            売上の引き方 <b>{{ canFetchByDriver ? '乗務員' : '車番' }}</b>
          </span>
          <label class="text-xs text-gray-500 flex items-center gap-1.5 cursor-pointer select-none">
            <input v-model="onlyIrregular" type="checkbox" class="cursor-pointer">
            未確定だけ表示
          </label>
        </div>

        <p v-if="visibleDrivers.length === 0" class="text-xs text-gray-400">
          未確定の便はありません
        </p>
        <div v-else class="border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th class="text-left px-3 py-2 font-medium text-gray-500">乗務員</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">運行</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">便</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">手当</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">売上</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">収支</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500">未確定</th>
                <th class="text-right px-3 py-2 font-medium text-gray-500" title="一番星に対応する明細が無かった便">未突合</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="d in visibleDrivers" :key="d.driverName">
                <tr
                  class="border-t border-gray-100 dark:border-gray-800 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  @click="openDrivers[d.driverName] = !openDrivers[d.driverName]"
                >
                  <td class="px-3 py-2 font-medium">
                    <span class="text-gray-400 mr-1">{{ openDrivers[d.driverName] ? '▾' : '▸' }}</span>
                    {{ d.driverName || '(不明)' }}
                  </td>
                  <td class="px-3 py-2 text-right">{{ d.operations.length }}</td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">
                    {{ driverTotals(d).trips }}
                    <span
                      v-if="driverTotals(d).ichibanTrips > 0"
                      class="text-teal-600 dark:text-teal-400"
                      :title="`うち ${driverTotals(d).ichibanTrips} 便は デジタコに運行が無い日を一番星から起こしたもの (手当 ${yen(driverTotals(d).ichibanYen)})`"
                    >(一番星 {{ driverTotals(d).ichibanTrips }})</span>
                  </td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">
                    {{ yen(driverTotals(d).allowanceYen) }}
                    <span
                      v-if="driverTotals(d).provisionalTrips > 0"
                      class="text-amber-600 dark:text-amber-400"
                      :title="`うち暫定 ${yen(driverTotals(d).provisionalYen)} (${driverTotals(d).provisionalTrips}便)`"
                    >暫定</span>
                  </td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">
                    {{ hasSales ? yen(driverTotals(d).salesYen) : '-' }}
                  </td>
                  <td
                    class="px-3 py-2 text-right whitespace-nowrap"
                    :class="driverTotals(d).marginYen < 0 ? 'text-red-600 dark:text-red-400' : ''"
                  >
                    {{ hasSales ? yen(driverTotals(d).marginYen) : '-' }}
                  </td>
                  <td
                    class="px-3 py-2 text-right"
                    :class="driverHasIssue(d) ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                  >
                    {{ driverUnresolvedTrips(d) }}<span v-if="d.failedOperations > 0"> + 運行{{ d.failedOperations }}</span>
                  </td>
                  <td
                    class="px-3 py-2 text-right"
                    :class="driverSales(d).unmatchedTrips > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                  >
                    {{ hasSales ? driverSales(d).unmatchedTrips : '-' }}
                  </td>
                </tr>

                <tr v-if="openDrivers[d.driverName]" class="border-t border-gray-100 dark:border-gray-800">
                  <td colspan="8" class="p-0">
                    <table class="w-full text-xs">
                      <thead class="bg-gray-100/60 dark:bg-gray-800/60">
                        <tr>
                          <th class="text-left pl-8 pr-3 py-1.5 font-medium text-gray-500">読取日</th>
                          <th class="text-left px-3 py-1.5 font-medium text-gray-500">運行NO</th>
                          <th class="text-left px-3 py-1.5 font-medium text-gray-500">車輌</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">便</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">売上</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">収支</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500">未確定</th>
                          <th class="text-right px-3 py-1.5 font-medium text-gray-500" title="一番星に対応する明細が無かった便">未突合</th>
                          <th class="px-3 py-1.5" />
                        </tr>
                      </thead>
                      <tbody>
                        <template v-for="op in visibleOperations(d)" :key="op.unkoNo">
                          <tr
                            class="border-t border-gray-100 dark:border-gray-800/70 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/40"
                            :class="op.error ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
                            @click="openOps[op.unkoNo] = !openOps[op.unkoNo]"
                          >
                            <td class="pl-8 pr-3 py-1.5 whitespace-nowrap">
                              <span class="text-gray-400 mr-1">{{ openOps[op.unkoNo] ? '▾' : '▸' }}</span>
                              {{ op.readingDate }}
                            </td>
                            <td class="px-3 py-1.5 font-mono text-[11px] whitespace-nowrap">{{ op.unkoNo }}</td>
                            <td class="px-3 py-1.5 whitespace-nowrap">{{ op.vehicleName || '-' }}</td>
                            <td class="px-3 py-1.5 text-right">{{ op.rows.length }}</td>
                            <td class="px-3 py-1.5 text-right whitespace-nowrap">
                              {{ yen(op.totalYen + opProvisional(op).yen) }}
                              <span
                                v-if="opProvisional(op).trips > 0"
                                class="text-amber-600 dark:text-amber-400"
                                :title="`うち暫定 ${yen(opProvisional(op).yen)} (${opProvisional(op).trips}便)`"
                              >暫定</span>
                            </td>
                            <td class="px-3 py-1.5 text-right whitespace-nowrap">
                              {{ hasSales ? yen(opSales(op).salesYen) : '-' }}
                            </td>
                            <td
                              class="px-3 py-1.5 text-right whitespace-nowrap"
                              :class="margin(opSales(op).salesYen, op.totalYen + opProvisional(op).yen) < 0 ? 'text-red-600 dark:text-red-400' : ''"
                            >
                              {{ hasSales ? yen(margin(opSales(op).salesYen, op.totalYen + opProvisional(op).yen)) : '-' }}
                            </td>
                            <td
                              class="px-3 py-1.5 text-right"
                              :class="opHasIssue(op) ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                            >
                              {{ opUnresolvedTrips(op) }}
                            </td>
                            <td
                              class="px-3 py-1.5 text-right"
                              :class="opSales(op).unmatchedTrips > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                            >
                              {{ hasSales ? opSales(op).unmatchedTrips : '-' }}
                            </td>
                            <td class="px-3 py-1.5 text-right whitespace-nowrap">
                              <button
                                class="text-blue-500 hover:text-blue-700 hover:underline"
                                @click.stop="openOperation(op.unkoNo)"
                              >
                                運行を開く
                              </button>
                            </td>
                          </tr>

                          <tr v-if="op.error" class="border-t border-gray-100 dark:border-gray-800/70">
                            <td colspan="10" class="pl-16 pr-3 py-1.5 text-amber-600 dark:text-amber-400">
                              便を取れませんでした — {{ op.error }}
                            </td>
                          </tr>

                          <tr v-else-if="openOps[op.unkoNo]" class="border-t border-gray-100 dark:border-gray-800/70">
                            <td colspan="10" class="p-0">
                              <table class="w-full text-xs">
                                <thead class="bg-gray-100/40 dark:bg-gray-800/40">
                                  <tr>
                                    <th class="text-left pl-16 pr-3 py-1 font-medium text-gray-500">日付</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">便</th>
                                    <th class="text-left px-3 py-1 font-medium text-gray-500">積地 → 卸地</th>
                                    <th class="text-left px-3 py-1 font-medium text-gray-500">マスタ卸地</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">手当</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">数量</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">売上</th>
                                    <th class="text-right px-3 py-1 font-medium text-gray-500">収支</th>
                                    <th class="text-left px-3 py-1 font-medium text-gray-500">突合</th>
                                    <th class="px-3 py-1" />
                                  </tr>
                                </thead>
                                <tbody>
                                  <tr
                                    v-for="r in visibleRows(op)"
                                    :key="`${r.unkoNo}-${r.seq}`"
                                    class="border-t border-gray-100 dark:border-gray-800/50 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                                    :class="legPayYen(r) === null ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
                                    :title="`運行 ${r.unkoNo} を開く`"
                                    @click="openOperation(r.unkoNo)"
                                  >
                                    <td class="pl-16 pr-3 py-1 whitespace-nowrap">{{ r.date }}</td>
                                    <td class="px-3 py-1 text-right">{{ r.seq }}</td>
                                    <td class="px-3 py-1">
                                      {{ r.originCity || '?' }} → {{ r.destCity || '?' }}
                                      <span
                                        v-if="r.destSource === 'carried'"
                                        class="ml-1 px-1 rounded text-[10px] bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300"
                                        title="この便に降しイベントが無く、卸地を次の運行の先頭の降しから引き継いでいます (推定)"
                                      >推定</span>
                                      <span
                                        v-else-if="r.destSource === 'forced'"
                                        class="ml-1 px-1 rounded text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300"
                                        title="この便に降しイベントが無く、人が結んだ一番星の明細から卸地を決めています (強制突合)"
                                      >強制突合</span>
                                      <span v-if="r.viaCities.includes('>')" class="text-gray-400">({{ r.viaCities }})</span>
                                    </td>
                                    <td class="px-3 py-1">{{ r.masterDest || '-' }}</td>
                                    <td class="px-3 py-1 text-right whitespace-nowrap">
                                      <span
                                        :class="legPayLabel(r).warn ? 'text-amber-600 dark:text-amber-400' : ''"
                                        :title="legPayLabel(r).title"
                                      >{{ legPayLabel(r).text }}</span>
                                    </td>
                                    <td class="px-3 py-1 text-right whitespace-nowrap text-gray-500">
                                      {{ legQuantityLabel(r) }}
                                    </td>
                                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(legSalesYen(r)) }}</td>
                                    <td
                                      class="px-3 py-1 text-right whitespace-nowrap"
                                      :class="(legMarginYen(r) ?? 0) < 0 ? 'text-red-600 dark:text-red-400' : ''"
                                    >
                                      {{ yen(legMarginYen(r)) }}
                                    </td>
                                    <td class="px-3 py-1 whitespace-nowrap">
                                      <span :class="legMatchLabel(r).warn ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500'">
                                        {{ legMatchLabel(r).text }}
                                      </span>
                                      <span
                                        v-for="flag in legMatchLabel(r).flags"
                                        :key="flag"
                                        class="ml-1 text-amber-600 dark:text-amber-400"
                                      >{{ flag }}</span>
                                    </td>
                                    <td class="px-3 py-1 text-right whitespace-nowrap">
                                      <button
                                        class="text-purple-500 hover:text-purple-700 hover:underline"
                                        title="この積みは便ではない、と印を付けて集計から外します (下の「除外した便」から戻せます)"
                                        @click.stop="toggleRowExclusion(r)"
                                      >
                                        除外
                                      </button>
                                    </td>
                                  </tr>
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        </template>
                        <tr
                          v-if="driverTotals(d).ichibanTrips > 0"
                          class="border-t border-gray-100 dark:border-gray-800/70 bg-teal-50/60 dark:bg-teal-950/30"
                        >
                          <td class="pl-8 pr-3 py-1.5 whitespace-nowrap text-teal-700 dark:text-teal-300" colspan="3">
                            一番星から起こした便 (デジタコに運行が無い日)
                          </td>
                          <td class="px-3 py-1.5 text-right">{{ driverTotals(d).ichibanTrips }}</td>
                          <td class="px-3 py-1.5 text-right whitespace-nowrap">{{ yen(driverTotals(d).ichibanYen) }}</td>
                          <td class="px-3 py-1.5 text-right whitespace-nowrap">{{ yen(driverTotals(d).ichibanSalesYen) }}</td>
                          <td class="px-3 py-1.5 text-right whitespace-nowrap">
                            {{ yen(margin(driverTotals(d).ichibanSalesYen, driverTotals(d).ichibanYen)) }}
                          </td>
                          <td
                            class="px-3 py-1.5 text-right"
                            :class="driverIchiban(d).unknownTrips > 0
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-gray-300 dark:text-gray-700'"
                          >
                            {{ driverIchiban(d).unknownTrips }}
                          </td>
                          <td class="px-3 py-1.5" />
                          <td class="px-3 py-1.5 text-right whitespace-nowrap text-gray-400">下に一覧</td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <div v-if="unresolvedDestRows.length > 0" class="mt-6 space-y-2 text-xs">
          <h2 class="text-sm font-semibold">卸地が決まらない便 (強制突合)</h2>
          <p class="text-gray-500">
            <b>降しイベントが 1 つも無い便</b>です。デジタコは積みで便を切り、卸地は後ろの降しから取りますが、
            <b>運行終了の後に卸している</b>運行があり、その便には降しが付きません
            (実例 <code>07/16 09:31 積み 釧路市西港</code> → <code>10:17 運転 123.2km</code> →
            <code>12:21 運行終了 音更町駒場北町</code>)。<b>次の運行から引き継ぐ推定も当たらない</b>ことがあります。
            <b>一番星には卸地も金額もあります</b> — 明細をクリックして結べば、
            <b>卸地・手当・売上がまとめて決まります</b>。<b>推測では結びません。人が選んでください。</b>
            候補は<b>同じ乗務員・日付 ±1 日</b>で、<b>他の便に当たっていない明細</b>だけ出しています
            (同じ売上を 2 つの便に付けないため)。積地が一致する明細を先に並べています。
          </p>
          <p class="text-gray-500">
            <b>除外した便もここに出します。</b>降しが無い便への答えは
            「<b>除外</b> = 実在しない」と「<b>強制突合</b> = 実在するが卸地が取れていない」の 2 つで、
            一方を選んだ後にもう一方へ移れないと詰むためです。
            <b>除外したままでは合計に入りません</b> — 結ぶなら「除外を戻す」も押してください。
          </p>
          <div class="space-y-2">
            <div
              v-for="r in unresolvedDestRows"
              :key="forceMatchKey(r)"
              class="border border-gray-200 dark:border-gray-800 rounded-lg p-3"
            >
              <div class="flex flex-wrap items-center gap-3">
                <span class="whitespace-nowrap">{{ r.date }}</span>
                <span class="whitespace-nowrap font-medium">{{ r.driverName }}</span>
                <span class="whitespace-nowrap text-gray-500">{{ r.vehicleName }}</span>
                <span class="whitespace-nowrap">便 {{ r.seq }}</span>
                <span class="whitespace-nowrap">{{ r.originCity || '?' }} → {{ r.destCity || '?' }}</span>
                <span class="whitespace-nowrap" :class="legPayLabel(r).warn ? 'text-amber-600 dark:text-amber-400' : ''">
                  {{ legPayLabel(r).text }}
                </span>
                <span v-if="forcedRowIds(r).length > 0" class="whitespace-nowrap text-emerald-600 dark:text-emerald-400">
                  売上 {{ yen(legSalesYen(r)) }}
                </span>
                <button class="text-blue-500 hover:text-blue-700 hover:underline" @click="openOperation(r.unkoNo)">
                  運行を開く
                </button>
                <button
                  v-if="forcedRowIds(r).length > 0"
                  class="text-purple-500 hover:text-purple-700 hover:underline"
                  @click="clearForcedLeg(forceMatchKey(r))"
                >
                  結びつけを全部外す
                </button>
                <span
                  v-if="isRowExcluded(r)"
                  class="px-1 rounded text-[10px] bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300"
                  title="「便ではない」と外した便。合計に入っていません"
                >除外中</span>
                <button
                  v-if="isRowExcluded(r)"
                  class="text-purple-500 hover:text-purple-700 hover:underline"
                  title="集計に戻します。結びつけても、除外したままでは合計に入りません"
                  @click="toggleRowExclusion(r)"
                >
                  除外を戻す
                </button>
              </div>
              <p v-if="candidatesFor(r).length === 0" class="mt-2 text-gray-400">
                結べる明細がありません (日付 ±1 日に、他の便に当たっていない明細が無い)
              </p>
              <div v-else class="mt-2 flex flex-wrap gap-1.5">
                <button
                  v-for="c in candidatesFor(r)"
                  :key="c.rowId"
                  class="px-2 py-1 rounded border text-left"
                  :class="forcedRowIds(r).includes(c.rowId)
                    ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                    : 'border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800'"
                  :title="forcedRowIds(r).includes(c.rowId) ? 'クリックで結びつけを外す' : 'クリックでこの便に結ぶ'"
                  @click="toggleForcedSlip(forceMatchKey(r), c.rowId)"
                >
                  {{ c.saleDate.slice(5) }} {{ c.origin || '?' }}→{{ c.dest || c.destAreaName || '?' }}
                  {{ tons(c.quantity) }} {{ yen(c.amount) }}
                  <span class="text-gray-400">{{ c.itemName }} 車{{ c.vehicleNumber }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="relayGroups.length > 0" class="mt-6 space-y-2 text-xs">
          <h2 class="text-sm font-semibold">中継 (1 つの荷を複数の車輌でつないだ運行)</h2>
          <p class="text-gray-500">
            一番星は 1 運行を 2 台以上で分けたとき、伝票を
            <b>通しの請求 1 本 (<code>請求K=1</code>)</b> と
            <b>車輌ごとの按分 N 本 (<code>請求K=2</code>)</b> に割ります。
            <b>走ったのは按分の方</b>なので、手当も売上も按分の便が持ちます。
            <b>通しの請求は便にしません</b> — 足すと同じ仕事の売上が二重に乗ります。
            ここに出しているのは、通しの請求が下の「どの便にも当たらなかった一番星明細」に紛れて
            <b>取り込み漏れに見えるのを防ぐ</b>ためです。
            組にできるのは<b>按分の合計が通しとぴったり一致したものだけ</b>で、
            一致しなければ組にせず「請求のみ」として扱います (推測で束ねません)。
          </p>
          <div class="space-y-2">
            <div
              v-for="(g, i) in relayGroups"
              :key="`rl-${i}`"
              class="border border-gray-200 dark:border-gray-800 rounded-lg px-3 py-2 space-y-1"
            >
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="text-gray-400">通しの請求</span>
                <span>{{ g.through.saleDate }}</span>
                <span>車{{ g.through.vehicleNumber }}</span>
                <span>{{ g.through.customerName }}</span>
                <span>{{ g.through.origin || '?' }} → {{ g.through.dest || '?' }}</span>
                <span class="text-gray-500">{{ g.through.itemName }} {{ tons(g.through.quantity) }}</span>
                <b>{{ yen(g.through.amount) }}</b>
                <span class="text-gray-400">(便にしていません)</span>
              </div>
              <div
                v-for="(l, j) in g.legs"
                :key="`rl-${i}-${j}`"
                class="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 text-gray-600 dark:text-gray-300"
              >
                <span class="text-gray-400">└ 走った便</span>
                <span>{{ l.saleDate }}</span>
                <span>車{{ l.vehicleNumber }}</span>
                <span>{{ l.origin || '?' }} → {{ l.dest || '?' }}</span>
                <span class="text-gray-500">{{ tons(l.quantity) }}</span>
                <span>{{ yen(l.amount) }}</span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="ichibanLegs.length > 0" class="mt-6 space-y-2 text-xs">
          <h2 class="text-sm font-semibold">一番星から起こした便</h2>
          <p class="text-gray-500">
            <b>デジタコに運行が 1 件も無い日</b>の便です。デジタコを積んでいない車輌 (車番 <code>0001</code>) や、
            その日の運行が alc に入っていない車番 (<code>0040</code> 等) で走った日は、
            <b>運行データが無いので便が作れません</b>。それでも仕事はしていて売上も立っているので、
            <b>一番星の明細から便を起こしています</b>。
            同じ日・同じ<b>積地</b>の明細を畳み、積載量が 1 台ぶん ({{ MAX_LOAD_TONS }}t) を超えたら分けます
            (<b>卸地では分けません</b> — 手当表は <code>広尾 → 札内・音更</code> のような複数卸しを 1 便として扱うため)。
            手当は<b>最終卸し地</b>でマスタから引き、決まらなければ<b>暫定手当</b>を経路キーで引きます。
            それも無ければ<b>未確定のまま</b>にします (推測で金額を作りません)。
            <b>デジタコ便に当たった明細は触っていません</b>ので、同じ仕事が二重に載ることはありません。
          </p>
          <div class="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
            <table class="w-full">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">日付</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">車番</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">積地 → 卸地</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">マスタ卸地</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">数量</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">売上</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">一番星の明細</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(l, i) in ichibanLegs"
                  :key="`il-${i}`"
                  class="border-t border-gray-100 dark:border-gray-800/70"
                  :class="l.allowanceYen === null ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
                >
                  <td class="px-3 py-1 whitespace-nowrap">{{ l.date }}</td>
                  <td class="px-3 py-1 whitespace-nowrap">{{ l.driverName }}</td>
                  <td class="px-3 py-1 whitespace-nowrap">{{ l.vehicleNumber }}</td>
                  <td class="px-3 py-1 whitespace-nowrap">{{ l.origin || '?' }} → {{ l.dest || '?' }}</td>
                  <td class="px-3 py-1 whitespace-nowrap">{{ l.masterDest || '-' }}</td>
                  <td class="px-3 py-1 text-right whitespace-nowrap text-gray-500">{{ tons(l.quantity) }}</td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">
                    <span v-if="l.allowanceYen !== null" :class="l.isProvisional ? 'text-amber-600 dark:text-amber-400' : ''">
                      {{ yen(l.allowanceYen) }}<span v-if="l.isProvisional"> (暫定)</span>
                    </span>
                    <span v-else class="text-amber-600 dark:text-amber-400">未確定 ({{ l.status }})</span>
                  </td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(l.salesYen) }}</td>
                  <td class="px-3 py-1">{{ l.slips.map(sl => `${sl.dest} ${sl.itemName} ${tons(sl.quantity)}`).join(' / ') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="pdfCompare" class="mt-6 space-y-2 text-xs">
          <h2 class="text-sm font-semibold">手当表PDF との差分</h2>
          <p class="text-gray-500">
            手当表PDF は<b>給与の正本</b>で、デジタコから出したこの画面の手当が合っているかを確かめる
            <b>唯一の外部の物差し</b>です。乗務員ごとに、<b>日付と経路が合う便どうし</b>を当てています。
            経路が合って日付が 1 日ずれたもの・日付が合って経路が違うものも当てますが、<b>印を残して</b>下に出します
            (黙って寄せません)。ここに出ている「PDF にあって画面に無い便」は、
            <b>デジタコに運行が無い日</b>か<b>alc への取り込み漏れ</b>のどちらかです。
            <b>一番星から起こした便も比べています</b> — 起こして埋まった便はここに出ません。
          </p>

          <div class="flex flex-wrap gap-6 text-sm items-center">
            <span>PDF <b>{{ pdfCompare.total.pdfTrips }}</b> 便 <b>{{ yen(pdfCompare.total.pdfYen) }}</b></span>
            <span>画面 <b>{{ pdfCompare.total.screenTrips }}</b> 便 <b>{{ yen(pdfCompare.total.screenYen) }}</b></span>
            <span :class="pdfCompare.total.screenYen - pdfCompare.total.pdfYen !== 0 ? 'text-amber-600 dark:text-amber-400' : ''">
              差 <b>{{ pdfCompare.total.screenTrips - pdfCompare.total.pdfTrips }}</b> 便
              <b>{{ yen(pdfCompare.total.screenYen - pdfCompare.total.pdfYen) }}</b>
            </span>
            <span>一致 <b>{{ pdfCompare.total.matched }}</b></span>
            <span :class="pdfCompare.total.pdfOnly > 0 ? 'text-amber-600 dark:text-amber-400' : ''">
              PDFのみ <b>{{ pdfCompare.total.pdfOnly }}</b> ({{ yen(pdfCompare.total.pdfOnlyYen) }})
            </span>
            <span :class="pdfCompare.total.screenOnly > 0 ? 'text-amber-600 dark:text-amber-400' : ''">
              画面のみ <b>{{ pdfCompare.total.screenOnly }}</b> ({{ yen(pdfCompare.total.screenOnlyYen) }})
            </span>
            <span :class="pdfCompare.total.amountDiff > 0 ? 'text-red-600 dark:text-red-400' : ''">
              金額違い <b>{{ pdfCompare.total.amountDiff }}</b> ({{ yen(pdfCompare.total.amountDiffYen) }})
            </span>
            <span
              v-if="pdfCompare.total.overpaid > 0"
              class="text-purple-600 dark:text-purple-400"
              title="手当表PDF 側が誤っていると人が確認した便。金額違いには数えていません"
            >
              過払い <b>{{ pdfCompare.total.overpaid }}</b> ({{ yen(pdfCompare.total.overpaidYen) }})
            </span>
            <span class="text-gray-400" title="経路は合うが日付が 1 日ずれて当てた便 / 日付は合うが経路が違うのに当てた便">
              1日ずれ {{ pdfCompare.total.dateShift }} ・ 経路違い {{ pdfCompare.total.routeDiff }}
            </span>
          </div>

          <div class="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
            <table class="w-full">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">PDF 便</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">PDF 手当</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">画面 便</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">画面 手当</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">差</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">一致</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500" title="PDF にあって画面に無い便">PDFのみ</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500" title="画面にあって PDF に無い便">画面のみ</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">金額違い</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500" title="手当表PDF 側が誤っていると確認した便">過払い</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in pdfCompareDrivers" :key="d.driverName" class="border-t border-gray-100 dark:border-gray-800/70">
                  <td class="px-3 py-1 whitespace-nowrap font-medium">{{ d.driverName }}</td>
                  <td class="px-3 py-1 text-right">{{ d.pdfTrips }}</td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(d.pdfYen) }}</td>
                  <td class="px-3 py-1 text-right">{{ d.screenTrips }}</td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(d.screenYen) }}</td>
                  <td
                    class="px-3 py-1 text-right whitespace-nowrap"
                    :class="d.screenYen - d.pdfYen !== 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                  >
                    {{ yen(d.screenYen - d.pdfYen) }}
                  </td>
                  <td class="px-3 py-1 text-right">{{ d.matched }}</td>
                  <td class="px-3 py-1 text-right" :class="d.pdfOnly > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'">
                    {{ d.pdfOnly }}
                  </td>
                  <td class="px-3 py-1 text-right" :class="d.screenOnly > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'">
                    {{ d.screenOnly }}
                  </td>
                  <td
                    class="px-3 py-1 text-right whitespace-nowrap"
                    :class="d.amountDiff > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-300 dark:text-gray-700'"
                  >
                    {{ d.amountDiff }}<span v-if="d.amountDiff > 0"> ({{ yen(d.amountDiffYen) }})</span>
                  </td>
                  <td
                    class="px-3 py-1 text-right whitespace-nowrap"
                    :class="d.overpaid > 0 ? 'text-purple-600 dark:text-purple-400' : 'text-gray-300 dark:text-gray-700'"
                  >
                    {{ d.overpaid }}<span v-if="d.overpaid > 0"> ({{ yen(d.overpaidYen) }})</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              PDF にあって画面に無い便
              <b :class="pdfOnlyEntries.length > 0 ? 'text-amber-600 dark:text-amber-400' : ''">{{ pdfOnlyEntries.length }}</b> 便
              <span class="text-gray-400">(デジタコに運行が無い日か、alc への取り込み漏れ)</span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">日付</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">経路 (PDF)</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当 (PDF)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(e, i) in pdfOnlyEntries" :key="`po-${i}`" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ e.pdfDate }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ e.driverName }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ routeText(e.pdfRoute) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(e.pdfYen) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              画面にあって PDF に無い便
              <b :class="screenOnlyEntries.length > 0 ? 'text-amber-600 dark:text-amber-400' : ''">{{ screenOnlyEntries.length }}</b> 便
              <span class="text-gray-400">(便の切り出しすぎか、PDF の転記漏れ)</span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">日付</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">経路 (画面)</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当 (画面)</th>
                    <th class="px-3 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(e, i) in screenOnlyEntries" :key="`so-${i}`" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ e.screenDate }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ e.driverName }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ routeText(e.screenRoute) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(e.screenYen) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">
                      <button class="text-blue-500 hover:text-blue-700 hover:underline" @click="openOperation(e.unkoNo)">
                        運行を開く
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              当たったが金額が違う便
              <b :class="pdfAmountDiffs.length > 0 ? 'text-red-600 dark:text-red-400' : ''">{{ pdfAmountDiffs.length }}</b> 便
              <span class="text-gray-400">
                (料金マスタか卸地の引き当てを疑う。暫定額もここに出ます。
                実データで<b>PDF 側が誤っている</b>と分かったら「過払いにする」で下へ移せます)
              </span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">日付</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">経路 (PDF)</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">経路 (画面)</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">PDF</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">画面</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">差</th>
                    <th class="px-3 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(e, i) in pdfAmountDiffs" :key="`ad-${i}`" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ e.pdfDate }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ e.driverName }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ routeText(e.pdfRoute) }}</td>
                    <td class="px-3 py-1 whitespace-nowrap" :class="e.routeDiff ? 'text-amber-600 dark:text-amber-400' : ''">
                      {{ routeText(e.screenRoute) }}
                    </td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(e.pdfYen) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(e.screenYen) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap text-red-600 dark:text-red-400">{{ yen(e.diffYen) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap space-x-3">
                      <button class="text-blue-500 hover:text-blue-700 hover:underline" @click="openOperation(e.unkoNo)">
                        運行を開く
                      </button>
                      <button
                        class="text-purple-500 hover:text-purple-700 hover:underline"
                        title="デジタコ・一番星の実データで画面側が正しいと確かめた便に付けます。金額違いから抜けて「過払い」に移ります"
                        @click="onToggleOverpaid(e)"
                      >
                        過払いにする
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <details
            v-if="pdfOverpaidEntries.length > 0 || staleOverpaid.length > 0"
            class="border border-gray-200 dark:border-gray-800 rounded-lg"
          >
            <summary class="px-3 py-2 cursor-pointer select-none">
              手当表PDF 側の過払い
              <b class="text-purple-600 dark:text-purple-400">{{ pdfOverpaidEntries.length }}</b> 便
              <b class="text-purple-600 dark:text-purple-400">{{ yen(pdfOverpaidYen) }}</b>
              <span class="text-gray-400">(画面側が正しいと確かめた便。金額違いには数えていません)</span>
            </summary>
            <div class="border-t border-gray-100 dark:border-gray-800 px-3 py-2 space-y-2">
              <p class="text-gray-500">
                手当表PDF は<b>給与の正本</b>ですが、<b>正本が間違っていることがあります</b>。
                デジタコの<b>卸地の住所</b>と<b>一番星の明細</b>の両方が画面側の金額を指しているのに
                手当表だけ違う便に、この印を付けます。<b>実データで裏を取ってから付けてください</b> —
                画面をPDFに寄せて直すと、同じ経路の他の便まで一緒に化けます。
                印はこのブラウザに保存され、<b>氏名・日付・その日の何便目か</b>で便を指します。
                <b>黙って消してはいません</b> — いつでも戻せます。
              </p>

              <p v-if="staleOverpaid.length > 0" class="text-amber-600 dark:text-amber-400">
                <b>{{ staleOverpaid.length }} 件</b>の印が、いまの便に当たっていません
                (同じ便番号に<b>別の経路・別の金額</b>が来ているので、<b>PDF の CSV を起こし直した</b>疑いがあります)。
                中身を確かめて、要らなければ消してください。
              </p>
              <ul v-if="staleOverpaid.length > 0" class="space-y-1">
                <li v-for="key in staleOverpaid" :key="key" class="flex flex-wrap items-center gap-2">
                  <code class="font-mono text-[11px]">{{ overpaidKeyText(key) }}</code>
                  <button class="text-purple-500 hover:text-purple-700 hover:underline" @click="onDropOverpaid(key)">
                    この印を消す
                  </button>
                </li>
              </ul>

              <div v-if="pdfOverpaidEntries.length > 0" class="overflow-x-auto">
                <table class="w-full">
                  <thead class="bg-gray-50 dark:bg-gray-800">
                    <tr>
                      <th class="text-left px-3 py-1.5 font-medium text-gray-500">日付</th>
                      <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                      <th class="text-right px-3 py-1.5 font-medium text-gray-500">便</th>
                      <th class="text-left px-3 py-1.5 font-medium text-gray-500">経路 (PDF)</th>
                      <th class="text-left px-3 py-1.5 font-medium text-gray-500">経路 (画面)</th>
                      <th class="text-right px-3 py-1.5 font-medium text-gray-500">PDF</th>
                      <th class="text-right px-3 py-1.5 font-medium text-gray-500">画面</th>
                      <th class="text-right px-3 py-1.5 font-medium text-gray-500">差</th>
                      <th class="px-3 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(e, i) in pdfOverpaidEntries" :key="`op-${i}`" class="border-t border-gray-100 dark:border-gray-800/70">
                      <td class="px-3 py-1 whitespace-nowrap">{{ e.pdfDate }}</td>
                      <td class="px-3 py-1 whitespace-nowrap">{{ e.driverName }}</td>
                      <td class="px-3 py-1 text-right whitespace-nowrap text-gray-500">{{ e.pdfSeq }}</td>
                      <td class="px-3 py-1 whitespace-nowrap">{{ routeText(e.pdfRoute) }}</td>
                      <td class="px-3 py-1 whitespace-nowrap">{{ routeText(e.screenRoute) }}</td>
                      <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(e.pdfYen) }}</td>
                      <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(e.screenYen) }}</td>
                      <td class="px-3 py-1 text-right whitespace-nowrap text-purple-600 dark:text-purple-400">{{ yen(e.diffYen) }}</td>
                      <td class="px-3 py-1 text-right whitespace-nowrap space-x-3">
                        <button class="text-blue-500 hover:text-blue-700 hover:underline" @click="openOperation(e.unkoNo)">
                          運行を開く
                        </button>
                        <button class="text-purple-500 hover:text-purple-700 hover:underline" @click="onToggleOverpaid(e)">
                          戻す
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </details>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              ゆるく当てた便 <b>{{ pdfLooseMatches.length }}</b> 便
              <span class="text-gray-400">(日付が 1 日ずれた / 経路が違うのに同じ日で当てた。合計には入れています)</span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">PDF 日付</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">画面 日付</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">経路 (PDF)</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">経路 (画面)</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">当て方</th>
                    <th class="px-3 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(e, i) in pdfLooseMatches" :key="`lm-${i}`" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ e.driverName }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ e.pdfDate }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ e.screenDate }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ routeText(e.pdfRoute) }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ routeText(e.screenRoute) }}</td>
                    <td class="px-3 py-1 whitespace-nowrap text-amber-600 dark:text-amber-400">
                      {{ e.dateShift ? '1日ずれ' : '経路違い' }}
                    </td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">
                      <button class="text-blue-500 hover:text-blue-700 hover:underline" @click="openOperation(e.unkoNo)">
                        運行を開く
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </div>

        <div v-if="unresolvedRoutes.length > 0" class="mt-6 space-y-2 text-xs">
          <h2 class="text-sm font-semibold">手当が決まらない経路</h2>
          <p class="text-gray-500">
            料金・給与マスタ (xlsx) に無い経路です。<b>金額が分かっているなら暫定額を入れられます</b> —
            入れると上の手当・収支に<b>入り</b>ますが、<b>「うち暫定」として別に数え続けます</b>。
            経路ごとに効くので、同じ経路の便は一度入れれば全部そろいます。
            <b>直し方が正反対</b>なので状態も見てください —
            <code>unknown</code> は料金表に行を足せば直り、<code>ambiguous</code> は同じ経路に違う金額があるので人が決めるしかありません。
          </p>
          <div class="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
            <table class="w-full">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">経路 (積地 → 卸地)</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">便</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">暫定の手当 (円/便)</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">小計</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="route in unresolvedRoutes" :key="route.key" class="border-t border-gray-100 dark:border-gray-800/70">
                  <td class="px-3 py-1 whitespace-nowrap">{{ route.label }}</td>
                  <td class="px-3 py-1 text-right">{{ route.trips }}</td>
                  <td class="px-3 py-1">
                    <input
                      :value="route.yen ?? ''"
                      type="number"
                      min="0"
                      step="500"
                      placeholder="9000"
                      class="w-28 border rounded px-2 py-0.5 dark:bg-gray-900"
                      @change="onProvisionalInput(route.key, ($event.target as HTMLInputElement).value)"
                    >
                  </td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">
                    <span v-if="route.yen !== null" class="text-amber-600 dark:text-amber-400">
                      {{ yen(route.yen * route.trips) }}
                    </span>
                    <span v-else class="text-gray-400">-</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="excludedRows.length > 0 || staleExclusions.length > 0" class="mt-6 space-y-2 text-xs">
          <h2 class="text-sm font-semibold">除外した便</h2>
          <p class="text-gray-500">
            <b>「便ではない」と印を付けて外した積み</b>です。デジタコには<b>降しが 1 つも無い積み</b>が混ざり、
            卸地が永久に決まらない便として残ります (実例 <code>2607152258300000001318</code> の 便3)。
            ここに出ている便は<b>便数・手当・売上・収支・未確定のどの合計にも入っていません</b>。
            <b>黙って消してはいません</b> — いつでも戻せます。
            印はこのブラウザに保存され、<b>積みの開始日時</b>で便を指しているので、イベントCSV を取り直しても同じ便に付いたままです。
          </p>

          <p v-if="staleExclusions.length > 0" class="text-amber-600 dark:text-amber-400">
            <b>{{ staleExclusions.length }} 件</b>の除外が、いまの便に当たっていません
            (同じ運行は集計に居るので、<b>イベントCSV が変わって積みが動いた</b>疑いがあります)。
            中身を確かめて、要らなければ外してください。
          </p>
          <ul v-if="staleExclusions.length > 0" class="space-y-1">
            <li v-for="key in staleExclusions" :key="key" class="flex flex-wrap items-center gap-2">
              <code class="font-mono text-[11px]">{{ key }}</code>
              <button class="text-blue-500 hover:text-blue-700 hover:underline" @click="openOperation(unkoNoOfKey(key))">
                運行を開く
              </button>
              <button class="text-purple-500 hover:text-purple-700 hover:underline" @click="toggleExclusion(key)">
                この除外を消す
              </button>
            </li>
          </ul>

          <div v-if="excludedRows.length > 0" class="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
            <table class="w-full">
              <thead class="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">日付</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">車輌</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">便</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">積地 → 卸地</th>
                  <th class="text-left px-3 py-1.5 font-medium text-gray-500">マスタ卸地</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当</th>
                  <th class="text-right px-3 py-1.5 font-medium text-gray-500">売上</th>
                  <th class="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in excludedRows" :key="excludedKey(r)" class="border-t border-gray-100 dark:border-gray-800/70">
                  <td class="px-3 py-1 whitespace-nowrap">{{ r.date }}</td>
                  <td class="px-3 py-1 whitespace-nowrap">{{ r.driverName }}</td>
                  <td class="px-3 py-1 whitespace-nowrap">{{ r.vehicleName }}</td>
                  <td class="px-3 py-1 text-right">{{ r.seq }}</td>
                  <td class="px-3 py-1">{{ r.originCity || '?' }} → {{ r.destCity || '?' }}</td>
                  <td class="px-3 py-1">{{ r.masterDest || '-' }}</td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">
                    <span :class="legPayLabel(r).warn ? 'text-amber-600 dark:text-amber-400' : ''">{{ legPayLabel(r).text }}</span>
                  </td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(legSalesYen(r)) }}</td>
                  <td class="px-3 py-1 text-right whitespace-nowrap">
                    <button class="text-blue-500 hover:text-blue-700 hover:underline mr-3" @click="openOperation(r.unkoNo)">
                      運行を開く
                    </button>
                    <button class="text-purple-500 hover:text-purple-700 hover:underline" @click="toggleRowExclusion(r)">
                      戻す
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div v-if="hasSales" class="mt-6 space-y-2 text-xs">
          <h2 class="text-sm font-semibold">突合できなかったもの</h2>
          <p class="text-gray-500">
            ここに出ているものは<b>売上・収支の合計に入っていません</b> (単価の食い違いを除く)。
            便と明細のどちらが正しいかは人が決めます。
          </p>
          <p class="text-gray-500">
            上の収支は<b>デジタコで見えている運行だけの収支</b>で、その乗務員の月の収支ではありません。
            <b>デジタコ非搭載の車輌に乗った日</b>は運行が 1 件も無いので便が作れず、売上だけが下の
            「どの便にも当たらなかった一番星明細」に残ります。<b>これは欠陥ではなく、追いかける対象でもありません。</b>
          </p>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              一番星に対応する明細が無い便
              <b :class="unmatchedLegs.length > 0 ? 'text-amber-600 dark:text-amber-400' : ''">{{ unmatchedLegs.length }}</b> 便
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">日付</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">車輌</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">積地 → 卸地</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">マスタ卸地</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">手当</th>
                    <th class="px-3 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in unmatchedLegs" :key="legKey(r)" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ r.date }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ r.driverName }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ r.vehicleName }}</td>
                    <td class="px-3 py-1">{{ r.originCity || '?' }} → {{ r.destCity || '?' }}</td>
                    <td class="px-3 py-1">{{ r.masterDest || '-' }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">
                      <span :class="legPayLabel(r).warn ? 'text-amber-600 dark:text-amber-400' : ''">{{ legPayLabel(r).text }}</span>
                    </td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">
                      <button class="text-blue-500 hover:text-blue-700 hover:underline" @click="openOperation(r.unkoNo)">
                        運行を開く
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              どの便にも当たらなかった一番星明細
              <b>{{ leftoverSlips.length }}</b> 本 = <b>{{ yen(leftoverYen) }}</b>
              <span class="text-gray-400">
                (収支の外。デジタコ非搭載の車輌に乗った日はここに出るのが正常です。
                受け皿の車番の残りは含みません)
              </span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">車輌C</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">売上年月日</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">得意先</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">着地</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">銘柄</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">数量</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">単価</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">売上</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="l in leftoverSlips" :key="l.slip.rowId" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.slip.vehicleNumber }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.slip.saleDate }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.slip.customerName }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.slip.dest }}<span class="text-gray-400"> ({{ l.slip.destAreaName }})</span></td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ l.slip.itemName }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ tons(l.slip.quantity) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(l.slip.unitPrice) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(l.slip.amount) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              マスタの運賃と単価が食い違う明細
              <b :class="fareMismatches.length > 0 ? 'text-amber-600 dark:text-amber-400' : ''">{{ fareMismatches.length }}</b> 本
              <span class="text-gray-400">(料金改定か入力ミスの疑い。売上は一番星の金額をそのまま使っています)</span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">売上年月日</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">着地</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">銘柄</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">数量</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">一番星の単価</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">マスタの運賃</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(f, i) in fareMismatches" :key="`${f.legKey}-${f.itemName}-${i}`" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.date }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.driverName || '(便に無し)' }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.dest }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.itemName }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ tons(f.quantity) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap text-amber-600 dark:text-amber-400">{{ yen(f.unitPrice) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ f.masterFares.map(v => yen(v)).join(' / ') }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>

          <details class="border border-gray-200 dark:border-gray-800 rounded-lg">
            <summary class="px-3 py-2 cursor-pointer select-none">
              マスタに無い銘柄・経路 (対象外) <b>{{ outOfMaster.length }}</b> 本
              <span class="text-gray-400">(肉牛・素牛・N搾乳 等。料金表が A飼料 系しか無いための対象外で、未確定とは別)</span>
            </summary>
            <div class="overflow-x-auto border-t border-gray-100 dark:border-gray-800">
              <table class="w-full">
                <thead class="bg-gray-50 dark:bg-gray-800">
                  <tr>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">売上年月日</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">乗務員</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">着地</th>
                    <th class="text-left px-3 py-1.5 font-medium text-gray-500">銘柄</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">数量</th>
                    <th class="text-right px-3 py-1.5 font-medium text-gray-500">単価</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(f, i) in outOfMaster" :key="`${f.legKey}-${f.itemName}-${i}`" class="border-t border-gray-100 dark:border-gray-800/70">
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.date }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.driverName || '(便に無し)' }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.dest }}</td>
                    <td class="px-3 py-1 whitespace-nowrap">{{ f.itemName }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ tons(f.quantity) }}</td>
                    <td class="px-3 py-1 text-right whitespace-nowrap">{{ yen(f.unitPrice) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </template>
    </template>

    <AllowanceOperationModal
      v-if="modalTarget"
      v-bind="modalTarget"
      :provisional="provisional"
      :excluded="excluded"
      @close="modalUnkoNo = null"
      @update-provisional="onProvisionalInput"
      @toggle-exclude="toggleExclusion"
    />
  </div>
</template>
