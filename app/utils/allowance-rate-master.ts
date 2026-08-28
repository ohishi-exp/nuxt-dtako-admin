/**
 * 帯広 バルク車の料金・給与マスタの **seed (同梱の初期値)**。元表は
 * `帯広　バルク車　料金・給与一覧.xlsx` (2026/07/01 現在)。
 *
 * ## このファイルは正本ではない (Refs #805 PR-2 / #1017 ⑤)
 *
 * **マスタの正は R2** (`restraint/{compId}/allowance-rate/latest.json`)。
 * `RATE_MASTER` は **R2 にまだ何も入っていない間だけ使う初期値**で、消さずに残して
 * ある。いま R2 と seed のどちらで計算しているかは
 * `app/utils/allowance-rate-source.ts` が `r2` / `seed` / `error` の 3 状態に分けて
 * 決め、**画面に出す**。「初期値で計算している」を黙って隠さないのが #805 の眼目
 * なので、**このファイルを読む側が `?? RATE_MASTER` と書かないこと。**
 *
 * ## 由来は 2 通り。生成器は**廃止**したが、手元のコピーは消えていない
 *
 * 62 行のうち **60 行は xlsx からの機械生成**だった (生成器は
 * `obihiro-profit/gen_rate_ts.py`。**2026-08-28 のオーナー判断で廃止** — Refs #1031)。
 * 元表は結合セルで積地・卸地・運賃を上の行から引き継ぐ形なので、生成時に埋めてある。
 *
 * **残る 2 行は手で足した** (#751 / #756、どちらも `allowanceYen: 4500`)。
 * `釧路→駒場` と `駒場→ユナイテッド牧場` — **xlsx に載っていない**のに手当表PDF と
 * 一番星に実在する中継の内訳なので、**生成器を回しても出てこない**。
 * 手編集の行は `note` が `xlsx 未収載` と書いてあるかで見分ける (この 2 行だけ)。
 *
 * ⇒ **廃止したのは「もう回さない」という取り決めであって、生成器自体が消えたわけではない。**
 * このスクリプトはどの repo にも入っていないが、作業者のローカルにファイルとして
 * 残っている。**見つけた人が手元のコピーを回して丸ごと上書きすれば、廃止後の今でも
 * この 2 行は黙って消える。** 消えると釧路→駒場→別海 の中継が `unknown`
 * (イレギュラー) に落ちる — `allowance-rate.ts` は**マスタに無い経路を推測しない**ため。
 * 回さないこと。上書きしてしまったら手で戻すこと。
 *
 * **「生成器をこの repo に置くか / seed を JSON にするか」は決着した** (#1017 ⑤ →
 * Refs #1031)。**どちらもやらない** — 生成器は廃止し、**以後の編集は画面
 * (`/profit/allowance` の編集 UI、PR #1020) から行い、その結果を書く R2 が正**。
 * この `RATE_MASTER` は R2 が空の間だけの初期値として据え置く。
 *
 * - `farePerT` (運賃) は 円/t。売上 = `farePerT` × 数量。一番星の `unit_price` と
 *   一致することを 2026-07 の実データ 275 本中 255 本で確認済み
 * - `allowanceYen` (給与) は 1 便あたりの定額 = 運転手の運行手当。手当表PDF の金額と
 *   一致することを 2026-07 の 313 便中 296 便で確認済み (**食い違いは 0 件**)
 * - この表は「A飼料」系のみ。肉牛・素牛・N搾乳・FMメイズ 等の銘柄は載っていない
 */

export interface RateRow {
  /** 荷主グループ (例 `大石グループ`)。 */
  shipper: string
  /** 得意先 (例 `大石畜産`)。 */
  customer: string
  /** 積地の業者 (例 `中部飼料`)。 */
  loader: string
  /** 積地 (例 `釧路`)。 */
  origin: string
  /** 卸地。**この語彙がマスタの正**で、手当表PDF やデジタコの地名は別名で寄せる。 */
  dest: string
  /** 銘柄。空の行もある (卸地だけで運賃が決まる契約)。 */
  brand: string
  /** 運賃 (円/t)。売上の単価。 */
  farePerT: number | null
  /** 給与 (円/便)。運転手の運行手当。 */
  allowanceYen: number
  /** 備考 (例 `解体`)。 */
  note: string
}

export const RATE_MASTER: RateRow[] = [
  { shipper: '大石グループ', customer: '大石畜産', loader: '中部飼料', origin: '釧路', dest: '上士幌', brand: '大石前期', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: '中部飼料', origin: '釧路', dest: '上士幌', brand: '大石後期', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: '中部飼料', origin: '釧路', dest: '上士幌', brand: '大石仕上', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: '中部飼料', origin: '釧路', dest: '川西', brand: '大石前期', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: '中部飼料', origin: '釧路', dest: '川西', brand: '大石後期', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: '中部飼料', origin: '釧路', dest: '川西', brand: '大石仕上', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: 'とかち飼料', origin: '広尾', dest: '富士', brand: '大石前期M', farePerT: 2000, allowanceYen: 8000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: 'フィードワン', origin: '苫小牧', dest: '富士', brand: '大石肉牛中期マッシュ', farePerT: 2850, allowanceYen: 12000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: 'フィードワン', origin: '苫小牧', dest: '富士', brand: '大石肉牛後期マッシュ', farePerT: 2850, allowanceYen: 12000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: 'とかち飼料', origin: '広尾', dest: '駒場', brand: '大石前期M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産2', loader: '中部飼料', origin: '釧路', dest: '浦幌', brand: '大石前期', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '大石勉', loader: '中部飼料', origin: '釧路', dest: '上士幌', brand: '大石後期', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '北海大石ファーム', loader: 'とかち飼料', origin: '広尾', dest: '音更', brand: '大石前期M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '北海大石ファーム', loader: 'とかち飼料', origin: '広尾', dest: '音更', brand: '大石後期M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '北海大石ファーム', loader: 'とかち飼料', origin: '広尾', dest: '音更', brand: '大石仕上M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '北海大石ファーム', loader: 'とかち飼料', origin: '広尾', dest: '安平', brand: '大石前期M', farePerT: 2000, allowanceYen: 6000, note: '' },
  { shipper: '大石グループ', customer: '北海大石ファーム', loader: 'とかち飼料', origin: '広尾', dest: '安平', brand: '大石後期M', farePerT: 2000, allowanceYen: 6000, note: '' },
  { shipper: '大石グループ', customer: '北海大石ファーム', loader: 'とかち飼料', origin: '広尾', dest: '安平', brand: '大石仕上M', farePerT: 2000, allowanceYen: 6000, note: '' },
  { shipper: '大石グループ', customer: '北海大石ファーム', loader: 'とかち飼料', origin: '広尾', dest: '本別', brand: '大石前期M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '北海大石ファーム', loader: 'とかち飼料', origin: '広尾', dest: '本別', brand: '大石後期M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '北海大石ファーム', loader: 'とかち飼料', origin: '広尾', dest: '本別', brand: '大石仕上M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: 'ダイチク', loader: 'とかち飼料', origin: '広尾', dest: '浦幌', brand: '大石前期M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: 'ダイチク', loader: 'とかち飼料', origin: '広尾', dest: '浦幌', brand: '大石後期M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: 'ダイチク', loader: 'とかち飼料', origin: '広尾', dest: '浦幌', brand: '大石仕上M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '十勝ビーフ', loader: 'とかち飼料', origin: '広尾', dest: '清水', brand: '大石前期M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '十勝ビーフ', loader: 'とかち飼料', origin: '広尾', dest: '清水', brand: '大石後期M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '十勝ビーフ', loader: 'とかち飼料', origin: '広尾', dest: '清水', brand: '大石仕上M', farePerT: 2000, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: 'トヨコロファーム', loader: '中部飼料', origin: '釧路', dest: '豊頃', brand: '大石前期', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: 'トヨコロファーム', loader: '中部飼料', origin: '釧路', dest: '豊頃', brand: '大石後期', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: 'トヨコロファーム', loader: '中部飼料', origin: '釧路', dest: '豊頃', brand: '大石仕上', farePerT: 2750, allowanceYen: 9000, note: '' },
  { shipper: '中部飼料', customer: '丹波屋', loader: '中部飼料', origin: '釧路', dest: '溝口', brand: 'ミックス18', farePerT: 3900, allowanceYen: 9000, note: '' },
  { shipper: '中部飼料', customer: '丹波屋', loader: '中部飼料', origin: '釧路', dest: '鎌田', brand: 'ミックス20', farePerT: 4000, allowanceYen: 9000, note: '' },
  { shipper: '中部飼料', customer: '佐々木畜産', loader: '中部飼料', origin: '釧路', dest: '北村', brand: 'ホルマッシュ', farePerT: 3000, allowanceYen: 9000, note: '' },
  { shipper: '中部飼料', customer: '佐々木畜産', loader: '中部飼料', origin: '釧路', dest: '角田', brand: 'エリートG', farePerT: 3000, allowanceYen: 9000, note: '' },
  { shipper: '中部飼料', customer: '湯浅商事', loader: '中部飼料', origin: '釧路', dest: '延与', brand: 'ノベルズブレンド', farePerT: 3550, allowanceYen: 9000, note: '' },
  { shipper: '中部飼料', customer: '湯浅商事', loader: '中部飼料', origin: '釧路', dest: 'ノベルズ', brand: 'ノベルズブレンド', farePerT: 3550, allowanceYen: 9000, note: '' },
  { shipper: '中部飼料', customer: '湯浅商事', loader: '中部飼料', origin: '釧路', dest: 'イートラスト', brand: 'ノベルズブレンド', farePerT: 3600, allowanceYen: 9000, note: '' },
  { shipper: '中部飼料', customer: '湯浅商事', loader: '中部飼料', origin: '釧路', dest: '浦幌DF', brand: 'ノベルズブレンド', farePerT: 2900, allowanceYen: 9000, note: '' },
  { shipper: 'フィードワン', customer: 'あらた物産', loader: '釧路飼料', origin: '釧路', dest: 'FCS標茶', brand: '星空の前期', farePerT: 3000, allowanceYen: 8000, note: '' },
  { shipper: 'フィードワン', customer: 'あらた物産', loader: '釧路飼料', origin: '釧路', dest: 'FCS標茶', brand: '星空のかがやき', farePerT: 3000, allowanceYen: 8000, note: '' },
  { shipper: 'フィードワン', customer: 'あらた物産', loader: '釧路飼料', origin: '釧路', dest: 'FCS標茶', brand: 'ほしぞら育成', farePerT: 3000, allowanceYen: 8000, note: '' },
  { shipper: 'フィードワン', customer: '丹波屋', loader: '釧路飼料', origin: '釧路', dest: 'ノベルズ音更', brand: '蝦夷', farePerT: 2950, allowanceYen: 9000, note: '' },
  { shipper: 'フィードワン', customer: '丹波屋', loader: '釧路飼料', origin: '釧路', dest: 'ノベルズ音更', brand: '蝦夷ZERO', farePerT: 2950, allowanceYen: 9000, note: '' },
  { shipper: 'フィードワン', customer: '丹波屋', loader: 'フィードワン', origin: '苫小牧', dest: '橋本畜産', brand: 'ときめき300', farePerT: 6000, allowanceYen: 12000, note: '' },
  { shipper: '日清丸紅', customer: '丹波屋', loader: '新北海道飼料', origin: '苫小牧', dest: '千代田', brand: '北海特専', farePerT: 2750, allowanceYen: 8000, note: '(8t補償)' },
  { shipper: '日清丸紅', customer: '丹波屋', loader: '新北海道飼料', origin: '苫小牧', dest: '千代田', brand: 'やわらぎ後期', farePerT: 2750, allowanceYen: 8000, note: '' },
  { shipper: '日清丸紅', customer: '丹波屋', loader: '新北海道飼料', origin: '苫小牧', dest: '千代田', brand: 'しもふり育成', farePerT: 2750, allowanceYen: 8000, note: '' },
  { shipper: 'ホクレン', customer: '佐々木畜産', loader: 'くみあい飼料', origin: '士幌', dest: '清水DF', brand: '', farePerT: 2520, allowanceYen: 8000, note: '' },
  { shipper: 'タイセイ飼料', customer: 'タイセイ飼料', loader: '道東飼料', origin: '釧路', dest: 'ユナイテッド牧場', brand: '搾りマッシュ', farePerT: 3500, allowanceYen: 9000, note: '' },
  { shipper: 'タイセイ飼料', customer: 'タイセイ飼料', loader: '中部飼料(株)', origin: '釧路', dest: '力武牧場', brand: 'ミルケア', farePerT: 3500, allowanceYen: 8000, note: '' },
  { shipper: 'タイセイ飼料', customer: 'タイセイ飼料', loader: '中部飼料(株)', origin: '釧路', dest: '力武牧場', brand: 'ミライコーン', farePerT: 3500, allowanceYen: 8000, note: '' },
  { shipper: '佐々木畜産', customer: '佐々木畜産', loader: 'とかち飼料', origin: '広尾', dest: '松山/浦幌', brand: 'ブリードグリーン', farePerT: 3200, allowanceYen: 9000, note: '解体' },
  { shipper: '佐々木畜産', customer: '佐々木畜産', loader: 'とかち飼料', origin: '広尾', dest: '松山/士幌', brand: 'ヘルシーミート', farePerT: 3300, allowanceYen: 9000, note: '解体' },
  { shipper: '佐々木畜産', customer: '佐々木畜産', loader: 'とかち飼料', origin: '広尾', dest: '松山/音更', brand: 'ブリードグリーン', farePerT: 3300, allowanceYen: 9000, note: '解体' },
  { shipper: '佐々木畜産', customer: '佐々木畜産', loader: 'とかち飼料', origin: '広尾', dest: '松山/札内', brand: 'ブリードグリーン', farePerT: 3250, allowanceYen: 9000, note: '解体' },
  { shipper: '佐々木畜産', customer: '佐々木畜産', loader: 'とかち飼料', origin: '広尾', dest: '長内畜産', brand: 'ヘルシービーフ', farePerT: 3200, allowanceYen: 8000, note: '' },
  { shipper: '丸勝', customer: '丸勝', loader: '丸勝', origin: '帯広', dest: '大樹', brand: '', farePerT: 4200, allowanceYen: 10000, note: '解体' },
  { shipper: '丸勝', customer: '丸勝', loader: '丸勝', origin: '帯広', dest: '鹿追', brand: '', farePerT: 3800, allowanceYen: 10000, note: '解体' },
  { shipper: '丸勝', customer: '丸勝', loader: '丸勝', origin: '帯広', dest: '士幌', brand: '', farePerT: 3800, allowanceYen: 10000, note: '解体' },
  { shipper: '丸勝', customer: '丸勝', loader: '中部飼料(株)', origin: '釧路', dest: '鹿追', brand: '', farePerT: 3900, allowanceYen: 9000, note: '' },
  { shipper: '大石グループ', customer: '大石畜産', loader: '中部飼料', origin: '釧路', dest: '駒場', brand: '', farePerT: null, allowanceYen: 4500, note: '手当表PDF 2026-07 柳井 07-16 『釧路〜駒場（別海）』より。xlsx 未収載。釧路→駒場→別海 の中継の前半' },
  { shipper: 'タイセイ飼料', customer: 'タイセイ飼料', loader: '', origin: '駒場', dest: 'ユナイテッド牧場', brand: '', farePerT: null, allowanceYen: 4500, note: '手当表PDF 2026-07 西島 07-17 『駒場（釧路）〜別海』より。xlsx 未収載。釧路→駒場→別海 の中継の後半で、前半は 釧路→駒場 (¥4,500)。一番星の通し請求 釧路→ユナイテッド牧場 12.5t @3500 ¥43,750 が、中継の内訳 釧路→駒場 ¥21,750 と 駒場→ユナイテッド牧場 ¥22,000 に割れている (和が通しと一致)。運賃は内訳側に単価が無い (一式) ので null' },
]
