/**
 * driver_cd + date から、その日の運行一覧を返す pure ロジック (Refs #633-17)。
 *
 * `dtako-day-events-lookup.ts` (`pickOnpremUnkoNoFromDayEvents`) の逆——あちらは
 * 「22桁 ope_no で絞って23桁1件を返す」専用だが、こちらは絞らず一覧を返す。
 * 上流は同じ `GET /api/kintai/day-events` (rust-ichibanboshi `dtako_day.rs`)。
 *
 * `ope_no`/`start_ope` は上流応答の `operations[].zip_request` にそのまま入って
 * いる (rust-ichibanboshi#273) — ここで桁を切ったり時刻を整形したりしない。
 * `zip_request` が欠けている・22桁でない運行は alc へ上げ直せないので一覧から
 * 落とす (捏造しない、`dtako-day-events-lookup.ts` の「壊れた形は黙って無視」と
 * 同じ方針)。
 */

const UNKO_NO_23_RE = /^\d{23}$/;
const OPE_NO_22_RE = /^\d{22}$/;

export interface DayOperationItem {
  unko_no: string;
  ope_no: string;
  start_ope: string;
  run_start: string | null;
  vehicle: string | null;
}

/** `day-events` の応答 (`raw`) から、運行ごとに alc へ上げ直すのに必要な値
 * (`ope_no`/`start_ope`、共に `zip_request` からそのまま) を持つ一覧を作る。
 * `unko_no` が重複する運行 (前日から続く休息等の混在) は重複除去する。 */
export function pickDayOperationsList(raw: unknown): DayOperationItem[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ops = Array.isArray(r.operations) ? r.operations : [];
  const seen = new Set<string>();
  const result: DayOperationItem[] = [];
  for (const op of ops) {
    if (op == null || typeof op !== "object") continue;
    const o = op as Record<string, unknown>;
    const unkoNo = o.unko_no;
    if (typeof unkoNo !== "string" || !UNKO_NO_23_RE.test(unkoNo) || seen.has(unkoNo)) continue;
    const zipRequest = o.zip_request;
    if (zipRequest == null || typeof zipRequest !== "object") continue;
    const zr = zipRequest as Record<string, unknown>;
    const opeNo = zr.ope_no;
    const startOpe = zr.start_ope;
    if (typeof opeNo !== "string" || !OPE_NO_22_RE.test(opeNo)) continue;
    if (typeof startOpe !== "string" || !startOpe) continue;
    seen.add(unkoNo);
    result.push({
      unko_no: unkoNo,
      ope_no: opeNo,
      start_ope: startOpe,
      run_start: typeof o.run_start === "string" ? o.run_start : null,
      vehicle: typeof o.vehicle === "string" ? o.vehicle : null,
    });
  }
  return result;
}
