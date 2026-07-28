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
  /** 法定時間外 (8h 超)。所定内・法定内残業はどちらも 1.00 倍なので分けて持たない。 */
  overtimeMinutes: number;
  /** 深夜 (所定内・法定内残業ぶん + 法定休日ぶん)。時間外深夜とは排他。 */
  nightMinutes: number;
  /** 時間外に重なる深夜。 */
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
 */
function toPart(r: Record<string, unknown>): KosokuCalendarPart {
  return {
    restraintMinutes: num(r.restraint_minutes),
    workingMinutes: num(r.working_minutes),
    overtimeMinutes: num(r.overtime_minutes),
    nightMinutes: num(r.night_minutes) + num(r.legal_holiday_night_minutes),
    overtimeNightMinutes: num(r.overtime_night_minutes),
    ferryMinusMinutes: num(r.ferry_minus_minutes),
  };
}

/**
 * `{drivers: [{driver, days}]}` を乗務員CD 引きに直す。
 *
 * - **乗務員CD は `String(Number(...))` で正規化**する (打刻側と同じ規則)
 * - **日付が `YYYY-MM-DD` でない勤務は捨てる** — 暦日に置き場が無い
 * - 乗務員CD 0 は捨てる (実測で返ってくる。社員マスタに居ない番号)
 */
export function parseKosokuDaily(body: unknown): Map<string, KosokuShift[]> {
  const out = new Map<string, KosokuShift[]>();
  if (typeof body !== "object" || body === null) return out;
  const drivers = (body as { drivers?: unknown }).drivers;
  if (!Array.isArray(drivers)) return out;
  for (const entry of drivers) {
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
      });
      return;
    }
    cur.restraintMinutes += v.restraintMinutes;
    cur.workingMinutes += v.workingMinutes;
    cur.overtimeMinutes += v.overtimeMinutes;
    cur.nightMinutes += v.nightMinutes;
    cur.overtimeNightMinutes += v.overtimeNightMinutes;
    cur.ferryMinusMinutes += v.ferryMinusMinutes;
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
