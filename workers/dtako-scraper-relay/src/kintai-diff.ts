/**
 * オンプレ (rust-ichibanboshi `/api/kintai/kosoku-daily`) と GCP
 * (`kintai.day_summaries`) の日別サマリを突き合わせる pure ロジック (Refs #615-4)。
 *
 * kyuyo-mcp の `get_kintai_diff` (`workers/kyuyo-mcp/src/mcp/tools.ts`) と
 * **同じ 5 区分・同じキー (`乗務員CD|暦日|開始時刻`)・同じフィールド名**で突き合わせる。
 * kyuyo-mcp は別デプロイ単位のため import できないが、意味はここで揃える —
 * コピーではなく独立に書き直す (#606-8 が front で同じことをやっている前例と同じ)。
 *
 * **どちら側が古いかはここでは判定しない。** 休憩/休息は双方向に伸び縮みするため、
 * 件数や長さだけで古い側を決めると外れる (get_kintai_diff の doc と同じ理由・実例あり)。
 * この module は「観測できる差」を返すだけで、原因の推定は呼び出し側にも持たせない。
 */

/** 両受け口 (オンプレ `kosoku-daily` / GCP `day_summaries`) が共通で持つ 11 分数列。
 * 列名はもともと両側で一致している (`kintai_day_summaries.rs` のモジュール docs)。
 * オンプレ側だけ `source`、GCP 側だけ `shift_source` と呼ぶので、そこだけ読み替える。 */
export const KINTAI_DIFF_MINUTE_FIELDS = [
  "restraint_minutes",
  "working_minutes",
  "break_minutes",
  "rest_minus_minutes",
  "statutory_minutes",
  "within_statutory_overtime_minutes",
  "overtime_minutes",
  "legal_holiday_minutes",
  "night_minutes",
  "overtime_night_minutes",
  "legal_holiday_night_minutes",
] as const;

export type KintaiDiffMinuteField = (typeof KINTAI_DIFF_MINUTE_FIELDS)[number];

/** 突合 1 行の値 (両側とも同じ形に揃えて持つ)。 */
export type KintaiDiffValue = { shift_source: unknown } & Record<KintaiDiffMinuteField, number>;

function toNumberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** GCP `day_summaries` の `{summaries: {key: {...}}}` を突合用の Map にする。 */
export function gcpSummariesToMap(body: unknown): Map<string, KintaiDiffValue> {
  const out = new Map<string, KintaiDiffValue>();
  const summaries = (body as { summaries?: unknown } | null)?.summaries;
  if (!summaries || typeof summaries !== "object") return out;
  for (const [key, raw] of Object.entries(summaries as Record<string, unknown>)) {
    const r = raw as Record<string, unknown>;
    const value = { shift_source: r.shift_source } as KintaiDiffValue;
    for (const f of KINTAI_DIFF_MINUTE_FIELDS) value[f] = toNumberOr0(r[f]);
    out.set(key, value);
  }
  return out;
}

/** [onpremKosokuDailyToMap] の結果。読めたかどうかを Map の中身から切り離して持つ
 * (空 Map だけでは「本当に 0 行」と「形が読めなかった」の区別が付かないため)。 */
export interface OnpremParseResult {
  map: Map<string, KintaiDiffValue>;
  /** `drivers` 配列 (全乗務員形) にも `days` 配列 (driver 指定形) にも当てはまらなかった。 */
  unreadable: boolean;
}

/** `days` 配列 1 人ぶんを `driver` 引きのキーで Map に足す (両形式で共有)。
 * **`punches` / `parts` はここで捨てる** — 突合に要るのは 11 分数 + `source` + キー 3 つだけ。 */
function addOnpremDriverDays(out: Map<string, KintaiDiffValue>, driver: unknown, days: unknown[]): void {
  for (const day of days) {
    const r = day as Record<string, unknown>;
    const date = r.date;
    const start = r.start;
    if (typeof date !== "string" || typeof start !== "string") continue;
    const key = `${driver}|${date}|${start}`;
    const value = { shift_source: r.source } as KintaiDiffValue;
    for (const f of KINTAI_DIFF_MINUTE_FIELDS) value[f] = toNumberOr0(r[f]);
    out.set(key, value);
  }
}

/**
 * オンプレ `kosoku-daily` を突合用の Map にする。**応答の形が `driver` クエリの
 * 有無で変わる** (get_kintai_diff と同じ実装済みの罠、Refs ohishi-exp/nuxt-dtako-admin#599):
 *
 * - `driver` 省略 = `{drivers: [{driver, days: [...]}]}` (全乗務員)
 * - `driver` 指定 = `{driver, days: [...]}` (`drivers` が無い。単一乗務員をトップレベルに展開)
 *
 * 単一乗務員形の乗務員CD は**応答の `driver` を優先し、無ければ `requestedDriver`
 * (呼び出し側が渡した値) へ落とす**。
 *
 * **どちらの形にも当てはまらなければ空 Map ではなく `unreadable: true` を返す。**
 * 空 Map のまま返すと「オンプレにその乗務員の行が無い」と「応答の形を読み間違えた」が
 * 呼び出し側から区別できず、両側に在る行まで `only_gcp` に化ける (#599)。
 */
export function onpremKosokuDailyToMap(body: unknown, requestedDriver?: string): OnpremParseResult {
  const out = new Map<string, KintaiDiffValue>();
  const b = (body ?? {}) as { drivers?: unknown; driver?: unknown; days?: unknown };
  if (Array.isArray(b.drivers)) {
    for (const d of b.drivers) {
      const driver = (d as { driver?: unknown }).driver;
      const days = (d as { days?: unknown }).days;
      if (!Array.isArray(days)) continue;
      addOnpremDriverDays(out, driver, days);
    }
    return { map: out, unreadable: false };
  }
  if (Array.isArray(b.days)) {
    const driver = b.driver ?? requestedDriver;
    addOnpremDriverDays(out, driver, b.days);
    return { map: out, unreadable: false };
  }
  return { map: out, unreadable: true };
}

/** `driver|date|start` キーから乗務員CD (先頭要素) を取り出す。 */
function driverOfKey(key: string): string {
  return key.slice(0, key.indexOf("|"));
}

/** キーは常に [gcpSummariesToMap] / [onpremKosokuDailyToMap] が組んだ 3 要素なので、
 *  分解結果が欠けることはない。 */
function keyToRow(key: string): { driver_cd: string; date: string; start: string } {
  const [driver_cd, date, ...rest] = key.split("|");
  return { driver_cd: driver_cd as string, date: date as string, start: rest.join("|") };
}

/** カテゴリごとの上限。get_kintai_diff / get_rest_diff と同じ既定に揃えた。 */
export const KINTAI_DIFF_MAX_ITEMS = 500;

export interface CappedCategory<T> {
  /** 切る前の総数。 */
  total: number;
  /** `total > items.length` か。 */
  capped: boolean;
  items: T[];
}

/** 1 カテゴリぶんを `KINTAI_DIFF_MAX_ITEMS` で切り、`total`/`capped` を添えて返す。黙って切らない。 */
function capCategory<T>(items: T[]): CappedCategory<T> {
  return {
    total: items.length,
    capped: items.length > KINTAI_DIFF_MAX_ITEMS,
    items: items.slice(0, KINTAI_DIFF_MAX_ITEMS),
  };
}

export interface KintaiDiffRow {
  driver_cd: string;
  date: string;
  start: string;
}

export type KintaiDiffValueDiffRow = KintaiDiffRow & {
  diff_fields: KintaiDiffMinuteField[];
  gcp: KintaiDiffValue;
  onprem: KintaiDiffValue;
};

export interface KintaiDiffResult {
  gcp_rows: number;
  onprem_rows: number;
  /** オンプレ応答の形が読めなかった (#599)。true のとき `onprem_rows: 0` は
   * 「本当に 0 行」ではないので `only_gcp` を「GCP にしか無い」と解釈しないこと。 */
  onprem_unreadable: boolean;
  /** GCP にしか無い。**運行NO単位の `never_onprem_ops` (下の
   * [`KintaiDiffGcpOnlyDriverSplit`]) とは母集団が違う** — こちらはオンプレ
   * `kosoku-daily` ⇔ GCP `day_summaries` (同じ fold・同じ乗務員母集団) の突合なので、
   * 打刻システムが無い営業所の乗務員が居ても構造的に非0にならない。差に含めてよい
   * 理由の実測・根拠は front (`nuxt-dtako-admin` の `app/utils/kintai-diff-view.ts`
   * `kintaiDiffHasAnyDiff` の docs) 参照 (Refs #620)。 */
  only_gcp: CappedCategory<KintaiDiffRow & { gcp: KintaiDiffValue }>;
  /** オンプレにしか無く乗務員CD=0。GCP が `driver_cd > 0` で意図的に除外しているので
   * 「欠け」ではない (rust-ichibanboshi `src/kintai_repo.rs` / `src/kintai_fold.rs`)。 */
  only_onprem_driver0: CappedCategory<KintaiDiffRow & { onprem: KintaiDiffValue }>;
  /** オンプレにしか無く乗務員CD≠0。こちらが本当の欠け。 */
  only_onprem_other: CappedCategory<KintaiDiffRow & { onprem: KintaiDiffValue }>;
  /** 値が違うが `restraint_minutes` は一致 (内訳だけ違う)。 */
  value_diff_restraint_match: CappedCategory<KintaiDiffValueDiffRow>;
  /** `restraint_minutes` も違う。 */
  value_diff_restraint_mismatch: CappedCategory<KintaiDiffValueDiffRow>;
}

/**
 * `乗務員CD|暦日|開始時刻` キーで突き合わせ、get_kintai_diff と同じ 5 区分に分ける。
 * 値が完全一致する行はどのカテゴリにも出さない (差が無いので報告不要)。
 */
export function buildKintaiDiff(gcpBody: unknown, onpremBody: unknown, requestedDriver?: string): KintaiDiffResult {
  const gcp = gcpSummariesToMap(gcpBody);
  const onpremParsed = onpremKosokuDailyToMap(onpremBody, requestedDriver);
  const onprem = onpremParsed.map;

  const onlyGcp: Array<KintaiDiffRow & { gcp: KintaiDiffValue }> = [];
  const onlyOnpremDriver0: Array<KintaiDiffRow & { onprem: KintaiDiffValue }> = [];
  const onlyOnpremOther: Array<KintaiDiffRow & { onprem: KintaiDiffValue }> = [];
  const restraintMatch: KintaiDiffValueDiffRow[] = [];
  const restraintMismatch: KintaiDiffValueDiffRow[] = [];

  for (const [key, g] of gcp) {
    const o = onprem.get(key);
    const row = keyToRow(key);
    if (!o) {
      onlyGcp.push({ ...row, gcp: g });
      continue;
    }
    const diffFields = KINTAI_DIFF_MINUTE_FIELDS.filter((f) => g[f] !== o[f]);
    if (diffFields.length === 0) continue;
    const bucket = g.restraint_minutes === o.restraint_minutes ? restraintMatch : restraintMismatch;
    bucket.push({ ...row, diff_fields: diffFields, gcp: g, onprem: o });
  }
  for (const [key, o] of onprem) {
    if (gcp.has(key)) continue;
    const row = keyToRow(key);
    (driverOfKey(key) === "0" ? onlyOnpremDriver0 : onlyOnpremOther).push({ ...row, onprem: o });
  }

  return {
    gcp_rows: gcp.size,
    onprem_rows: onprem.size,
    onprem_unreadable: onpremParsed.unreadable,
    only_gcp: capCategory(onlyGcp),
    only_onprem_driver0: capCategory(onlyOnpremDriver0),
    only_onprem_other: capCategory(onlyOnpremOther),
    value_diff_restraint_match: capCategory(restraintMatch),
    value_diff_restraint_mismatch: capCategory(restraintMismatch),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 観測値 (原因ではなく判定材料) — GCP recalc の dry-run 応答から拾う
// ─────────────────────────────────────────────────────────────────────────

/**
 * `relayKintaiRecalc` (kintai-relay.ts) の dry-run (apply 省略) 応答から、
 * 差の「原因」ではなく「判定材料」になる観測値だけを拾う (Refs #615-4)。
 *
 * **原因を断定しないこと。** stale や warnings は「GCP が畳み直し待ちかもしれない」
 * 「入力が欠けているかもしれない」という手がかりであって、どちらの DB が正しいかを
 * 決めるものではない (get_kintai_diff の note と同じ理由)。
 *
 * 応答は受け側 (rust-ichibanboshi `src/routes/kintai_recalc.rs`) の形をそのまま
 * 読む — [`relayKintaiRecalc`] 自身が reshape しない方針(kintai-relay.ts の docs参照)
 * を踏襲し、ここでも新しいフィールドが増えたら拾えるだけ拾う・欠けていれば `null`/`[]`
 * に倒す防御的な読み方に統一する (型を固定しすぎて上流の応答変化で丸ごと壊れないため)。
 */
/**
 * [`KintaiDiffObservations.unko_diff_gcp_only_in_month`] の内訳 (Refs #615-7)。
 * 対象月に GCP にしか無い運行を、乗務員側の事情で 3 つに割る:
 *
 * - `never_onprem_*`: 対象乗務員がオンプレに一度も居ない。**打刻システムが無い営業所**の
 *   乗務員、または**乗務員CD=0** (構内移動・回送等) — 構造的に説明が付くので差ではない
 * - `also_in_month_*`: 対象乗務員は当月オンプレにも居る。**取り込み漏れの候補**
 * - `other_month_only_*`: 対象乗務員は別月にはオンプレに居る
 *
 * `never_onprem_ops + also_in_month_ops + other_month_only_ops` は
 * `unko_diff_gcp_only_in_month` (対象月の合計) と一致する。上流 (`run_kintai_recalc`) が
 * 既に計算しているものをそのまま読むだけで、ここでは何も計算しない。
 * 欠けたフィールドは 0 に倒す (undefined 安全 — 合計との整合を壊さないため `null` にしない)。
 */
export interface KintaiDiffGcpOnlyDriverSplit {
  never_onprem_drivers: number;
  never_onprem_ops: number;
  also_in_month_drivers: number;
  also_in_month_ops: number;
  other_month_only_drivers: number;
  other_month_only_ops: number;
}

export interface KintaiDiffObservations {
  /** 現行 `logic_version` を 1 つも持たない乗務員数 (= stale)。読めなければ `null`。 */
  stale_drivers: number | null;
  /** dry-run で畳み直したら値が変わる乗務員数 (= 「recalc の dry で何行変わるか」)。
   * 読めなければ `null`。 */
  fold_would_write_drivers: number | null;
  /** fold の warnings (例: "dtako 入力欠け: 乗務員12名の末尾が16日超")。無ければ空配列。 */
  warnings: string[];
  /** 対象月に GCP にしか無い運行の件数。読めなければ `null`。 */
  unko_diff_gcp_only_in_month: number | null;
  /** [`KintaiDiffGcpOnlyDriverSplit`] の docs 参照。上流に無ければ全フィールド 0。 */
  unko_diff_gcp_only_driver_split: KintaiDiffGcpOnlyDriverSplit;
  /** ページングの続きがあるか (`null` なら回りきった/情報なし)。 */
  next_after_driver_cd: number | null;
}

function toNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pickGcpOnlyDriverSplit(raw: unknown): KintaiDiffGcpOnlyDriverSplit {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    never_onprem_drivers: toNumberOr0(obj.never_onprem_drivers),
    never_onprem_ops: toNumberOr0(obj.never_onprem_ops),
    also_in_month_drivers: toNumberOr0(obj.also_in_month_drivers),
    also_in_month_ops: toNumberOr0(obj.also_in_month_ops),
    other_month_only_drivers: toNumberOr0(obj.other_month_only_drivers),
    other_month_only_ops: toNumberOr0(obj.other_month_only_ops),
  };
}

/** [`KintaiDiffObservations`] の docs 参照。 */
export function pickRecalcObservations(raw: unknown): KintaiDiffObservations {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const stale = typeof obj.stale === "object" && obj.stale !== null ? (obj.stale as Record<string, unknown>) : {};
  const fold = typeof obj.fold === "object" && obj.fold !== null ? (obj.fold as Record<string, unknown>) : {};
  const warningsRaw = Array.isArray(obj.warnings) ? obj.warnings : [];
  return {
    stale_drivers: toNumberOrNull(stale.drivers),
    fold_would_write_drivers: toNumberOrNull(fold.drivers_written ?? obj.drivers_written),
    warnings: warningsRaw.filter((w): w is string => typeof w === "string"),
    unko_diff_gcp_only_in_month: toNumberOrNull(obj.unko_diff_gcp_only_in_month),
    unko_diff_gcp_only_driver_split: pickGcpOnlyDriverSplit(obj.unko_diff_gcp_only_driver_split),
    next_after_driver_cd: toNumberOrNull(obj.next_after_driver_cd),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 突合結果のキャッシュ (Refs #620-3)
//
// `/kintai/diff` (このファイルの上、約50秒) の結果を保存し「最終確認日」を添えて
// 出すための pure ロジック。保存先の版管理 (R2 latest + 内容が変わった時だけ
// `v-{ts}`、customMetadata に sha256/fetchedAt/lastVerifiedAt) は
// `/restraint-fetch` の CSV/サマリ archive (`theearth-restraint-client.ts` の
// `restraintR2Paths` / DO の `putVersionedR2`) と同じ流儀に揃える — 新しい
// 方式は作らない。実行 (R2 read/write) は DO 側、ここは変換だけ。
//
// **保存するのは表示に要る分だけ** — 各カテゴリの `total`/`capped` だけを持ち、
// `items` (行の中身、カテゴリごと最大500件) は捨てる。この画面 (オンプレ vs
// Supabase タブ) は件数しか表示しないため。行の一覧が要る取り込み漏れ候補の導線
// (#623-2) は別の新しい口を持つ計画で、ここのキャッシュとは無関係。
// ─────────────────────────────────────────────────────────────────────────

/** R2 保存用の1カテゴリ (`total`/`capped` だけ。`items` は保存しない)。 */
export interface KintaiDiffCachedCategory {
  total: number;
  capped: boolean;
}

function toCachedCategory(c: CappedCategory<unknown>): KintaiDiffCachedCategory {
  return { total: c.total, capped: c.capped };
}

/** R2 latest.json の中身。フィールド名は `/kintai/diff` の応答 (`diff`/`observations`/
 * `observations_error`) と揃えている — front の `parseKintaiDiffApiResponse` が
 * ライブ応答・キャッシュ応答のどちらもそのまま読めるようにするため。 */
export interface KintaiDiffCacheSnapshot {
  month: string;
  diff: {
    gcp_rows: number;
    onprem_rows: number;
    onprem_unreadable: boolean;
    only_gcp: KintaiDiffCachedCategory;
    only_onprem_driver0: KintaiDiffCachedCategory;
    only_onprem_other: KintaiDiffCachedCategory;
    value_diff_restraint_match: KintaiDiffCachedCategory;
    value_diff_restraint_mismatch: KintaiDiffCachedCategory;
  };
  observations: KintaiDiffObservations | null;
  observations_error: string | null;
}

/** 突合の結果 (フル、`items` 込み) から保存用スナップショットを組む
 * (`items` を捨てるだけ — 判定や計算は一切しない)。 */
export function buildKintaiDiffCacheSnapshot(
  month: string,
  diff: KintaiDiffResult,
  observations: KintaiDiffObservations | null,
  observationsError: string | null,
): KintaiDiffCacheSnapshot {
  return {
    month,
    diff: {
      gcp_rows: diff.gcp_rows,
      onprem_rows: diff.onprem_rows,
      onprem_unreadable: diff.onprem_unreadable,
      only_gcp: toCachedCategory(diff.only_gcp),
      only_onprem_driver0: toCachedCategory(diff.only_onprem_driver0),
      only_onprem_other: toCachedCategory(diff.only_onprem_other),
      value_diff_restraint_match: toCachedCategory(diff.value_diff_restraint_match),
      value_diff_restraint_mismatch: toCachedCategory(diff.value_diff_restraint_mismatch),
    },
    observations,
    observations_error: observationsError,
  };
}

function parseCachedCategory(raw: unknown): KintaiDiffCachedCategory | null {
  if (raw == null || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.total !== "number" || typeof c.capped !== "boolean") return null;
  return { total: c.total, capped: c.capped };
}

/** 保存済み `observations` を読む。**保存時と同じ (既に平らな) 形**なので
 * `pickRecalcObservations` (upstream の recalc dry-run 応答の形、`stale.drivers`
 * のようにネストしている) とは読む形が違う — 混同しないこと。 */
function parseCachedObservations(raw: unknown): KintaiDiffObservations | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    stale_drivers: toNumberOrNull(r.stale_drivers),
    fold_would_write_drivers: toNumberOrNull(r.fold_would_write_drivers),
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : [],
    unko_diff_gcp_only_in_month: toNumberOrNull(r.unko_diff_gcp_only_in_month),
    unko_diff_gcp_only_driver_split: pickGcpOnlyDriverSplit(r.unko_diff_gcp_only_driver_split),
    next_after_driver_cd: toNumberOrNull(r.next_after_driver_cd),
  };
}

/**
 * R2 latest.json (`JSON.parse` 済みの値) を検証して読む。壊れている/形が
 * 合わない場合は `null` — 呼び出し側はこれを**「読めませんでした」として表示し、
 * 「差はありません」(0件の正常な結果) と混同しないこと** (#620-3 やること★:
 * 「無い」と「引けていない」を混同しない、この repo で繰り返し要求される作法)。
 */
export function parseKintaiDiffCacheSnapshot(raw: unknown): KintaiDiffCacheSnapshot | null {
  if (raw == null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.month !== "string") return null;
  if (r.diff == null || typeof r.diff !== "object") return null;
  const d = r.diff as Record<string, unknown>;
  const onlyGcp = parseCachedCategory(d.only_gcp);
  const onlyOnpremDriver0 = parseCachedCategory(d.only_onprem_driver0);
  const onlyOnpremOther = parseCachedCategory(d.only_onprem_other);
  const valueDiffMatch = parseCachedCategory(d.value_diff_restraint_match);
  const valueDiffMismatch = parseCachedCategory(d.value_diff_restraint_mismatch);
  if (!onlyGcp || !onlyOnpremDriver0 || !onlyOnpremOther || !valueDiffMatch || !valueDiffMismatch) return null;
  if (typeof d.gcp_rows !== "number" || typeof d.onprem_rows !== "number" || typeof d.onprem_unreadable !== "boolean") {
    return null;
  }
  return {
    month: r.month,
    diff: {
      gcp_rows: d.gcp_rows,
      onprem_rows: d.onprem_rows,
      onprem_unreadable: d.onprem_unreadable,
      only_gcp: onlyGcp,
      only_onprem_driver0: onlyOnpremDriver0,
      only_onprem_other: onlyOnpremOther,
      value_diff_restraint_match: valueDiffMatch,
      value_diff_restraint_mismatch: valueDiffMismatch,
    },
    observations: r.observations != null ? parseCachedObservations(r.observations) : null,
    observations_error: typeof r.observations_error === "string" ? r.observations_error : null,
  };
}

/** R2 key 設計。`/restraint-fetch` の `restraintR2Paths` と同じ `${prefix}/${compId}/...`
 * 形に揃える (月ごとの `latest.json` + 内容が変わった時だけ `v-{ts}.json`)。 */
export interface KintaiDiffCacheR2Paths {
  /** 版一覧の list / prune 用ディレクトリ。 */
  dir: string;
  latest: string;
  version(ts: string): string;
}

export function kintaiDiffCacheR2Paths(prefix: string, compId: string, ym: string): KintaiDiffCacheR2Paths {
  const dir = `${prefix}/${compId}/kintai-diff/${ym}`;
  return {
    dir,
    latest: `${dir}/latest.json`,
    version: (ts) => `${dir}/v-${ts}.json`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MySQL 取り直し (①②③) の「押しても直る保証」判定
// ─────────────────────────────────────────────────────────────────────────

/**
 * オンプレ `rest-diff` (`GET /api/kintai/rest-diff`) の応答から、指定した `unko_no`
 * が **押しても直る保証がある対象 (`kind: "mismatch"`) かどうか** を引く (Refs #615-4)。
 *
 * rust-ichibanboshi 側のコード自身が「押す対象は `mismatch` だけ。`dtako_missing` は
 * 押しても直る保証が無いので混ぜるな」と明記している (`src/kintai_rest_diff.rs` の doc、
 * #615-2 で確認済み)。**ここではその判定を実行せず、観測結果をそのまま返すだけ** —
 * `dtako_missing`/`events_missing` を弾く/ブロックすることはしない (実測で `mismatch` が
 * 3 か月連続 0 件になっており、弾くと MySQL 取り直し口が実質使えなくなる。
 * 保証の有無は画面が併記する、#615-3 決定2)。
 *
 * 応答に対象 `unko_no` が見当たらない場合は `kind: null` (判定不能 — その月/乗務員の
 * 対象では無かった、または既に一致している)。
 */
export interface RestDiffGuarantee {
  found: boolean;
  kind: string | null;
  /** `kind === "mismatch"` のときだけ true。`found: false` のときも false
   * (判定不能を「保証なし」と混同しないよう `found` を必ず併読すること)。 */
  guaranteed: boolean;
}

export function pickRestDiffGuarantee(raw: unknown, unkoNo: string): RestDiffGuarantee {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const items = Array.isArray(obj.items) ? obj.items : [];
  for (const item of items) {
    const r = item as Record<string, unknown>;
    if (typeof r.unko_no === "string" && r.unko_no === unkoNo) {
      const kind = typeof r.kind === "string" ? r.kind : null;
      return { found: true, kind, guaranteed: kind === "mismatch" };
    }
  }
  return { found: false, kind: null, guaranteed: false };
}

// ─────────────────────────────────────────────────────────────────────────
// unko_no → ope_no_22 / start_ope の導出 (Refs #615-4、親の指摘 2026-08-03)
// ─────────────────────────────────────────────────────────────────────────

/**
 * 運行NO (`unko_no`) から theearth 側の識別子 (`ope_no_22`/`start_ope`) を導く
 * (Refs #615-4)。**運行NO は桁に情報を持っている**: 23桁 = 開始日時12桁 +
 * 車輌CD10桁 + 対象CD1桁。前半12桁を読めば始業日時が復元できる。
 *
 * - オンプレの `unko_no` は**23桁**、GCP (alc 由来) は既に**22桁** (kintai-ops skill
 *   §4.6)。**末尾1桁を落とすのはオンプレ形のときだけ** — 22桁と23桁を混ぜる
 *   (23桁のまま末尾を落とし忘れる/22桁からさらに落とす) と存在しない運行を指す。
 * - `start_ope` の形式は `"YYYY/MM/DD H:mm:ss"`。**時は0埋めなし** (`START_OPE_RE`
 *   がそう定義している) — 分・秒は2桁のまま。
 *
 * 23桁/22桁のどちらでもない (桁数違反) 入力は `null` を返す (呼び出し側が400にする)。
 * 前半12桁が実在するカレンダー値かまでは検証しない — 運行NOの構造から機械的に
 * 切り出すだけで、意味的な妥当性は theearth 側 (押した結果) が判定する。
 */
export interface DerivedOpeNo {
  opeNo22: string;
  startOpe: string;
}

const UNKO_NO_23_RE = /^\d{23}$/;
const UNKO_NO_22_RE = /^\d{22}$/;

export function deriveOpeNoFromUnkoNo(unkoNo: string): DerivedOpeNo | null {
  let opeNo22: string;
  if (UNKO_NO_23_RE.test(unkoNo)) {
    opeNo22 = unkoNo.slice(0, 22);
  } else if (UNKO_NO_22_RE.test(unkoNo)) {
    opeNo22 = unkoNo;
  } else {
    return null;
  }

  const prefix = opeNo22.slice(0, 12);
  const yy = Number(prefix.slice(0, 2));
  const mm = prefix.slice(2, 4);
  const dd = prefix.slice(4, 6);
  const hh = Number(prefix.slice(6, 8));
  const mi = prefix.slice(8, 10);
  const ss = prefix.slice(10, 12);
  // 2000年代決め打ち (theearth/dtako の運用開始が2000年以降のため)。
  const year = 2000 + yy;
  const startOpe = `${year}/${mm}/${dd} ${hh}:${mi}:${ss}`;
  return { opeNo22, startOpe };
}
