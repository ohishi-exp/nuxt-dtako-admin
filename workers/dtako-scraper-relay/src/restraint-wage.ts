/**
 * 拘束時間サマリ → 時間給計算 (pure、Refs #244)。
 *
 * 給与様式の法定区分 (法定時間内 / 法定時間外 / 深夜 / 時間外深夜 / 法定外休日 /
 * 法定外休日深夜 / 法定休日 / 法定休日深夜 / 週40超過時間) に日別データを分類し、
 * 乗務員別の基本時間単価 (適用開始日つき履歴) × 区分係数で金額を出す。
 *
 * 決定事項 (Refs #244):
 * - 法定休日 = 日曜 (wage-config で変更可)。法定外休日 = 土曜を既定 (要確認)
 * - 週40h 超過は日曜起算。**週はその終端 (起算+6日) が属する月に計上**し、
 *   月初の跨ぎ週は前月末日の実働を含めて計算する (前月 summary の days を渡す)
 * - 「休出」列は保留
 *
 * 時間の出どころ: 深夜系 (深夜/時間外深夜) と時間外は theearth CSV の日別値を
 * 採用し、法定内 (= 実働 − 時間外 − 時間外深夜)・休日区分・週40h は自前分類。
 */

import { TheearthClientError } from "./theearth-client";
import type { RestraintDriverSummary, RestraintSummaryDay } from "./theearth-restraint-client";

// ---------------------------------------------------------------------------
// マスタの型と検証
// ---------------------------------------------------------------------------

/** マスタ JSON の構造不正 (呼び出し側で 400 にマップする)。 */
export class WageMasterError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "WageMasterError";
  }
}

/** 単価履歴 1 件。effectiveFrom は "YYYY-MM-DD"。 */
export interface WageRateEntry {
  effectiveFrom: string;
  hourlyRate: number;
}

export interface WageMasterDriver {
  /** 表示用の氏名キャッシュ (キーは乗務員CD)。 */
  name?: string;
  rates: WageRateEntry[];
  /** 退職日 (任意)。UI でグレー表示するだけで計算からは除外しない。 */
  retiredAt?: string;
}

export interface WageMaster {
  drivers: Record<string, WageMasterDriver>;
}

export interface MinWageEntry {
  effectiveFrom: string;
  rate: number;
}

export interface MinWageMaster {
  /** 都道府県名 → 改定履歴。 */
  prefectures: Record<string, MinWageEntry[]>;
  /** 事業所名 (summary の branchName そのまま) → 都道府県名。 */
  branchToPrefecture: Record<string, string>;
  /** 未マッピング事業所のフォールバック県 (未設定なら比較不能として警告)。 */
  defaultPrefecture?: string;
}

/** 法定区分ごとの係数ほか計算設定。 */
export interface WageConfig {
  rates: {
    statutory: number;
    overtime: number;
    /** 深夜は「加算分」の係数 (0.25)。法定時間内の 1.0 とは別に上乗せする。 */
    night: number;
    overtimeNight: number;
    nonLegalHoliday: number;
    nonLegalHolidayNight: number;
    legalHoliday: number;
    legalHolidayNight: number;
    weekly40Excess: number;
  };
  /** 法定休日の曜日 (0=日曜)。 */
  legalHolidayWeekday: number;
  /** 法定外休日 (所定休日) の曜日群。既定 [6]=土曜 (会社カレンダー未対応の近似)。 */
  nonLegalHolidayWeekdays: number[];
  /** 週40h の起算曜日 (0=日曜 — 決定事項)。 */
  weekStartsOn: number;
  /** 換算時給の分母。 */
  hourlyBasis: "working" | "restraint";
}

export const DEFAULT_WAGE_CONFIG: WageConfig = {
  rates: {
    statutory: 1.0,
    overtime: 1.25,
    night: 0.25,
    overtimeNight: 1.5,
    nonLegalHoliday: 1.25,
    nonLegalHolidayNight: 1.5,
    legalHoliday: 1.35,
    legalHolidayNight: 1.6,
    weekly40Excess: 1.25,
  },
  legalHolidayWeekday: 0,
  nonLegalHolidayWeekdays: [6],
  weekStartsOn: 0,
  hourlyBasis: "working",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** R2 から読んだ/PUT された wage-master JSON を検証・正規化する。 */
export function normalizeWageMaster(raw: unknown): WageMaster {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WageMasterError("wage-master は {drivers: {...}} の JSON オブジェクトが必要です");
  }
  const drivers = (raw as { drivers?: unknown }).drivers;
  if (!drivers || typeof drivers !== "object" || Array.isArray(drivers)) {
    throw new WageMasterError("wage-master.drivers がオブジェクトではありません");
  }
  const out: WageMaster = { drivers: {} };
  for (const [cd, entryRaw] of Object.entries(drivers as Record<string, unknown>)) {
    if (!/^\d{1,8}$/.test(cd)) {
      throw new WageMasterError(`wage-master の乗務員CD が不正です: ${cd}`);
    }
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
      throw new WageMasterError(`wage-master.drivers[${cd}] がオブジェクトではありません`);
    }
    const entry = entryRaw as { name?: unknown; rates?: unknown; retiredAt?: unknown };
    if (!Array.isArray(entry.rates)) {
      throw new WageMasterError(`wage-master.drivers[${cd}].rates が配列ではありません`);
    }
    const rates: WageRateEntry[] = entry.rates.map((r: unknown, i: number) => {
      const rr = r as { effectiveFrom?: unknown; hourlyRate?: unknown };
      if (typeof rr?.effectiveFrom !== "string" || !DATE_RE.test(rr.effectiveFrom)) {
        throw new WageMasterError(`drivers[${cd}].rates[${i}].effectiveFrom は YYYY-MM-DD が必要です`);
      }
      if (!isFiniteNumber(rr.hourlyRate) || rr.hourlyRate < 0) {
        throw new WageMasterError(`drivers[${cd}].rates[${i}].hourlyRate は 0 以上の数値が必要です`);
      }
      return { effectiveFrom: rr.effectiveFrom, hourlyRate: rr.hourlyRate };
    });
    rates.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    out.drivers[cd] = {
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
      rates,
      ...(typeof entry.retiredAt === "string" ? { retiredAt: entry.retiredAt } : {}),
    };
  }
  return out;
}

/** min-wage JSON を検証・正規化する。 */
export function normalizeMinWageMaster(raw: unknown): MinWageMaster {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WageMasterError("min-wage は JSON オブジェクトが必要です");
  }
  const obj = raw as { prefectures?: unknown; branchToPrefecture?: unknown; defaultPrefecture?: unknown };
  const prefectures: Record<string, MinWageEntry[]> = {};
  if (obj.prefectures !== undefined) {
    if (!obj.prefectures || typeof obj.prefectures !== "object" || Array.isArray(obj.prefectures)) {
      throw new WageMasterError("min-wage.prefectures がオブジェクトではありません");
    }
    for (const [pref, entriesRaw] of Object.entries(obj.prefectures as Record<string, unknown>)) {
      if (!Array.isArray(entriesRaw)) {
        throw new WageMasterError(`min-wage.prefectures[${pref}] が配列ではありません`);
      }
      prefectures[pref] = entriesRaw.map((r: unknown, i: number) => {
        const rr = r as { effectiveFrom?: unknown; rate?: unknown };
        if (typeof rr?.effectiveFrom !== "string" || !DATE_RE.test(rr.effectiveFrom)) {
          throw new WageMasterError(`prefectures[${pref}][${i}].effectiveFrom は YYYY-MM-DD が必要です`);
        }
        if (!isFiniteNumber(rr.rate) || rr.rate < 0) {
          throw new WageMasterError(`prefectures[${pref}][${i}].rate は 0 以上の数値が必要です`);
        }
        return { effectiveFrom: rr.effectiveFrom, rate: rr.rate };
      });
      prefectures[pref].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    }
  }
  const branchToPrefecture: Record<string, string> = {};
  if (obj.branchToPrefecture !== undefined) {
    if (!obj.branchToPrefecture || typeof obj.branchToPrefecture !== "object" || Array.isArray(obj.branchToPrefecture)) {
      throw new WageMasterError("min-wage.branchToPrefecture がオブジェクトではありません");
    }
    for (const [branch, pref] of Object.entries(obj.branchToPrefecture as Record<string, unknown>)) {
      if (typeof pref !== "string") {
        throw new WageMasterError(`min-wage.branchToPrefecture[${branch}] が文字列ではありません`);
      }
      branchToPrefecture[branch] = pref;
    }
  }
  return {
    prefectures,
    branchToPrefecture,
    ...(typeof obj.defaultPrefecture === "string" ? { defaultPrefecture: obj.defaultPrefecture } : {}),
  };
}

/** wage-config JSON を検証し、欠けたキーは既定値で埋める。 */
export function normalizeWageConfig(raw: unknown): WageConfig {
  if (raw === null || raw === undefined) return DEFAULT_WAGE_CONFIG;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new WageMasterError("wage-config は JSON オブジェクトが必要です");
  }
  const obj = raw as Partial<WageConfig> & { rates?: Partial<WageConfig["rates"]> };
  const rates = { ...DEFAULT_WAGE_CONFIG.rates, ...(obj.rates ?? {}) };
  for (const [key, value] of Object.entries(rates)) {
    if (!isFiniteNumber(value) || value < 0) {
      throw new WageMasterError(`wage-config.rates.${key} は 0 以上の数値が必要です`);
    }
  }
  const weekday = (v: unknown, label: string, fallback: number): number => {
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 6) {
      throw new WageMasterError(`wage-config.${label} は 0〜6 の曜日番号が必要です`);
    }
    return v as number;
  };
  const nonLegal = obj.nonLegalHolidayWeekdays ?? DEFAULT_WAGE_CONFIG.nonLegalHolidayWeekdays;
  if (!Array.isArray(nonLegal) || nonLegal.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new WageMasterError("wage-config.nonLegalHolidayWeekdays は 0〜6 の配列が必要です");
  }
  const hourlyBasis = obj.hourlyBasis ?? DEFAULT_WAGE_CONFIG.hourlyBasis;
  if (hourlyBasis !== "working" && hourlyBasis !== "restraint") {
    throw new WageMasterError('wage-config.hourlyBasis は "working" | "restraint" が必要です');
  }
  return {
    rates,
    legalHolidayWeekday: weekday(obj.legalHolidayWeekday, "legalHolidayWeekday", DEFAULT_WAGE_CONFIG.legalHolidayWeekday),
    nonLegalHolidayWeekdays: nonLegal,
    weekStartsOn: weekday(obj.weekStartsOn, "weekStartsOn", DEFAULT_WAGE_CONFIG.weekStartsOn),
    hourlyBasis,
  };
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

function monthAnchor(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/** 対象月の 1 日に有効な単価 (effectiveFrom <= 月初日 の最新)。無ければ null。 */
export function rateForMonth(entries: WageRateEntry[], year: number, month: number): number | null {
  const anchor = monthAnchor(year, month);
  let best: WageRateEntry | null = null;
  for (const e of entries) {
    if (e.effectiveFrom <= anchor && (best === null || e.effectiveFrom > best.effectiveFrom)) {
      best = e;
    }
  }
  return best ? best.hourlyRate : null;
}

export interface MinWageLookup {
  rate: number | null;
  prefecture: string | null;
  /** branchToPrefecture に明示マッピングがあったか (false = default 県で近似 → 警告表示)。 */
  mapped: boolean;
}

/** 事業所名から都道府県 → 対象月に有効な最低賃金を引く。 */
export function minWageForBranch(
  master: MinWageMaster,
  branchName: string,
  year: number,
  month: number,
): MinWageLookup {
  const mapped = Object.prototype.hasOwnProperty.call(master.branchToPrefecture, branchName);
  const prefecture = mapped
    ? master.branchToPrefecture[branchName]
    : master.defaultPrefecture ?? null;
  if (!prefecture) return { rate: null, prefecture: null, mapped: false };
  const anchor = monthAnchor(year, month);
  let best: MinWageEntry | null = null;
  for (const e of master.prefectures[prefecture] ?? []) {
    if (e.effectiveFrom <= anchor && (best === null || e.effectiveFrom > best.effectiveFrom)) {
      best = e;
    }
  }
  return { rate: best ? best.rate : null, prefecture, mapped };
}

// ---------------------------------------------------------------------------
// 法定区分の分類
// ---------------------------------------------------------------------------

/** 法定区分ごとの時間 (分)。 */
export interface WageCategoryMinutes {
  statutory: number;
  overtime: number;
  night: number;
  overtimeNight: number;
  nonLegalHoliday: number;
  nonLegalHolidayNight: number;
  legalHoliday: number;
  legalHolidayNight: number;
  weekly40Excess: number;
}

export function emptyCategoryMinutes(): WageCategoryMinutes {
  return {
    statutory: 0,
    overtime: 0,
    night: 0,
    overtimeNight: 0,
    nonLegalHoliday: 0,
    nonLegalHolidayNight: 0,
    legalHoliday: 0,
    legalHolidayNight: 0,
    weekly40Excess: 0,
  };
}

/** 曜日 (0=日)。日付は JST の暦日として扱う (UTC 換算不要 — 暦日計算のみ)。 */
export function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

interface ClassifiedDay {
  day: number;
  dow: number;
  /** 前月末日由来 (週40h の跨ぎ週計算にだけ使い、区分時間には計上しない)。 */
  fromPrevMonth: boolean;
  working: number;
  overtime: number;
  night: number;
  overtimeNight: number;
  isLegalHoliday: boolean;
  isNonLegalHoliday: boolean;
}

function classifyDayRow(
  d: RestraintSummaryDay,
  year: number,
  month: number,
  config: WageConfig,
  fromPrevMonth: boolean,
): ClassifiedDay {
  const dow = dayOfWeek(year, month, d.day);
  const working = d.isRestDay ? 0 : d.workingMinutes ?? 0;
  return {
    day: d.day,
    dow,
    fromPrevMonth,
    working,
    overtime: d.isRestDay ? 0 : d.overtimeMinutes ?? 0,
    night: d.isRestDay ? 0 : d.nightMinutes ?? 0,
    overtimeNight: d.isRestDay ? 0 : d.overtimeNightMinutes ?? 0,
    isLegalHoliday: dow === config.legalHolidayWeekday,
    isNonLegalHoliday: dow !== config.legalHolidayWeekday && config.nonLegalHolidayWeekdays.includes(dow),
  };
}

/**
 * 月内の日別データを法定区分の時間に分類する。
 *
 * - 平日: 法定時間内 = 実働 − 時間外 − 時間外深夜。深夜は 0.25 加算の対象分数
 *   (法定時間内の 1.0 とは別枠で加算)。時間外/時間外深夜は theearth の日別値。
 * - 法定休日 (日曜): 時間外の概念なし — 実働すべてを 法定休日 (深夜分は
 *   法定休日深夜) に計上する。
 * - 法定外休日 (既定 土曜): 実働すべてを 法定外休日 (深夜分は 法定外休日深夜)。
 * - 週40超過: 週 (weekStartsOn 起算、**終端が当月に属する週のみ**) の実働合計
 *   (法定休日を除く) − 40h − その週で既に割増計上済みの分 (時間外・時間外深夜・
 *   法定外休日) を正の範囲で計上。月初の跨ぎ週は prevMonthDays (前月 summary の
 *   days) を含めて計算する。
 */
export function classifyMonth(
  days: RestraintSummaryDay[],
  year: number,
  month: number,
  config: WageConfig,
  prevMonthDays: RestraintSummaryDay[] = [],
): WageCategoryMinutes {
  const out = emptyCategoryMinutes();
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;

  const classified: ClassifiedDay[] = [
    ...prevMonthDays.map((d) => classifyDayRow(d, prevYear, prevMonth, config, true)),
    ...days.map((d) => classifyDayRow(d, year, month, config, false)),
  ];

  // 区分時間 (当月分のみ)
  for (const c of classified) {
    if (c.fromPrevMonth || c.working <= 0) continue;
    const nightTotal = c.night + c.overtimeNight;
    if (c.isLegalHoliday) {
      out.legalHolidayNight += nightTotal;
      out.legalHoliday += Math.max(0, c.working - nightTotal);
    } else if (c.isNonLegalHoliday) {
      out.nonLegalHolidayNight += nightTotal;
      out.nonLegalHoliday += Math.max(0, c.working - nightTotal);
    } else {
      out.overtime += c.overtime;
      out.overtimeNight += c.overtimeNight;
      out.night += c.night;
      out.statutory += Math.max(0, c.working - c.overtime - c.overtimeNight);
    }
  }

  // 週40h 超過 (終端が当月に属する週のみ。前月由来の日も週合計には含める)
  const FORTY_HOURS = 40 * 60;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const epochDay = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  const weekIndexOf = (y: number, m: number, d: number) => {
    // weekStartsOn 起算の週番号 (絶対値に意味はなく、同一週の同定にのみ使う)
    const ed = epochDay(y, m, d);
    return Math.floor((ed - ((dayOfWeek(y, m, d) - config.weekStartsOn + 7) % 7)) / 7);
  };
  const weeks = new Map<number, { working: number; premium: number; endsInMonth: boolean }>();
  for (const c of classified) {
    const [y, m] = c.fromPrevMonth ? [prevYear, prevMonth] : [year, month];
    const wi = weekIndexOf(y, m, c.day);
    let week = weeks.get(wi);
    if (!week) {
      week = { working: 0, premium: 0, endsInMonth: false };
      weeks.set(wi, week);
    }
    if (!c.isLegalHoliday) {
      week.working += c.working;
      // 既に割増計上済みの分は週40h の追加割増から除外する (二重計上防止)
      week.premium += c.isNonLegalHoliday ? c.working : c.overtime + c.overtimeNight;
    }
    // 週の終端 (起算 + 6 日) が当月に属するか
    const endOffset = 6 - ((dayOfWeek(y, m, c.day) - config.weekStartsOn + 7) % 7);
    const endEpoch = epochDay(y, m, c.day) + endOffset;
    const monthStart = epochDay(year, month, 1);
    const monthEnd = epochDay(year, month, daysInMonth);
    if (endEpoch >= monthStart && endEpoch <= monthEnd) week.endsInMonth = true;
  }
  for (const week of weeks.values()) {
    if (!week.endsInMonth) continue;
    out.weekly40Excess += Math.max(0, week.working - FORTY_HOURS - week.premium);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 金額計算
// ---------------------------------------------------------------------------

/** 法定区分ごとの金額 (円、円未満四捨五入)。 */
export type WageCategoryAmounts = Record<keyof WageCategoryMinutes, number>;

export interface WageRow {
  driverCd: string;
  driverName: string;
  branchName: string;
  /** 対象月に有効な基本時間単価。単価マスタに無ければ null (金額列は計算しない)。 */
  hourlyRate: number | null;
  minutes: WageCategoryMinutes;
  amounts: WageCategoryAmounts | null;
  totalAmount: number | null;
  /** 換算時給 (円/h、支給見込 ÷ hourlyBasis の時間)。分母 0 や単価なしは null。 */
  hourlyEquivalent: number | null;
  minWage: MinWageLookup;
  /** 換算時給 − 最低賃金 (どちらか欠けたら null。負 = 最低賃金割れ)。 */
  minWageDiff: number | null;
}

export function computeWageAmounts(
  minutes: WageCategoryMinutes,
  hourlyRate: number,
  config: WageConfig,
): { amounts: WageCategoryAmounts; total: number } {
  const amounts = {} as WageCategoryAmounts;
  let total = 0;
  for (const key of Object.keys(minutes) as Array<keyof WageCategoryMinutes>) {
    const amount = Math.round((minutes[key] / 60) * hourlyRate * config.rates[key]);
    amounts[key] = amount;
    total += amount;
  }
  return { amounts, total };
}

/** 乗務員 1 名 × 1 ヶ月の賃金行を計算する。 */
export function computeWageRow(
  summary: RestraintDriverSummary,
  year: number,
  month: number,
  wageMaster: WageMaster,
  minWageMaster: MinWageMaster,
  config: WageConfig,
  prevMonthDays: RestraintSummaryDay[] = [],
): WageRow {
  const hourlyRate = rateForMonth(wageMaster.drivers[summary.driverCd]?.rates ?? [], year, month);
  const minutes = classifyMonth(summary.days, year, month, config, prevMonthDays);
  const minWage = minWageForBranch(minWageMaster, summary.branchName, year, month);

  let amounts: WageCategoryAmounts | null = null;
  let totalAmount: number | null = null;
  let hourlyEquivalent: number | null = null;
  if (hourlyRate !== null) {
    const computed = computeWageAmounts(minutes, hourlyRate, config);
    amounts = computed.amounts;
    totalAmount = computed.total;
    const basisMinutes =
      config.hourlyBasis === "working" ? summary.workingMinutes : summary.restraintMinutes;
    if (basisMinutes !== null && basisMinutes > 0) {
      hourlyEquivalent = Math.round(totalAmount / (basisMinutes / 60));
    }
  }
  return {
    driverCd: summary.driverCd,
    driverName: summary.driverName,
    branchName: summary.branchName,
    hourlyRate,
    minutes,
    amounts,
    totalAmount,
    hourlyEquivalent,
    minWage,
    minWageDiff:
      hourlyEquivalent !== null && minWage.rate !== null ? hourlyEquivalent - minWage.rate : null,
  };
}

// ---------------------------------------------------------------------------
// 単価マスタ CSV (1 行 = 1 履歴、UTF-8 BOM は呼び出し側で付ける)
// ---------------------------------------------------------------------------

export const WAGE_MASTER_CSV_HEADER = "乗務員CD,乗務員名,基本時間単価,適用開始日";

/** wage-master を CSV (1 行 = 1 履歴) に直列化する。 */
export function wageMasterToCsv(master: WageMaster): string {
  const lines = [WAGE_MASTER_CSV_HEADER];
  const cds = Object.keys(master.drivers).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const cd of cds) {
    const driver = master.drivers[cd];
    // 新しい履歴を上に (Excel で見た時に現行単価が先頭)
    const rates = [...driver.rates].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    for (const rate of rates) {
      lines.push([cd, driver.name ?? "", String(rate.hourlyRate), rate.effectiveFrom].join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}

/** CSV を wage-master へ upsert する (乗務員CD × 適用開始日 がキー。同キーは
 * 上書き、新キーは追加。既存マスタに無い行を消すことはしない)。 */
export function upsertWageMasterFromCsv(base: WageMaster, csvText: string): WageMaster {
  const lines = csvText.split(/\r\n|\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    throw new WageMasterError("単価 CSV が空です");
  }
  const out: WageMaster = { drivers: {} };
  for (const [cd, driver] of Object.entries(base.drivers)) {
    out.drivers[cd] = { ...driver, rates: [...driver.rates] };
  }
  const startIdx = lines[0].startsWith("乗務員CD") ? 1 : 0;
  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    // split は必ず 1 要素以上返すので cols[0] は常に存在する
    const [cd, name, rateStr, effectiveFrom] = [cols[0], cols[1] ?? "", cols[2] ?? "", cols[3] ?? ""];
    if (!/^\d{1,8}$/.test(cd)) {
      throw new WageMasterError(`単価 CSV ${i + 1} 行目: 乗務員CD が不正です (${cd})`);
    }
    const hourlyRate = Number(rateStr);
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
      throw new WageMasterError(`単価 CSV ${i + 1} 行目: 基本時間単価が不正です (${rateStr})`);
    }
    if (!DATE_RE.test(effectiveFrom)) {
      throw new WageMasterError(`単価 CSV ${i + 1} 行目: 適用開始日は YYYY-MM-DD が必要です (${effectiveFrom})`);
    }
    const driver = out.drivers[cd] ?? { rates: [] };
    if (name) driver.name = name;
    const existing = driver.rates.findIndex((r) => r.effectiveFrom === effectiveFrom);
    if (existing >= 0) driver.rates[existing] = { effectiveFrom, hourlyRate };
    else driver.rates.push({ effectiveFrom, hourlyRate });
    driver.rates.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    out.drivers[cd] = driver;
  }
  return out;
}
