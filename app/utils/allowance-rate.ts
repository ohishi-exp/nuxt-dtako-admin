/**
 * 料金・給与マスタ (`allowance-rate-master.ts`) の引き方 (pure)。
 *
 * **地名の曖昧一致はしない。** `釧路〜士幌` は素朴な部分一致だと `上士幌` に当たる
 * (2026-08-21 に実際に踏んだ。金額が同じで偶然正解になり、気付きにくい)。金額を
 * 決める処理なので、マスタの卸地に寄せる対応は `DEST_ALIASES` に明示的に書く。
 *
 * マスタに無い経路は**推測しない**。`unknown` を返して呼び出し側が「イレギュラー」
 * として人に見せる (2026-08-21 ユーザー判断)。
 */
import { RATE_MASTER, type RateRow } from './allowance-rate-master'

/** 全角/半角と空白の揺れを潰す。マスタ・PDF・デジタコで表記が揃っていないため。 */
export function normalizePlace(text: string | null | undefined): string {
  return (text ?? '').normalize('NFKC').replace(/[\s　]+/g, '').trim()
}

/**
 * 手当表のセルや デジタコの地名から、照合に使う地名を取り出す。
 *
 * - 複数卸し (`清水・富士`) は**最終卸し地**を採る (手当は最終卸し地で決まる)
 * - 括弧書き (`駒場（別海）` / `駒場(釧路)`) は括弧の外を採る
 */
export function placeKey(cell: string | null | undefined): string {
  const parts = normalizePlace(cell).split('・').filter(Boolean)
  const last = parts.length ? parts[parts.length - 1]! : ''
  return last.replace(/[(（][^)）]*[)）]/g, '')
}

/**
 * 手当表PDF / デジタコの地名 → マスタの卸地。
 *
 * **キーは必ず `積地|卸地`。** 積地によって卸し先が変わる (`士幌` は釧路発なら
 * `溝口`、広尾発なら `松山/士幌`) ので、卸地だけで寄せると別の場所に当たる。
 * **一番星の実データで裏が取れたものだけを書く。**
 */
export const DEST_ALIASES: Record<string, string> = {
  '釧路|士幌': '溝口',
  '釧路|標茶': 'FCS標茶',
  '釧路|別海': 'ユナイテッド牧場',
  '釧路|音更': 'ノベルズ音更',
  '士幌|清水': '清水DF',
  '苫小牧|千歳': '千代田',
  '広尾|士幌': '松山/士幌',
  '広尾|札内': '松山/札内',
}

/** `origin`/`dest` をマスタの卸地語彙に寄せる。 */
export function resolveDest(origin: string, dest: string): string {
  const o = placeKey(origin)
  const d = placeKey(dest)
  return DEST_ALIASES[`${o}|${d}`] ?? d
}

export type AllowanceLookup =
  /** 一意に決まった。 */
  | { status: 'ok', allowanceYen: number, dest: string, rows: RateRow[] }
  /** マスタに複数の金額がある。自動では決めない。 */
  | { status: 'ambiguous', dest: string, candidates: number[] }
  /** マスタに経路が無い。イレギュラーとして人が見る。 */
  | { status: 'unknown', dest: string }

/** マスタから (積地, 卸地) に該当する行を集める。 */
export function matchRows(origin: string, dest: string, master: RateRow[] = RATE_MASTER): RateRow[] {
  const o = placeKey(origin)
  const target = normalizePlace(resolveDest(origin, dest))
  return master.filter(r => normalizePlace(r.origin) === o && normalizePlace(r.dest) === target)
}

/** 1 便の運行手当 (給与) を引く。 */
export function lookupAllowance(
  origin: string,
  dest: string,
  master: RateRow[] = RATE_MASTER,
): AllowanceLookup {
  const target = resolveDest(origin, dest)
  const rows = matchRows(origin, dest, master)
  if (!rows.length) return { status: 'unknown', dest: target }
  const amounts = [...new Set(rows.map(r => r.allowanceYen))].sort((a, b) => a - b)
  if (amounts.length > 1) return { status: 'ambiguous', dest: target, candidates: amounts }
  return { status: 'ok', allowanceYen: amounts[0]!, dest: target, rows }
}

/**
 * 運賃 (円/t) を引く。売上 = これ × 数量。
 *
 * 銘柄が空のマスタ行は「卸地だけで運賃が決まる契約」なので、どの銘柄にも一致する。
 * 一意に決まらなければ null (呼び出し側が人に見せる)。
 */
export function lookupFare(
  origin: string,
  dest: string,
  brand: string,
  master: RateRow[] = RATE_MASTER,
): number | null {
  const b = normalizePlace(brand)
  const rows = matchRows(origin, dest, master)
    .filter(r => r.brand === '' || normalizePlace(r.brand) === b)
  const fares = [...new Set(rows.map(r => r.farePerT).filter((f): f is number => f !== null))]
  return fares.length === 1 ? fares[0]! : null
}
