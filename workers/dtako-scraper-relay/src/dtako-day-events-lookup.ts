/**
 * ②(取り込み)のあと、オンプレに生まれた運行から実物の23桁 `unko_no` を引く
 * pure ロジック (Refs #625)。
 *
 * ## ★ CSV を解凍して読む必要はない (0段目、issue #625 のコメント参照)
 *
 * 取り込み漏れ候補は GCP (alc) 由来の22桁 (対象CD抜き) しか無く、③ (勤務時間
 * 再登録、`resetby-unko-no/{unko_no}`) には実物の23桁が要る。**② で取り込んだ
 * 直後は、その運行はオンプレに存在する** — 23桁は zip の CSV から読むのではなく、
 * 取り込んだ後のオンプレから `GET /api/kintai/day-events` (rust-ichibanboshi
 * `src/routes/dtako_day.rs`、Refs #205 の 57) で引ける。この module は**その応答を
 * 読むだけ**で新しい計算はしない。
 *
 * ## ★ 黙って1件を選ばない (受け入れ条件2/3)
 *
 * `day-events` は driver (乗務員CD) + date で絞るが、同じ日に他の運行の
 * イベント (前日から続く休息等) が混ざって返ることがある (実データ確認
 * 2026-08-03: 233 件中 50 件で該当)。**22桁 prefix で絞る**ことでそれを除く。
 * 絞った結果が0件・複数件のときは呼び出し側 (人) に決めさせる —
 * `not_found`/`ambiguous` を返し、どちらを消すか自動では選ばない。
 *
 * ## ★★ ambiguous を自動選択してはいけない理由 (Refs #625-2 調査、
 * `rust-ichibanboshi#281` 実害の実コード確認)
 *
 * ③ (`resetbyUnkoNo`) は **delete と rebuild が非対称**: PHP の `deleteAll` は
 * **呼び出し側が渡した exact な `unko_no` の行だけ**を消すが、続く
 * `_setbyUnkoNo` (再構築 insert) は **22桁prefix + "1"/"2" (対象CD 1/2) 両方**の
 * `dtako_events` を材料にする。つまり「delete は渡した1件だけ、rebuild は
 * 両クルー分」。**対象CDを取り違えて渡すと、delete だけが他人 (もう一方の
 * クルー) の行に当たる** — rebuild 側は両方カバーするので気付きにくい形で
 * 実害化する。同じ22桁prefixに23桁が2件 (`ambiguous`) 出たら、**どちらが
 * 呼び出し元の意図した対象CDかはこのmoduleには判別できない**ので、1件目を
 * 選ぶような近道は絶対に取らない。
 */

export type DayEventsLookupStatus = "found" | "not_found" | "ambiguous";

export interface DayEventsLookupResult {
  status: DayEventsLookupStatus;
  /** status === "found" のときだけ非null。 */
  unkoNo: string | null;
  /** マッチした23桁の一覧 (重複除去済み)。found なら1件、ambiguous なら2件以上、
   * not_found なら空。 */
  candidates: string[];
}

const UNKO_NO_23_RE = /^\d{23}$/;
const UNKO_NO_22_RE = /^\d{22}$/;

/** `day-events` (`dtako_day.rs`) の応答から `operations[].unko_no` (23桁のみ) を
 * 拾う。壊れた形・非23桁の値は黙って無視する (捏造した値を候補に混ぜない)。 */
function extractOperationUnkoNos(raw: unknown): string[] {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ops = Array.isArray(r.operations) ? r.operations : [];
  const seen = new Set<string>();
  for (const op of ops) {
    if (op == null || typeof op !== "object") continue;
    const u = (op as Record<string, unknown>).unko_no;
    if (typeof u === "string" && UNKO_NO_23_RE.test(u)) seen.add(u);
  }
  return [...seen];
}

/**
 * `day-events` の応答 (`raw`) から、22桁候補 (`opeNo22`) の先頭22桁に一致する
 * 23桁を選ぶ。`opeNo22` が22桁ちょうどでなければ (呼び出し側の入力誤り)
 * 常に `not_found` を返す — 曖昧な入力で決め打ちしない。
 */
export function pickOnpremUnkoNoFromDayEvents(raw: unknown, opeNo22: string): DayEventsLookupResult {
  if (!UNKO_NO_22_RE.test(opeNo22)) {
    return { status: "not_found", unkoNo: null, candidates: [] };
  }
  const matches = extractOperationUnkoNos(raw).filter((u) => u.slice(0, 22) === opeNo22);
  if (matches.length === 0) return { status: "not_found", unkoNo: null, candidates: [] };
  if (matches.length === 1) return { status: "found", unkoNo: matches[0]!, candidates: matches };
  return { status: "ambiguous", unkoNo: null, candidates: matches };
}
