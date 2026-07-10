// 全ト協 標準的運賃計算サイト (detailedfare.jta.support) の Supabase 接続情報
// および運賃コードマッピング (Refs #198 Phase 4/5)。
//
// URL / anon key は公開 JS bundle に平文で載っている公開値 (RLS 前提の anon
// ロール、秘密ではない)。fetch-tariff-snapshot.mjs (Node スクリプト) と
// server route の両方から使うため .mjs で export する。
//
// SoT: detailedfare.jta.support の JS bundle を静的解析 (2026-07-10)。
// スキーマ:
//   fare_rates(region_code, vehicle_code, upto_km, fare_yen)  — 距離制運賃 (告示 I)
//   charge_data(id_code, vehicle_code, time_code, charge_yen) — 待機/積込 (告示 V/VI)

export const JTA_SUPABASE_URL = 'https://pwnkpkeelpsxlvyxsaml.supabase.co'
export const JTA_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB3bmtwa2VlbHBzeGx2eXhzYW1sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDczNzc2ODAsImV4cCI6MjA2Mjk1MzY4MH0.wExTYvz9s-HBKKJr12miIyeuAgKKtrH7W8yo8RRhUbI'

/** 運輸局 → region_code (JTA JS の tH マップ) */
export const REGION_CODE = {
  hokkaido: 1, tohoku: 2, kanto: 3, hokuriku_shinetsu: 4, chubu: 5,
  kinki: 6, chugoku: 7, shikoku: 8, kyushu: 9, okinawa: 10,
}

/** 車種 → vehicle_code (JTA JS の tJ マップ) */
export const VEHICLE_CODE = {
  small_2t: 1, medium_4t: 2, large_10t: 3, trailer_20t: 4,
}

/** charge_data.id_code: 1=待機時間料, 2=手積み, 3=機械積み(フォークリフト等) */
export const CHARGE_ID_CODE = { waiting: 1, manual: 2, machine: 3 }

/** charge_data.time_code: 0=通常単価, 9=2時間超単価 */
export const CHARGE_TIME_CODE = { normal: 0, over2h: 9 }
