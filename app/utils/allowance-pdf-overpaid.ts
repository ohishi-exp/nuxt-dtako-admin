/**
 * **手当表PDF 側が誤っている便に「過払い」の印を付ける** (pure)。
 *
 * 手当表PDF は給与の正本だが、**正本が間違っていることがある**。実データで確定した
 * 例が `2026-07-27 佐竹 繁` の 2 便目で、手当表は `広尾〜士幌 ¥9,000` と書いて
 * 払っているのに、実際の卸地は 富士 (¥8,000) だった:
 *
 * ```
 * デジタコの GPS 住所   北海道帯広市富士町西５線   (KUDGIVT の 終了市町村名)
 * 一番星の明細         広尾 → 富士 / 北海道帯広市 / 大石畜産 / 大石前期M @¥2,000
 * 走行時間             積み終わり→降し開始 82分 (7月の 広尾〜富士 は 72〜90分、
 *                      広尾〜士幌 は 125分)
 * ```
 *
 * 対照として、手当表が正しく `広尾〜士幌` と書いている 07-07 の同じ経路は
 * `北海道河東郡士幌町士幌` を返す。**住所は両者を取り違えていない**ので、
 * 引き当ての規則 (`allowance-trips.ts` の `CITY_TO_DEST`) は正しい。
 *
 * ## だから「寄せて直す」のではなく「過払いとして数える」
 *
 * `広尾町|帯広市` を 士幌 に寄せれば差は消えるが、**2026-07 だけで 広尾 → 帯広市 の
 * 便は 13 本**あり (富士 7 / 長内畜産 6)、全部 ¥9,000 に化ける。しかも
 * `tests/fixtures/allowance-golden-2026-07.ts` は PDF 語彙で `lookupAllowance` を
 * 引くだけなので、**この壊し方は緑のまま通る**。差の原因が PDF 側にあるなら、
 * 画面を PDF に合わせにいってはいけない。
 *
 * ## 黙って消さない
 *
 * 印を付けた便は「当たったが金額が違う便」から抜けるが、**件数と額を別に数え続ける**
 * (`overpaid` / `overpaidYen`)。除外 (`allowance-excluded.ts`) と暫定手当
 * (`allowance-provisional.ts`) と同じ方針で、一覧から戻せるのが呼び出し側の責務。
 *
 * ## 印は「その日の何便目か」で持つ
 *
 * PDF の便は `氏名|日付|便番号` で一意に指せる (手当表の 1便/2便/3便 の列がそのまま
 * 便番号になる)。経路や金額を鍵にすると、**同じ日に同じ経路が 2 便ある乗務員**
 * (実例 `2026-07-03 中村 一由` の 釧路〜標茶 ×2) で 2 便まとめて印が付く。
 *
 * ただし CSV を起こし直すと便番号がずれ得るので、**印を付けたときの経路と金額を
 * 一緒に保存し、食い違ったら当てない** (`staleOverpaidKeys` が画面に出す)。
 * 静かに別の便を過払い扱いにするのは、給与に効く以上許容できない。
 */

/** localStorage のキー。**形を変えるときは番号を上げる。** */
export const OVERPAID_KEY = 'dtako:allowance:pdf-overpaid:v1'

/** 印を付けたときの PDF 側の中身。**変わっていたら別の便**なので当てない。 */
export interface OverpaidMark {
  /** 経路キー (`広尾|松山/士幌`)。 */
  pdfRoute: string
  /** 手当表PDF に書かれていた金額。 */
  pdfYen: number
}

/** 印のキー → 付けたときの PDF 側の中身。 */
export type OverpaidMap = Record<string, OverpaidMark>

/** キーと突合に要る分だけ。`PdfCompareEntry` がそのまま渡せる。 */
export interface OverpaidTarget {
  driverName: string
  pdfDate: string
  /** その乗務員のその日の何便目か (1 始まり)。 */
  pdfSeq: number
  pdfRoute: string
  pdfYen: number | null
}

/** PDF の便を指すキー (`佐竹繁|2026-07-27|2`)。 */
export function overpaidKey(target: OverpaidTarget): string {
  return `${target.driverName}|${target.pdfDate}|${target.pdfSeq}`
}

/** キーの読み下し (`佐竹繁 2026-07-27 2便目`)。戻すボタンの横に出す。 */
export function overpaidKeyText(key: string): string {
  const [name = '', date = '', seq = ''] = key.split('|')
  return `${name} ${date} ${seq}便目`
}

/**
 * 保存済みの印を読む。**壊れていても投げない** — 空として扱う。
 *
 * 金額は給与に混ざる数字なので、数でない値・整数でない値は捨てる。
 */
export function parseOverpaid(raw: string | null | undefined): OverpaidMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: OverpaidMap = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const { pdfRoute, pdfYen } = value as Partial<OverpaidMark>
    if (typeof pdfRoute !== 'string' || typeof pdfYen !== 'number' || !Number.isInteger(pdfYen)) continue
    out[key] = { pdfRoute, pdfYen }
  }
  return out
}

export function serializeOverpaid(map: OverpaidMap): string {
  return JSON.stringify(map)
}

/**
 * 印を付ける / 外す。**手当が決まっていない便 (`pdfYen` が null) には付けない** —
 * PDF に金額が無い便は「差」がそもそも出ていないので、過払いではない。
 */
export function toggleOverpaid(map: OverpaidMap, target: OverpaidTarget): OverpaidMap {
  const key = overpaidKey(target)
  const next = { ...map }
  if (key in next) {
    delete next[key]
    return next
  }
  if (target.pdfYen === null) return next
  next[key] = { pdfRoute: target.pdfRoute, pdfYen: target.pdfYen }
  return next
}

/**
 * この便に印が当たっているか。
 *
 * **キーが合うだけでは当てない** — 印を付けたときの経路と金額まで一致して初めて
 * 「同じ便」と見なす (CSV を起こし直して便番号がずれた場合の取り違えを防ぐ)。
 */
export function isOverpaid(map: OverpaidMap, target: OverpaidTarget): boolean {
  const mark = map[overpaidKey(target)]
  if (mark === undefined) return false
  return mark.pdfRoute === target.pdfRoute && mark.pdfYen === target.pdfYen
}

/**
 * **キーは当たっているのに中身が食い違う印**を返す。
 *
 * 別の月の PDF を見ているだけならキー自体が現れないので、**いま見えている便の中に
 * 同じキーがある場合だけ**を stale とする。そうしないと、月を切り替えるたびに
 * 前の月の印が全部「効いていない」と出て読めなくなる。
 */
export function staleOverpaidKeys(map: OverpaidMap, targets: OverpaidTarget[]): string[] {
  const out: string[] = []
  for (const target of targets) {
    const key = overpaidKey(target)
    const mark = map[key]
    if (mark === undefined) continue
    if (mark.pdfRoute === target.pdfRoute && mark.pdfYen === target.pdfYen) continue
    out.push(key)
  }
  return out
}
