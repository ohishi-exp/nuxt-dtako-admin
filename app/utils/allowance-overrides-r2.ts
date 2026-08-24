/**
 * **人が手で確定したもの**を端末 (localStorage) から R2 (全員で共有) へ移すための
 * pure 部分 (Refs #845 / Refs #820)。
 *
 * 運行手当タブで人が決めた 3 つ — **暫定手当** (`allowance-provisional.ts`)・
 * **除外** (`allowance-excluded.ts`)・**強制突合** (`allowance-force-match.ts`) — は
 * どれも localStorage にしか無く、**その端末にしか見えない**。「見るたび数字が違う」の
 * 実体的な原因になり得るので、R2 に載せて共有する。**この PR で移すのは `provisional`
 * だけ**で、`excluded` / `force-match` は後続 (PR-3b / PR-3c)。土台はここで作る。
 *
 * 作法は `margin-r2.ts` / `profit-r2.ts` / `server/utils/profit-r2-io.ts` を
 * **そのまま流用する** (`latest.json` + `v-{ts}.json` + `history.jsonl`、sha256 差分検知)。
 * `marginR2Paths(ym)` が手本で、こちらは月で割らない (下の「月で割らない」参照)。
 *
 * IO (R2 read/write) はここに置かない。R2 binding は Nitro server route からしか
 * 触れないので `server/api/profit/allowance-override.post.ts` が持つ。
 *
 * ## ★ 「いまは端末が 1 台」は設計の前提にならない
 *
 * この機能の目的そのものが「端末依存をやめて全員で共有する」ことなので、**うまくいけば
 * 必ず複数端末になる**。だから壊れ方を先に潰してある:
 *
 * - **全体マップをまるごと置換しない。** 2 台目が現れた瞬間、片方が押すたびに相手の
 *   確定を消す。だから**送るのは 1 件だけ** (`AllowanceOverrideOperation`) にして、
 *   **畳み込みはサーバー側**でやる (`applyAllowanceOverrideOperation`)
 * - **単純な和集合 (union) にもしない。** `toggleExcluded` は `delete` するだけで
 *   **消した痕跡を残さない**ので、union だと「解除した除外」が他端末の push で復活する。
 *   だから**消したことを値として残す** (`value: null` = tombstone)。
 *   **鍵が無いこと ≠ 消したこと** で、この 2 つを別物として扱うのが根治
 *
 * 別々の鍵を触っている限り 2 台が同時に編集しても衝突しない (実際の使われ方はほぼこれ)。
 * 同じ鍵を同時に触ったときだけが衝突で、**後勝ちでよい** —
 * `history.jsonl` に**誰が・いつ・何を**が残るので後から追える。
 * **衝突解決の UI は作らない。**
 */
import type { ProfitR2Paths } from './profit-r2'

// --- キー設計 ---

/**
 * 人が確定する 3 種類。**混ぜない** — 種類ごとに別の系列 (`latest`/`v-{ts}`/`history`) を持つ。
 * 値の形も種類ごとに違う (暫定は円、除外は `true`、強制突合は `rowId` の配列) ので、
 * **値の検査だけを種類ごとに差し込む**作りにしてある (`parseAllowanceOverrideSnapshot`)。
 */
export type AllowanceOverrideKind = 'provisional' | 'excluded' | 'force-match'

/**
 * `profit/allowance-overrides/{kind}/` 配下に種類ごと 1 系列で置く。
 *
 * **月で割らない。** 3 種類とも月に紐づかない (暫定手当の経路キー `広尾|芽室` に月が無い)。
 * localStorage の実装も最初から全期間のフラットなマップで、**月分割は意味論を変えてしまう**。
 *
 * 既存 2 系統 (`profit/{ym}/{車輌CD}/...` と `profit/{ym}/margin-summary/`) と構造的に
 * 衝突しない — どちらも次の階層が `YYYY-MM` 形式で、`allowance-overrides` はその形を
 * していない (`margin-summary` を `{車輌CD}` の位置に予約したのと同じ手筋)。
 */
export function allowanceOverrideR2Paths(kind: AllowanceOverrideKind): ProfitR2Paths {
  const dir = `profit/allowance-overrides/${kind}`
  return {
    dir,
    latest: `${dir}/latest.json`,
    version: ts => `${dir}/v-${ts}.json`,
    history: `${dir}/history.jsonl`,
  }
}

// --- 保存する形 ---

export const ALLOWANCE_OVERRIDE_SCHEMA_VERSION = 1

/**
 * 1 つの鍵についての「いまの答え」。
 *
 * **`value: null` は「消した」** (tombstone) であって「まだ何も無い」ではない。
 * 鍵ごと消してしまうと、他端末が持っている古い値との突き合わせで**消したはずのものが
 * 復活する**ので、消したことも値として残す。
 */
export interface AllowanceOverrideEntry<V> {
  /** いまの値。**`null` は「消した」** (鍵が無いこと≠消したこと)。 */
  value: V | null
  /** 最後に触った人 (ログインの email)。**空文字に倒さない** (`UNKNOWN_OVERRIDE_BY`)。 */
  by: string
  /** 最後に触った時刻 (ISO8601、サーバーの時計)。 */
  at: string
}

/** R2 に置く JSON。**いま有効な全体像**を持つ (読む側が 1 回で読めるように)。 */
export interface AllowanceOverrideSnapshot<V> {
  schemaVersion: typeof ALLOWANCE_OVERRIDE_SCHEMA_VERSION
  kind: AllowanceOverrideKind
  /** 鍵 → いまの答え。**消した鍵も tombstone として残る。** */
  entries: Record<string, AllowanceOverrideEntry<V>>
  /** この `latest.json` を書いた時刻 (ISO8601)。**毎回変わるのでハッシュ対象から外す。** */
  savedAt: string
}

/** **1 回の操作 = 1 件。** 画面が送るのはこれだけで、全体マップは送らせない。 */
export interface AllowanceOverrideOperation<V> {
  key: string
  /** 入れる値。**`null` は「消した」。** */
  value: V | null
}

/** 何も入っていない状態。`latest.json` がまだ無い / 読めなかったときの出発点。 */
export function emptyAllowanceOverrideSnapshot<V>(kind: AllowanceOverrideKind): AllowanceOverrideSnapshot<V> {
  return { schemaVersion: ALLOWANCE_OVERRIDE_SCHEMA_VERSION, kind, entries: {}, savedAt: '' }
}

/**
 * 保存済みの全体像を読む。**壊れていても投げない** — 空として扱う。
 *
 * localStorage 側の 3 つのパーサ (`parseProvisional` / `parseExcluded` /
 * `parseForceMatch`) が持っている防御を **R2 化しても落とさない**。R2 の中身は人が
 * 直接置き換えられるので、むしろ要る。
 *
 * `schemaVersion` と `kind` が食い違う本文は**丸ごと捨てる** — 形が変わった / 別の種類の
 * ファイルを取り違えた、のどちらでも「その内容を今の意味で読む」のは誤りなので。
 * 個々のエントリは `parseProvisional` と同じく**壊れた行だけ落とす** (1 行のために
 * 全部を失わない)。
 */
export function parseAllowanceOverrideSnapshot<V>(
  raw: string | null | undefined,
  kind: AllowanceOverrideKind,
  isValue: (v: unknown) => v is V,
): AllowanceOverrideSnapshot<V> {
  const empty = emptyAllowanceOverrideSnapshot<V>(kind)
  if (!raw) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return empty
  const blob = parsed as Partial<AllowanceOverrideSnapshot<unknown>>
  if (blob.schemaVersion !== ALLOWANCE_OVERRIDE_SCHEMA_VERSION) return empty
  if (blob.kind !== kind) return empty
  const rawEntries = blob.entries
  if (typeof rawEntries !== 'object' || rawEntries === null || Array.isArray(rawEntries)) return empty
  const entries: Record<string, AllowanceOverrideEntry<V>> = {}
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (!key) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Partial<AllowanceOverrideEntry<unknown>>
    if (typeof entry.by !== 'string' || typeof entry.at !== 'string') continue
    // **tombstone (`null`) は正しい値。**捨てると「消した」が「まだ何も無い」に化ける。
    if (entry.value !== null && !isValue(entry.value)) continue
    entries[key] = { value: entry.value, by: entry.by, at: entry.at }
  }
  return { schemaVersion: ALLOWANCE_OVERRIDE_SCHEMA_VERSION, kind, entries, savedAt: typeof blob.savedAt === 'string' ? blob.savedAt : '' }
}

/**
 * **サーバー側で 1 件だけを畳み込む。** これがこの設計の核心で、画面から全体マップを
 * 送らせないための関数。
 *
 * **鍵を `delete` しない** — 消す操作でも `value: null` の entry を**書く**。
 * `by` / `at` はサーバーが埋める (時計もログインもサーバーの持ち物)。
 * 同じ鍵を同時に触った 2 台は**後勝ち**になるが、`history.jsonl` に両方の行が残る。
 */
export function applyAllowanceOverrideOperation<V>(
  snapshot: AllowanceOverrideSnapshot<V>,
  operation: AllowanceOverrideOperation<V>,
  by: string,
  at: string,
): AllowanceOverrideSnapshot<V> {
  return {
    schemaVersion: ALLOWANCE_OVERRIDE_SCHEMA_VERSION,
    kind: snapshot.kind,
    entries: { ...snapshot.entries, [operation.key]: { value: operation.value, by, at } },
    savedAt: at,
  }
}

/** その鍵のいまの値。鍵が無い場合も tombstone の場合も `null` (どちらも「値が無い」)。 */
export function allowanceOverrideValue<V>(snapshot: AllowanceOverrideSnapshot<V>, key: string): V | null {
  return snapshot.entries[key]?.value ?? null
}

/** **生きている** (消されていない) 鍵の数。画面に「R2 にはいま N 件」と出すのに使う。 */
export function liveAllowanceOverrideCount<V>(snapshot: AllowanceOverrideSnapshot<V>): number {
  return Object.values(snapshot.entries).filter(entry => entry.value !== null).length
}

/**
 * sha256 差分検知に渡す文字列。**値そのものだけを見る。**
 *
 * `savedAt` と、エントリごとの `by` / `at` を外すのが肝。**版を分けるのは値が動いた
 * とき**であって、同じ値をもう一度送り直した回 (移行ボタンを 2 回押した等) に版を
 * 増やすと、R2 の容量が「押した回数」で伸びる。**誰がいつ触ったかは `history.jsonl`
 * に全部残る**ので、版の側で持つ必要が無い。
 *
 * **鍵は必ず並べ替える。** JSON のキー順は操作が届いた順に決まるので、並べ替えないと
 * **値が同じなのに版が増える** (2 台が別の順で同じ鍵を触っただけで差分と判定される)。
 */
export function allowanceOverrideHashInput<V>(snapshot: AllowanceOverrideSnapshot<V>): string {
  const values = Object.keys(snapshot.entries).sort().map(key => [key, snapshot.entries[key]!.value])
  return JSON.stringify({ schemaVersion: snapshot.schemaVersion, kind: snapshot.kind, values })
}

/**
 * `history.jsonl` の 1 行。**誰が・いつ・どの鍵を・何から何にしたか。**
 *
 * 権限範囲が「その端末の人だけ」から「R2 に触れる人全員」に広がるので、後から追える
 * ようにするのが `requireAuth` を付けた理由そのもの。**本文 (全体像) は入れない**
 * (それは `v-{ts}.json` に有る) — 行数上限 (`PROFIT_HISTORY_MAX_LINES`) に載るよう
 * 小さく保つ。
 */
export interface AllowanceOverrideHistoryLine<V> {
  ts: string
  /** 値が動いて新しい版を書いたか (同じ値の送り直しなら `false`)。 */
  changed: boolean
  kind: AllowanceOverrideKind
  key: string
  /** 触った人 (ログインの email)。 */
  by: string
  /** 前の値。**鍵が無かった場合も消されていた場合も `null`** (どちらも「値が無い」)。 */
  before: V | null
  /** 後の値。**`null` は「消した」。** */
  after: V | null
  /** この操作の後で生きている鍵の数。 */
  entries: number
}

export function allowanceOverrideHistoryLine<V>(params: {
  snapshot: AllowanceOverrideSnapshot<V>
  key: string
  by: string
  before: V | null
  changed: boolean
}): AllowanceOverrideHistoryLine<V> {
  return {
    ts: params.snapshot.savedAt,
    changed: params.changed,
    kind: params.snapshot.kind,
    key: params.key,
    by: params.by,
    before: params.before,
    after: allowanceOverrideValue(params.snapshot, params.key),
    entries: liveAllowanceOverrideCount(params.snapshot),
  }
}

// --- 触った人 ---

/**
 * ログインの email が取れなかったときに `by` へ置く言葉。**空文字に倒さない** —
 * 空だと「誰が触ったか」の欄がレンダリングの不具合に見える (`MARGIN_VERSION_UNNAMED`
 * と同じ理由)。`requireAuth` は通っているので**誰かではある**、というのがこの語の意味。
 */
export const UNKNOWN_OVERRIDE_BY = '(email 不明)'

/** `requireAuth` の返す `email` を `by` に正規化する。 */
export function resolveOverrideBy(email: unknown): string {
  if (typeof email !== 'string' || email === '') return UNKNOWN_OVERRIDE_BY
  return email
}

// --- 暫定手当 (この PR で移す 1 種類) ---

/**
 * 暫定手当の値として受ける形。**`parseProvisional` と同じ物差し** —
 * 数でない値・整数でない値・0 以下は捨てる (給与に混ざる数字なので緩めない)。
 * 「消した」は値ではなく `null` (tombstone) で表すので、ここには来ない。
 */
export function isProvisionalOverrideValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export type ProvisionalOverrideSnapshot = AllowanceOverrideSnapshot<number>

// --- 画面が送る body ---

export type ParsedAllowanceOverrideBody =
  | { ok: true, kind: AllowanceOverrideKind, key: string, value: number | null }
  | { ok: false, error: string }

/**
 * `POST /api/profit/allowance-override` の body を検査する。
 *
 * **受けるのは 1 件だけ** (`key` + `value`)。全体マップを受ける口を作らないのは、
 * 作ってしまうと 2 台目が現れた瞬間に相手の確定を消せてしまうため。
 *
 * `kind` は**この PR では `provisional` だけ**を受ける。`excluded` / `force-match` は
 * 値の形が違う (それぞれ `true` / `rowId` の配列) ので、**検査を持たないまま受けると
 * 中身が検査されずに R2 へ入る**。後続 PR がそれぞれの検査と一緒に開ける。
 */
export function parseAllowanceOverrideBody(body: unknown): ParsedAllowanceOverrideBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body が object ではありません' }
  }
  const b = body as Record<string, unknown>
  if (b.schemaVersion !== ALLOWANCE_OVERRIDE_SCHEMA_VERSION) {
    return { ok: false, error: `schemaVersion は ${ALLOWANCE_OVERRIDE_SCHEMA_VERSION} が必要です` }
  }
  if (b.kind !== 'provisional') {
    return { ok: false, error: 'kind は provisional だけを受け付けます (excluded / force-match は未対応)' }
  }
  if (typeof b.key !== 'string' || b.key === '') {
    return { ok: false, error: 'key (経路キー) が必要です' }
  }
  if (b.value !== null && !isProvisionalOverrideValue(b.value)) {
    return { ok: false, error: 'value は 1 以上の整数 (円) か、消すなら null が必要です' }
  }
  return { ok: true, kind: 'provisional', key: b.key, value: b.value }
}

// --- 画面に出す注記 ---

/** 保存の結果 (`POST /api/profit/allowance-override` の応答)。 */
export interface AllowanceOverrideSaveResult {
  saved: boolean
  /** 値が動いて新しい版が増えたか。 */
  changed: boolean
  savedAt: string
  by: string
  key: string
  /**
   * **R2 に保存された後の値** (`null` は消した)。
   *
   * **画面が送った値のエコーではない** — サーバーが畳み込んだ後の全体像から
   * `allowanceOverrideValue` で読み直したもの。**この PR には読む口 (GET) が無い**ので、
   * 「サーバーが実際に何を保存したか」を確かめられるのはここだけになる。
   * エコーにすると、サーバー側が値を取り違えても画面には正しく見えてしまう
   * (#833 の「金額を省いた」と「読めなかった」が同じ見た目だったのと同じ型の穴)。
   */
  value: number | null
  /** 保存の後で R2 に生きている鍵の数 (**tombstone は数えない**)。 */
  entries: number
  /** `latest` がいま指している版の R2 キー。古い保存には無いので空文字になりうる。 */
  versionKey: string
}

/** 保存された 1 件 (鍵と、**R2 が返した**値)。移行ボタンの注記に並べる。 */
export interface AllowanceOverrideSavedValue {
  key: string
  value: number | null
}

/**
 * 注記に並べる保存済みの値の上限。**黙って切らない** — 超えたぶんは件数で言う
 * (`MARGIN_VERSION_BODY_LIMIT` と同じ方針。黙って切ると「全部出ている」と誤読される)。
 */
export const ALLOWANCE_OVERRIDE_NOTE_MAX_ITEMS = 20

/** 保存された値の見せ方。**消した回を空白にしない** (欠落と区別が付かなくなる)。 */
export function allowanceOverrideValueText(value: number | null): string {
  if (value === null) return '(消しました)'
  return `¥${value.toLocaleString('ja-JP')}`
}

/**
 * **R2 に実際に入った 鍵 = 値**を注記に並べる。
 *
 * 件数だけだと**値が正しいかは分からない**。読む口が無いこの PR では、本番で
 * 「移行が本当に入ったか」を確かめる手段がここしか無いので、鍵と値をそのまま出す。
 * 1 件も入らなかった (全部失敗した) ときは**何も足さない** — 空の一覧を出すと
 * 「入ったが中身が無い」に読める。
 */
export function allowanceOverrideSavedList(saved: AllowanceOverrideSavedValue[]): string {
  if (saved.length === 0) return ''
  const shown = saved.slice(0, ALLOWANCE_OVERRIDE_NOTE_MAX_ITEMS)
  const list = shown.map(item => `${item.key} = ${allowanceOverrideValueText(item.value)}`).join(' / ')
  const omitted = saved.length - shown.length
  if (omitted > 0) {
    return ` R2 に入ったのは ${list} …ほか ${omitted} 件`
      + ` (この注記には ${ALLOWANCE_OVERRIDE_NOTE_MAX_ITEMS} 件まで出しています)。`
  }
  return ` R2 に入ったのは ${list}。`
}

/**
 * 1 件の保存の注記。**失敗を黙らせない** (`marginSummarySaveNote` と同じ方針) —
 * 黙ると、端末の記録だけを見て「共有できている」と誤読する。
 *
 * **成功しても「この画面の集計は今までどおり端末の記録から出している」と断る。**
 * この PR ではロード時の自動 fetch を入れていないので、R2 は**共有の控え**であって
 * 画面の数字の出どころではない。ここを曖昧にすると、他端末で入れた暫定が自分の画面に
 * 出てこないのを不具合だと読む。
 */
export function allowanceOverrideSaveNote(result: AllowanceOverrideSaveResult | null, error: string | null): string {
  if (error !== null) {
    return `暫定手当を R2 (共有) に送れませんでした (${error}) — この端末の記録は残っているので、`
      + '集計はこのまま続けられます。あとでもう一度送ってください。'
  }
  if (result === null) return ''
  // **サーバーが保存した値をそのまま出す。**「送った値」と食い違っていれば人が気づける。
  const stored = `${result.key} = ${allowanceOverrideValueText(result.value)}`
  const tail = `R2 にはいま ${result.entries} 件の暫定手当があります。`
    + 'この画面の集計はこの端末の記録から出しています (R2 は共有の控えです)。'
  if (result.changed) {
    return `暫定手当を R2 (共有) に保存しました — ${stored} (${result.by})。${tail}`
  }
  return `暫定手当は R2 (共有) の値と同じでした — ${stored} なので版は増やしていません (${result.by})。${tail}`
}

/**
 * 移行ボタン (「この端末のぶんを R2 へ送る」) の注記。
 *
 * **1 件ずつの操作として送る**ので、途中で失敗しても送れたぶんは R2 に残る。
 * だから「もう一度押せば送り直せる」と書く — 全体を 1 回で置き換える作りなら
 * 言えないことで、**1 件ずつにした利点**そのもの。
 */
export function allowanceOverrideMigrationNote(params: {
  sent: number
  failed: number
  entries: number
  firstError: string
  /** **R2 が返した**鍵と値 (送った値のエコーではない)。落ちたぶんは入らない。 */
  saved: AllowanceOverrideSavedValue[]
}): string {
  const stored = allowanceOverrideSavedList(params.saved)
  if (params.failed > 0) {
    return `${params.sent + params.failed} 件のうち ${params.failed} 件を R2 (共有) に送れませんでした`
      + ` (${params.firstError}) — この端末の記録はそのままです。もう一度押せば、送れなかったぶんだけ送り直せます。`
      + stored
  }
  return `${params.sent} 件を R2 (共有) に送りました。R2 にはいま ${params.entries} 件の暫定手当があります。`
    + 'この端末の記録は消していません — この画面の集計は今までどおりそちらから出しています。'
    + stored
}
