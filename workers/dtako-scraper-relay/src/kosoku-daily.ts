/**
 * 打刻基準の日別サマリ (`GET /api/kintai/kosoku-daily`) の受け取りと**暦日按分**
 * (Refs ohishi-exp/rust-ichibanboshi#118 / #130)。
 *
 * ## なぜ打刻からセッションを組まないのか
 *
 * `timecard-summary.ts` は当初 CakePHP の打刻 (`/api/kintai/daily`) から
 * 「始業 → 次の終業」で 1 勤務を組んでいた。**長距離は出発時と帰着時にしか打刻しない**
 * ため、それだと数日が 1 勤務になり、所定を超えた分が全部 時間外になる
 * (実測: 乗務員 1104 / 2026-04 は打刻が月 6 個だけで、4/6 05:44 → 4/14 15:31 が
 * 1 勤務 = 実働 192h46m・月の残業 321h04m)。
 *
 * 上流の `kosoku-daily` は **MariaDB を直読みし、打刻が無い区間は休息イベントで割る**。
 * 同じ月が 26 勤務・拘束 275h56m・残業 34h30m になり、社内 CakePHP が出している紙の
 * タイムカード (日別の拘束) と日単位で一致する。**時間の出どころはこちらに統一する**
 * (2026-07-28 決定)。打刻は休暇・打刻エラーの判定にだけ使う。
 *
 * ## 暦日按分
 *
 * 上流は勤務を**始業日へ丸ごと寄せて**返す。現行の拘束時間管理表 (CakePHP) は暦日へ
 * 配っているので、日跨ぎ勤務は上流が添える内訳 (`parts`) で暦日に割り直す。
 * `parts` は 1 日で終わる勤務では空 (按分しても同じ値なので上流が省く)。
 */

/** 暦日 1 日ぶんの時間 (分)。 */
export interface KosokuCalendarPart {
  restraintMinutes: number;
  workingMinutes: number;
  /**
   * 法定時間外 (8h 超) のうち**深夜に重ならない分**。所定内・法定内残業はどちらも
   * 1.00 倍なので分けて持たない。
   *
   * **上流とは意味が違う** — 上流 (`overtime_minutes`) は時間外の全部で
   * `overtime_night_minutes` はその内数だが、こちらは `overtimeNightMinutes` と
   * **排他**にして持つ (`toPart` で引く。理由はそちらの doc)。
   */
  overtimeMinutes: number;
  /** 深夜 (所定内・法定内残業ぶん + 法定休日ぶん)。時間外深夜とは排他。 */
  nightMinutes: number;
  /** 時間外に重なる深夜。`overtimeMinutes` とは排他 (上記)。 */
  overtimeNightMinutes: number;
  /**
   * **紙のタイムカード表がこの暦日から引いている同日フェリー控除** (分)。
   * (Refs ohishi-exp/rust-ichibanboshi#146/#148)
   *
   * こちらの拘束には**入っていない** — 上流が `dtako_ferry_rows` から算出して
   * 添えているだけで、紙との差の原因を説明するために運ぶ。
   *
   * **上流は暦日に 1 回しか載せない。** フェリー自体が休息イベントなので同じ暦日に
   * 勤務が複数できることがあり (実測 1726 / 2026-03-14 は 4 勤務)、全部に載せると
   * ここで合算したときに 4 倍になる。上流は最初の勤務にだけ載せている。
   */
  ferryMinusMinutes: number;
  /**
   * **運行の継ぎ目** — 勤務の中の 運行終了 → 次の運行開始 の空き (分)
   * (Refs ohishi-exp/rust-ichibanboshi#170、ユーザー決定 2026-07-29)。
   *
   * 紙は運行単位のスパンを合算するのでこの空きを拘束に入れない。こちらは
   * #123 の決定どおり入れる。こちらの拘束には**含まれている** (フェリーと逆) —
   * 突合が cause `run-gap` として差を説明するための実額。
   */
  runGapMinutes: number;
  /**
   * **日跨ぎ終業の尻尾** — 最後のデジタコイベント → 翌暦日の終業打刻 (分)
   * (Refs ohishi-exp/rust-ichibanboshi#172)。
   *
   * 紙は暦日ごとに「最初→最後のイベント」で数えるため、0 時過ぎの終業打刻までの
   * 尻尾を数えない。こちらの拘束には含まれている — cause `punch-tail` の実額。
   */
  punchTailMinutes: number;
  /**
   * **日跨ぎ始業の頭** — 始業打刻 → 後の暦日の最初のデジタコイベント (分)
   * (Refs ohishi-exp/rust-ichibanboshi#173、`punchTailMinutes` の鏡像)。
   * cause `punch-head` の実額。
   */
  punchHeadMinutes: number;
  /**
   * **始業前の運行の頭** — 直前の運行開始 → 始業打刻 (分)
   * (Refs ohishi-exp/rust-ichibanboshi#174)。
   *
   * **紙が大きくなる向き** (他の実額と逆) — 紙は運行スパンを運行開始から数え、
   * minus_unko 控除は 1 日 1 回しか効かない。cause `run-head` は
   * 「紙の TC_DC_minus_unko − この頭」を負の説明に使う。
   */
  runHeadMinutes: number;
  /**
   * **昼休の窓 (12:00-13:00) との重なり** (分、Refs ohishi-exp/rust-ichibanboshi#177)。
   *
   * 紙の昼休控除は一律 60 分ではなく、運行を挟まない打刻の対と窓の重なりを引く
   * (終業が窓の中なら重なりだけ)。cause `lunch` の実額 — 0 より大きければ固定 60
   * の推定より優先する。
   */
  lunchOverlapMinutes: number;
}

/** 上流の 1 勤務 (必要な項目だけ)。 */
export interface KosokuShift extends KosokuCalendarPart {
  /** 始業日 (`YYYY-MM-DD`)。日跨ぎ勤務もここに寄る。 */
  date: string;
  /** 暦日按分の内訳。1 日で終わる勤務は空。 */
  parts: Array<{ date: string } & KosokuCalendarPart>;
}

/** `YYYY-MM` の前月。1 月は前年 12 月へ回る。 */
export function prevYmOf(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 上流の 1 件を畳む。**深夜は法定休日ぶんも足す** — 上流は割増ごとに別項目で持つが、
 * こちらの日別行は「その日に深夜帯で何分働いたか」しか持たず、法定休日かどうかは
 * `holidayKind` を見て `classifyMonth` が決めるため。
 *
 * **`overtime_night_minutes` は `overtime_minutes` の内数なので引く** (Refs #564)。
 * 上流 (rust-ichibanboshi `src/kosoku.rs`) は実働を 1 分ずつ歩き、法定時間外の 1 分を
 * `overtime_minutes` に足したうえで、その分が深夜ならさらに `overtime_night_minutes`
 * にも足す。こちらの日別行 (`RestraintSummaryDay`) は
 * **実働 = 法定内 + 時間外 + 時間外深夜** が成り立つ排他の契約なので、内数のまま流すと
 * `classifyMonth` の法定内 (= 実働 − 時間外 − 時間外深夜) が深夜残業ぶんだけ二重に
 * 引かれ、時間外深夜が 1.25 と 1.5 の両方で払われる (2026-06 の実データで
 * 法定内が `max(0, …)` に張り付き、最低賃金チェックの差分列に負で表面化した)。
 *
 * `Math.max` は上流が壊れた値を返した時の防御 (上流の構成上 内数 ≤ 全体 は保証される)。
 */
function toPart(r: Record<string, unknown>): KosokuCalendarPart {
  const overtimeNightMinutes = num(r.overtime_night_minutes);
  return {
    restraintMinutes: num(r.restraint_minutes),
    workingMinutes: num(r.working_minutes),
    overtimeMinutes: Math.max(0, num(r.overtime_minutes) - overtimeNightMinutes),
    nightMinutes: num(r.night_minutes) + num(r.legal_holiday_night_minutes),
    overtimeNightMinutes,
    ferryMinusMinutes: num(r.ferry_minus_minutes),
    runGapMinutes: num(r.run_gap_minutes),
    punchTailMinutes: num(r.punch_tail_minutes),
    punchHeadMinutes: num(r.punch_head_minutes),
    runHeadMinutes: num(r.run_head_minutes),
    lunchOverlapMinutes: num(r.lunch_overlap_minutes),
  };
}

/**
 * 応答から**乗務員エントリの配列**を取り出す。**上流の形は `driver` クエリの有無で
 * 変わる** (Refs #602。`/kintai/diff` 経路では `kintai-diff.ts` の
 * `onpremKosokuDailyToMap` が同じ罠を吸収済み、Refs #599 / #600):
 *
 * - `driver` 省略 = `{month, drivers: [{driver, days, ...}]}` (全乗務員)
 * - `driver` 指定 = `{month, driver, days, ...}` (**`drivers` が無く**、1 名がトップレベルへ展開)
 *
 * 単一乗務員形は**トップレベルをそのまま乗務員エントリ 1 件として読む** — `driver` /
 * `days` / 日別マップのキーが `drivers[]` の 1 要素と同じ位置にあるので、同じループに
 * 載る。nginx の `/time-card/pdf-json` を読む `timecard-compare.ts` の `parsePdfJson`
 * が使っている `else entries = [b]` と同じ形で、新しい流儀は作らない。
 *
 * **この repo の呼び出し元 3 箇所 (`loadKosokuShifts` / `loadCompareKosoku` /
 * kyuyo-mcp の `get_timecard_diff`) はいずれも `driver` を付けない**ので、いまは常に
 * `drivers` 配列の側を通る。予防的な整合であって現行の応答での結果は変わらない —
 * `driver=` 付きで呼ぶ経路が増えた瞬間に静かに 0 行になるのを先に塞いでおく。
 */
function driverEntriesOf(body: unknown): unknown[] {
  if (typeof body !== "object" || body === null) return [];
  const drivers = (body as { drivers?: unknown }).drivers;
  return Array.isArray(drivers) ? drivers : [body];
}

/**
 * 上流の応答を乗務員CD 引きに直す (**両方の形を読む** — [driverEntriesOf])。
 *
 * - **乗務員CD は `String(Number(...))` で正規化**する (打刻側と同じ規則)
 * - **日付が `YYYY-MM-DD` でない勤務は捨てる** — 暦日に置き場が無い
 * - 乗務員CD 0 は捨てる (実測で返ってくる。社員マスタに居ない番号)
 */
export function parseKosokuDaily(body: unknown): Map<string, KosokuShift[]> {
  const out = new Map<string, KosokuShift[]>();
  for (const entry of driverEntriesOf(body)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { driver?: unknown; days?: unknown };
    const cd = Number(e.driver);
    if (!Number.isFinite(cd) || cd === 0) continue;
    if (!Array.isArray(e.days)) continue;
    const shifts: KosokuShift[] = [];
    for (const day of e.days) {
      if (typeof day !== "object" || day === null) continue;
      const d = day as Record<string, unknown>;
      if (typeof d.date !== "string" || !DATE_RE.test(d.date)) continue;
      const parts: KosokuShift["parts"] = [];
      if (Array.isArray(d.parts)) {
        for (const raw of d.parts) {
          if (typeof raw !== "object" || raw === null) continue;
          const p = raw as Record<string, unknown>;
          if (typeof p.date !== "string" || !DATE_RE.test(p.date)) continue;
          parts.push({ date: p.date, ...toPart(p) });
        }
      }
      shifts.push({ date: d.date, ...toPart(d), parts });
    }
    out.set(String(cd), shifts);
  }
  return out;
}

/**
 * 上流が乗務員ごとに添える**紙の再現値との差** (`paper_drift_by_date`、
 * Refs ohishi-exp/rust-ichibanboshi#179) を乗務員CD 引きに直す。
 *
 * 値は `ours − paper` (正 = こちらが大きい)。紙は秒を保持したまま区分ごとに丸める
 * ため、区分の切れ目が多い日に ±数分が堆積する — 突合が cause `rounding` /
 * `ferry+rounding` の実額に使う。上流は差の無い日・値の無い日を省くので、無い日は
 * 0 と読む。**当月の応答からだけ**読めばよい (紙もこちらの再現も月単位で閉じている)。
 */
export function parsePaperDriftByDriver(body: unknown): Map<string, Map<string, number>> {
  return parseDateMapByDriver(body, "paper_drift_by_date");
}

/**
 * 上流が乗務員ごとに添える**フェリー控除の日別マップ** (`ferry_minus_by_date`、
 * Refs ohishi-exp/rust-ichibanboshi#181) を乗務員CD 引きに直す。
 *
 * 勤務への貼り付け (`ferry_minus_minutes`) は「その日に始まる勤務か、その日に掛かる
 * parts が応答に居る」前提で、**前月に始業した勤務だけが覆う日**の控除は貼れずに
 * 落ちる (実測 1026 一瀬 2026-05-01: 出庫 04-30 の運行のフェリー 76 分)。突合は
 * このマップを優先し、無ければ従来の貼り付け値へ倒す (旧上流との互換)。
 */
export function parseFerryMinusByDriver(body: unknown): Map<string, Map<string, number>> {
  return parseDateMapByDriver(body, "ferry_minus_by_date");
}

/**
 * 上流が乗務員ごとに添える**紙だけが数える勤務外の分** (`paper_outside_by_date`、
 * Refs #546 / ohishi-exp/rust-ichibanboshi#182) を乗務員CD 引きに直す。
 *
 * 紙は打刻に縛られず、デジタコのイベントと隣接対を数え続ける — 終業打刻の後も
 * 続くイベント (状態切り忘れの夜通し「積み」、構内ミニ運行) が勤務の外に残ると、
 * その分だけ紙が大きくなる。**紙が大きくなる向き** (run-head と同じ) の実額で、
 * 突合が cause `paper-outside` に使う。
 */
export function parsePaperOutsideByDriver(body: unknown): Map<string, Map<string, number>> {
  return parseDateMapByDriver(body, "paper_outside_by_date");
}

/**
 * 上流が乗務員ごとに添える**こちらだけが数える時間** (`ours_outside_by_date`、
 * `paper_outside_by_date` の鏡像。Refs #546 / ohishi-exp/rust-ichibanboshi#182)。
 *
 * 紙の計上材料 (デジタコの DIGI イベント + 打刻/運行境界の対) に覆われない
 * こちらの拘束 — アイドリングだけの休息明け勤務 (車中泊) など。**紙が小さくなる
 * 向き** (run-gap と同じ) の実額で、突合が cause `ours-outside` に使う。
 */
export function parseOursOutsideByDriver(body: unknown): Map<string, Map<string, number>> {
  return parseDateMapByDriver(body, "ours_outside_by_date");
}

/**
 * 上流が乗務員ごとに添える**紙が引く `運行開始 → 始業`** (`minus_unko_by_date`、
 * Refs #546 / ohishi-exp/rust-ichibanboshi#182)。
 *
 * 打刻より先に運行を始めた日、紙はその頭を日計から引く (`_make_minus_unko_day`)
 * のでこちらより小さくなる。**紙が小さくなる向き** (lunch と同じ) の実額で、
 * 突合が cause `minus-unko` と汎用部分和の項に使う。
 */
export function parseMinusUnkoByDriver(body: unknown): Map<string, Map<string, number>> {
  return parseDateMapByDriver(body, "minus_unko_by_date");
}

/**
 * 上流が乗務員ごとに添える**深夜を跨ぐ継ぎ目の暦日配分の差** (`gap_midnight_by_date`、
 * Refs #546 / ohishi-exp/rust-ichibanboshi#182)。
 *
 * 紙は `運行終了 → 運行開始` の対を丸ごと運行開始の日へ載せるが、こちらは暦日で
 * 割る。**同じ時間の置き場所が違うだけ**なので、運行開始日が正 (紙が多い)・前日が
 * 負 (紙が少ない) で釣り合う。突合が cause `gap-midnight` に使う。
 */
export function parseGapMidnightByDriver(body: unknown): Map<string, Map<string, number>> {
  return parseDateMapByDriver(body, "gap_midnight_by_date");
}

/** 乗務員エントリ ([driverEntriesOf]) の `<key>` にある `{YYYY-MM-DD: 分}` を
 *  乗務員CD 引きに直す共通部。**単一乗務員形もそのまま読む** (Refs #602)。 */
function parseDateMapByDriver(body: unknown, key: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const entry of driverEntriesOf(body)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const cd = Number(e.driver);
    if (!Number.isFinite(cd) || cd === 0) continue;
    const raw = e[key];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const byDate = new Map<string, number>();
    for (const [date, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!DATE_RE.test(date)) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      byDate.set(date, v);
    }
    if (byDate.size > 0) out.set(String(cd), byDate);
  }
  return out;
}

/**
 * 対象月の**暦日ごとの合計**を作る。
 *
 * - 内訳 (`parts`) がある勤務は対象月に落ちる日だけを足す
 * - 内訳の無い勤務は、その勤務の日付が対象月なら丸ごとその日へ足す
 * - **同じ日に複数の勤務があれば 1 つにまとまる** (日数を二重に数えない)
 *
 * `ym` は `YYYY-MM`。前月に始業して当月へ跨いだ勤務も渡してよい — 当月に落ちる分
 * だけが拾われる。
 */
export function kosokuPartsByDate(
  shifts: readonly KosokuShift[],
  ym: string,
): Map<string, KosokuCalendarPart> {
  const byDate = new Map<string, KosokuCalendarPart>();
  const add = (date: string, v: KosokuCalendarPart) => {
    if (date.slice(0, 7) !== ym) return;
    const cur = byDate.get(date);
    if (!cur) {
      // `date` を持ち回らない — 値は暦日の合計だけを表す (キーが日付)
      byDate.set(date, {
        restraintMinutes: v.restraintMinutes,
        workingMinutes: v.workingMinutes,
        overtimeMinutes: v.overtimeMinutes,
        nightMinutes: v.nightMinutes,
        overtimeNightMinutes: v.overtimeNightMinutes,
        ferryMinusMinutes: v.ferryMinusMinutes,
        runGapMinutes: v.runGapMinutes,
        punchTailMinutes: v.punchTailMinutes,
        punchHeadMinutes: v.punchHeadMinutes,
        runHeadMinutes: v.runHeadMinutes,
        lunchOverlapMinutes: v.lunchOverlapMinutes,
      });
      return;
    }
    cur.restraintMinutes += v.restraintMinutes;
    cur.workingMinutes += v.workingMinutes;
    cur.overtimeMinutes += v.overtimeMinutes;
    cur.nightMinutes += v.nightMinutes;
    cur.overtimeNightMinutes += v.overtimeNightMinutes;
    cur.ferryMinusMinutes += v.ferryMinusMinutes;
    cur.runGapMinutes += v.runGapMinutes;
    cur.punchTailMinutes += v.punchTailMinutes;
    cur.punchHeadMinutes += v.punchHeadMinutes;
    cur.runHeadMinutes += v.runHeadMinutes;
    cur.lunchOverlapMinutes += v.lunchOverlapMinutes;
  };
  for (const shift of shifts) {
    if (shift.parts.length > 0) {
      for (const p of shift.parts) add(p.date, p);
    } else {
      add(shift.date, shift);
    }
  }
  return byDate;
}

/**
 * **月境界を跨ぐ勤務**が対象月の暦日へ落とす拘束 (分) を、暦日ごとに数える
 * (Refs #501)。
 *
 * 紙のタイムカード表 (nginx) は**月内の打刻だけで対を組む**ため、月を跨ぐ勤務は
 * どちらの月のシートにも載らない — 前月に始業した勤務は当月シートから (始業が
 * 見えない)、当月末に始業して翌月に終業する勤務は当月シートから (終業が見えない)
 * 丸ごと落ちる。こちらは暦日按分で両方数えるので、その分がそのまま差になる。
 *
 * 実測 (1196 副島 / 純夜勤 23:47→翌 08:03): 02-28 始業の勤務 494 分が 2 月・3 月
 * どちらの紙にも無く、3 月は 03-01 に -481 (前月から跨いだ朝側) と 03-31 に
 * ours-only 15 (翌月へ跨ぐ頭) が出た。2 月も対称に -487 / 15。
 *
 * 返り値は「その暦日の値のうち、月を跨ぐ勤務由来の分」。突合側 (`timecard-compare`)
 * が差の説明 (`cause: "month-boundary"`) に使う。1 日で終わる勤務 (`parts` が空) は
 * 跨ぎようがないので見ない。
 */
export function crossMonthMinutesByDate(
  shifts: readonly KosokuShift[],
  ym: string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const shift of shifts) {
    if (shift.parts.length === 0) continue;
    const startsBefore = shift.date.slice(0, 7) < ym;
    const endsAfter = shift.parts.some((p) => p.date.slice(0, 7) > ym);
    if (!startsBefore && !endsAfter) continue;
    for (const p of shift.parts) {
      if (p.date.slice(0, 7) !== ym) continue;
      out.set(p.date, (out.get(p.date) ?? 0) + p.restraintMinutes);
    }
  }
  return out;
}

/**
 * 月ごとに取った勤務表を 1 本にまとめる (乗務員CD ごとに連結)。
 *
 * 当月の暦日按分には**前月から跨いだ勤務**も要るが、前月ぶんは前月の集計でも使う。
 * 同じ月を 2 度取らないよう、取得は月ごとに 1 回だけにしてここで合成する。
 * どちらかが null (取得失敗) ならもう一方をそのまま返す。
 */
export function mergeKosokuShiftMaps(
  a: Map<string, KosokuShift[]> | null,
  b: Map<string, KosokuShift[]> | null,
): Map<string, KosokuShift[]> | null {
  if (!a) return b;
  if (!b) return a;
  const out = new Map<string, KosokuShift[]>(a);
  for (const [driverCd, shifts] of b) {
    out.set(driverCd, [...(out.get(driverCd) ?? []), ...shifts]);
  }
  return out;
}
