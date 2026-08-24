/**
 * 経路の行 (`広尾 → 士幌`) から、**その売上が出た運行**へ辿れるようにする素材
 * (pure、Refs #818)。
 *
 * 経路の行の数字は「その経路の便を全部束ねた合計」なので、**どの運行から出た売上なのか
 * が読めない**。オーナーの言葉は「その売り上げが出てきた運行へのリンクが欲しい。
 * 実運行を流れで見たい」。ここは `RouteSummary.legRefs` (`{ unkoNo, seq }`) を
 * **運行の単位に畳んで、運行日の昇順に並べる**だけを行う。
 *
 * ```
 * 2026-07-03  運行NO 1412070301  便 2
 * 2026-07-11  運行NO 1412071101  便 1, 4
 * (運行日なし) 運行NO 1412999901  便 3
 * ```
 *
 * ## 決まっていること (勝手に変えない)
 *
 * - **粗利の数字には 1 円も効かない。** `margin.ts` の計算には触らず `legRefs` を読むだけ
 *   (`legRefs` は行の数字に効かない「便の居場所」。地図もこれを読んでいる)
 * - **運行日の昇順**で並べる — 「実運行を流れで見たい」ため。`OperationMargin.date` は
 *   `YYYY-MM-DD` なので文字の比較で日付順になる
 * - **運行日が引けない運行は 0 や空文字で潰さず `null` にして末尾へ寄せる。**
 *   空文字にすると先頭 (どの日付より小さい) に並び、「月初の運行」に見えてしまう
 * - **黙って打ち切らない。** 便数が多い経路でも運行を全部返す (打ち切ると
 *   「この経路はこの運行だけ」と読める)
 * - **リンクは運行単位** (`/operations/{運行NO}`)。`app/pages/operations/[unko_no].vue`
 *   は便 (`seq`) を受け取らないので、便の番号は「その運行のどれを見ればよいか」の
 *   手がかりとして文字で出すだけ
 */

import type { LegRef } from './margin'

/** 運行日が引けなかった運行の、運行日の欄に出す文字。 */
export const UNKNOWN_RUN_DATE = '(運行日なし)'

/** `runDatesByUnkoNo` の入力。`OperationMargin` の必要な 2 列だけを受ける。 */
export interface RunDateSource {
  unkoNo: string
  /** 運行日 (`YYYY-MM-DD`)。**空文字は「引けなかった」として扱う** (下記)。 */
  date: string
}

/**
 * 運行NO → 運行日 の索引。**空文字の運行日は鍵を作らない** —
 * 画面の `date` は `便の日付 ?? 読取日` で埋めており、どちらも取れない運行では
 * 空文字になり得る。空文字を日付として持ち回ると `''` が最も小さい日付として
 * 先頭に並ぶので、ここで「引けなかった」に倒す (`routeOperationRows` が `null` にする)。
 *
 * 同じ運行NO が 2 度来ることは無い (運行の一覧が鍵) が、来たときは後を採る。
 */
export function runDatesByUnkoNo(operations: readonly RunDateSource[]): Map<string, string> {
  const dates = new Map<string, string>()
  for (const op of operations) {
    if (op.date !== '') dates.set(op.unkoNo, op.date)
  }
  return dates
}

/** 経路の行の下に出す運行 1 本。 */
export interface RouteOperationRow {
  unkoNo: string
  /** 運行日 (`YYYY-MM-DD`)。**引けなければ `null`** (0 や空文字に潰さない)。 */
  date: string | null
  /** 運行日の表示 (引けなければ `(運行日なし)`)。 */
  dateLabel: string
  /** その運行に入っている**この経路の**便 (`seq` の昇順、重複は畳む)。 */
  seqs: number[]
  /** 便の表示 (`便 1, 4`)。 */
  seqLabel: string
}

/** 運行日が引けない運行を末尾へ寄せるための順位。 */
function missingDateRank(row: RouteOperationRow): number {
  return row.date === null ? 1 : 0
}

/**
 * 運行日の昇順 → (同じ日は) 運行NO の昇順。**運行日が引けない運行は末尾。**
 * 畳んだ後なので運行NO は重複しない (比較が 0 になることは無い)。
 */
function compareRows(a: RouteOperationRow, b: RouteOperationRow): number {
  const byMissing = missingDateRank(a) - missingDateRank(b)
  if (byMissing !== 0) return byMissing
  // 両方 `null` (どちらも引けない) のときだけ `??` の右に来る。日付では並べられない
  // ので運行NO に落ちる。
  const byDate = (a.date ?? '').localeCompare(b.date ?? '')
  if (byDate !== 0) return byDate
  return a.unkoNo.localeCompare(b.unkoNo)
}

/**
 * `legRefs` を**運行NO で畳んで、運行日の昇順**に並べる (Refs #818)。
 *
 * 1 運行に同じ経路の便が複数入ることがある (往復の積み替え等) ので、便は
 * `seqs` に畳んで並べる。**運行は打ち切らない。**
 *
 * @param legRefs その経路に入っている便 (`RouteSummary.legRefs`)。**並び順は問わない**
 * @param runDates `runDatesByUnkoNo` が作った索引。**無い運行は運行日 `null`**
 */
export function routeOperationRows(
  legRefs: readonly LegRef[],
  runDates: ReadonlyMap<string, string>,
): RouteOperationRow[] {
  const seqsByUnko = new Map<string, Set<number>>()
  for (const ref of legRefs) {
    const seqs = seqsByUnko.get(ref.unkoNo)
    if (seqs === undefined) seqsByUnko.set(ref.unkoNo, new Set([ref.seq]))
    else seqs.add(ref.seq)
  }
  const rows: RouteOperationRow[] = []
  for (const [unkoNo, seqSet] of seqsByUnko) {
    const date = runDates.get(unkoNo) ?? null
    const seqs = [...seqSet].sort((a, b) => a - b)
    rows.push({
      unkoNo,
      date,
      dateLabel: date ?? UNKNOWN_RUN_DATE,
      seqs,
      seqLabel: `便 ${seqs.join(', ')}`,
    })
  }
  return rows.sort(compareRows)
}
