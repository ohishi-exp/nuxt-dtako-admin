/**
 * 2026年7月の手当表PDF (帯広 5 枚 / 313 便) から起こした経路別の給与。
 * **マスタ (`allowance-rate-master.ts`) の答え合わせ用の実データ。**
 *
 * PDF 側は各ページ下部に印字された列合計 15 本すべてと一致することを確認済み。
 * `irregular: true` はマスタに載っていない経路 (2026-08-21 時点)。
 * `釧路〜駒場（別海）` は 2026-08-21 に xlsx 未収載のままマスタへ足した
 * (実在する経路で、手当表PDF に金額がある。詳細は `rate_master.json` の `note`)。
 * その相方の `駒場（釧路）〜別海` を 2026-08-22 に足した — **同じ荷の中継**で、
 * 07-16 柳井が 釧路→駒場 まで、07-17 西島が 駒場→別海 まで運び、**片道ずつ ¥4,500**。
 * 一番星の通し請求 ¥43,750 が内訳 ¥21,750 + ¥22,000 に割れていることで裏が取れる。
 */
export interface AllowanceGoldenRow {
  origin: string
  dest: string
  /** PDF に書かれていた 1 便あたりの金額。 */
  allowanceYen: number
  /** 2026-07 でこの経路が現れた便数。 */
  trips: number
  /** マスタに経路が無く、人が見る対象。 */
  irregular: boolean
}

export const ALLOWANCE_GOLDEN_2026_07: AllowanceGoldenRow[] = [
  { origin: '釧路', dest: '上士幌', allowanceYen: 9000, trips: 46, irregular: false },
  { origin: '釧路', dest: '川西', allowanceYen: 9000, trips: 36, irregular: false },
  { origin: '釧路', dest: '浦幌', allowanceYen: 9000, trips: 36, irregular: false },
  { origin: '釧路', dest: '標茶', allowanceYen: 8000, trips: 32, irregular: false },
  { origin: '士幌', dest: '清水', allowanceYen: 8000, trips: 30, irregular: false },
  { origin: '苫小牧', dest: '富士', allowanceYen: 12000, trips: 23, irregular: false },
  { origin: '釧路', dest: '士幌', allowanceYen: 9000, trips: 22, irregular: false },
  { origin: '広尾', dest: '安平', allowanceYen: 6000, trips: 18, irregular: false },
  { origin: '広尾', dest: '芽室', allowanceYen: 9000, trips: 11, irregular: true },
  { origin: '釧路', dest: '別海', allowanceYen: 9000, trips: 10, irregular: false },
  { origin: '帯広', dest: '士幌', allowanceYen: 10000, trips: 9, irregular: false },
  { origin: '広尾', dest: '士幌', allowanceYen: 9000, trips: 8, irregular: false },
  { origin: '広尾', dest: '富士', allowanceYen: 8000, trips: 6, irregular: false },
  { origin: '広尾', dest: '川西', allowanceYen: 8000, trips: 6, irregular: true },
  { origin: '苫小牧', dest: '千歳', allowanceYen: 8000, trips: 5, irregular: false },
  { origin: '釧路', dest: '鹿追', allowanceYen: 9000, trips: 4, irregular: false },
  { origin: '苫小牧', dest: '清水・富士', allowanceYen: 12000, trips: 3, irregular: false },
  { origin: '釧路', dest: '音更', allowanceYen: 9000, trips: 2, irregular: false },
  { origin: '広尾', dest: '札内', allowanceYen: 9000, trips: 1, irregular: false },
  { origin: '広尾', dest: '札内・音更', allowanceYen: 9000, trips: 1, irregular: false },
  { origin: '広尾', dest: '浦幌', allowanceYen: 9000, trips: 1, irregular: false },
  { origin: '苫小牧', dest: '（清水）・富士', allowanceYen: 12000, trips: 1, irregular: false },
  { origin: '釧路', dest: '駒場（別海）', allowanceYen: 4500, trips: 1, irregular: false },
  { origin: '駒場（釧路）', dest: '別海', allowanceYen: 4500, trips: 1, irregular: false },
]
