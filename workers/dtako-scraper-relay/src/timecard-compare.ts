/**
 * 社内 CakePHP のタイムカード表 (PDF) と、こちらの拘束時間を**暦日ごとに突き合わせる**
 * (Refs #492 PR-A、上流は yhonda-ohishi/nginx#782 / ohishi-exp/rust-ichibanboshi#143)。
 *
 * ## なぜ暦日で比べられるのか
 *
 * nginx の `time_card_kosoku` は計算した時点で**暦日へ配ってある** (勤務ではなく運行
 * 単位で積み、`proc_date` ごとに保存する)。こちら側も #473〜#479 で拘束・深夜・残業・
 * 出勤日数をすべて暦日按分に統一した。よって単位変換は要らず、`YYYY-MM-DD` をキーに
 * そのまま引き算できる。
 *
 * ## 突合するのは拘束だけ
 *
 * - **残業は比較しない** (ユーザー決定)。nginx の残業列は旅費由来 + 手入力の加算補正で、
 *   こちらの `overtimeMinutes` (所定超) とは定義が別物。並べても差の意味が読めない
 * - 打刻・休暇区分・月次集計欄の突合は上流の実応答を見てから (#492 の後続)
 *
 * ## 負の拘束は clamp しない
 *
 * nginx 側は控除 (昼休の一律 -60 分・フェリー・運行重複) がその日の積算を上回ると
 * **拘束が負になる** (yhonda-ohishi/nginx#783)。それを見つけるのがこの突合の目的
 * なので、途中のどこでも 0 に丸めない。`anomalies` に載せて数える。
 *
 * ## 突合の基準は「減算後」= 紙の値 (2026-07-28 ユーザー決定)
 *
 * nginx は控除の**前**の値も診断として出す (`total_before_minus` / `ferry_minus`)
 * が、**比較に使うのは減算後**。理由は 2 つ:
 *
 * 1. 紙のタイムカード表に出ているのが減算後の値で、突合の相手はその紙
 * 2. 「運行開始 → 始業」の減算 (`minus_unko`) は**減算後のほうがこちらと一致する** —
 *    1379 / 2026-04-27 は差 -1 分、減算前だと +12 分。こちらの `kosoku-daily` も
 *    その区間を拘束に入れていないため
 *
 * **フェリー控除だけは逆で、引きすぎ**。1726 / 2026-03-14 は nginx -112 に対し
 * こちら 321 で、差 -433 が控除額そのものだった。基準は変えず、差の原因として
 * `anomalies` に書く。
 *
 * ## 控除額の出どころは**こちら側** (2026-07-28)
 *
 * 一時 nginx が `ferry_minus` を出していたが (yhonda-ohishi/nginx#787)、算出コストが
 * 運行ごとの N+1 で全乗務員 +5 秒だったため revert され (#788)、
 * **`dtako_ferry_rows` からの算出は rust 側へ移った**
 * (ohishi-exp/rust-ichibanboshi#146/#148)。よって控除額は `kosoku-daily` の日別行に
 * 乗って来る。nginx が再び出した場合に備えて pdf-json 側の読み取りも残してあるが、
 * **こちらの値を優先**する。
 */

/** 突合の既定の許容誤差 (分)。秒→分の丸め方の違いで 1 分ずれる。 */
export const DEFAULT_TOLERANCE_MINUTES = 1;

/** nginx 側の 1 暦日。 */
export interface NginxDay {
  /** `YYYY-MM-DD`。 */
  date: string;
  /** 拘束 (分)。**負のまま持つ**。行はあるが値が無い場合は null。 */
  kosokuMinutes: number | null;
  /** type 別内訳 (`デジタコ` / `TC_DC`)。上流が出さなければ空。 */
  kosokuByType: Record<string, number>;
  /**
   * type 別の「運行開始 → 始業」減算分 (yhonda-ohishi/nginx#785)。0 は載せない。
   *
   * **突合の基準は変えない。** 実データで確かめたところ、減算前の値はこちらの値に
   * 近づかない (1379 / 2026-04-27 は差 -1 分 → 減算前だと +12 分)。紙に出ているのは
   * 減算後なので、比較はそちらのまま。この値は**負値の原因を説明する**ために持つ。
   */
  minusUnkoByType: Record<string, number>;
  /**
   * 同日フェリーとして日計から引かれた分 (yhonda-ohishi/nginx#787)。該当なしは null。
   *
   * **`minus_unko` とは逆で、こちらは引きすぎ**。実データ (1726 / 2026-03-14) では
   * nginx -112 に対しこちら 321 で、差 -433 が**フェリー控除額そのもの**だった。
   * 同日に 4 時間未満のフェリーが 2 本あると両方引かれて積算を食い破る。
   */
  ferryMinusMinutes: number | null;
}

/** nginx 側の 1 乗務員 × 1 ヶ月。 */
export interface NginxDriverMonth {
  /** 乗務員CD (`String(Number(...))` 正規化済み)。 */
  driverCd: string;
  name: string;
  days: NginxDay[];
  /** 月次集計欄。負値の検出に使うので生値のまま持つ。 */
  totals: Record<string, number>;
}

/** 検出した異常 1 件。**差分とは独立** — 両者が一致していても出る。 */
export interface CompareAnomaly {
  kind:
    | "negative-kosoku"
    | "negative-kosoku-type"
    | "impossible-kosoku"
    | "negative-total"
    | "ferry-minus";
  /** 対象の暦日 (`YYYY-MM-DD`)。月次集計欄の異常は null。 */
  date: string | null;
  /** `negative-kosoku-type` は type 名、`negative-total` は集計欄の項目名。 */
  field: string | null;
  minutes: number;
  message: string;
}

/** 1 暦日の突合結果。 */
export interface CompareDay {
  date: string;
  nginxMinutes: number | null;
  oursMinutes: number | null;
  /** `nginx - ours`。どちらかが欠けている日は null。 */
  diffMinutes: number | null;
  status: "match" | "within-tolerance" | "mismatch" | "nginx-only" | "ours-only" | "both-empty";
  /**
   * その日に nginx が引いた同日フェリー控除 (分)。該当なしは null。
   *
   * **合計が正でも出す。** 実データ (1726 / 2026-03) では 3/14 が -112 分 (控除 433)、
   * 3/21 が +677 分 (控除 78) で、後者は負にならないぶん見落とす。控除額そのものを
   * 画面と MCP から確かめられるようにする。
   */
  ferryMinusMinutes: number | null;
  /**
   * その日の差 (`nginx - ours`) を**どこまで説明できたか** (Refs #501)。
   *
   * 今回の目標は直すことではなく、**差を全部検知して原因の当たりを付ける**こと。
   * `cause` が `unknown` の日が残っている限り、突合はまだ見えていない差を持っている。
   */
  cause: DiffCause;
  /** 既知の規則で説明が付いた分 (分)。nginx がこちらより小さくなる向きを正で持つ。 */
  explainedMinutes: number;
  /** 説明しきれずに残った差 (分)。`diffMinutes + explainedMinutes`。 */
  residualMinutes: number | null;
  anomalies: CompareAnomaly[];
}

/**
 * 差の**推定原因**。片側にしか無い日と、許容誤差に収まる日は `none`。
 *
 * `lunch` は**推定**で、`ferry` は**実額**。nginx が引いた昼休は上流の応答に出て
 * こないので差の形 (60 分前後) から当てるしかないが、フェリー控除額はこちら側の
 * `kosoku-daily` が実額を運んでくる (ohishi-exp/rust-ichibanboshi#146/#148)。
 */
export type DiffCause =
  /** 説明する差が無い (`match` / `within-tolerance` / 片側だけ / 両側空)。 */
  | "none"
  /** 昼休の一律控除 (推定)。nginx は**拘束から**引くが、こちらは休憩に入れて拘束からは引かない。 */
  | "lunch"
  /** 同日フェリー控除 (実額)。 */
  | "ferry"
  /** 昼休 + フェリーの合計で説明が付く。 */
  | "lunch+ferry"
  /**
   * **月境界を跨ぐ勤務** (実額)。紙は月内の打刻だけで対を組むため、月を跨ぐ勤務は
   * どちらの月のシートにも載らない — 前月から跨いだ朝側が月初に、翌月へ跨ぐ頭が
   * 月末に、こちら側だけの値として出る (`crossMonthMinutesByDate`)。紙が構造的に
   * 数え漏らしている分なので、こちらが正。
   */
  | "month-boundary"
  /**
   * **運行の継ぎ目** (実額)。紙は運行単位のスパン合算なので 運行終了 → 次の運行開始
   * の短い空きを拘束に入れない。こちらは #123 の決定どおり入れる (ユーザー決定
   * 2026-07-29: 拘束は変えず突合で説明扱いに落とす)。実額は上流の
   * `run_gap_minutes` (ohishi-exp/rust-ichibanboshi#170)。
   */
  | "run-gap"
  /** 昼休 + 運行の継ぎ目。対の打刻を持つ乗務員の運行日で併発する。 */
  | "lunch+run-gap"
  /**
   * **日跨ぎ終業の尻尾** (実額)。紙は暦日ごとに「最初→最後のイベント」で数える
   * ため、0 時過ぎの終業打刻までの尻尾を数えない。実額は上流の
   * `punch_tail_minutes` (ohishi-exp/rust-ichibanboshi#172)。
   */
  | "punch-tail"
  /** フェリー + 尻尾。1708 松江 03-13 (-584 = 432 + 151 + 丸め 1) の形。 */
  | "ferry+punch-tail"
  /** フェリー + 日跨ぎ始業の頭。1029 冨田 03-18 (-89 = 84 + 5) の形。 */
  | "ferry+punch-head"
  /** 昼休 + 尻尾。 */
  | "lunch+punch-tail"
  /**
   * **日跨ぎ始業の頭** (実額、尻尾の鏡像)。対の無い始業が次の休息まで伸びるとき、
   * 最初のデジタコイベントが後の暦日にあると紙は打刻の日を数えない。実額は上流の
   * `punch_head_minutes` (ohishi-exp/rust-ichibanboshi#173)。
   * 1108 福留 03-05/06 (頭 1495 分 = 979 + 516) の形。
   */
  | "punch-head"
  /**
   * **始業前の運行の頭** (実額、**紙が大きくなる向き**)。紙は運行スパンを運行開始
   * から数えるが minus_unko 控除 (nginx#785) は 1 日 1 回しか効かず、同じ暦日に
   * 勤務が 2 本ある日や TC_DC null の日は頭が紙に残る。説明は「紙の
   * `TC_DC_minus_unko` − こちらの `run_head_minutes`」(通常は負)。
   * 実測 1026 一瀬 03-12 (+7 = 朝の頭 7 が残り、控除は夕方の 3 のみ)。
   */
  | "run-head"
  /** フェリー + 始業前の運行の頭。フェリー航路の常連 (1026) は毎日併発する。 */
  | "ferry+run-head"
  /** 昼休 + 始業前の運行の頭。 */
  | "lunch+run-head"
  /**
   * **丸め方式の差** (実額)。紙は打刻・イベントの秒を保持したまま**区分ごとに**
   * 丸めて日計へ足す (TC_DC は経過秒切り捨て、デジタコの区間時間は端点床) ため、
   * 区分の切れ目が多い日に ±数分が堆積する — 正負両方向に出る。実額は上流の
   * `paper_drift_by_date` (ohishi-exp/rust-ichibanboshi#179 = 紙の日別拘束の再現値
   * とこちらの暦日按分値の差)。
   *
   * **最後の候補。** 再現値との差は昼休など既存 cause の分も含む全再現差なので、
   * 個別の cause で説明できる日はそちらが先に当たる — ここへ落ちるのは丸めだけが
   * 残った日。
   */
  | "rounding"
  /** フェリー + 丸め。1714 井上 03-06 (-76 = 73 + 3) の形。 */
  | "ferry+rounding"
  /**
   * **月境界の跨ぎ + 丸め**。純夜勤の跨ぎ勤務でも、0 時過ぎの運行イベントは紙の
   * デジタコ側に**部分計上**される — 跨ぎの丸ごと (`crossMonth`) から紙が拾った分
   * (drift が負に出る) を引いた残りが差になる。1194 陣野 04-01
   * (-525 = 跨ぎ 552 − 紙の部分計上 27) の形。
   */
  | "month-boundary+rounding"
  /** **未説明。** ここが 0 になるまでが検知の仕事。 */
  | "unknown";

/** 1 乗務員 × 1 ヶ月の突合結果。 */
export interface CompareResult {
  month: string;
  driverCd: string;
  name: string;
  toleranceMinutes: number;
  days: CompareDay[];
  totals: {
    nginxMinutes: number;
    oursMinutes: number;
    diffMinutes: number;
    /** 月内のフェリー控除の合計 (分)。nginx の `summary.total_ferry_minus` と一致する。 */
    ferryMinusMinutes: number;
  };
  /** `status` が `match` / `within-tolerance` / `both-empty` 以外の日数。 */
  mismatchCount: number;
  /** 原因が `unknown` の日数。**検知の抜けを測る数字**なので、独立に持つ。 */
  unknownCount: number;
  /** 原因が `unknown` の日の `residualMinutes` の合計 (分)。 */
  unknownMinutes: number;
  anomalies: CompareAnomaly[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 暦日として取りうる上限 (分)。これを超える値は上流の計算事故。 */
const MINUTES_PER_DAY = 1440;

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * `day` (1〜31) か `date` (`YYYY-MM-DD`) のどちらでも暦日にする。
 *
 * 上流 (nginx#782) の形が確定していないので**両方受ける**。突合の相手 (こちら側) は
 * `YYYY-MM-DD` を鍵にしているので、ここで揃える。
 */
export function toDateKey(raw: Record<string, unknown>, ym: string): string | null {
  if (typeof raw.date === "string" && DATE_RE.test(raw.date)) return raw.date;
  const day = finiteNumber(raw.day);
  if (day === null || !Number.isInteger(day) || day < 1 || day > 31) return null;
  return `${ym}-${String(day).padStart(2, "0")}`;
}

function toKosokuByType(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = finiteNumber(raw);
    if (n !== null) out[key] = n;
  }
  return out;
}

function toTotals(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = finiteNumber(raw);
    if (n !== null) out[key] = n;
  }
  return out;
}

/**
 * `kosoku_minutes` のうち**拘束そのものではない診断値**
 * (yhonda-ohishi/nginx#785 / #787)。
 *
 * - `<type>_minus_unko` … 「運行開始 → 始業」として日計から引かれた分
 * - `<type>_before_minus` / `total_before_minus` … その減算をする前の値
 * - `ferry_minus` … 同日フェリーとして日計から引かれた分
 *
 * これらを type 別内訳に混ぜると**存在しない拘束区分**ができ、値が負なら偽の異常に
 * なる。接尾辞と既知のキー名で外す — 上流が診断を増やしても同じ命名なら追随できる。
 */
const KOSOKU_DIAGNOSTIC_SUFFIXES = ["_minus_unko", "_before_minus"] as const;

/** 接尾辞では拾えない診断値のキー (`ferry_minus` は type 名を前に持たない)。 */
const FERRY_MINUS_KEY = "ferry_minus";

function diagnosticSuffixOf(key: string): string | null {
  return KOSOKU_DIAGNOSTIC_SUFFIXES.find((s) => key.endsWith(s)) ?? null;
}

/** 1 日の拘束の読み取り結果。 */
interface ParsedKosoku {
  minutes: number | null;
  byType: Record<string, number>;
  /** type 別の「運行開始 → 始業」減算分 (0 は載せない)。負値の説明に使う。 */
  minusUnkoByType: Record<string, number>;
  /** 同日フェリーとして引かれた分 (0/未提供は null)。負値の説明に使う。 */
  ferryMinusMinutes: number | null;
}

/**
 * 1 日の拘束を読む。
 *
 * 実応答 (yhonda-ohishi/nginx#784) は
 * `kosoku_minutes: {total, デジタコ, TC_DC}` の**オブジェクト**で、値は日により null。
 * #785 で診断値 (`TC_DC_minus_unko` ほか) が加わった。数値 1 個の形も受けておく
 * (起票時の想定がそちらだった)。
 *
 * `total` と診断値を除いたキーを type 別内訳として扱うので、上流が拘束区分を
 * 増やしてもここを触らずに拾える。
 */
function toKosoku(raw: unknown): ParsedKosoku {
  const empty = { byType: {}, minusUnkoByType: {}, ferryMinusMinutes: null };
  const direct = finiteNumber(raw);
  if (direct !== null) return { minutes: direct, ...empty };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { minutes: null, ...empty };
  }
  const byType: Record<string, number> = {};
  const minusUnkoByType: Record<string, number> = {};
  let ferryMinusMinutes: number | null = null;
  let minutes: number | null = null;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = finiteNumber(value);
    if (n === null) continue;
    if (key === FERRY_MINUS_KEY) {
      // 0 は「該当なし」— null と同じ扱いにして説明文を出さない
      if (n !== 0) ferryMinusMinutes = n;
      continue;
    }
    const suffix = diagnosticSuffixOf(key);
    if (suffix === "_minus_unko") {
      // 0 は「該当なし」— 全日に載せると異常メッセージが読みにくくなる
      if (n !== 0) minusUnkoByType[key.slice(0, -suffix.length)] = n;
      continue;
    }
    if (suffix) continue;
    if (key === "total") minutes = n;
    else byType[key] = n;
  }
  return { minutes, byType, minusUnkoByType, ferryMinusMinutes };
}

function toNginxDriver(entry: unknown, ym: string): NginxDriverMonth | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  // 上流は `driver_id`、こちらの他経路は `driver` — どちらでも拾う
  const cd = Number(e.driver_id ?? e.driver);
  if (!Number.isFinite(cd) || cd === 0) return null;
  const days: NginxDay[] = [];
  if (Array.isArray(e.days)) {
    for (const raw of e.days) {
      if (typeof raw !== "object" || raw === null) continue;
      const d = raw as Record<string, unknown>;
      const date = toDateKey(d, ym);
      if (!date) continue;
      const kosoku = toKosoku(d.kosoku_minutes);
      days.push({
        date,
        kosokuMinutes: kosoku.minutes,
        // 内訳が別項目で来る形 (起票時の想定) も残す
        kosokuByType: { ...toKosokuByType(d.kosoku_by_type), ...kosoku.byType },
        minusUnkoByType: kosoku.minusUnkoByType,
        ferryMinusMinutes: kosoku.ferryMinusMinutes,
      });
    }
  }
  return {
    driverCd: String(cd),
    name: typeof e.name === "string" ? e.name : "",
    days,
    // 実応答は `summary`。`totals` は起票時の想定
    totals: { ...toTotals(e.totals), ...toTotals(e.summary) },
  };
}

/**
 * nginx が**エラーを HTTP 200 + `{error}` で返してくる**ので、それを拾う
 * (yhonda-ohishi/nginx#784: 月の書式違い・`KyuyoKisoDate` 未登録)。
 *
 * 素通しすると `rows` が無いだけになり、画面には「差なし」と出てしまう。
 * **黙って一致に見えるのが一番まずい**ので、呼び出し側で 502 に倒すために出す。
 */
export function pdfJsonError(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const err = (body as { error?: unknown }).error;
  return typeof err === "string" && err !== "" ? err : null;
}

/**
 * nginx の `/time-card/pdf-json` 応答を乗務員CD 引きに直す。
 *
 * 実応答 (yhonda-ohishi/nginx#784) は `{rows: [{driver_id, name, month, days, summary}]}`。
 * `days` は `array_values` 済みの配列で、1 名指定でも全乗務員でも同じ形。
 * 起票時に想定していた `{drivers: [...]}` / 単体オブジェクトも受けておく
 * (呼び分けや将来の変更で黙って空にならないように)。
 *
 * 解釈できない行は捨てる — 中継は既に済んでおり、ここで throw しても呼び出し側に
 * 打つ手が無い。**応答全体がエラーの場合だけ** [`pdfJsonError`] で別に拾う。
 */
export function parsePdfJson(body: unknown, ym: string): Map<string, NginxDriverMonth> {
  const out = new Map<string, NginxDriverMonth>();
  if (typeof body !== "object" || body === null) return out;
  const b = body as Record<string, unknown>;
  let entries: unknown[];
  if (Array.isArray(b.rows)) entries = b.rows;
  else if (Array.isArray(b.drivers)) entries = b.drivers;
  else entries = [b];
  for (const entry of entries) {
    const parsed = toNginxDriver(entry, ym);
    if (parsed) out.set(parsed.driverCd, parsed);
  }
  return out;
}

/** その日の nginx 側の値から異常を拾う。 */
function dayAnomalies(day: NginxDay): CompareAnomaly[] {
  const found: CompareAnomaly[] = [];
  const total = day.kosokuMinutes;
  if (total !== null && total < 0) {
    // フェリー控除で説明できるなら書く。原因が特定済み (yhonda-ohishi/nginx#787:
    // 同日 4 時間未満のフェリーが 2 本あると両方引かれて積算を食い破る) なので、
    // 読む人が毎回 CakePHP を追い直さずに済む
    const ferry = day.ferryMinusMinutes;
    const why =
      ferry !== null && ferry > 0
        ? `。同日フェリー控除の ${ferry} 分が引かれたため (控除前は ${total + ferry} 分)`
        : "";
    found.push({
      kind: "negative-kosoku",
      date: day.date,
      field: null,
      minutes: total,
      message: `nginx の拘束が負です (${total} 分)${why}`,
    });
  }
  if (total !== null && total > MINUTES_PER_DAY) {
    found.push({
      kind: "impossible-kosoku",
      date: day.date,
      field: null,
      minutes: total,
      message: `nginx の拘束が 1 日 (${MINUTES_PER_DAY} 分) を超えています (${total} 分)`,
    });
  }
  // フェリー控除は**それ自体が nginx 側の欠陥**なので、合計が負でなくても出す。
  //
  // 根拠は実測: 1726 / 2026-03 の 3/14 (控除 433) と 3/21 (控除 78) はどちらも
  // **控除前の値がこちらと一致する** (321 / 755)。同月の他の日は ±1 分で揃うので、
  // 控除ぶんだけが差になっている = 二重に引いている。
  //
  // **フェリーは `dtako_events` からは見分けられない。** 実測では 3/14 の 2 本が
  // 「休息」(224分 / 210分)、3/21 の 1 本が「休憩」(78分) で、イベント名が一定しない。
  // 見分けるには `dtako_ferry_rows` が要る。よってここでは分類から演繹せず、
  // **控除前の値がこちらと一致するという実測だけ**を根拠にする。
  const ferry = day.ferryMinusMinutes;
  if (ferry !== null && ferry > 0) {
    const before = total === null ? null : total + ferry;
    found.push({
      kind: "ferry-minus",
      date: day.date,
      field: null,
      minutes: ferry,
      message:
        `nginx が同日フェリー控除で ${ferry} 分を引いています` +
        (before === null ? "" : ` (控除前は ${before} 分)`) +
        "。控除前の値がこちらと一致するので二重に引いています",
    });
  }
  // 合計が正でも内訳の片方が負なことがある (控除が type ごとに効くため)
  for (const [type, minutes] of Object.entries(day.kosokuByType)) {
    if (minutes < 0) {
      // 「運行開始 → 始業」の二重補正で説明できるならそう言う — 上流の原因が
      // 特定済み (yhonda-ohishi/nginx#785) なので、読む人が毎回調べ直さずに済む
      const minus = day.minusUnkoByType[type];
      const why =
        minus !== undefined && minus > 0
          ? `。運行開始→始業の ${minus} 分が引かれたため (減算前は ${minutes + minus} 分)`
          : "";
      found.push({
        kind: "negative-kosoku-type",
        date: day.date,
        field: type,
        minutes,
        message: `nginx の拘束内訳 ${type} が負です (${minutes} 分)${why}`,
      });
    }
  }
  return found;
}

/** 月次集計欄の負値を拾う。 */
function totalsAnomalies(totals: Record<string, number>): CompareAnomaly[] {
  const found: CompareAnomaly[] = [];
  for (const [field, minutes] of Object.entries(totals)) {
    if (minutes < 0) {
      found.push({
        kind: "negative-total",
        date: null,
        field,
        minutes,
        message: `nginx の月次集計 ${field} が負です (${minutes})`,
      });
    }
  }
  return found;
}

/** その月の暦日 (`YYYY-MM-DD`) を 1 日から末日まで。 */
export function daysOfMonth(ym: string): string[] {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  // 翌月 0 日 = 当月末日
  const last = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0)).getUTCDate();
  const out: string[] = [];
  for (let d = 1; d <= last; d += 1) out.push(`${ym}-${String(d).padStart(2, "0")}`);
  return out;
}

function statusOf(
  nginxMinutes: number | null,
  oursMinutes: number | null,
  tolerance: number,
): CompareDay["status"] {
  // 「行が無い」と「0 分」は実質同じなので、片方が 0 なら一致扱いにする —
  // そうしないと稼働の無い日が月の 2/3 ほど mismatch になり、本当の差が埋もれる
  const nginxEmpty = nginxMinutes === null || nginxMinutes === 0;
  const oursEmpty = oursMinutes === null || oursMinutes === 0;
  if (nginxEmpty && oursEmpty) return "both-empty";
  if (nginxMinutes === null) return "ours-only";
  if (oursMinutes === null) return "nginx-only";
  const diff = Math.abs(nginxMinutes - oursMinutes);
  if (diff === 0) return "match";
  return diff <= tolerance ? "within-tolerance" : "mismatch";
}

/**
 * 紙が拘束から一律で引く昼休 (分)。
 *
 * nginx は運行を挟まない勤務 (`始業` → `終業`) で、始業が 12:00 前・終業が 13:00 後なら
 * **拘束から 60 分引く** (`TimeCardKosokuController::_make_tc_to_tc`)。こちらは同じ昼休を
 * **休憩**に入れるだけで拘束からは引かない (`rust-ichibanboshi/src/kosoku.rs`) ため、
 * その 60 分がまるごと差になる。
 */
const LUNCH_DEDUCTION_MINUTES = 60;

/**
 * その日の差の**推定原因**を決める (Refs #501)。
 *
 * 既知の規則で引かれた分を差から取り除き、残り (`residual`) が許容誤差に収まれば
 * 説明が付いたとみなす。**収まらなければ `unknown`** — そこが未解明の差。
 *
 * 昼休は上流の応答に出てこないので**差の形から当てる**。フェリーは実額が来るので
 * そのまま引く。当てる順は「フェリー → 月境界 → 継ぎ目 → 昼休 → 併発」—
 * 実額 (確実) を推定より先に。
 */
function classifyDiff(
  diffMinutes: number | null,
  ferryMinusMinutes: number | null,
  crossMonthMinutes: number,
  runGapMinutes: number,
  punchTailMinutes: number,
  punchHeadMinutes: number,
  runHeadCorrection: number,
  lunchOverlapMinutes: number,
  paperDriftMinutes: number,
  tolerance: number,
): { cause: DiffCause; explainedMinutes: number; residualMinutes: number | null } {
  if (diffMinutes === null) {
    return { cause: "none", explainedMinutes: 0, residualMinutes: null };
  }
  if (Math.abs(diffMinutes) <= tolerance) {
    return { cause: "none", explainedMinutes: 0, residualMinutes: diffMinutes };
  }
  const ferry = ferryMinusMinutes ?? 0;
  const tail = punchTailMinutes;
  // 紙が控除しきれなかった運行の頭 (通常は負 = 紙が大きい)。0 なら候補にならない
  const runHead = runHeadCorrection;
  // 昼休は実額 (rust#177 の窓の重なり) があればそれを、無ければ従来の固定 60 を使う。
  // 終業が窓の中に落ちる対は 60 未満になる (1714 井上 03-04 の 20 分)
  const lunch = lunchOverlapMinutes > 0 ? lunchOverlapMinutes : LUNCH_DEDUCTION_MINUTES;
  const candidates: Array<{ cause: DiffCause; explained: number }> = [
    { cause: "ferry", explained: ferry },
    { cause: "month-boundary", explained: crossMonthMinutes },
    { cause: "run-gap", explained: runGapMinutes },
    { cause: "punch-tail", explained: tail },
    { cause: "punch-head", explained: punchHeadMinutes },
    { cause: "run-head", explained: runHead },
    { cause: "ferry+punch-tail", explained: ferry === 0 || tail === 0 ? 0 : ferry + tail },
    { cause: "ferry+punch-head", explained: ferry === 0 || punchHeadMinutes === 0 ? 0 : ferry + punchHeadMinutes },
    { cause: "ferry+run-head", explained: ferry === 0 || runHead === 0 ? 0 : ferry + runHead },
    { cause: "lunch", explained: lunch },
    { cause: "lunch+run-gap", explained: runGapMinutes === 0 ? 0 : runGapMinutes + lunch },
    { cause: "lunch+punch-tail", explained: tail === 0 ? 0 : tail + lunch },
    { cause: "lunch+run-head", explained: runHead === 0 ? 0 : runHead + lunch },
    { cause: "lunch+ferry", explained: ferry + lunch },
    // 丸め (紙の再現値との差) は**必ず最後** — 全再現差なので、先に置くと個別の
    // cause で説明できる日まで rounding に見えてしまう。負にもなる (紙が大きい日)
    { cause: "rounding", explained: paperDriftMinutes },
    {
      cause: "ferry+rounding",
      explained: ferry === 0 || paperDriftMinutes === 0 ? 0 : ferry + paperDriftMinutes,
    },
    // 跨ぎ勤務でも 0 時過ぎの運行イベントは紙のデジタコ側に部分計上される — その分
    // drift が負に出るので、跨ぎの丸ごとと合算すると釣り合う (1194 陣野 04-01)
    {
      cause: "month-boundary+rounding",
      explained:
        crossMonthMinutes === 0 || paperDriftMinutes === 0
          ? 0
          : crossMonthMinutes + paperDriftMinutes,
    },
  ];
  for (const c of candidates) {
    // 引かれていない (ferry 0) 組み合わせは候補にしない — 0 を足しても説明にならない
    if (c.explained === 0) continue;
    const residual = diffMinutes + c.explained;
    if (Math.abs(residual) <= tolerance) {
      return { cause: c.cause, explainedMinutes: c.explained, residualMinutes: residual };
    }
  }
  return { cause: "unknown", explainedMinutes: 0, residualMinutes: diffMinutes };
}

/**
 * 1 乗務員 × 1 ヶ月を暦日で突き合わせる。
 *
 * `oursByDate` は [`kosokuPartsByDate`](./kosoku-daily.ts) の出力を想定 (暦日按分後)。
 * 月の全暦日を必ず返す — 画面は 1〜31 日の固定行で描くため、欠けた日を呼び出し側が
 * 埋め直さなくていいようにする。
 */
export function compareTimecardMonth(input: {
  month: string;
  driverCd: string;
  nginx: NginxDriverMonth | null;
  oursByDate: ReadonlyMap<
    string,
    {
      restraintMinutes: number,
      ferryMinusMinutes?: number,
      runGapMinutes?: number,
      punchTailMinutes?: number,
      punchHeadMinutes?: number,
      runHeadMinutes?: number,
      lunchOverlapMinutes?: number,
    }
  >;
  /**
   * 暦日 → 月境界を跨ぐ勤務由来の分 (`crossMonthMinutesByDate`)。渡されなければ
   * `month-boundary` の説明は付かない (候補の explained が 0 で素通り)。
   */
  crossMonthByDate?: ReadonlyMap<string, number>;
  /**
   * 暦日 → 紙の再現値との差 (`ours − paper`、上流の `paper_drift_by_date`)。
   * 渡されなければ `rounding` の説明は付かない。
   */
  paperDriftByDate?: ReadonlyMap<string, number>;
  /**
   * 暦日 → フェリー控除 (上流の `ferry_minus_by_date`、
   * ohishi-exp/rust-ichibanboshi#181)。勤務への貼り付けではマップに直せない日がある
   * (前月に始業した勤務だけが覆う日 — 実測 1026 一瀬 2026-05-01 の 76 分) ので、
   * あればこちらを優先する。無ければ従来の貼り付け値へ倒す。
   */
  ferryMinusByDate?: ReadonlyMap<string, number>;
  toleranceMinutes?: number;
}): CompareResult {
  const tolerance = input.toleranceMinutes ?? DEFAULT_TOLERANCE_MINUTES;
  const nginxByDate = new Map<string, NginxDay>();
  for (const d of input.nginx?.days ?? []) nginxByDate.set(d.date, d);

  const days: CompareDay[] = [];
  const anomalies: CompareAnomaly[] = [];
  let nginxTotal = 0;
  let oursTotal = 0;
  let ferryTotal = 0;
  let mismatchCount = 0;
  let unknownCount = 0;
  let unknownMinutes = 0;

  for (const date of daysOfMonth(input.month)) {
    const ours = input.oursByDate.get(date);
    const nginxDay = nginxByDate.get(date) ?? null;
    const nginxMinutes = nginxDay?.kosokuMinutes ?? null;
    const oursMinutes = ours?.restraintMinutes ?? null;
    const status = statusOf(nginxMinutes, oursMinutes, tolerance);
    // 控除額は**こちら側の kosoku-daily 由来**を優先する。nginx が出していた頃の
    // 値 (pdf-json の `ferry_minus`) は後方互換で残すだけ。
    // 日別マップ (rust#181) があれば勤務への貼り付けより優先 — 貼り付けは
    // 前月に始業した勤務だけが覆う日の控除を運べない
    const ferryFromOurs = input.ferryMinusByDate?.get(date) ?? ours?.ferryMinusMinutes;
    const withFerry: NginxDay | null =
      nginxDay && ferryFromOurs !== undefined && ferryFromOurs > 0
        ? { ...nginxDay, ferryMinusMinutes: ferryFromOurs }
        : nginxDay;
    const dayFound = withFerry ? dayAnomalies(withFerry) : [];
    anomalies.push(...dayFound);
    if (nginxMinutes !== null) nginxTotal += nginxMinutes;
    if (oursMinutes !== null) oursTotal += oursMinutes;
    if (status !== "match" && status !== "within-tolerance" && status !== "both-empty") {
      mismatchCount += 1;
    }
    const ferryMinusMinutes =
      ferryFromOurs !== undefined && ferryFromOurs > 0
        ? ferryFromOurs
        : (nginxDay?.ferryMinusMinutes ?? null);
    if (ferryMinusMinutes !== null) ferryTotal += ferryMinusMinutes;
    const diffMinutes =
      nginxMinutes === null || oursMinutes === null ? null : nginxMinutes - oursMinutes;
    const crossMonth = input.crossMonthByDate?.get(date) ?? 0;
    const runGap = ours?.runGapMinutes ?? 0;
    const punchTail = ours?.punchTailMinutes ?? 0;
    const punchHead = ours?.punchHeadMinutes ?? 0;
    // 始業前の運行の頭: 紙の minus_unko (nginx#785 の診断値) が控除した分を引いた
    // 残りが、紙に残った頭 = 紙が大きくなる向きの説明。
    // **TC_DC が null の日は minus_unko が計算されても着地しない** (紙は TC_DC から
    // 引くため。実測 1541 吉田 03-21: minus_unko 5 が診断に出るが total には効いて
    // いない) — 適用済みとして数えるのは TC_DC が値を持つ日だけ
    const runHeadOurs = ours?.runHeadMinutes ?? 0;
    const paperMinusUnko =
      nginxDay === null || nginxDay.kosokuByType["TC_DC"] === undefined
        ? 0
        : Object.values(nginxDay.minusUnkoByType).reduce((a, b) => a + b, 0);
    const runHeadCorrection =
      runHeadOurs === 0 && paperMinusUnko === 0 ? 0 : paperMinusUnko - runHeadOurs;
    let classified = classifyDiff(
      diffMinutes,
      ferryMinusMinutes,
      crossMonth,
      runGap,
      punchTail,
      punchHead,
      runHeadCorrection,
      ours?.lunchOverlapMinutes ?? 0,
      input.paperDriftByDate?.get(date) ?? 0,
      tolerance,
    );
    // 片側 (こちら) だけの日は差が引けず `none` になるが、値の全部が「紙が構造的に
    // 見えない分」(月境界の跨ぎ / 日跨ぎ始業の頭) なら説明は付いている —
    // 翌月へ跨ぐ勤務の頭 (月末の ours-only) や、始業打刻だけの日 (1108 03-05) がこの形
    if (status === "ours-only" && oursMinutes !== null) {
      const oursOnlyCandidates: Array<{ cause: DiffCause; explained: number }> = [
        { cause: "month-boundary", explained: crossMonth },
        { cause: "punch-head", explained: punchHead },
      ];
      for (const c of oursOnlyCandidates) {
        if (c.explained > 0 && Math.abs(oursMinutes - c.explained) <= tolerance) {
          classified = {
            cause: c.cause,
            explainedMinutes: c.explained,
            residualMinutes: classified.residualMinutes,
          };
          break;
        }
      }
    }
    // `unknown` になるのは差が引けた日だけなので、残差 = 差そのもの
    if (diffMinutes !== null && classified.cause === "unknown") {
      unknownCount += 1;
      unknownMinutes += diffMinutes;
    }
    days.push({
      date,
      nginxMinutes,
      oursMinutes,
      diffMinutes,
      status,
      ferryMinusMinutes,
      cause: classified.cause,
      explainedMinutes: classified.explainedMinutes,
      residualMinutes: classified.residualMinutes,
      anomalies: dayFound,
    });
  }

  anomalies.push(...totalsAnomalies(input.nginx?.totals ?? {}));

  return {
    month: input.month,
    driverCd: input.driverCd,
    name: input.nginx?.name ?? "",
    toleranceMinutes: tolerance,
    days,
    totals: {
      nginxMinutes: nginxTotal,
      oursMinutes: oursTotal,
      diffMinutes: nginxTotal - oursTotal,
      ferryMinusMinutes: ferryTotal,
    },
    mismatchCount,
    unknownCount,
    unknownMinutes,
    anomalies,
  };
}

/**
 * 全乗務員ぶんをまとめて突合する (MCP の一括チェック用)。
 *
 * **どちらか片方にしか居ない乗務員も返す** — 「nginx に居るのにこちらに居ない」は
 * それ自体が調べたい異常なので、積集合を取ると消えてしまう。
 *
 * `onlyAnomalies` を立てると、差分も異常も無い乗務員を落とす (既定の呼ばれ方)。
 */
export function compareTimecardMonthAll(input: {
  month: string;
  nginxByDriver: ReadonlyMap<string, NginxDriverMonth>;
  oursByDriver: ReadonlyMap<
    string,
    ReadonlyMap<
      string,
      {
        restraintMinutes: number,
        ferryMinusMinutes?: number,
        runGapMinutes?: number,
        punchTailMinutes?: number,
        punchHeadMinutes?: number,
        runHeadMinutes?: number,
        lunchOverlapMinutes?: number,
      }
    >
  >;
  /** 乗務員CD → 暦日 → 月境界を跨ぐ勤務由来の分 (`crossMonthMinutesByDate`)。 */
  crossMonthByDriver?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** 乗務員CD → 暦日 → 紙の再現値との差 (`paper_drift_by_date`)。 */
  paperDriftByDriver?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** 乗務員CD → 暦日 → フェリー控除 (`ferry_minus_by_date`)。 */
  ferryMinusByDriver?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  toleranceMinutes?: number;
  onlyAnomalies?: boolean;
}): CompareResult[] {
  const driverCds = new Set<string>([...input.nginxByDriver.keys(), ...input.oursByDriver.keys()]);
  const out: CompareResult[] = [];
  for (const driverCd of [...driverCds].sort((a, b) => Number(a) - Number(b))) {
    const result = compareTimecardMonth({
      month: input.month,
      driverCd,
      nginx: input.nginxByDriver.get(driverCd) ?? null,
      oursByDate: input.oursByDriver.get(driverCd) ?? new Map(),
      crossMonthByDate: input.crossMonthByDriver?.get(driverCd),
      paperDriftByDate: input.paperDriftByDriver?.get(driverCd),
      ferryMinusByDate: input.ferryMinusByDriver?.get(driverCd),
      toleranceMinutes: input.toleranceMinutes,
    });
    if (input.onlyAnomalies && result.mismatchCount === 0 && result.anomalies.length === 0) {
      continue;
    }
    out.push(result);
  }
  return out;
}

/**
 * 1 乗務員 × 1 ヶ月の突合を、**日別を落として 1 行**にしたもの (Refs #501 F)。
 *
 * `only_anomalies=true` でも 129 名で 54 万文字返り、読み手の context に載らなかった。
 * まずこの形で「誰のどこが変か」を数えてから、`driver` 指定で日別に掘る。
 */
export interface CompareSummaryRow {
  driverCd: string;
  /** nginx 側の氏名。**`ours-only` の乗務員は空**になる (nginx に居ないため)。 */
  name: string;
  /** status ごとの日数。すべての status を必ず持つ (0 も載せる)。 */
  statusDays: Record<CompareDay["status"], number>;
  mismatchCount: number;
  anomalyCount: number;
  /** kind ごとの anomaly 件数。**0 件の kind は載せない**。 */
  anomalyKinds: Partial<Record<CompareAnomaly["kind"], number>>;
  /** 推定原因ごとの日数。**0 件の原因は載せない** (`none` も載せない)。 */
  causeDays: Partial<Record<DiffCause, number>>;
  /** 未説明の日数と、その残差の合計 (分)。**検知の抜けを測る数字**。 */
  unknownCount: number;
  unknownMinutes: number;
  totals: CompareResult["totals"];
  /**
   * `mismatch` 日の `diffMinutes` の最小・最大。mismatch が 1 日も無ければ null。
   *
   * 幅が狭い (例 -76〜-68) なら**日ごとに一定の控除**、広いなら勤務の切り方の違い、
   * と型を 1 行で見分けるために持つ。
   */
  diffRange: { min: number; max: number } | null;
}

const ALL_STATUSES: CompareDay["status"][] = [
  "match",
  "within-tolerance",
  "mismatch",
  "nginx-only",
  "ours-only",
  "both-empty",
];

/** 突合結果 1 件を 1 行に畳む。日別は落とす。 */
export function summarizeCompareResult(result: CompareResult): CompareSummaryRow {
  const statusDays = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
    CompareDay["status"],
    number
  >;
  const anomalyKinds: Partial<Record<CompareAnomaly["kind"], number>> = {};
  const causeDays: Partial<Record<DiffCause, number>> = {};
  let min: number | null = null;
  let max: number | null = null;

  for (const day of result.days) {
    statusDays[day.status] += 1;
    if (day.cause !== "none") causeDays[day.cause] = (causeDays[day.cause] ?? 0) + 1;
    // 幅は mismatch だけで取る。within-tolerance は丸めノイズ、片側欠けの日は
    // diffMinutes が null で引き算になっていない
    if (day.status === "mismatch" && day.diffMinutes !== null) {
      min = min === null ? day.diffMinutes : Math.min(min, day.diffMinutes);
      max = max === null ? day.diffMinutes : Math.max(max, day.diffMinutes);
    }
  }
  for (const a of result.anomalies) {
    anomalyKinds[a.kind] = (anomalyKinds[a.kind] ?? 0) + 1;
  }

  return {
    driverCd: result.driverCd,
    name: result.name,
    statusDays,
    mismatchCount: result.mismatchCount,
    anomalyCount: result.anomalies.length,
    anomalyKinds,
    causeDays,
    unknownCount: result.unknownCount,
    unknownMinutes: result.unknownMinutes,
    totals: result.totals,
    diffRange: min === null || max === null ? null : { min, max },
  };
}

/** 全乗務員ぶんを畳む。並び順は入力のまま (乗務員CD 昇順)。 */
export function summarizeCompareResults(
  results: readonly CompareResult[],
): CompareSummaryRow[] {
  return results.map(summarizeCompareResult);
}
