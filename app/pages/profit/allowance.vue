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
 * マスタで金額が決まらない便 (未確定) は合計に入れず、各段に件数を出す。
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
 * 起こしたぶんは**デジタコ由来と混ぜず**、別に数えて「合計 (デジタコ + 一番星)」で足す。
 */
import { getOperations, getOperationCsv, getDrivers } from '~/utils/api'
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
  EXCLUDED_KEY,
  parseExcluded,
  serializeExcluded,
  toggleExcluded,
  excludedKey,
  applyExclusions,
  staleExclusionKeys,
  unkoNoOfKey,
  type ExcludedMap,
} from '~/utils/allowance-excluded'
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
  routeText,
  type PdfTripFile,
} from '~/utils/allowance-pdf-compare'
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
}

/** 入力欄 (文字列) → 円。空・数でない値は「消す」扱いの 0 にする。 */
function onProvisionalInput(key: string, raw: string) {
  saveProvisional(key, Math.trunc(Number(raw)) || 0)
}

/**
 * **便ではない積み**に印を付けて集計から外す (キー → true)。
 *
 * デジタコには「実際には積んでいない積み」が混ざり、降しが 1 つも無い便として
 * 残り続ける (実例 `2607152258300000001318` の 便3)。**黙って消さない** —
 * 外した件数を出し、下の一覧から戻せるようにする。
 */
const excluded = ref<ExcludedMap>({})

function persistExcluded(next: ExcludedMap) {
  excluded.value = next
  try {
    localStorage.setItem(EXCLUDED_KEY, serializeExcluded(next))
  }
  catch (e) {
    cacheNote.value = `除外を保存できませんでした — ${e instanceof Error ? e.message : String(e)}`
  }
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

const yen = (v: number | null) => (v === null ? '-' : `¥${v.toLocaleString()}`)
const tons = (v: number) => `${Math.round(v * 100) / 100}t`

/** 除外を当てる**前**の集計。モーダル (外した便を戻す場所) と、当たらなくなった
 * 除外の検出はこちらを見る。 */
const monthlyAll = computed(() => buildMonthlyAllowance(operations.value, shownYm.value))
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
/** 引いた一番星の明細 (鍵は `driver:<CD>` か 車番)。**便を起こすのに使う。** */
const slipsByKey = ref<Record<string, VehicleDailySlip[]>>({})

const byLeg = computed(() => reconciled.value?.byLeg ?? new Map<string, LegReconcile>())
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

/** 1 便の「支払う手当」= 確定があればそれ、無ければ暫定。どちらも無ければ null。 */
function legPayYen(r: AllowanceReportRow): number | null {
  if (r.allowanceYen !== null) return r.allowanceYen
  return legProvisionalYen(r)
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
    const slips = slipsByKey.value[driverSlipKey(cd)] ?? []
    // **デジタコ便がある `日付|積地`。** その積地に残った明細は複数卸しの片割れ。
    const coveredOrigins = new Set(d.operations.flatMap(op => op.rows
      .map(r => `${r.date}|${cityToPlace(addressToCity(r.originCity))}`)))
    out.push(...buildIchibanLegs(d.driverName, slips, used, coveredOrigins, shownYm.value, provisional.value))
  }
  return out
})
const ichibanTotals = computed(() => summarizeIchibanLegs(ichibanLegs.value))

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

/** デジタコ由来 + 一番星から起こしたぶん の合計。**画面で足して見せるのはここだけ。** */
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
  ])
})
/** PDF の月と集計中の月が違う。押す前に気付けるように出す。 */
const pdfMonthMismatch = computed(() =>
  pdfFile.value !== null && status.value === 'ready' && pdfFile.value.ym !== shownYm.value)

const pdfOnlyEntries = computed(() => (pdfCompare.value?.entries ?? []).filter(e => e.status === 'pdf_only'))
const screenOnlyEntries = computed(() => (pdfCompare.value?.entries ?? []).filter(e => e.status === 'screen_only'))
const pdfAmountDiffs = computed(() => (pdfCompare.value?.entries ?? [])
  .filter(e => e.status === 'matched' && e.diffYen !== null && e.diffYen !== 0))
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
  return op.irregularTrips > 0 || op.error !== null
}
function driverHasIssue(d: DriverNode): boolean {
  return d.irregularTrips > 0 || d.failedOperations > 0
}

const visibleDrivers = computed(() => (onlyIrregular.value
  ? monthly.value.drivers.filter(driverHasIssue)
  : monthly.value.drivers))

function visibleOperations(d: DriverNode): OperationNode[] {
  return onlyIrregular.value ? d.operations.filter(opHasIssue) : d.operations
}
function visibleRows(op: OperationNode): AllowanceReportRow[] {
  return onlyIrregular.value ? op.rows.filter(r => r.status !== 'ok') : op.rows
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
      salesError.value = e instanceof Error ? e.message : String(e)
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
      乗務員 → 運行 → 便 の順に開けます。マスタで金額が決まらない便は合計に入れず「未確定」に数えます。
      突合できなかった便・明細と、マスタの運賃と単価が食い違う明細は、下に件数と一覧で出します。
      <b>降しが 1 つも無い積み</b>のような実在しない便は、便の行 (または運行を開いたところ) の
      <b>除外</b>で集計から外せます。外した便は<b>下の「除外した便」から戻せます</b>。
      <b>手当表PDF から起こした CSV</b> を読み込むと、便単位で突き合わせて差分を出します。
      売上は<b>対象乗務員を指定していれば乗務員CD で引きます</b> — その乗務員が
      <b>別の車番で走った日</b>の売上も入ります (車番で引くと丸ごと落ちます)。
      <b>デジタコに運行が 1 件も無い日</b>は、一番星の明細から便を起こして
      「合計 (デジタコ + 一番星)」に足します。
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
          <span>便 <b>{{ monthly.trips }}</b></span>
          <span>
            手当 <b>{{ yen(monthly.totalYen + monthProvisional.yen) }}</b>
            <span
              v-if="monthProvisional.trips > 0"
              class="text-amber-600 dark:text-amber-400"
              title="マスタに無いので手で入れた暫定額。上の手当・収支に含まれています"
            >うち暫定 {{ yen(monthProvisional.yen) }} ({{ monthProvisional.trips }}便)</span>
          </span>
          <span>売上 <b>{{ hasSales ? yen(monthSales.salesYen) : '-' }}</b></span>
          <span>収支 <b :class="margin(monthSales.salesYen, monthly.totalYen + monthProvisional.yen) < 0 ? 'text-red-600 dark:text-red-400' : ''">
            {{ hasSales ? yen(margin(monthSales.salesYen, monthly.totalYen + monthProvisional.yen)) : '-' }}
          </b></span>
          <span :class="monthly.irregularTrips > 0 ? 'text-amber-600 dark:text-amber-400' : ''">
            未確定 <b>{{ monthly.irregularTrips }}</b> 便
          </span>
          <span
            v-if="ichibanTotals.trips > 0"
            class="text-teal-600 dark:text-teal-400"
            title="デジタコに運行が無い日の便を、一番星の明細から起こしたぶん。上の便数・手当・売上・収支には入っていません (下の「合計」に入ります)"
          >
            一番星から <b>{{ ichibanTotals.trips }}</b> 便
            (手当 {{ yen(ichibanTotals.allowanceYen) }}<span
              v-if="ichibanTotals.provisionalTrips > 0"
            > うち暫定 {{ yen(ichibanTotals.provisionalYen) }} ({{ ichibanTotals.provisionalTrips }}便)</span>
            ・ 売上 {{ yen(ichibanTotals.salesYen) }}<span
              v-if="ichibanTotals.unknownTrips > 0"
            > ・未確定 {{ ichibanTotals.unknownTrips }}</span>)
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

        <div v-if="ichibanTotals.trips > 0" class="mb-3 flex flex-wrap gap-6 text-sm items-center border-t border-gray-200 dark:border-gray-800 pt-2">
          <span class="font-semibold">合計 (デジタコ + 一番星)</span>
          <span>便 <b>{{ combined.trips }}</b></span>
          <span>手当 <b>{{ yen(combined.allowanceYen) }}</b></span>
          <span>売上 <b>{{ hasSales ? yen(combined.salesYen) : '-' }}</b></span>
          <span>収支 <b :class="combined.marginYen < 0 ? 'text-red-600 dark:text-red-400' : ''">
            {{ hasSales ? yen(combined.marginYen) : '-' }}
          </b></span>
          <span class="text-gray-400">
            デジタコから {{ monthly.trips + monthProvisional.trips }} 便 ・
            一番星から {{ ichibanTotals.trips }} 便
          </span>
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
                  <td class="px-3 py-2 text-right">{{ d.trips }}</td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">
                    {{ yen(d.totalYen + driverProvisional(d).yen) }}
                    <span
                      v-if="driverProvisional(d).trips > 0"
                      class="text-amber-600 dark:text-amber-400"
                      :title="`うち暫定 ${yen(driverProvisional(d).yen)} (${driverProvisional(d).trips}便)`"
                    >暫定</span>
                  </td>
                  <td class="px-3 py-2 text-right whitespace-nowrap">
                    {{ hasSales ? yen(driverSales(d).salesYen) : '-' }}
                  </td>
                  <td
                    class="px-3 py-2 text-right whitespace-nowrap"
                    :class="margin(driverSales(d).salesYen, d.totalYen + driverProvisional(d).yen) < 0 ? 'text-red-600 dark:text-red-400' : ''"
                  >
                    {{ hasSales ? yen(margin(driverSales(d).salesYen, d.totalYen + driverProvisional(d).yen)) : '-' }}
                  </td>
                  <td
                    class="px-3 py-2 text-right"
                    :class="driverHasIssue(d) ? 'text-amber-600 dark:text-amber-400' : 'text-gray-300 dark:text-gray-700'"
                  >
                    {{ d.irregularTrips }}<span v-if="d.failedOperations > 0"> + 運行{{ d.failedOperations }}</span>
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
                              {{ op.irregularTrips }}
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
                                    :class="r.status !== 'ok' ? 'bg-amber-50 dark:bg-amber-950/30' : ''"
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
                      </tbody>
                    </table>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
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
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in pdfCompare.drivers" :key="d.driverName" class="border-t border-gray-100 dark:border-gray-800/70">
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
                  <td class="px-3 py-1 text-right" :class="d.amountDiff > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-300 dark:text-gray-700'">
                    {{ d.amountDiff }}
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
              <span class="text-gray-400">(料金マスタか卸地の引き当てを疑う。暫定額もここに出ます)</span>
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
