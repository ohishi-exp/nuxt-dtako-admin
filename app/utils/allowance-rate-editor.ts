/**
 * 運行手当マスタを**画面から書き換える**ための pure ロジック (Refs #805 PR-3)。
 *
 * 読む側は `allowance-rate-source.ts` (PR-2)。こちらは**その 3 状態のどれで
 * 編集を許すか**と、入力欄 (文字列) ⇔ `RateRow` の変換、保存後の 1 文、
 * 409 (楽観排他) の読み解きを持つ。**通信はしない。**
 *
 * ## 3 状態のうち編集させてよいのは 2 つで、意味が違う
 *
 * | 状態 | mode | ボタン | `baseVersion` |
 * |---|---|---|---|
 * | `r2` | `edit` | マスタを保存 | 読んだ `version` |
 * | `seed` | `register` | **R2 に登録** | **`''` (空文字)** |
 * | `error` | `locked` | 出さない | — |
 *
 * **`error` で編集させないのは、読めていない版を上書きすると他の人が保存した
 * 内容が消えるから。** 「読めなかった」を「まだ何も無い」と同じ扱いにすると、
 * `register` の初回登録がそのまま**他人の版の全消し**になる。
 *
 * ## ★ `seed` でも `baseVersion` を送る — 空文字が「無いはず」を意味する
 *
 * relay の `handleWageMasterRoute` (`dtako-scraper-relay-do.ts`) は
 *
 * ```ts
 * if (typeof baseVersion === "string") {
 *   const currentSha = (await bucket.head(latest))?.customMetadata?.sha256 ?? null;
 *   if (currentSha !== null && currentSha !== baseVersion) return 409 + current;
 * }
 * ```
 *
 * なので、**省くと無条件保存**・**空文字を送ると「まだ無いはず」の主張**になる。
 * `seed` を 2 人が同時に見て両方が登録した場合、省いていたら後勝ちで先の登録が
 * 黙って消えるが、空文字なら 2 人目に 409 が返る。**relay は 1 行も変えていない。**
 *
 * ## 0 行は保存させない
 *
 * relay の `normalizeAllowanceRateMaster` は `rows: []` を通す。通すと GET 側の
 * `resolveAllowanceRateMaster` が `error` (「R2 のマスタが 0 行です」) にするので、
 * **全部消す操作は「マスタを読めない状態」を自分で作る**ことになる。最低賃金カードの
 * 「削除」で 47 都道府県が丸ごと消える形 (#805 設計 §7 U5) と同じ穴なので、
 * ここで止める。
 */
import type { RateRow } from './allowance-rate-master'
import { resolveAllowanceRateMaster, type AllowanceRateState } from './allowance-rate-source'

/** 入力欄がそのまま入る 1 行。**数値も文字列で持つ** — 「2750」と打っている途中の
 * 「27」で行が消えたり 0 に倒れたりしないように。 */
export interface AllowanceRateDraftRow {
  shipper: string
  customer: string
  loader: string
  origin: string
  dest: string
  brand: string
  /** 円/t。**空欄 = `null` (単価が無い便)。0 に倒さない。** */
  farePerT: string
  /** 円/便。 */
  allowanceYen: string
  note: string
}

/** 編集の可否。**`locked` には `rows` を持たせていない** — 呼び出し側が
 * 「読めなかったけどとりあえず初期値を出す」と書けないようにするため
 * (`AllowanceRateState` の `error` と同じ作法)。 */
export type AllowanceRateEditability =
  | { mode: 'edit', baseVersion: string, rows: RateRow[] }
  | { mode: 'register', baseVersion: string, rows: RateRow[] }
  | { mode: 'locked', reason: string }

/**
 * 出どころの 3 状態から、編集の可否と `baseVersion` を決める。
 *
 * `r2` で `version` が `null` の回 (R2 に物はあるが `sha256` メタデータが無い) は
 * `''` を送る。**その回だけ楽観排他が効かない**が、出どころの注記が
 * 「版 不明」と言っているので黙ってはいない。
 */
export function allowanceRateEditability(state: AllowanceRateState): AllowanceRateEditability {
  if (state.status === 'error') {
    return {
      mode: 'locked',
      reason: `運行手当マスタを読めていないので編集できません — ${state.reason}。`
        + '読めないまま保存すると、他の人が保存した版を上書きします。',
    }
  }
  if (state.status === 'seed') return { mode: 'register', baseVersion: '', rows: state.rows }
  return { mode: 'edit', baseVersion: state.version ?? '', rows: state.rows }
}

/** 保存ボタンの文言。**`register` は「保存」と呼ばない** — R2 にまだ何も無い状態から
 * 作るので、押した人が「前からあるものを直した」と読まないように。 */
export function allowanceRateSaveLabel(mode: 'edit' | 'register'): string {
  return mode === 'register' ? 'R2 に登録' : 'マスタを保存'
}

/**
 * 保存後の 1 文。**`changed` の出し分けまで `salary-item-config` に揃える**
 * (`restraint-wage.vue` の「(新しい版を作成)」/「(内容は前回と同一)」)。
 * 「保存しました」だけだと、同じ内容を押した人が「版が増えた」と誤解する。
 */
export function allowanceRateSavedMessage(mode: 'edit' | 'register', changed: boolean): string {
  const what = mode === 'register' ? 'を R2 に登録しました' : 'を保存しました'
  return `運行手当マスタ${what} (${changed ? '新しい版を作成' : '内容は前回と同一'})`
}

/**
 * 保存した直後、**画面に出ている集計は保存前のマスタで計算されたもの**になる。
 * 注記だけ新しい版を指すと「この版で出した金額」に読めてしまうので、必ず出す
 * (`allowanceRateNoticeForMargin` が粗利タブのキャッシュに足しているのと同じ理由)。
 */
export const ALLOWANCE_RATE_STALE_AMOUNTS_NOTICE
  = '表示中の金額は保存前のマスタで計算したものです。集計 を押すと引き直します。'

/** `RateRow[]` → 入力欄。`farePerT: null` は**空欄**にする (`0` にしない)。 */
export function toAllowanceRateDraft(rows: RateRow[]): AllowanceRateDraftRow[] {
  return rows.map(r => ({
    shipper: r.shipper,
    customer: r.customer,
    loader: r.loader,
    origin: r.origin,
    dest: r.dest,
    brand: r.brand,
    farePerT: r.farePerT === null ? '' : String(r.farePerT),
    allowanceYen: String(r.allowanceYen),
    note: r.note,
  }))
}

/** 「行を追加」で入る空行。**`allowanceYen` も空**にする — `0` を既定にすると
 * 「手当 ¥0 の経路」を黙って作ってしまう。 */
export function emptyAllowanceRateDraftRow(): AllowanceRateDraftRow {
  return { shipper: '', customer: '', loader: '', origin: '', dest: '', brand: '', farePerT: '', allowanceYen: '', note: '' }
}

/** 検証の結果。**壊れていれば行を保存しない** (部分保存はしない)。 */
export type AllowanceRateDraftParse =
  | { ok: true, rows: RateRow[] }
  | { ok: false, errors: string[] }

/** 入力欄の 1 項目 → 数値。空欄・空白のみは `null` (= 未入力)。 */
function parseNumberField(raw: string): number | null | 'invalid' {
  const text = raw.trim()
  if (text === '') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : 'invalid'
}

/**
 * 入力欄 → `RateRow[]`。**規則は relay の `normalizeAllowanceRateMaster` と同じ**
 * にしてある (文字列 7 項目 / `allowanceYen` は 0 以上の有限数 / `farePerT` は
 * 有限数か `null`)。ここで通して relay で 400 になる形を作らないため。
 *
 * **文字列 7 項目は空文字を許す** — `brand` と `note` は実データに空がある
 * (`RATE_MASTER` の 62 行のうち `brand` が空の行が実在する契約)。空を弾くと
 * 既存のマスタを読み込んだだけで保存できなくなる。
 */
export function parseAllowanceRateDraft(draft: AllowanceRateDraftRow[]): AllowanceRateDraftParse {
  const errors: string[] = []
  const rows: RateRow[] = []
  draft.forEach((d, i) => {
    const fare = parseNumberField(d.farePerT)
    const yen = parseNumberField(d.allowanceYen)
    if (fare === 'invalid') errors.push(`${i + 1} 行目: 運賃 (円/t) が数値ではありません`)
    if (yen === 'invalid') errors.push(`${i + 1} 行目: 手当 (円/便) が数値ではありません`)
    else if (yen === null) errors.push(`${i + 1} 行目: 手当 (円/便) が空です`)
    else if (yen < 0) errors.push(`${i + 1} 行目: 手当 (円/便) が負の数です`)
    if (fare === 'invalid' || yen === 'invalid' || yen === null || yen < 0) return
    rows.push({
      shipper: d.shipper,
      customer: d.customer,
      loader: d.loader,
      origin: d.origin,
      dest: d.dest,
      brand: d.brand,
      farePerT: fare,
      allowanceYen: yen,
      note: d.note,
    })
  })
  // **0 行は「空のマスタ」として保存できてしまう** (relay は通す)。保存すると
  // 次に読んだとき `error` になり、全便の手当が出なくなる。ここで止める。
  if (errors.length === 0 && rows.length === 0) {
    errors.push('1 行も残っていません。マスタを空で保存すると、次に読んだとき「0 行」として読めなくなります')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rows }
}

/** 行の同一性を見るための正規化 (差分の件数を数えるためだけに使う)。 */
function rowKey(r: RateRow): string {
  return JSON.stringify([r.shipper, r.customer, r.loader, r.origin, r.dest, r.brand, r.farePerT, r.allowanceYen, r.note])
}

/** 手元とサーバの行の食い違い。**「何行違うか」だけ**を数える (行に一意キーが
 * 無いので「どの行が変わったか」は言えない — 言えないことを言わない)。 */
export interface AllowanceRateRowDiff {
  /** 手元にだけある行数 (= 自分が足した/直した行)。 */
  onlyMine: number
  /** サーバにだけある行数 (= 相手が足した/直した行)。 */
  onlyTheirs: number
  /** 一字一句同じ行数。 */
  same: number
}

export function allowanceRateRowDiff(mine: RateRow[], theirs: RateRow[]): AllowanceRateRowDiff {
  const pool = new Map<string, number>()
  for (const r of theirs) {
    const k = rowKey(r)
    pool.set(k, (pool.get(k) ?? 0) + 1)
  }
  let same = 0
  for (const r of mine) {
    const k = rowKey(r)
    const left = pool.get(k) ?? 0
    if (left > 0) {
      pool.set(k, left - 1)
      same++
    }
  }
  let onlyTheirs = 0
  for (const left of pool.values()) onlyTheirs += left
  return { onlyMine: mine.length - same, onlyTheirs, same }
}

/** 409 の中身。**サーバの現在値が読めなかった回も `rows: null` で残す** —
 * 「競合した」ことは分かっているので、黙って成功にしない。 */
export interface AllowanceRateConflict {
  version: string | null
  rows: RateRow[] | null
  /** 画面に出す 1 文。 */
  message: string
}

/**
 * 409 の本文 (`{ error: 'conflict', current: { data, version } }`) を読み解く。
 *
 * **上書きはしない。** 呼び出し側は手元の編集内容をそのまま残し、この結果を
 * 「サーバはいまこうなっている」として並べて見せる。
 *
 * 行の検証は **`resolveAllowanceRateMaster` を使い回す** — 409 の `current` は
 * GET の `{exists, data, version}` と形が違うので、その形に組み直してから渡す。
 * 規則 (文字列 7 項目 / `allowanceYen` / `farePerT` / 0 行は不可) を 2 か所に
 * 書かないため。
 */
export function resolveAllowanceRateConflict(body: unknown): AllowanceRateConflict {
  const current = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as { current?: unknown }).current
    : undefined
  const bag = current !== null && typeof current === 'object' && !Array.isArray(current)
    ? current as { data?: unknown, version?: unknown }
    : null
  const version = typeof bag?.version === 'string' ? bag.version : null
  const head = '他の人が先に保存しています。あなたの編集は送っていません (サーバは書き換わっていません)。'
  if (bag === null) {
    return { version, rows: null, message: `${head}サーバの現在値が応答に入っていません — 読み直してから編集し直してください。` }
  }
  const state = resolveAllowanceRateMaster({ exists: true, data: bag.data, version })
  if (state.status === 'error') {
    // 現在値が壊れている / 0 行。**理由をそのまま運ぶ。**
    return { version, rows: null, message: `${head}サーバの現在値を読み取れませんでした — ${state.reason}。` }
  }
  // ここは `r2` だけ (`exists: true` を渡しているので `seed` にはならない)。
  // `seed` を別扱いしないのは、**通らない分岐をテストで埋めないため。**
  return {
    version,
    rows: state.rows,
    message: `${head}サーバの現在値は ${state.rows.length} 行 / 版 ${version ?? '不明'} です。`,
  }
}

/** `PUT` の結果を素のまま運ぶ (通信は呼び出し側が持つ)。 */
export type AllowanceRatePutOutcome =
  /** 2xx。`changed` は relay の応答 (**内容が前回と同一なら false**)。 */
  | { ok: true, changed: boolean }
  /** 非 2xx。`status` と本文をそのまま渡す (`reason` は `describeApiError` の 1 文)。 */
  | { ok: false, status: number | undefined, body: unknown, reason: string }

/**
 * 保存の結果を画面の状態に落としたもの。
 *
 * ★ **`conflict` に「手元をこう置き換えろ」という材料を入れていない。**
 * 409 で返ってくるサーバの現在値は `conflict.conflict.rows` として**別に**持ち、
 * 入力欄を差し替える形 (`draft` や `rows` を返す) は型に無い。**上書きは呼び出し側が
 * 書こうとしても書けない** — `AllowanceRateState` の `error` に `rows` を持たせて
 * いないのと同じ作法。
 */
export type AllowanceRateSaveResult =
  | { kind: 'saved', message: string }
  | { kind: 'conflict', conflict: AllowanceRateConflict, diff: AllowanceRateRowDiff | null }
  | { kind: 'failed', message: string }

/**
 * `PUT /restraint-api/allowance-rate` の結果を読み解く。
 *
 * - 2xx → `changed` の出し分けを含む 1 文
 * - **409 → `conflict`。上書きしない**。手元 (`sent`) とサーバの現在値の食い違いも数える
 * - それ以外 → `failed` (理由をそのまま画面へ)
 */
export function resolveAllowanceRateSave(
  mode: 'edit' | 'register',
  sent: RateRow[],
  outcome: AllowanceRatePutOutcome,
): AllowanceRateSaveResult {
  if (outcome.ok) return { kind: 'saved', message: allowanceRateSavedMessage(mode, outcome.changed) }
  if (outcome.status !== 409) return { kind: 'failed', message: outcome.reason }
  const conflict = resolveAllowanceRateConflict(outcome.body)
  return {
    kind: 'conflict',
    conflict,
    diff: conflict.rows === null ? null : allowanceRateRowDiff(sent, conflict.rows),
  }
}

/** 409 のときに出す差分の 1 文。**「どの行が変わったか」は言わない** — 行に一意キーが
 * 無いので言えない。 */
export function allowanceRateDiffLabel(diff: AllowanceRateRowDiff): string {
  return `あなたの手元だけにある行 ${diff.onlyMine} 件 / サーバだけにある行 ${diff.onlyTheirs} 件`
    + ` (一致 ${diff.same} 件)。`
}
