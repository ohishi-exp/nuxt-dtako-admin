// 標準的運賃 九州運輸局ブロック (令和6年国土交通省告示第209号)
//
// SOURCE: 官報 令和6年3月22日 (号外第66号) — 距離制: 96頁 / 時間制: 97〜98頁
//         https://www.mlit.go.jp/jidosha/content/001732621.pdf
// 転記は官報 PDF から二重チェック済み (2026-07-10)。数値を変更する場合は
// 必ず官報原本と突合し、tests/utils/tariff.test.ts の代表値も更新すること。
//
// 他運輸局ブロックの追加は同じ構造のファイルを増やす (まず九州のみ、Refs #198)。

import type { DistanceTariffTable, TimeTariffTable } from '../types'

/** 距離制運賃表 (九州運輸局)。index 0 = 10km, …, 19 = 200km */
export const KYUSHU_DISTANCE: DistanceTariffTable = {
  bureau: 'kyushu',
  upTo200km: {
    small_2t: [
      13450, 15170, 16890, 18610, 20330, 22050, 23770, 25490, 27210, 28930,
      30630, 32340, 34050, 35750, 37460, 39170, 40870, 42580, 44290, 45990,
    ],
    medium_4t: [
      15730, 17750, 19780, 21800, 23820, 25840, 27870, 29890, 31910, 33930,
      35910, 37900, 39880, 41860, 43840, 45820, 47800, 49780, 51760, 53740,
    ],
    large_10t: [
      20470, 23290, 26110, 28930, 31750, 34580, 37400, 40220, 43040, 45860,
      48580, 51300, 54020, 56740, 59460, 62180, 64900, 67620, 70340, 73060,
    ],
    trailer_20t: [
      26120, 29940, 33750, 37570, 41390, 45210, 49020, 52840, 56660, 60470,
      64140, 67810, 71480, 75150, 78820, 82490, 86160, 89830, 93500, 97170,
    ],
  },
  per20kmOver200: { small_2t: 3390, medium_4t: 3920, large_10t: 5350, trailer_20t: 7210 },
  per50kmOver500: { small_2t: 8480, medium_4t: 9800, large_10t: 13380, trailer_20t: 18020 },
}

/** 時間制運賃表 (九州運輸局)。加算額の中型 400 円は九州のみの値 (他局は 410 円) */
export const KYUSHU_TIME: TimeTariffTable = {
  bureau: 'kyushu',
  base8h: { small_2t: 33770, medium_4t: 40740, large_10t: 53860, trailer_20t: 69700 },
  base4h: { small_2t: 20260, medium_4t: 24440, large_10t: 32320, trailer_20t: 41820 },
  perExtra10km: { small_2t: 340, medium_4t: 400, large_10t: 630, trailer_20t: 920 },
  perExtraHour: { small_2t: 2940, medium_4t: 3090, large_10t: 3320, trailer_20t: 3900 },
}
