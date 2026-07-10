# 全ト協 標準的運賃計算サイト — API 解析メモ

Refs #198 (Phase 3/5)

対象: https://detailedfare.jta.support/ （全ト協「標準的運賃計算サイト」）
解析日: 2026-07-10 / 手法: 公開 JS bundle の静的解析 + REST 実測

## 構成

- フロント: Next.js (static export)。**認証なし**（`noindex, nofollow`）
- バックエンド: **Supabase** (PostgREST)。運賃計算は「Supabase から表を引いて
  クライアント JS で計算」する構造で、専用の計算 API は存在しない
- 距離計測: Google Maps（経路上の距離）。運賃計算距離は切り上げ後の値

## Supabase 接続 (公開値)

JS bundle に平文で載っている anon ロールの値（RLS 前提、秘密ではない）:

- URL: `https://pwnkpkeelpsxlvyxsaml.supabase.co`
- anon key: `eyJ...RhUbI`（`server/utils/jta-tariff.mjs` に収録）

## テーブルスキーマ

### `fare_rates` — 距離制運賃表（告示 I）

| カラム | 意味 |
|---|---|
| `region_code` | 運輸局（`tH` マップ: 北海道1…九州9・沖縄10） |
| `vehicle_code` | 車種（`tJ` マップ: small1 / medium2 / large3 / trailer4） |
| `upto_km` | 距離帯（10〜2000km の事前計算表。切り上げ後の km と一致） |
| `fare_yen` | 基準運賃額（円、割増・消費税・高速代を含まない） |

行数: 各運輸局 4 車種 × 65 距離帯 = 260 行（沖縄のみ 5km 始まりで 104 行）。

```
GET /rest/v1/fare_rates?region_code=eq.9&vehicle_code=eq.3&upto_km=eq.100&select=fare_yen
→ [{"fare_yen":45860}]
```

### `charge_data` — 待機時間料・積込取卸料（告示 V/VI）

| カラム | 意味 |
|---|---|
| `id_code` | 1=待機時間料 / 2=手積み / 3=機械積み（フォークリフト等） |
| `vehicle_code` | 車種（同上） |
| `time_code` | 0=通常単価 / 9=2時間超単価 |
| `charge_yen` | 30 分あたりの金額 |

## クライアント計算ロジック（JS から抽出）

- 距離切り上げ: `≤200km → 10km`, `≤500km → 20km`, `>500km → 50km`
  （本 repo `roundUpDistanceKm` と一致）
- 燃料サーチャージ基準 120円/L、休日・深夜早朝割増 各 2 割（告示準拠と明記）

## 突合結果（検算）

- 手で官報転記した九州 260 行（`app/utils/tariff/data/kyushu.ts`）が
  Supabase の値と **全件一致（mismatch 0）**
- `charge_data` の待機/積込値も `common.ts` の官報転記値と一致
- → このサイトのデータは告示 209 号の公開値と同一と確認

## 本 repo での利用方針

- **主**: 本番の運賃 lookup は実行時に Supabase を直接叩く
  (`server/utils/tariff-lookup.ts` の `fetchFareFromJta`)
- **副**: 失敗時（先方障害 / RLS 変更 / revoke）は取得済み snapshot
  (`server/tariff/snapshot.json`) にフォールバック
- snapshot は `scripts/tariff/fetch-tariff-snapshot.mjs` で全運輸局を再取得
  （告示改定時に再実行）。CI のゴールデンテスト fixture も兼ねる
- 割増・サーチャージ・時間制など「表引き以外」の計算は自作ロジック
  (`app/utils/tariff/calc.ts`) を使う（issue #198 の「主計算は自作」方針）

## 留意

- 2000km 超は JTA 表の範囲外（`lookupFare` は throw）。長距離運行が必要に
  なったら加算式（`distanceBaseFare`）へのフォールバックを検討
- 沖縄は 5km 始まりの別構造。九州以外を主対象にする際に対応
- 自動アクセスは低頻度・検算用途に留める（大量アクセスは先方負荷 + 規約リスク）
