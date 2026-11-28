/**
 * 乗務員未登録 (乗務員CD=0) のまま走った運行を LINE WORKS へ知らせる pure ロジック
 * (Refs ippoan/alc-app#676)。配線は `dtako-scraper-relay-do.ts` の `runCronDtakoScrape`
 * (日次の取り込みが成功した直後)、送信は `lineworks-notify.ts` の
 * [`sendLineworksTextViaAlcInternalProxy`]。画面の警告帯は front の `app/utils/driver0-alert.ts`。
 *
 * - theearth は乗務員を登録しないまま走った運行を「対象乗務員CD=0」で出す
 * - 1 運行ずつ見て、総走行距離が {@link DRIVER0_MIN_DISTANCE_KM} km 以上のものだけを出す (ユーザー判断)
 * - 始業・終業は**出庫・帰庫** (KUDGURI の 出庫日時 / 帰庫日時。alc の garage_out_at / garage_in_at)
 *
 * **読むのは取り込んだばかりの日次 zip の KUDGURI.csv。** 日次 cron の zip は「前日の読取日 1 日分」
 * なので、状態を持たずに「前日の読取日に入った運行だけを送る」(重複させない) がそのまま成り立つ。
 * **送るのは日次 cron から来た取り込みだけ** (`cron.ts` の `DTAKO_DAILY_ORIGIN` → キューの `daily`)。同じ取り込み経路は
 * 読取日の取り直し (`scrape-dispatch.ts`、MCP の run_dtako_scrape) にも使われるので、そちらでは送らない
 * (取り直しのたびに同じ運行が再送される)。
 * alc へ引きに行かないのは、relay から通る alc-internal-proxy の口に KUDGURI の CSV が無いため
 * (通るのは運行一覧と KUDGSIR だけ)。**0 件の日は送らない。**
 */

import { splitCsvLine } from "./etc-card-register";
import { formatDateSlash } from "./netprint-cron";
import { resolveAlertTargetVar } from "./scrape-alert";
import type { LineworksDestinationResolution } from "./lineworks-notify";

/** 宛先を置く plain 変数の名前 (Cloudflare dashboard + `keep_vars = true`。値は commit しない)。 */
export const DRIVER0_ALERT_TARGET_VAR = "DRIVER0_ALERT_TARGET";
/** 乗務員未登録の運行に付く乗務員CD。 */
export const DRIVER0_CD = "0";
/** これ未満の距離 (km) の運行は知らせない。 */
export const DRIVER0_MIN_DISTANCE_KM = 10;

export interface Driver0Run {
  unkoNo: string;
  officeName: string;
  vehicleName: string;
  /** 出庫日時 (KUDGURI の値そのまま。日本時間)。空なら null。 */
  garageOutAt: string | null;
  /** 帰庫日時。 */
  garageInAt: string | null;
  distanceKm: number;
}

/** KUDGURI.csv の見出しが足りない (取り込みの形が変わった)。黙って 0 件にしない。 */
export class Driver0CsvShapeError extends Error {
  constructor(missing: string[]) {
    super(`KUDGURI.csv に列がありません: ${missing.join(", ")}`);
    this.name = "Driver0CsvShapeError";
  }
}

/** `DRIVER0_ALERT_TARGET` を宛先 1 つに解決する (規則と文言は `SCRAPE_ALERT_TARGET` と同じ)。 */
export function resolveDriver0AlertTarget(raw: unknown): LineworksDestinationResolution {
  return resolveAlertTargetVar(raw, DRIVER0_ALERT_TARGET_VAR, "乗務員未登録の運行の通知");
}

/**
 * KUDGURI.csv (文字列) から、対象乗務員CD=0 で {@link DRIVER0_MIN_DISTANCE_KM} km 以上走った運行を拾う。
 * 2 マン運行は乗務の役ごとに行があるので運行NO で 1 つにする。乗務員の列は alc の取り込みと同じく
 * 「対象乗務員CD」、無い古い形は「乗務員CD1」。
 */
export function findDriver0Runs(kudguriCsv: string): Driver0Run[] {
  const lines = kudguriCsv.replace(/^﻿/, "").split(/\r?\n/);
  const headers = splitCsvLine(lines[0]!); // split は必ず 1 要素以上返す
  const col = (name: string) => headers.indexOf(name);
  const unkoCol = col("運行NO");
  const driverCol = col("対象乗務員CD") >= 0 ? col("対象乗務員CD") : col("乗務員CD1");
  const distanceCol = col("総走行距離");
  const missing = [
    ...(unkoCol < 0 ? ["運行NO"] : []),
    ...(driverCol < 0 ? ["対象乗務員CD"] : []),
    ...(distanceCol < 0 ? ["総走行距離"] : []),
  ];
  if (missing.length > 0) throw new Driver0CsvShapeError(missing);
  const optional = (cells: string[], name: string) => cells[col(name)] ?? "";

  const runs = new Map<string, Driver0Run>();
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line);
    if (cells[driverCol] !== DRIVER0_CD) continue;
    const distanceKm = Number.parseFloat(cells[distanceCol] ?? "");
    if (!(distanceKm >= DRIVER0_MIN_DISTANCE_KM)) continue;
    const unkoNo = cells[unkoCol]!;
    if (runs.has(unkoNo)) continue;
    runs.set(unkoNo, {
      unkoNo,
      officeName: optional(cells, "事業所名"),
      vehicleName: optional(cells, "車輌名"),
      garageOutAt: optional(cells, "出庫日時") || null,
      garageInAt: optional(cells, "帰庫日時") || null,
      distanceKm,
    });
  }
  return [...runs.values()];
}

/** KUDGURI の日時 (`2026/11/27 8:05:42`) を `2026/11/27 08:05` にする。無い・形が違えば `-`。 */
export function formatKudguriDateTime(value: string | null): string {
  const m = value ? /^(\d{4})\/(\d{1,2})\/(\d{1,2}) +(\d{1,2}):(\d{2})/.exec(value) : null;
  if (!m) return "-";
  const pad = (v: string) => v.padStart(2, "0");
  return `${m[1]}/${pad(m[2]!)}/${pad(m[3]!)} ${pad(m[4]!)}:${m[5]}`;
}

/** 通知文 (1 社 1 日 1 通)。運行が無ければ null (= 送らない)。 */
export function buildDriver0Notification(input: {
  compId: string;
  readingDate: string;
  runs: Driver0Run[];
}): string | null {
  if (input.runs.length === 0) return null;
  const lines = [
    `【dtako 乗務員未登録】comp_id ${input.compId} の読取日 ${formatDateSlash(input.readingDate)} に、` +
      `乗務員未登録のまま ${DRIVER0_MIN_DISTANCE_KM}km 以上走った運行が ${input.runs.length} 件あります`,
  ];
  for (const r of input.runs) {
    lines.push(
      `・運行NO ${r.unkoNo} / ${r.officeName || "-"} / ${r.vehicleName || "-"} / ` +
        `始業(出庫) ${formatKudguriDateTime(r.garageOutAt)} / 終業(帰庫) ${formatKudguriDateTime(r.garageInAt)} / ` +
        `${r.distanceKm.toFixed(1)}km`,
    );
  }
  return lines.join("\n");
}
