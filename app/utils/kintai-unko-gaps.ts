/**
 * 取り込み漏れ候補 (`also_in_month`) の運行NO一覧の表示用 pure ロジック (Refs #623-2)。
 *
 * `GET /restraint-api/kintai/unko-gaps` (relay
 * `workers/dtako-scraper-relay/src/kintai-relay.ts` の `relayKintaiUnkoGaps`。
 * 受け側は rust-ichibanboshi `src/routes/unko_gaps.rs` 想定) の応答を読む。
 * **新しい計算はしない** — 受け側の分類 (`also_in_month`) をそのまま一覧にするだけ。
 *
 * ★ この口は遅い (alc への etags 往復を含む)。**この module 自体は呼び出しタイミングを
 * 制御しない** — 呼ぶかどうかは画面側 (ボタン) の責務。
 *
 * ★ 「無い」と「引けていない」の区別 (#620/#615-7 と同型):
 * - `gcp_etags_available: false` = GCP側の運行一覧が引けていない
 * - `driver_cds_available: false` = alc が driver_cds を返していない (**正常に空**なこともある)
 * どちらかが false のときに「候補なし」と丸めないこと — [`kintaiUnkoGapsReadability`] を参照。
 *
 * すべて `unknown` を受けて防御的に読む (root `npm install` が通らず front は CI が
 * 初検証のため、実行時前提を増やさない — CLAUDE.md の規範)。
 */

export interface KintaiUnkoGapsDriverEntry {
  driverCd: string
  unkoNos: string[]
  truncated: boolean
}

export interface KintaiUnkoGaps {
  month: string | null
  driverCd: string | null
  gcpEtagsAvailable: boolean | null
  driverCdsAvailable: boolean | null
  /** 受け口が返す運行NOの桁数。**GCP側 (22桁) を前提にする** — 23桁を捏造しないための拠り所。 */
  unkoNoDigits: number | null
  drivers: KintaiUnkoGapsDriverEntry[]
  driversTruncated: boolean
  unknownDriverUnkoNos: string[]
  unknownDriverUnkoNosTruncated: boolean
  elapsedMs: number | null
}

function toBoolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function toNumberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function toStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * `driver_cd` は口によって表現が違う (★ #630-1 の原因)。
 * 受け口 (`unko_gaps.rs`) は `drivers[].driver_cd` を **文字列** (`HashMap<String, _>`
 * 由来) で返す一方、絞り込み指定の echo (`driver_cd` トップレベル) は `Option<i64>`
 * = **数値 or null**。ここで数値表現に固定すると `drivers[]` が丸ごと弾かれて
 * 「候補はありません」に化ける (本番実測、乗務員 1445/1740 が両方消えた) — 両方
 * 受けて文字列に揃える。
 */
function toDriverCdString(v: unknown): string | null {
  if (typeof v === 'string') {
    const s = v.trim()
    return s.length > 0 ? s : null
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function parseDriverEntry(raw: unknown): KintaiUnkoGapsDriverEntry | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const driverCd = toDriverCdString(r.driver_cd)
  if (driverCd === null) return null
  return {
    driverCd,
    unkoNos: toStringArray(r.unko_nos),
    truncated: r.truncated === true,
  }
}

/** `GET /restraint-api/kintai/unko-gaps` の応答をそのまま camelCase に読み替える。
 * 壊れた形は空 (`drivers: []`、可用性フラグは `null`) に倒す — 呼び出し側は
 * `null` を「引けていない」と同じ扱い (丸めない) にすること。 */
export function parseKintaiUnkoGaps(raw: unknown): KintaiUnkoGaps {
  const r = (raw ?? {}) as Record<string, unknown>
  const driversRaw = Array.isArray(r.drivers) ? r.drivers : []
  return {
    month: typeof r.month === 'string' ? r.month : null,
    driverCd: toDriverCdString(r.driver_cd),
    gcpEtagsAvailable: toBoolOrNull(r.gcp_etags_available),
    driverCdsAvailable: toBoolOrNull(r.driver_cds_available),
    unkoNoDigits: toNumberOrNull(r.unko_no_digits),
    drivers: driversRaw
      .map(parseDriverEntry)
      .filter((d): d is KintaiUnkoGapsDriverEntry => d !== null),
    driversTruncated: r.drivers_truncated === true,
    unknownDriverUnkoNos: toStringArray(r.unknown_driver_unko_nos),
    unknownDriverUnkoNosTruncated: r.unknown_driver_unko_nos_truncated === true,
    elapsedMs: toNumberOrNull(r.elapsed_ms),
  }
}

/**
 * 「候補なし」と表示していい状態かどうか (#620/#615-7 と同型の区別)。
 *
 * - `ok`: 両方 `true`。件数をそのまま信じてよい
 * - `etags_unavailable`: GCP側の運行一覧が引けていない — 候補は**不明**、0件ではない
 * - `driver_cds_unavailable`: alc が driver_cds を返していない — **正常に空のこともある**が、
 *   「取り込み漏れ0件」と断定はできない
 *
 * ★ **`true` 以外はすべて「引けていない」扱いにする** (`=== false` ではなく `!== true`)。
 * 欠落・`null`・型不一致 (壊れた応答・上流の形変更) を `'ok'` に倒すと、画面が
 * 「取り込み漏れの候補はありません」と静かに嘘をつく (親指摘、PR #628 CI で捕まった)。
 *
 * 両方 `true` でないならより重い `etags_unavailable` を優先する。
 */
export type KintaiUnkoGapsReadability = 'ok' | 'etags_unavailable' | 'driver_cds_unavailable'

export function kintaiUnkoGapsReadability(g: KintaiUnkoGaps): KintaiUnkoGapsReadability {
  if (g.gcpEtagsAvailable !== true) return 'etags_unavailable'
  if (g.driverCdsAvailable !== true) return 'driver_cds_unavailable'
  return 'ok'
}

/** 一覧に出す運行NOの延べ件数 (乗務員別 + 対象乗務員不明ぶんの内訳は別に見せる)。 */
export function kintaiUnkoGapsDriverTotalCount(g: KintaiUnkoGaps): number {
  return g.drivers.reduce((sum, d) => sum + d.unkoNos.length, 0)
}

const UNKO_NO_22_RE = /^\d{22}$/
const UNKO_NO_23_RE = /^\d{23}$/

/**
 * 運行NOの先頭12桁 (開始日時 `YYMMDDHHMMSS`) から `start_ope` 相当の表示文字列を作る
 * (`"YYYY/MM/DD H:mm:ss"`、時は0埋めなし)。**表示専用** — ③のフォームへ送る値の
 * 生成ではない (23桁の対象CDが無いと送れないため、relay 側
 * `deriveOpeNoFromUnkoNo` と同じ導出を前提知識として見せるだけ)。
 *
 * 22桁・23桁のどちらでもない入力は `null`。
 */
export function kintaiUnkoGapsDeriveStartOpe(unkoNo: string): string | null {
  if (!UNKO_NO_22_RE.test(unkoNo) && !UNKO_NO_23_RE.test(unkoNo)) return null
  const prefix = unkoNo.slice(0, 12)
  const yy = Number(prefix.slice(0, 2))
  const mm = prefix.slice(2, 4)
  const dd = prefix.slice(4, 6)
  const hh = Number(prefix.slice(6, 8))
  const mi = prefix.slice(8, 10)
  const ss = prefix.slice(10, 12)
  const year = 2000 + yy
  return `${year}/${mm}/${dd} ${hh}:${mi}:${ss}`
}

// ─────────────────────────────────────────────────────────────────────────
// 候補ごとの「オンプレにデジタコ (dtako_events) が在るか」チェック (Refs #633-1
// 条件8〜14、親が実測で確定した原因への対応)。
//
// ★ 原因 (親の実測、2026-08-04): `unko-gaps` の「オンプレ側」は
// `source = ANY(["timecard", "dtako"])` で絞っている (`kintai_push.rs`)。
// `dtako` = オンプレ MariaDB の `time_card_dtako` であって `dtako_events` では
// ない。⇒ **デジタコ (`dtako_events`) 自体は取り込み済みでも、`time_card_dtako`
// に行が無いだけの運行が「取り込み漏れの候補」に出る** (1445 の実例)。
// この節は「候補である」ことと「デジタコ自体が無い」ことを区別するための判定を足す。
//
// ★ 新しい判定はしない — 既存の口 (`GET /restraint-api/kintai/day-events-lookup`、
// `kintai-day-events-lookup.ts` の `parseDayEventsLookup`) が返す
// `status` (found/not_found/ambiguous) をそのまま3値に倒すだけ。前提が変わったら
// 上流 (`kintai-day-events-lookup.ts`) 側の docs を見直すこと。
// ─────────────────────────────────────────────────────────────────────────

export type KintaiUnkoGapDtakoCheckStatus = 'present' | 'absent' | 'inconclusive'

export interface KintaiUnkoGapDtakoCheckResult {
  status: KintaiUnkoGapDtakoCheckStatus
  /** `status === 'present'` のときだけ非null (見つかった23桁の実物)。 */
  unkoNo23: string | null
}

/**
 * `day-events-lookup` の `status` を、この候補判定専用の3値に倒す。
 *
 * - `found` → `present` (オンプレにデジタコあり)
 * - `not_found` → `absent` (その乗務員・その日で引いた限り見つからない)
 * - `ambiguous` / `null` (応答が読めなかった・まだ調べていない) → `inconclusive`
 *
 * ★ `ambiguous` を `absent` と混同しないこと (条件12) — 複数候補があるだけで
 * 「無い」と決まったわけではない。呼び出し側 (画面) は「まだ調べていない」
 * (候補が結果一覧に無い) 場合もこの関数を経由させず `inconclusive` 相当の表示に
 * 倒してよい — 3値とも表示文言は同じ「調べられていません」で構わない
 * (条件12「ambiguous/エラー/未実行はまとめて『調べられていない』」)。
 */
export function kintaiUnkoGapDtakoCheckResultFromLookup(
  status: 'found' | 'not_found' | 'ambiguous' | null,
  unkoNo: string | null,
): KintaiUnkoGapDtakoCheckResult {
  if (status === 'found') return { status: 'present', unkoNo23: unkoNo }
  if (status === 'not_found') return { status: 'absent', unkoNo23: null }
  return { status: 'inconclusive', unkoNo23: null }
}

export interface KintaiUnkoGapDtakoCheckView {
  status: KintaiUnkoGapDtakoCheckStatus
  message: string
  unkoNo23: string | null
}

/**
 * 表示用の文言に倒す (条件10〜12の文言そのもの)。**「押せば直る」とは書かない**
 * (条件10) — `present` でも「③のみで直る可能性がありますが保証ではありません」に
 * とどめる。`result` が無い (まだこの候補を調べていない) 場合も `inconclusive`
 * と同じ文言にする (条件12)。
 */
export function kintaiUnkoGapDtakoCheckView(result: KintaiUnkoGapDtakoCheckResult | undefined): KintaiUnkoGapDtakoCheckView {
  const r = result ?? { status: 'inconclusive' as const, unkoNo23: null }
  if (r.status === 'present') {
    return {
      status: 'present',
      message: 'オンプレにデジタコがあります — デジタコ自体の取り込み漏れではありません。'
        + '足りないのは time_card_dtako の行だけです (③のみで直る可能性がありますが、保証ではありません)。',
      unkoNo23: r.unkoNo23,
    }
  }
  if (r.status === 'absent') {
    return {
      status: 'absent',
      message: 'その乗務員・その日で引いた限り、オンプレにデジタコが見つかりません (別の乗務員CD・別の日の可能性は潰していません)。',
      unkoNo23: null,
    }
  }
  return {
    status: 'inconclusive',
    message: 'オンプレにデジタコがあるか調べられていません。',
    unkoNo23: null,
  }
}
