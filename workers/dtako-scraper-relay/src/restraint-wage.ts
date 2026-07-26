/**
 * 拘束時間サマリ → 時間給計算 (pure、Refs #244)。
 *
 * 給与様式の法定区分 (法定時間内 / 法定時間外 / 深夜 / 時間外深夜 / 法定外休日 /
 * 法定外休日深夜 / 法定休日 / 法定休日深夜 / 週40超過時間) に日別データを分類し、
 * 乗務員別の基本時間単価 (適用開始日つき履歴) × 区分係数で金額を出す。
 *
 * 決定事項 (Refs #244):
 * - 法定休日 = 日曜 (wage-config で変更可)。法定外休日は既定で使わない
 *   (土曜は平日扱い、2026-07-18 user 決定 Refs #282。必要になったら wage-config の
 *   nonLegalHolidayWeekdays で指定)
 * - 週40h 超過は日曜起算。**週はその終端 (起算+6日) が属する月に計上**し、
 *   月初の跨ぎ週は前月末日の実働を含めて計算する (前月 summary の days を渡す)
 * - 「休出」列は保留
 *
 * 時間の出どころ: 深夜系 (深夜/時間外深夜) と時間外は theearth CSV の日別値を
 * 採用し、法定内 (= 実働 − 時間外 − 時間外深夜)・休日区分・週40h は自前分類。
 *
 * 注意 (WageRow の `actual*` 系フィールドについて): これは「単価マスタ (会社が
 * 登録した基本時間単価) × デジタコ拘束時間」で計算した**理論値**であり、実際に
 * 振り込まれた給与額 (支払い実績) ではない。実際の支払い実績は給与明細 CSV
 * (app/utils/salary-compare.ts の SalaryCsvRow) が持つ — このファイルの計算値は
 * 「単価マスタの設定自体が最低賃金水準を満たしているか」を事前チェックするための
 * 理論値同士の比較に使う (fable 相談、2026-07-17)。
 */

import { TheearthClientError } from "./theearth-client";
import type { RestraintDriverSummary, RestraintSummaryDay } from "./theearth-restraint-client";
import { compareText, isBranchUnder, resolveBranchPrefecture } from "./branch-prefecture";

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
  /** 最低賃金の一括設定で入れた場合、根拠にした都道府県 (Refs #409)。
   * 手入力の単価には付かないので、後から見て出どころが区別できる。 */
  prefecture?: string;
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
    /** 最低賃金ベース残業代の月60h超過分の係数 (改正労基法、中小企業も2023-04〜適用)。 */
    overtimeOver60h: number;
  };
  /** 法定休日の曜日 (0=日曜)。 */
  legalHolidayWeekday: number;
  /** 法定外休日 (所定休日) の曜日群。既定 [] = 使わない (土曜も平日扱い、
   * 2026-07-18 決定 Refs #282)。 */
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
    overtimeOver60h: 1.5,
  },
  legalHolidayWeekday: 0,
  nonLegalHolidayWeekdays: [],
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
      const rr = r as { effectiveFrom?: unknown; hourlyRate?: unknown; prefecture?: unknown };
      if (typeof rr?.effectiveFrom !== "string" || !DATE_RE.test(rr.effectiveFrom)) {
        throw new WageMasterError(`drivers[${cd}].rates[${i}].effectiveFrom は YYYY-MM-DD が必要です`);
      }
      if (!isFiniteNumber(rr.hourlyRate) || rr.hourlyRate < 0) {
        throw new WageMasterError(`drivers[${cd}].rates[${i}].hourlyRate は 0 以上の数値が必要です`);
      }
      return {
        effectiveFrom: rr.effectiveFrom,
        hourlyRate: rr.hourlyRate,
        ...(typeof rr.prefecture === "string" && rr.prefecture !== "" ? { prefecture: rr.prefecture } : {}),
      };
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

// ---------------------------------------------------------------------------
// 給与明細 CSV 比較の支給項目区分 (Refs #253)
// ---------------------------------------------------------------------------

/** 支給項目の区分 (Refs #278)。割増賃金の基礎 (労基法37条) × 最低賃金の対象
 * (最低賃金法4条3項) の 2 軸の組合せで 5 区分。base = 両方算入 (基本給・職務手当等)、
 * overtime = 割増そのもの (残業・深夜・休日出勤)、minwage-only = 最低賃金のみ算入
 * (住宅・別居・子女教育)、premium-base-only = 割増基礎のみ算入 (精皆勤)、
 * excluded = 両方除外 (通勤・家族・臨時・賞与)。'base'/'overtime' は旧 2 区分の
 * 保存済み設定と同じ値・同じ意味 (後方互換)。集計の意味論はフロント
 * (app/utils/salary-compare.ts の SALARY_CATEGORY_FLAGS) が持つ。 */
export type SalaryItemCategory = "base" | "overtime" | "minwage-only" | "premium-base-only" | "excluded";

const SALARY_ITEM_CATEGORIES: ReadonlySet<string> = new Set([
  "base",
  "overtime",
  "minwage-only",
  "premium-base-only",
  "excluded",
]);

/** 支給項目名 (NFKC 正規化 + trim 済みのヘッダーラベル) → 区分。
 * 貼り付けられた給与 CSV 本文は保存しない — 保存するのはこの区分設定だけ。 */
export interface SalaryItemConfig {
  items: Record<string, SalaryItemCategory>;
}

/** salary-item-config JSON を検証・正規化する。 */
export function normalizeSalaryItemConfig(raw: unknown): SalaryItemConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WageMasterError("salary-item-config は {items: {...}} の JSON オブジェクトが必要です");
  }
  const items = (raw as { items?: unknown }).items;
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    throw new WageMasterError("salary-item-config.items がオブジェクトではありません");
  }
  const out: SalaryItemConfig = { items: {} };
  for (const [label, category] of Object.entries(items as Record<string, unknown>)) {
    const key = label.normalize("NFKC").trim();
    if (!key) {
      throw new WageMasterError("salary-item-config.items に空の項目名があります");
    }
    if (typeof category !== "string" || !SALARY_ITEM_CATEGORIES.has(category)) {
      throw new WageMasterError(
        `salary-item-config.items[${key}] は "base" | "overtime" | "minwage-only" | "premium-base-only" | "excluded" が必要です (${String(category)})`,
      );
    }
    out.items[key] = category as SalaryItemCategory;
  }
  return out;
}

// 給与社員コード → 乗務員CD の突合マスタ (R2 `salary-cd-map`、Refs #253) は
// D1 社員マスタ (`employees.driver_cd`、Refs #367) に吸収されたため撤去した。
// 突合キーの組み立ては app/utils/salary-compare.ts の `salaryCdMapKey` が持ち、
// worker 側は乗務員CD を行として持つだけで JSON マスタを検証しない。

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
  /** 採用した最低賃金の発効日 (県ごとに違う)。額が引けなければ付かない。 */
  rateEffectiveFrom?: string;
}

/**
 * 所属/事業所名から都道府県 → 対象月に有効な最低賃金を引く。
 *
 * 引く順序 (Refs #409 Phase 3):
 * 1. **社員マスタの所属** (`employeeBranch`) — 最低賃金は就業地の県で決まるので、
 *    theearth の事業所名より社員マスタの所属を正とする
 * 2. theearth の事業所名 (`branchName`) — 社員マスタに居ない乗務員のフォールバック
 * 3. `defaultPrefecture` — どちらも引けない場合の近似 (`mapped: false` で警告表示)
 *
 * 1・2 とも**前方一致**で引く (`本社` キーが `本社 乗務員` を覆う)。完全一致も前方一致の
 * 一種なので、theearth 事業所名で登録済みの旧キー (Refs #253) はそのまま効く。
 */
export function minWageForBranch(
  master: MinWageMaster,
  branchName: string,
  year: number,
  month: number,
  employeeBranch?: string | null,
): MinWageLookup {
  const hit = employeeBranch
    ? resolveBranchPrefecture(master.branchToPrefecture, employeeBranch)
    : { prefecture: null, matchedKey: null };
  const fallback = hit.prefecture === null
    ? resolveBranchPrefecture(master.branchToPrefecture, branchName)
    : hit;
  const mapped = fallback.prefecture !== null;
  const prefecture = mapped ? fallback.prefecture : master.defaultPrefecture ?? null;
  if (!prefecture) return { rate: null, prefecture: null, mapped: false };
  const anchor = monthAnchor(year, month);
  let best: MinWageEntry | null = null;
  for (const e of master.prefectures[prefecture] ?? []) {
    if (e.effectiveFrom <= anchor && (best === null || e.effectiveFrom > best.effectiveFrom)) {
      best = e;
    }
  }
  return {
    rate: best ? best.rate : null,
    prefecture,
    mapped,
    ...(best ? { rateEffectiveFrom: best.effectiveFrom } : {}),
  };
}

// ---------------------------------------------------------------------------
// 最低賃金 → 単価マスタへの一括設定 (Refs #409 Phase 4)
// ---------------------------------------------------------------------------

/** 一括設定 1 件の結果。 */
export interface MinWageApplyItem {
  driverCd: string;
  /** 社員マスタの所属 (原文)。 */
  branch: string;
  prefecture: string | null;
  rate: number | null;
  /** その県の最低賃金の**発効日** (法律側の日付)。会社が決める適用日とは別物なので、
   * 判断材料として返すだけで適用日には使わない。 */
  rateEffectiveFrom: string | null;
  /**
   * - `add` 新規に単価を入れる / `overwrite` 既存を上書きする
   * - `keep` 既に単価があるので触らない (既定)
   * - `unmapped` 拠点に都道府県が未設定 / `no-rate` その県にその日時点の額が無い
   */
  status: "add" | "overwrite" | "keep" | "unmapped" | "no-rate";
}

export interface MinWageApplyResult {
  master: WageMaster;
  items: MinWageApplyItem[];
  added: number;
  overwritten: number;
  kept: number;
  unresolved: number;
}

/**
 * 最低賃金を単価マスタへ一括で入れる (「単価マスタ = 最低賃金」運用、Refs #282)。
 *
 * 月次集計に `⚠ 単価未設定` が並ぶと時間給が計算できないので、拠点の最低賃金を
 * 既定値として流し込めるようにする。
 *
 * **既に単価がある乗務員は既定で触らない** (`overwrite` で明示的に指定した時だけ
 * 上書きする)。会社が決めた支給単価を最低賃金で潰さないため。
 *
 * `sites` を渡すと、その拠点キーに前方一致する所属の乗務員だけを対象にする。
 */
export function applyMinWageToWageMaster(
  wageMaster: WageMaster,
  minWageMaster: MinWageMaster,
  branchByDriverCd: ReadonlyMap<string, string>,
  /** 参照時点 (YYYY-MM-DD)。この日時点で有効な最低賃金の版と、所属を引く月を決める。
   * **単価の適用開始日には使わない** — 書き込むのはその県の発効日 (Refs #409)。 */
  asOf: string,
  opts: {
    overwrite?: boolean;
    sites?: readonly string[] | null;
    /** 乗務員CD → 氏名 (社員マスタ由来)。単価マスタの氏名表示に使う。 */
    namesByDriverCd?: ReadonlyMap<string, string>;
  } = {},
): MinWageApplyResult {
  if (!DATE_RE.test(asOf)) {
    throw new WageMasterError("参照時点は YYYY-MM-DD が必要です");
  }
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const sites = opts.sites && opts.sites.length > 0 ? opts.sites : null;

  const drivers: Record<string, WageMasterDriver> = {};
  for (const [cd, d] of Object.entries(wageMaster.drivers)) {
    drivers[cd] = { ...d, rates: [...d.rates] };
  }

  const items: MinWageApplyItem[] = [];
  for (const [driverCd, branch] of [...branchByDriverCd].sort((a, b) => compareText(a[0], b[0]))) {
    if (sites && !sites.some((s) => isBranchUnder(s, branch))) {
      continue;
    }
    // 氏名は単価の追加可否と関係なく補完する (新規行を氏名なしで作ってしまった
    // 分を後追いの再実行で埋められるように)
    const name = opts.namesByDriverCd?.get(driverCd);
    if (name && !drivers[driverCd]?.name) {
      drivers[driverCd] = { ...(drivers[driverCd] ?? { rates: [] }), name };
    }

    // 最低賃金は就業地の県で決まるので所属だけで引く (theearth 事業所名は使わない)
    const lookup = minWageForBranch(minWageMaster, "", year, month, branch);
    const prefecture = lookup.mapped ? lookup.prefecture : null;
    if (prefecture === null) {
      items.push({ driverCd, branch, prefecture: null, rate: null, rateEffectiveFrom: null, status: "unmapped" });
      continue;
    }
    if (lookup.rate === null) {
      items.push({ driverCd, branch, prefecture, rate: null, rateEffectiveFrom: null, status: "no-rate" });
      continue;
    }
    // 適用開始日はその県の最低賃金の発効日 (厚労省が定めた日をそのまま使う)
    const appliedFrom = lookup.rateEffectiveFrom!;
    const entries = drivers[driverCd]?.rates ?? [];
    const at = entries.findIndex((e) => e.effectiveFrom === appliedFrom);
    const hasAny = entries.length > 0;
    if (hasAny && !opts.overwrite) {
      // 据え置きでも、同じ適用開始日で**金額まで一致**する行に根拠県が無ければ
      // 注記だけ入れる。金額は触らないので手入力の単価を潰す心配が無く、この機能で
      // 入れた既存行 (根拠県を持たない古い版) を後から識別できるようになる
      // entries は drivers[driverCd].rates そのもの (先頭で複製済み) なので、
      // ここでの差し替えがそのまま反映される
      if (at >= 0 && entries[at]!.hourlyRate === lookup.rate && !entries[at]!.prefecture) {
        entries[at] = { ...entries[at]!, prefecture };
      }
      items.push({ driverCd, branch, prefecture, rate: lookup.rate, rateEffectiveFrom: appliedFrom, status: "keep" });
      continue;
    }
    // どの県の最低賃金を当てたかを履歴に残す (後から見て根拠が分かるように)
    const next = { effectiveFrom: appliedFrom, hourlyRate: lookup.rate, prefecture };
    if (at >= 0) entries[at] = next;
    else entries.push(next);
    entries.sort((a, b) => compareText(a.effectiveFrom, b.effectiveFrom));
    drivers[driverCd] = { ...(drivers[driverCd] ?? {}), rates: entries };
    items.push({
      driverCd,
      branch,
      prefecture,
      rate: lookup.rate,
      rateEffectiveFrom: appliedFrom,
      status: hasAny ? "overwrite" : "add",
    });
  }

  return {
    master: { ...wageMaster, drivers },
    items,
    added: items.filter((i) => i.status === "add").length,
    overwritten: items.filter((i) => i.status === "overwrite").length,
    kept: items.filter((i) => i.status === "keep").length,
    unresolved: items.filter((i) => i.status === "unmapped" || i.status === "no-rate").length,
  };
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
  // タイムカード由来の日は CakePHP の休日判定 (日曜 + 祝日 + 会社指定休) を持って
  // いるので、**曜日判定より優先する** (Refs #424 PR-D)。これが無いと祝日・指定休の
  // 承認済み休日出勤が平日として計算され、法定外休日の 1.25 倍が付かない。
  // theearth (デジタコ) 由来の日別行は暦を持たず undefined なので、乗務員側は
  // 従来どおり wage-config の曜日指定で決まる = 既存挙動は変わらない。
  const kind = d.holidayKind;
  return {
    day: d.day,
    dow,
    fromPrevMonth,
    working,
    overtime: d.isRestDay ? 0 : d.overtimeMinutes ?? 0,
    night: d.isRestDay ? 0 : d.nightMinutes ?? 0,
    overtimeNight: d.isRestDay ? 0 : d.overtimeNightMinutes ?? 0,
    isLegalHoliday: kind === undefined ? dow === config.legalHolidayWeekday : kind === "legal",
    isNonLegalHoliday:
      kind === undefined
        ? dow !== config.legalHolidayWeekday && config.nonLegalHolidayWeekdays.includes(dow)
        : kind === "non_legal",
  };
}

/**
 * 月内の日別データを法定区分の時間に分類する。
 *
 * - 平日: 法定時間内 = 実働 − 時間外 − 時間外深夜 (さらに月末に週40超過分を控除、
 *   下記)。深夜は 0.25 加算の対象分数 (法定時間内の 1.0 とは別枠で加算)。
 *   時間外/時間外深夜は theearth の日別値。
 * - 法定休日 (日曜): 時間外の概念なし — 実働すべてを 法定休日 (深夜分は
 *   法定休日深夜) に計上する。
 * - 法定外休日 (wage-config で指定した曜日のみ、既定なし): 実働すべてを
 *   法定外休日 (深夜分は 法定外休日深夜)。
 * - **日別行が `holidayKind` を持つ場合はそれが優先**される (タイムカード由来。
 *   CakePHP が日曜 + 祝日 + 会社指定休を判定済み)。曜日では拾えない祝日・指定休の
 *   休日出勤に法定外休日の割増が付く (Refs #424 PR-D)。
 * - 週40超過: 週 (weekStartsOn 起算、**終端が当月に属する週のみ**) の実働合計
 *   (法定休日を除く) − 40h − その週で既に割増計上済みの分 (時間外・時間外深夜・
 *   法定外休日) を正の範囲で計上。月初の跨ぎ週は prevMonthDays (前月 summary の
 *   days) を含めて計算する。
 * - **週40超過分は法定時間内から控除する** (2026-07-18 案B 決定 Refs #282):
 *   週40超過の時間は日次では法定時間内に積まれているため、そのままだと
 *   基礎 1.0 (statutory) + 1.25 (weekly40Excess) の 2.25 倍で二重計上になる。
 *   控除して「法定内 = 割増の付かない時間だけ / 週40超過 = 1.25 フル」に揃える。
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
  // 週40超過分の基礎 1.0 は日次集計で法定時間内に積まれている — 二重計上を防ぐため
  // 控除する (週40超過は 1.25 フルで払う、案B Refs #282)。clamp は日次 max(0) との
  // 端数不整合への防御。
  out.statutory = Math.max(0, out.statutory - out.weekly40Excess);
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
  /** 最低賃金 × hourlyBasis の時間 (支給見込みの最低賃金換算値)。分母 0 や最低賃金なしは null。 */
  minWageTotalPay: number | null;
  /** 法定時間内賃金の最低賃金換算 (最低賃金 × statutory 時間)。UI の「基本給(法定内)」
   * 列の比較対象。最低賃金なしは null。 */
  minWageStatutoryPay: number | null;
  /** 通常勤務中の深夜加算 (night 区分、残業ではない深夜) の最低賃金換算
   * (最低賃金 × night 時間 × night 係数 0.25 — 加算分のみ)。最低賃金なしは null。 */
  minWageNightPay: number | null;
  /** totalAmount − minWageTotalPay (どちらか欠けたら null。負 = 支給見込みが最低賃金換算を下回る)。 */
  totalPayDiff: number | null;
  /** 通常残業 (時間外 + 週40超過) の合計時間 (分)。時間外深夜は含まない (nightOvertimeMinutes)。 */
  overtimeMinutes: number;
  /** 通常残業の代表単価 (最低賃金ベース、円/h)。実額按分平均 (minWageOvertimePay ÷
   * overtimeMinutes) — 月60h超が絡む月は 1.25〜1.5 の間の値になる。時間が 0 の月は
   * minWage.rate × overtime 係数にフォールバック。minWage.rate が無ければ null。 */
  minWageOvertimeRate: number | null;
  /** 通常残業の最低賃金換算理論値 (月60hまで overtime 係数、超過分は overtimeOver60h
   * 係数)。時間外深夜分は含まない (minWageNightOvertimePay を参照)。60h 枠は通常残業
   * から先に消費する扱いだが、これは表示上の按分に過ぎず合計額 (+ nightOvertimePay)
   * は按分順序に依存しない。minWage.rate が無ければ null。 */
  minWageOvertimePay: number | null;
  /** 単価マスタの実単価で計算した通常残業代 (時間外+週40超過の金額)。hourlyRate が無ければ null。 */
  actualOvertimePay: number | null;
  /** actualOvertimePay − minWageOvertimePay (どちらか欠けたら null。負 = 最低賃金ベースの残業代を下回る)。 */
  overtimePayDiff: number | null;
  /** 時間外深夜の時間 (分)。minutes.overtimeNight と同じ値。 */
  nightOvertimeMinutes: number;
  /** 深夜残業の代表単価 (最低賃金ベース、円/h)。実額按分平均 (minWageNightOvertimePay ÷
   * nightOvertimeMinutes) — 深夜加算 0.25 を常時含むため通常時は概ね 1.5 倍、月60h超が
   * 絡む月は 1.5〜1.75 の間の値になる。時間が 0 の月は minWage.rate × overtimeNight
   * 係数にフォールバック。minWage.rate が無ければ null。 */
  minWageNightOvertimeRate: number | null;
  /** 深夜残業の最低賃金換算理論値。時間外軸 (60hまで1.25倍・超過1.5倍、通常残業と
   * 合算した月60h判定のうち通常残業消費後の残り枠を充てる) と深夜軸 (常時+0.25倍)
   * を独立加算する。minWage.rate が無ければ null。 */
  minWageNightOvertimePay: number | null;
  /** 単価マスタの実単価で計算した深夜残業代 (時間外深夜の金額)。hourlyRate が無ければ null。 */
  actualNightOvertimePay: number | null;
  /** actualNightOvertimePay − minWageNightOvertimePay (どちらか欠けたら null。負 = 最低賃金ベースの深夜残業代を下回る)。 */
  nightOvertimePayDiff: number | null;
}

/** 月の時間外割増の法定上限 (これを超えると overtimeOver60h 係数に切り替わる)。 */
const MONTHLY_OVERTIME_THRESHOLD_MINUTES = 60 * 60;

/**
 * 最低賃金を基礎額とみなした場合の割増残業代。
 *
 * 労基法37条の割増は時間外軸 (月60hまで1.25倍・超過分1.5倍) と深夜軸 (常時+0.25倍)
 * が独立して加算される。時間外深夜の時間は月60h判定の対象 (時間外労働) に含めつつ、
 * 深夜加算 0.25 は 60h 超過の有無に関係なく常時上乗せする (60h超の深夜残業は
 * 1.5+0.25=1.75 相当になり、単純な合成係数の切替では表せない)。
 *
 * @param overtimeMinutes 時間外 + 時間外深夜 + 週40超過 の合計時間 (分、月60h判定の対象)
 * @param overtimeNightMinutes うち時間外深夜の時間 (分、深夜加算 0.25 を常時上乗せする対象)
 */
export function computeMinWageOvertimePay(
  overtimeMinutes: number,
  overtimeNightMinutes: number,
  minWageRate: number,
  config: WageConfig,
): number {
  const under = Math.min(overtimeMinutes, MONTHLY_OVERTIME_THRESHOLD_MINUTES);
  const over = Math.max(0, overtimeMinutes - MONTHLY_OVERTIME_THRESHOLD_MINUTES);
  return Math.round(
    (under / 60) * minWageRate * config.rates.overtime
    + (over / 60) * minWageRate * config.rates.overtimeOver60h
    + (overtimeNightMinutes / 60) * minWageRate * config.rates.night,
  );
}

/**
 * computeMinWageOvertimePay の合計理論値を「通常残業 (時間外+週40超過)」と
 * 「深夜残業 (時間外深夜)」の表示用 2 列に按分する。
 *
 * 60h 枠は通常残業から先に消費する順序で割り振るが、これは表示上の慣行に過ぎない。
 * 改正労基法の月60h超判定は「月の時間外労働合計」に対する一律ルールであり、個々の
 * 区分がどちらの60h枠を消費したかを定める法的根拠は無い。normalUnder+nightUnder=under、
 * normalOver+nightOver=over が常に成り立つため、按分順序を変えても
 * `normalPay + nightPay` の合計 (= computeMinWageOvertimePay の返り値) は不変。
 */
export function splitMinWageOvertimePay(
  normalMinutes: number,
  nightMinutes: number,
  minWageRate: number,
  config: WageConfig,
): { normalPay: number; nightPay: number } {
  const totalMinutes = normalMinutes + nightMinutes;
  const under = Math.min(totalMinutes, MONTHLY_OVERTIME_THRESHOLD_MINUTES);
  const over = Math.max(0, totalMinutes - MONTHLY_OVERTIME_THRESHOLD_MINUTES);

  const normalUnder = Math.min(normalMinutes, under);
  const normalOver = normalMinutes - normalUnder;
  const nightUnder = under - normalUnder;
  const nightOver = nightMinutes - nightUnder;

  const normalPay = Math.round(
    (normalUnder / 60) * minWageRate * config.rates.overtime
    + (normalOver / 60) * minWageRate * config.rates.overtimeOver60h,
  );
  const nightPay = Math.round(
    (nightUnder / 60) * minWageRate * config.rates.overtime
    + (nightOver / 60) * minWageRate * config.rates.overtimeOver60h
    + (nightMinutes / 60) * minWageRate * config.rates.night,
  );
  return { normalPay, nightPay };
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
  /** 社員マスタ由来の所属 (月末時点)。最低賃金の県はこちらを優先する (Refs #409)。 */
  employeeBranch: string | null = null,
): WageRow {
  const hourlyRate = rateForMonth(wageMaster.drivers[summary.driverCd]?.rates ?? [], year, month);
  const minutes = classifyMonth(summary.days, year, month, config, prevMonthDays);
  const minWage = minWageForBranch(minWageMaster, summary.branchName, year, month, employeeBranch);

  const basisMinutes =
    config.hourlyBasis === "working" ? summary.workingMinutes : summary.restraintMinutes;

  let amounts: WageCategoryAmounts | null = null;
  let totalAmount: number | null = null;
  let hourlyEquivalent: number | null = null;
  if (hourlyRate !== null) {
    const computed = computeWageAmounts(minutes, hourlyRate, config);
    amounts = computed.amounts;
    totalAmount = computed.total;
    if (basisMinutes !== null && basisMinutes > 0) {
      hourlyEquivalent = Math.round(totalAmount / (basisMinutes / 60));
    }
  }
  const minWageTotalPay =
    minWage.rate !== null && basisMinutes !== null && basisMinutes > 0
      ? Math.round(minWage.rate * (basisMinutes / 60))
      : null;
  const minWageStatutoryPay =
    minWage.rate !== null ? Math.round(minWage.rate * (minutes.statutory / 60)) : null;
  const minWageNightPay =
    minWage.rate !== null
      ? Math.round(minWage.rate * (minutes.night / 60) * config.rates.night)
      : null;
  const overtimeMinutes = minutes.overtime + minutes.weekly40Excess;
  const nightOvertimeMinutes = minutes.overtimeNight;
  let minWageOvertimePay: number | null = null;
  let minWageNightOvertimePay: number | null = null;
  if (minWage.rate !== null) {
    const split = splitMinWageOvertimePay(overtimeMinutes, nightOvertimeMinutes, minWage.rate, config);
    minWageOvertimePay = split.normalPay;
    minWageNightOvertimePay = split.nightPay;
  }
  const minWageOvertimeRate =
    minWageOvertimePay !== null && overtimeMinutes > 0
      ? Math.round(minWageOvertimePay / (overtimeMinutes / 60))
      : minWage.rate !== null
        ? Math.round(minWage.rate * config.rates.overtime)
        : null;
  const minWageNightOvertimeRate =
    minWageNightOvertimePay !== null && nightOvertimeMinutes > 0
      ? Math.round(minWageNightOvertimePay / (nightOvertimeMinutes / 60))
      : minWage.rate !== null
        ? Math.round(minWage.rate * config.rates.overtimeNight)
        : null;
  const actualOvertimePay = amounts !== null ? amounts.overtime + amounts.weekly40Excess : null;
  const actualNightOvertimePay = amounts !== null ? amounts.overtimeNight : null;

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
    minWageTotalPay,
    minWageStatutoryPay,
    minWageNightPay,
    totalPayDiff:
      totalAmount !== null && minWageTotalPay !== null ? totalAmount - minWageTotalPay : null,
    overtimeMinutes,
    minWageOvertimeRate,
    minWageOvertimePay,
    actualOvertimePay,
    overtimePayDiff:
      actualOvertimePay !== null && minWageOvertimePay !== null
        ? actualOvertimePay - minWageOvertimePay
        : null,
    nightOvertimeMinutes,
    minWageNightOvertimeRate,
    minWageNightOvertimePay,
    actualNightOvertimePay,
    nightOvertimePayDiff:
      actualNightOvertimePay !== null && minWageNightOvertimePay !== null
        ? actualNightOvertimePay - minWageNightOvertimePay
        : null,
  };
}

// ---------------------------------------------------------------------------
// 単価マスタ CSV (1 行 = 1 履歴、UTF-8 BOM は呼び出し側で付ける)
// ---------------------------------------------------------------------------

export const WAGE_MASTER_CSV_HEADER = "乗務員CD,乗務員名,基本時間単価,適用開始日";

/** wage-master を CSV (1 行 = 1 履歴) に直列化する。
 * 並びは 適用開始日 降順 → 乗務員CD 昇順 (最新の改定グループが上、
 * frontend の exportMasterCsv と同じ並び)。 */
export function wageMasterToCsv(master: WageMaster): string {
  const lines = [WAGE_MASTER_CSV_HEADER];
  const flat: Array<{ cd: string; name: string; rate: WageRateEntry }> = [];
  for (const [cd, driver] of Object.entries(master.drivers)) {
    for (const rate of driver.rates) {
      flat.push({ cd, name: driver.name ?? "", rate });
    }
  }
  flat.sort(
    (a, b) =>
      b.rate.effectiveFrom.localeCompare(a.rate.effectiveFrom) ||
      a.cd.localeCompare(b.cd, undefined, { numeric: true }),
  );
  for (const r of flat) {
    lines.push([r.cd, r.name, String(r.rate.hourlyRate), r.rate.effectiveFrom].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** CSV 1 行をダブルクォート ("" エスケープ) 対応で分割する。Excel が桁区切り
 * 表示のセルを `"1,430"` として保存するケースに耐えるため、素の split(",") に
 * しない。 */
export function splitCsvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Excel が書き換えた日付表記 (2025/10/4・2025-1-4・全角数字) を YYYY-MM-DD に
 * 正規化する。解釈できなければ null。 */
export function normalizeDateCell(cell: string): string | null {
  const m = cell.normalize("NFKC").trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** CSV を wage-master へ upsert する (乗務員CD × 適用開始日 がキー。同キーは
 * 上書き、新キーは追加。既存マスタに無い行を消すことはしない)。
 * Excel で開いて保存し直した CSV (日付が 2025/10/4 形式・金額が "1,430" 等) も
 * 受け付ける。 */
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
    const cols = splitCsvCells(lines[i]).map((c) => c.trim());
    // NFKC は CD・単価・日付セルだけに適用する (氏名の全角スペースは原文保持)。
    // splitCsvCells は必ず 1 要素以上返すので cols[0] は常に存在する
    const cd = cols[0].normalize("NFKC");
    const name = cols[1] ?? "";
    const rateStr = (cols[2] ?? "").normalize("NFKC");
    const effectiveFromRaw = cols[3] ?? "";
    if (!/^\d{1,8}$/.test(cd)) {
      throw new WageMasterError(`単価 CSV ${i + 1} 行目: 乗務員CD が不正です (${cd})`);
    }
    const hourlyRate = Number(rateStr.replace(/,/g, ""));
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) {
      throw new WageMasterError(`単価 CSV ${i + 1} 行目: 基本時間単価が不正です (${rateStr})`);
    }
    const effectiveFrom = normalizeDateCell(effectiveFromRaw);
    if (effectiveFrom === null) {
      throw new WageMasterError(
        `単価 CSV ${i + 1} 行目: 適用開始日は YYYY-MM-DD (または 2025/10/4 形式) が必要です (${effectiveFromRaw})`,
      );
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
