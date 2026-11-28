/**
 * 乗務員未登録 (乗務員CD=0) のまま走った運行を、日次の「[dtako] 取り込み成功」のメールの本文に載せる
 * pure ロジック (Refs ippoan/alc-app#676)。配線は `dtako-scraper-relay-do.ts` の `runCronDtakoScrape`
 * (日次の取り込みが成功した直後)、本文は `scrape-alert-email.ts` の [`buildScrapeSuccessBody`]
 * (宛先は KV `scrape_alert_email`)。画面の警告帯は front の `app/utils/driver0-alert.ts`。
 *
 * - theearth は乗務員を登録しないまま走った運行を「対象乗務員CD=0」で出す
 * - 1 運行ずつ見て、総走行距離が {@link DRIVER0_MIN_DISTANCE_KM} km 以上のものだけを出す (ユーザー判断)
 * - 始業・終業は**出庫・帰庫** (KUDGURI の 出庫日時 / 帰庫日時。alc の garage_out_at / garage_in_at)
 *
 * **読むのは取り込んだばかりの日次 zip の KUDGURI.csv。** 日次 cron の zip は「前日の読取日 1 日分」
 * なので、状態を持たずに「前日の読取日に入った運行だけを載せる」(重複させない) がそのまま成り立つ。
 * **載せるのは日次 cron から来た取り込みだけ** (`cron.ts` の `DTAKO_DAILY_ORIGIN` → キューの `daily`)。同じ取り込み経路は
 * 読取日の取り直し (`scrape-dispatch.ts`、MCP の run_dtako_scrape) にも使われるので、そちらの成功メールには載せない
 * (取り直しのたびに同じ運行が再び載る)。
 * alc へ引きに行かないのは、relay から通る alc-internal-proxy の口に KUDGURI の CSV が無いため
 * (通るのは運行一覧と KUDGSIR だけ)。**0 件の日は何も足さない** (本文は今のまま)。
 */

import { splitCsvLine } from "./etc-card-register";
/** 乗務員未登録の運行に付く乗務員CD。 */
export const DRIVER0_CD = "0";
/** これ未満の距離 (km) の運行は知らせない。 */
export const DRIVER0_MIN_DISTANCE_KM = 10;

export interface Driver0Run {
  unkoNo: string;
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

/**
 * 成功メールの本文に足す行。0 件なら空 (= 何も足さない)。1 行目が件数、続けて 1 運行 1 行
 * (運行NO・車輌・出庫・帰庫・距離)。**運行NO を載せる** — ユーザーの指示 (「運行NO も載せる」)。
 */
export function driver0MailLines(runs: Driver0Run[]): string[] {
  if (runs.length === 0) return [];
  return [
    `乗務員未登録のまま ${DRIVER0_MIN_DISTANCE_KM}km 以上走った運行: ${runs.length} 件`,
    ...runs.map(
      (r) =>
        `・運行NO ${r.unkoNo} / 車輌 ${r.vehicleName || "-"} / 出庫 ${formatKudguriDateTime(r.garageOutAt)} / ` +
        `帰庫 ${formatKudguriDateTime(r.garageInAt)} / ${r.distanceKm.toFixed(1)}km`,
    ),
  ];
}
