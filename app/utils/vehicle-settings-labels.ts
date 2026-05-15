/**
 * NET780 デジタコ `*.cfg` 設定キーの日本語ラベル / 単位 / enum / スケール辞書。
 *
 * 出典: 車載機設定確認表 PDF (e-Tacho NET780) — メーカー公式の「車輌設定」一覧。
 * cfg ファイルの `KEY_NAME = VALUE` 形式は内部識別子なので、PDF にあるユーザー向け
 * 項目名 / 単位 / enum 値の意味 / スケール係数 で補強する。
 *
 * 全てのキーを網羅しているわけではないが、PDF に出てくるものは原則カバー。
 * カバーされていないキー (state-2 variant の一部、`OPER_REBOOT_RECOVER_*`、
 * `DVR_*`の細目、`CALI_*` 等) は UI 側で raw 表示する。
 */

export interface SettingLabel {
  /** 項目名 (日本語) */
  label: string
  /** 単位 (例: "秒", "km/h", "G") — `[]` は付けず単体で持つ */
  unit?: string
  /**
   * 表示スケール: `display = raw * scale`
   * 例: PULS_SPNUM の raw=800 を `8.00 パルス` と表示するには scale=0.01。
   */
  scale?: number
  /** scale 指定時の表示小数桁数 (default: scale から推定) */
  decimals?: number
  /** 値 → 日本語意味 (PDF にある enum のみ。マッチしない値は素通し) */
  enums?: Record<string, string>
}

export interface FormattedSetting {
  key: string
  /** 辞書ヒット時の日本語ラベル、なければ `null` */
  label: string | null
  /** cfg の生値 */
  raw: string | number
  /** 表示用に整形した値 (例: "8.00 パルス", "1 (自動補正あり)") */
  formatted: string
  /** enum マッチ時の意味だけ (例: "自動補正あり") */
  enumMeaning: string | null
  /** 単位 (例: "秒") */
  unit: string | null
  /** スケール適用後の数値 (number 値のときのみ、それ以外は null) */
  scaledValue: number | null
}

// ─────────────────────────────────────────────────────────────────────
// 共通 enum セット (PDF で繰り返し出現)
// ─────────────────────────────────────────────────────────────────────

const ALARM_TYPE_ENUMS: Record<string, string> = {
  '0': 'なし',
  '1': '1回音声',
}

const YES_NO_ENUMS: Record<string, string> = {
  '0': 'なし',
  '1': 'あり',
}

const PULSE_KIND_ENUMS: Record<string, string> = {
  '1': 'オープンコレクタ',
}

const SIGNAL_LEVEL_ENUMS: Record<string, string> = {
  '3': '1.15_1.75v',
}

const BUTTON_TYPE_ENUMS: Record<string, string> = {
  '0': '単独トグル',
  '1': '作業トグル',
  '2': '走行操作トグル',
  '6': '免許証読取ボタン',
}

const BUTTON_SLEEP_ENUMS: Record<string, string> = {
  '0': '画面復帰',
}

const SENSOR_TYPE_ENUMS: Record<string, string> = {
  '0': 'NP純正温度ｾﾝｻｰ',
}

const SEND_ENUMS: Record<string, string> = {
  '0': '送信しない',
  '1': '送信する',
}

const EXTIO_TYPE_ENUMS: Record<string, string> = {
  '0': '使用しない',
  '1': 'モーメンタリ',
}

const EXTIO_ACT_ENUMS: Record<string, string> = {
  '3': '記録・音声なし',
}

// ─────────────────────────────────────────────────────────────────────
// 静的辞書本体 — Object.assign で section ごとに追加していく
// ─────────────────────────────────────────────────────────────────────

const STATIC_LABELS: Record<string, SettingLabel> = {
  // Base Settings (PDF 1003-1015)
  BASE_COMPANYCD: { label: '会社コード' },
  BASE_BRANCHCD: { label: '事業所コード' },
  BASE_VEHICLECD: { label: '車輌コード' },
  BASE_DRIVERCD1: { label: '乗務員コード1' },
  BASE_DRIVERCD2: { label: '乗務員コード2' },
  BASE_VOLUME: { label: '音量', enums: { '0': '無音', '1': '小', '2': '中', '3': '大' } },
  BASE_GPSTIMECORRECT: { label: 'GPS時刻補正', enums: { '0': 'なし', '1': '自動補正あり' } },
  BASE_INSTPOSITION: {
    label: '設置位置',
    enums: { '0': '水平前(車輌コンソール内)' },
  },
  BASE_ANGLE_X: { label: '設置角度補正X', unit: '°' },
  BASE_ANGLE_Y: { label: '設置角度補正Y', unit: '°' },
  BASE_ANGLE_Z: { label: '設置角度補正Z', unit: '°' },
  BASE_DOOROPENSEC: { label: 'カードロックオープン検出時間', unit: '秒' },
  BASE_DRIVERCDCHECK: { label: '乗務員コード登録確認', enums: { '0': 'なし', '1': '運行開始時' } },

  // Pulse Settings (PDF 2001-2012)
  PULS_SPNUM: { label: '速度パルス数', unit: 'パルス', scale: 0.01, decimals: 2 },
  PULS_SPKIND: { label: '速度パルス波形', enums: PULSE_KIND_ENUMS },
  PULS_SPLEVEL: { label: '速度信号電圧レベル', enums: SIGNAL_LEVEL_ENUMS },
  PULS_SPLIMIT: { label: '有効速度', unit: 'km/h' },
  PULS_DISTFACTOR: { label: '距離補正', scale: 0.0001, decimals: 4 },
  PULS_RVNUM: { label: '回転パルス数', unit: 'パルス', scale: 0.01, decimals: 2 },
  PULS_RVKIND: { label: '回転パルス波形', enums: PULSE_KIND_ENUMS },
  PULS_RVLEVEL: { label: '回転信号電圧レベル', enums: SIGNAL_LEVEL_ENUMS },
  PULS_RVLIMIT: { label: '有効回転', unit: 'rpm' },
  PULS_RVUNIT: { label: '回転記録単位', unit: 'rpm' },
  PULS_SPINVALIDSEC: { label: '速度取得開始時間', unit: '秒' },
  PULS_RVINVALIDSEC: { label: '回転取得開始時間', unit: '秒' },

  // Operation Settings (PDF 3001-3026)
  OPER_RECTYPE: { label: '運行データ管理方法', enums: { '2': 'LTE' } },
  OPER_DAYMAX: { label: '運行最大日数', unit: '日' },
  OPER_HIGHSW: { label: '高速切替SW', enums: { '6': 'ボタンA' } },
  OPER_BPSW: { label: 'バイパス切替SW', enums: { '7': 'ボタンB' } },
  OPER_AUTOWAY: { label: '道路自動切替', enums: { '2': 'ETC ON/OFF' } },
  OPER_TRANSSW: { label: '実車切替SW', enums: { '5': 'ボタン5' } },
  OPER_AUTOTRANS: { label: '実車自動切替', enums: { '0': '手動' } },
  OPER_LOADSW: { label: '積込SW', enums: { '1': 'ボタン1' } },
  OPER_UNLOADSW: { label: '荷降SW', enums: { '2': 'ボタン2' } },
  OPER_DRIVERSW: { label: '乗務員切替SW' },
  OPER_RUNDETECTSP: { label: '走行検知速度', unit: 'km/h', scale: 0.1, decimals: 1 },
  OPER_RUNSEC: { label: '走行検知時間', unit: '秒' },
  OPER_STOPDETECTSP: { label: '停車検知速度', unit: 'km/h', scale: 0.1, decimals: 1 },
  OPER_STOPSEC: { label: '停車検知時間', unit: '秒' },
  OPER_WORKENDSP: { label: '作業自動オフ速度', unit: 'km/h', scale: 0.1, decimals: 1 },
  OPER_WORKENDDIST: { label: '作業自動オフ距離', unit: 'm' },
  OPER_WORKENDSEC: { label: '作業自動オフ時間', unit: '秒' },
  OPER_BACKUPDAY: { label: '運行データ保存日数', unit: '日' },
  OPER_GSENSREC: { label: 'Gセンサーデータ記録有無', enums: YES_NO_ENUMS },
  OPER_BUTTON_NUM: { label: 'ボタン使用数', enums: { '1': '10個' } },
  OPER_BUTTON_RESTORE: { label: 'ボタン復元時間', unit: '秒' },
  OPER_BUTTON_RESTORE_CONDITION: {
    label: 'ボタン復元条件',
    enums: { '0': '表示ページのボタンONが無い時のみ復元' },
  },
  OPER_NFC_TIMEOUT: { label: 'ICカード読取タイムアウト', unit: '秒' },
  OPER_MSG_NOTICE: { label: 'メッセージ受信時通知タイプ', enums: { '0': '受信時のみ' } },
  OPER_MSG_NOTTICE_INTERVAL: { label: 'メッセージ通知間隔', unit: '秒' },
  OPER_IGNORE_SDERR: { label: 'カードレス運用許可', enums: { '0': '運行開始しない', '1': '運行開始する' } },
  OPER_REBOOT_RECOVER: { label: '再起動リカバリ', enums: YES_NO_ENUMS },
  OPER_REBOOT_RECOVER_SEC: { label: '再起動リカバリ判定時間', unit: '秒' },
  OPER_GYROREC: { label: 'ジャイロセンサーデータ記録有無', enums: YES_NO_ENUMS },
  OPER_DMSG_SDERR: { label: 'SDエラー時データメッセージ', enums: YES_NO_ENUMS },
  OPER_SD_REBIND: { label: 'SD再マウント回数', unit: '回' },

  // Display Settings (PDF 4001-4017)
  DISP_SLEEPSEC1: { label: '停車中スリープ時間', unit: '秒' },
  DISP_SLEEPSEC2: { label: '走行中スリープ時間', unit: '秒' },
  DISP_SLEEPBTN: { label: 'スリープ時ボタン動作', enums: { '0': '画面復帰' } },
  DISP_AUTO_BNS: { label: '輝度自動調節', enums: YES_NO_ENUMS },
  DISP_OLED_BNS_D: {
    label: '画面輝度(昼間)',
    enums: { '0': '無効', '1': '20%', '2': '30%', '3': '40%', '4': '50%', '5': '60%', '6': '70%', '7': '80%', '8': '90%', '9': '100%' },
  },
  DISP_OLED_BNS_N: {
    label: '画面輝度(夜間)',
    enums: { '0': '無効', '1': '20%', '2': '30%', '3': '40%', '4': '50%', '5': '60%', '6': '70%', '7': '80%', '8': '90%', '9': '100%' },
  },
  DISP_LED_BNS_D: {
    label: 'LED輝度(昼間)',
    enums: { '0': '無効', '1': '20%', '2': '30%', '3': '40%', '4': '50%', '5': '60%', '6': '70%', '7': '80%', '8': '90%', '9': '100%' },
  },
  DISP_LED_BNS_N: {
    label: 'LED輝度(夜間)',
    enums: { '0': '無効', '1': '20%', '2': '30%', '3': '40%', '4': '50%', '5': '60%', '6': '70%', '7': '80%', '8': '90%', '9': '100%' },
  },
  DISP_AUTO_BNS_THLD: {
    label: '輝度自動調節判定値',
    enums: { '0': 'レベル1', '1': 'レベル2', '2': 'レベル3', '3': 'レベル4', '4': 'レベル5', '5': 'レベル6', '6': 'レベル7' },
  },
  DISP_AUTO_BNS_SEC: { label: '輝度自動調節時間', enums: { '0': '遅い', '1': '普通', '2': '早い' } },
  DISP_G_PLS: { label: '速度/回転/距離/G表示', enums: YES_NO_ENUMS },
  DISP_TMP: { label: '温度表示', enums: YES_NO_ENUMS },
  DISP_DRIVETIME: { label: '連続運転時間表示', enums: YES_NO_ENUMS },
  DISP_RESTTIME: { label: '休息時間表示', enums: YES_NO_ENUMS },
  DISP_DRIVEAVE: { label: '平均運転時間表示', enums: YES_NO_ENUMS },
  DISP_BINDHOURS: { label: '拘束時間表示', enums: YES_NO_ENUMS },
  DISP_BREAKTIME: { label: '累計休憩時間表示', enums: YES_NO_ENUMS },
  DISP_UPKEY: { label: '上キー機能' },
  DISP_DOWNKEY: { label: '下キー機能' },
  DISP_LEFTKEY: { label: '左キー機能' },
  DISP_RIGHTKEY: { label: '右キー機能' },

  // Acceleration Warning (PDF 6001-6015)
  ACCWARN_METHOD: { label: '急加減速判定方法', enums: { '1': 'Gセンサー判定' } },
  ACCWARN_ACCEL_ALRM: { label: '急加速警告アラーム', enums: ALARM_TYPE_ENUMS },
  ACCWARN_ACCEL_THLD_D: { label: '急加速許容加速度[データ]', unit: 'G', scale: 0.01, decimals: 2 },
  ACCWARN_ACCEL_THLD_A: { label: '急加速許容加速度[アラーム]', unit: 'G', scale: 0.01, decimals: 2 },
  ACCWARN_ACCEL_THLD_RETURN: { label: '急加速判定終了加速度', unit: 'G', scale: 0.01, decimals: 2 },
  ACCWARN_BRAKE_ALRM: { label: '急減速警告アラーム', enums: ALARM_TYPE_ENUMS },
  ACCWARN_BRAKE_THLD_D: { label: '急減速許容加速度[データ]', unit: 'G', scale: 0.01, decimals: 2 },
  ACCWARN_BRAKE_THLD_A: { label: '急減速許容加速度[アラーム]', unit: 'G', scale: 0.01, decimals: 2 },
  ACCWARN_BRAKE_THLD_RETURN: { label: '急減速判定終了加速度', unit: 'G', scale: 0.01, decimals: 2 },
  ACCWARN_CURVE_ALRM: { label: '急ハンドル警告アラーム', enums: ALARM_TYPE_ENUMS },
  ACCWARN_CURVE_THLD_D: { label: '急ハンドル許容加速度[データ]', unit: 'G', scale: 0.01, decimals: 2 },
  ACCWARN_CURVE_THLD_A: { label: '急ハンドル許容加速度[アラーム]', unit: 'G', scale: 0.01, decimals: 2 },
  ACCWARN_CURVE_THLD_RETURN: { label: '急ハンドル判定終了加速度', unit: 'G', scale: 0.01, decimals: 2 },
  ACCWARN_CURVE_METHOD: { label: '急ハンドル判定方法', enums: { '0': 'Gセンサー判定' } },
  ACCWARN_RISK_CALC_METHOD: { label: '危険度判定方法', enums: { '0': '判定しない' } },

  // Idle Warning (PDF 8001-8007)
  IDLWARN_METHOD: { label: 'アイドリング判定方法', enums: { '1': '回転のみ' } },
  IDLWARN_UNIT: { label: 'アイドリング時間判定単位', enums: { '0': '秒', '1': '分' } },
  IDLWARN_ALRM: { label: 'アイドリング警告アラーム', enums: ALARM_TYPE_ENUMS },
  IDLWARN_INTERVAL: { label: 'アイドリング連続アラーム間隔', unit: '秒' },
  IDLWARN_CONDITION: { label: 'アイドリング判定除外条件' },
  IDLWARN_ALLOW_MIN: { label: 'アイドリング許容時間', unit: '分' },
  IDLWARN_END_SEC: { label: 'アイドリング判定終了時間', unit: '秒' },

  // Long-drive Warning (PDF 9001-9013)
  LDWARN_METHOD: { label: '連続運転判定方法', enums: { '2': '労基基準(停車ベース)' } },
  LDWARN_UNIT: { label: '連続運転判定時間単位', enums: { '0': '秒', '1': '分' } },
  LDWARN_ALRM: { label: '連続運転警告アラーム', enums: ALARM_TYPE_ENUMS },
  LDWARN_ALRM_DISP: { label: '連続運転警告アラーム画面', enums: { '0': 'スクロール表示' } },
  LDWARN_ALRM_INTERVAL: { label: '連続運転連続アラーム間隔', unit: '分' },
  LDWARN_ALLOW_MIN: { label: '連続運転警告制限時間', unit: '分' },
  LDWARN_STOP_MIN: { label: '連続運転最低停車時間', unit: '分' },
  LDWARN_STOP_MIN_RESET: { label: '連続運転クリア累計停車時間', unit: '分' },
  LDWARN_PALRM_MIN: { label: '連続運転予告アラーム時間', unit: '分' },
  LDWARN_PALRM_INTERVAL: { label: '連続運転予告アラーム間隔', unit: '分' },
  LDWARN_NOTICE: { label: '連続運転状況通知', enums: YES_NO_ENUMS },
  LDWARN_STOP_CAL_METHOD: { label: '連続運転停車判定方法', enums: { '0': '停車' } },
  LDWARN_DISP_REMAIN: { label: '必要最低停車時間表示', enums: YES_NO_ENUMS },

  // GPS / Temp (PDF 10001-10014)
  GPS_INTERVAL: { label: 'GPS記録間隔', unit: '秒' },
  GPS_TIMEZONE: { label: 'タイムゾーン指定' },
  GPS_CS_FIRSTVALID_SEC: { label: 'GPS初回有効判定時間', unit: '秒' },
  GPS_CS_FIRSTVALID_RETRY: { label: 'GPS初回有効リトライ回数', unit: '回' },
  GPS_CS_INVALIDRANGE: { label: 'GPS無効判定範囲' },
  GPS_CS_EXTSEC: { label: 'GPS無効猶予時間', unit: '秒' },
  TMP_NUM: { label: '温度取得CH数' },
  TMP_INTERVAL: { label: '温度記録間隔', unit: '秒' },
  TMP_INTERVAL_ST: { label: '温度取得間隔', unit: '秒' },
  TMP_MOMENT: { label: '瞬間温度記録', enums: YES_NO_ENUMS },
  TMP_MAX: { label: '最高温度記録', enums: YES_NO_ENUMS },
  TMP_MIN: { label: '最低温度記録', enums: YES_NO_ENUMS },
  TMP_SET: { label: '設定温度記録', enums: YES_NO_ENUMS },
  TMP_CONF2: { label: '温度状態2設定' },
  TMP_TYPE_1: { label: 'CH1センサータイプ', enums: SENSOR_TYPE_ENUMS },
  TMP_TYPE_2: { label: 'CH2センサータイプ', enums: SENSOR_TYPE_ENUMS },
  TMP_TYPE_3: { label: 'CH3センサータイプ', enums: SENSOR_TYPE_ENUMS },
  TMP_TYPE_4: { label: 'CH4センサータイプ', enums: SENSOR_TYPE_ENUMS },
  TMP_RCCOPT: { label: '温度記録オプション' },

  // Rest (PDF 13001-13018)
  REST_BUTTON: { label: '休息切替SW', enums: { '0': '使用しない' } },
  REST_UNIT: { label: '休息判定時間単位', enums: { '0': '秒', '1': '分' } },
  REST_CONT_MAX: { label: '連続休息判定時間', unit: '分' },
  REST_SEP_MIN: { label: '分割休息判定時間(1回当たり)', unit: '分' },
  REST_SEP_MAX: { label: '2分割休息判定時間(累計)', unit: '分' },
  REST_SEP_3RD_MAX: { label: '3分割休息判定時間(累計)', unit: '分' },
  REST_OFF_SPEED: { label: '休息判定OFF速度', unit: 'km/h', scale: 0.1, decimals: 1 },
  REST_OFF_DIST: { label: '休息判定OFF距離', unit: 'm' },
  REST_ALARM_ENABLE: { label: '休息警告アラーム', enums: YES_NO_ENUMS },
  REST_ALARM_MIN: { label: '休息警告アラーム時間', unit: '分' },
  REST_ALARM_INTERVAL: { label: '休息警告アラーム間隔', unit: '分' },
  REST_ALARM_NUM: { label: '休息警告アラーム回数', unit: '回' },
  REST_PREALARM_ENABLE: { label: '休息予告アラーム', enums: YES_NO_ENUMS },
  REST_PREALARM_MIN: { label: '休息予告アラーム時間', unit: '分' },
  REST_PREALARM_INTERVAL: { label: '休息予告アラーム間隔', unit: '分' },
  REST_PREALARM_NUM: { label: '休息予告アラーム回数', unit: '回' },
  REST_DISP_REMAIN: { label: '必要休息時間表示', enums: YES_NO_ENUMS },
  REST_BREAK_MIN: { label: '休憩判定時間', unit: '分' },

  // External I/O (PDF 14001-14012)
  EXTIO_ATTR_IN1: { label: '外部入力1タイプ', enums: EXTIO_TYPE_ENUMS },
  EXTIO_ACT_IN1: { label: '外部入力1動作', enums: EXTIO_ACT_ENUMS },
  EXTIO_ATTR_IN2: { label: '外部入力2タイプ', enums: EXTIO_TYPE_ENUMS },
  EXTIO_ACT_IN2: { label: '外部入力2動作', enums: EXTIO_ACT_ENUMS },
  EXTIO_ATTR_IN3: { label: '外部入力3タイプ', enums: EXTIO_TYPE_ENUMS },
  EXTIO_ACT_IN3: { label: '外部入力3動作', enums: EXTIO_ACT_ENUMS },
  EXTIO_ATTR_IN4: { label: '外部入力4タイプ', enums: EXTIO_TYPE_ENUMS },
  EXTIO_ACT_IN4: { label: '外部入力4動作', enums: EXTIO_ACT_ENUMS },
  EXTIO_ATTR_IN5: { label: '外部入力5タイプ', enums: EXTIO_TYPE_ENUMS },
  EXTIO_ACT_IN5: { label: '外部入力5動作', enums: EXTIO_ACT_ENUMS },
  EXTIO_ATTR_IN6: { label: '外部入力6タイプ', enums: EXTIO_TYPE_ENUMS },
  EXTIO_ACT_IN6: { label: '外部入力6動作', enums: EXTIO_ACT_ENUMS },

  // Communication (PDF 15001-15013)
  COMM_NETOP: { label: 'Network Operator', enums: { '4': 'sp mode' } },
  COMM_APN: { label: 'APN Name' },
  COMM_AUTHID: { label: 'Auth ID' },
  COMM_AUTHPWD: { label: 'Auth Password' },
  COMM_AUTHTYPE: { label: 'Auth Type', enums: { '0': 'none' } },
  COMM_WF_ESSID: { label: 'Wi-Fi ESSID' },
  COMM_WF_PASSWORD: { label: 'Wi-Fi Password' },
  COMM_FT_ADDRESS: { label: 'FTP Server IP' },
  COMM_FT_PORT: { label: 'FTP Server Port' },
  COMM_FT_USERID: { label: 'FTP User ID' },
  COMM_FT_PASS: { label: 'FTP Password' },
  COMM_FT_RETRY: { label: 'FTP 送信リトライ回数', unit: '回' },
  COMM_FT_TIMEOUT: { label: 'FTP タイムアウト', unit: '秒' },
  COMM_PNG_IPC: { label: '定期通信ping' },
  COMM_PNG_IPC_INTERVAL: { label: '定期通信ping間隔', unit: '秒' },
  COMM_PNG_IPC_NUM: { label: '定期通信ping回数', unit: '回' },

  // Serial Port (PDF 17001-17007)
  SERIAL_ETC: { label: 'ETC設定', enums: { '0': '使用しない', '2': 'デンソーETC' } },
  SERIAL_KEYPAD: { label: 'KEYPAD設定', enums: { '0': '使用しない' } },
  SERIAL_KEYPAD_PORT: { label: 'KEYPAD接続ポート', enums: { '0': 'KP/ALCポート' } },
  SERIAL_REF: { label: '冷凍機設定', enums: { '0': '使用しない' } },
  SERIAL_REF_PORT: { label: '冷凍機接続ポート', enums: { '3': 'REFポート' } },
  SERIAL_ALC: { label: 'ALC設定', enums: { '0': '使用しない' } },
  SERIAL_ALC_PORT: { label: 'ALC接続ポート', enums: { '0': 'KP/ALCポート' } },
  SERIAL_TPMS: { label: 'TPMS設定', enums: { '0': '使用しない' } },
  SERIAL_TPMS_PORT: { label: 'TPMS接続ポート' },

  // Calibration — PDF にないので生値表示用ラベルのみ
  CALI_G_X: { label: 'Gセンサー較正X' },
  CALI_G_Y: { label: 'Gセンサー較正Y' },
  CALI_G_Z: { label: 'Gセンサー較正Z' },
  CALI_GYR_X: { label: 'ジャイロ較正X' },
  CALI_GYR_Y: { label: 'ジャイロ較正Y' },
  CALI_GYR_Z: { label: 'ジャイロ較正Z' },

  // Input Settings (運転者が手入力する数値項目: 給油量 等)
  INPUT1_NAME: { label: '入力項目1 名称' },
  INPUT1_UNIT: { label: '入力項目1 単位' },
  INPUT1_ATTR: { label: '入力項目1 属性' },
  INPUT1_BIGDIG: { label: '入力項目1 整数桁' },
  INPUT1_SMLDIG: { label: '入力項目1 小数桁' },
  INPUT1_MAX: { label: '入力項目1 最大値' },
  INPUT1_MIN: { label: '入力項目1 最小値' },
  INPUT1_MST: { label: '入力項目1 マスター' },
  INPUT1_DEF: { label: '入力項目1 初期値' },
  INPUT2_NAME: { label: '入力項目2 名称' },
  INPUT2_UNIT: { label: '入力項目2 単位' },
  INPUT2_ATTR: { label: '入力項目2 属性' },
  INPUT2_BIGDIG: { label: '入力項目2 整数桁' },
  INPUT2_SMLDIG: { label: '入力項目2 小数桁' },
  INPUT2_MAX: { label: '入力項目2 最大値' },
  INPUT2_MIN: { label: '入力項目2 最小値' },
  INPUT2_MST: { label: '入力項目2 マスター' },
  INPUT2_DEF: { label: '入力項目2 初期値' },
  INPUT3_NAME: { label: '入力項目3 名称' },
  INPUT3_UNIT: { label: '入力項目3 単位' },
  INPUT3_ATTR: { label: '入力項目3 属性' },
  INPUT3_BIGDIG: { label: '入力項目3 整数桁' },
  INPUT3_SMLDIG: { label: '入力項目3 小数桁' },
  INPUT3_MAX: { label: '入力項目3 最大値' },
  INPUT3_MIN: { label: '入力項目3 最小値' },
  INPUT3_MST: { label: '入力項目3 マスター' },
  INPUT3_DEF: { label: '入力項目3 初期値' },
}

// ─────────────────────────────────────────────────────────────────────
// 繰り返しパターンを programmatic に生成 (SPWARN_WAY1-3, RVWARN1-2, T1/T2, BUTT_*, DVR_*)
// ─────────────────────────────────────────────────────────────────────

function buildSpeedWarnLabels(): Record<string, SettingLabel> {
  const wayPrefix: Record<string, string> = {
    WAY1: '一般道',
    WAY2: '高速道',
    WAY3: '専用道',
  }
  const out: Record<string, SettingLabel> = {}
  for (const [way, jp] of Object.entries(wayPrefix)) {
    out[`SPWARN_${way}_ALRM`] = { label: `${jp}速度警告アラーム`, enums: ALARM_TYPE_ENUMS }
    out[`SPWARN_${way}_INTERVAL`] = { label: `${jp}警告連続アラーム間隔`, unit: '秒' }
    out[`SPWARN_${way}_START`] = { label: `${jp}制限速度`, unit: 'km/h', scale: 0.1, decimals: 1 }
    out[`SPWARN_${way}_EXT_SEC`] = { label: `${jp}超過猶予時間`, unit: '秒' }
    out[`SPWARN_${way}_END_SEC`] = { label: `${jp}超過判定終了速度`, unit: 'km/h', scale: 0.1, decimals: 1 }
    out[`SPWARN_${way}_PALRM`] = { label: `${jp}速度予告アラーム`, enums: YES_NO_ENUMS }
    out[`SPWARN_${way}_PALRM_START`] = { label: `${jp}予告発声速度`, unit: 'km/h', scale: 0.1, decimals: 1 }
  }
  return out
}

function buildRevWarnLabels(): Record<string, SettingLabel> {
  const out: Record<string, SettingLabel> = {}
  for (const n of ['1', '2']) {
    const suffix = n === '2' ? '[状態2]' : ''
    out[`RVWARN${n}_ALRM`] = { label: `回転警告アラーム${suffix}`, enums: ALARM_TYPE_ENUMS }
    out[`RVWARN${n}_INTERVAL`] = { label: `回転警告連続アラーム間隔${suffix}`, unit: '秒' }
    out[`RVWARN${n}_START`] = { label: `許容回転数${suffix}`, unit: 'rpm' }
    out[`RVWARN${n}_EXT_SEC`] = { label: `回転超過判定猶予時間${suffix}`, unit: '秒' }
    out[`RVWARN${n}_END_RPM`] = { label: `回転判定終了回転数${suffix}`, unit: 'rpm' }
    out[`RVWARN${n}_PALRM`] = { label: `回転予告アラーム${suffix}`, enums: YES_NO_ENUMS }
    out[`RVWARN${n}_PALRM_START`] = { label: `回転予告回転数${suffix}`, unit: 'rpm' }
  }
  out['RVWARN2_CONDITION'] = { label: '回転警告状態2設定' }
  out['RVWARN2_EXCL_G'] = { label: '減速時無効加速度', unit: 'G', scale: 0.01, decimals: 2 }
  return out
}

function buildTempWarnLabels(): Record<string, SettingLabel> {
  const out: Record<string, SettingLabel> = {}
  for (const t of ['T1', 'T2']) {
    const suffix = t === 'T2' ? '[状態2]' : ''
    out[`${t}_ALRM`] = { label: `温度警告アラーム${suffix}`, enums: YES_NO_ENUMS }
    out[`${t}_ALRM_INTERVAL`] = { label: `警告アラーム間隔${suffix}`, unit: '秒' }
    out[`${t}_ALRM_STSEC`] = { label: `温度警告開始時間${suffix}`, unit: '秒' }
    out[`${t}_ALRM_EDDEG`] = { label: `温度警告終了差分温度${suffix}`, unit: '℃' }
    out[`${t}_NOTE_INTERVAL`] = { label: `温度注意アラーム間隔${suffix}`, unit: '秒' }
    out[`${t}_NOTE_STSEC`] = { label: `温度注意開始時間${suffix}`, unit: '秒' }
    out[`${t}_NOTE_EDDEG`] = { label: `温度注意終了差分温度${suffix}`, unit: '℃' }
    for (const ch of ['1', '2', '3', '4']) {
      out[`${t}_ALRM_CH${ch}_MAX`] = { label: `CH${ch}高温警告温度${suffix}`, unit: '℃' }
      out[`${t}_ALRM_CH${ch}_MIN`] = { label: `CH${ch}低温警告温度${suffix}`, unit: '℃' }
      out[`${t}_NOTE_CH${ch}_MAX`] = { label: `CH${ch}高温注意温度${suffix}`, unit: '℃' }
      out[`${t}_NOTE_CH${ch}_MIN`] = { label: `CH${ch}低温注意温度${suffix}`, unit: '℃' }
    }
  }
  return out
}

function buildButtonLabels(): Record<string, SettingLabel> {
  // PDF 90001-90069 の "ボタンN" マッピング (cfg では BUTT_6,7 → ボタンA,B)
  const buttonName: Record<string, string> = {
    '1': 'ボタン1', '2': 'ボタン2', '3': 'ボタン3', '4': 'ボタン4', '5': 'ボタン5',
    '6': 'ボタンA', '7': 'ボタンB',
    '11': 'ボタン11', '12': 'ボタン12', '13': 'ボタン13', '14': 'ボタン14', '15': 'ボタン15',
    '21': 'ボタン21', '22': 'ボタン22', '23': 'ボタン23', '24': 'ボタン24', '25': 'ボタン25',
  }
  const out: Record<string, SettingLabel> = {}
  for (const [n, jp] of Object.entries(buttonName)) {
    out[`BUTT_${n}_TYPE`] = { label: `${jp} タイプ`, enums: BUTTON_TYPE_ENUMS }
    out[`BUTT_${n}_OPT`] = { label: `${jp} オプション` }
    out[`BUTT_${n}_SLEEP`] = { label: `${jp} スリープ`, enums: BUTTON_SLEEP_ENUMS }
    out[`BUTT_${n}_SOUND`] = { label: `${jp} サウンド` }
    out[`BUTT_${n}_NAME`] = { label: `${jp} 名称` }
  }
  return out
}

function buildDvrLabels(): Record<string, SettingLabel> {
  // DVR_INFREC = 連続録画, DVR_EVTREC = イベント録画, DVR_PRKREC = 駐車監視録画
  // cam 0=HDカメラ, 1-4=VGAカメラ1-4
  const out: Record<string, SettingLabel> = {}
  const recPhase: Record<string, string> = {
    INFREC: '連続録画',
    EVTREC: 'イベント録画',
    PRKREC: '駐車監視録画',
  }
  for (const [k, jp] of Object.entries(recPhase)) {
    out[`DVR_${k}_ENABLE`] = { label: `${jp}有無`, enums: { '0': '録画しない', '1': '録画する' } }
    out[`DVR_${k}_BUFFERNUM`] = { label: `${jp}バッファ数` }
    out[`DVR_${k}_DURATION`] = { label: `${jp}ファイル時間`, unit: '秒' }
  }
  const camName: Record<string, string> = {
    '0': 'HDカメラ',
    '1': 'VGAカメラ1',
    '2': 'VGAカメラ2',
    '3': 'VGAカメラ3',
    '4': 'VGAカメラ4',
  }
  const camPhase: Record<string, string> = {
    INFCAM: '連続録画',
    EVTCAM: 'Evt録画',
    PRKCAM: 'Prk録画',
  }
  for (const [phaseKey, phaseJp] of Object.entries(camPhase)) {
    for (const [n, camJp] of Object.entries(camName)) {
      out[`DVR_${phaseKey}${n}_ENABLE`] = { label: `${camJp}${phaseJp}有無`, enums: { '0': '録画しない', '1': '録画する' } }
      out[`DVR_${phaseKey}${n}_FRAMERATE`] = { label: `${camJp}${phaseJp}FPS`, unit: 'fps' }
      out[`DVR_${phaseKey}${n}_QUALITY`] = {
        label: `${camJp}${phaseJp}画質レベル`,
        enums: { '0': '低画質', '1': '中画質', '2': '標準画質', '3': '高画質', '4': '最高画質' },
      }
      out[`DVR_${phaseKey}${n}_BITRATE`] = { label: `${camJp}${phaseJp}BPS`, unit: 'kbps' }
      out[`DVR_${phaseKey}${n}_CONDITION`] = { label: `${camJp}${phaseJp}実行条件`, enums: { '0': '条件なし' } }
      out[`DVR_CAM${n}_ROTATE`] = {
        label: `${camJp}映像回転`,
        enums: { '0': '回転なし', '1': '90°', '2': '180°', '3': '270°' },
      }
      out[`DVR_CAM${n}_FLIP`] = {
        label: `${camJp}映像反転`,
        enums: { '0': '反転なし', '1': '左右反転', '2': '上下反転', '3': '上下左右反転' },
      }
    }
  }
  out['DVR_INFREC_SUSPENDWAIT'] = { label: '連続録画中断判定時間', unit: '秒' }
  out['DVR_INFREC_SUSPENDSPEED'] = { label: '連続録画中断判定速度', unit: 'km/h', scale: 0.1, decimals: 1 }
  out['DVR_INFREC_RESUMEWAIT'] = { label: '連続録画再開判定時間', unit: '秒' }
  out['DVR_INFREC_RESUMESPEED'] = { label: '連続録画再開判定速度', unit: 'km/h', scale: 0.1, decimals: 1 }
  out['DVR_PRKREC_EXECTIME'] = { label: '駐車監視録画動作時間', unit: '分' }
  out['DVR_VIDREC_TRIGGER'] = { label: '映像記録制御トリガ' }
  out['DVR_EMGCY_TRIGGER'] = { label: '手動トリガイベント' }
  out['DVR_CAPTUREWAIT'] = { label: 'イベント録画記録時間', unit: '秒' }
  out['DVR_RECORD_EVENTRATE'] = { label: 'SD保存イベント比率', unit: '%' }
  out['DVR_ALC_CAM'] = { label: 'ALC撮影カメラ選択', enums: { '0': '使用しない' } }
  out['DVR_CAMERR_DELAYSEC'] = { label: 'カメラエラー判定遅延', unit: '秒' }
  out['DVR_CAM_HD_TYPE'] = { label: 'HDカメラタイプ', enums: { '0': 'HD(720P)' } }
  out['DVR_CAM_HD_SCALING'] = { label: 'HDカメラスケーリング' }
  out['DVR_AUDIO_ENABLE'] = { label: '音声記録有無', enums: YES_NO_ENUMS }
  out['DVR_AUDIO_CH'] = { label: '音声記録チャンネル数' }
  out['DVR_AUDIO_SAMPLRATE'] = { label: '音声サンプリングレート', unit: 'Hz' }
  out['DVR_AUDIO_BITRATE'] = { label: '音声ビットレート', unit: 'bps' }
  out['DVR_DISPLAY_ENABLE'] = { label: '映像表示有無', enums: YES_NO_ENUMS }
  out['DVR_DISPLAY_FUNCTION'] = { label: '映像表示機能' }
  out['DVR_DISPCAMNUM'] = { label: '表示カメラ番号' }
  out['DVR_ACTIVELOWEXTIO'] = { label: '外部入力信号有効値' }
  return out
}

function buildMisc(): Record<string, SettingLabel> {
  // PDF 16001-16011 — cfg では MVSND_ 系で再構成
  return {
    MVSND_INTERVAL: { label: '定期データ送信間隔', unit: '分' },
    MVSND_VIDEO_INFO: { label: '映像ファイル情報送信', enums: SEND_ENUMS },
    MVSND_IGOFF: { label: 'IG-OFF間の送信対象', enums: { '3': '両方' } },
    MVSND_ACCEL: { label: '急加減速データ', enums: SEND_ENUMS },
    MVSND_CURVE: { label: '急ハンドルデータ', enums: SEND_ENUMS },
    MVSND_SPEED: { label: '速度オーバーデータ', enums: SEND_ENUMS },
    MVSND_RV: { label: '回転オーバーデータ', enums: SEND_ENUMS },
    MVSND_IDL: { label: 'アイドリングデータ', enums: SEND_ENUMS },
    MVSND_LD: { label: '連続運転データ', enums: SEND_ENUMS },
    MVSND_TMP: { label: '温度警告データ', enums: SEND_ENUMS },
    MVSND_ETC: { label: 'ETCデータ', enums: SEND_ENUMS },
    NAVI_ENABLE: { label: 'ナビ機能有無', enums: YES_NO_ENUMS },
    WLAN_ENABLE: { label: 'WLAN機能有無', enums: YES_NO_ENUMS },
  }
}

// ─────────────────────────────────────────────────────────────────────
// マージ + export
// ─────────────────────────────────────────────────────────────────────

export const VEHICLE_SETTING_LABELS: Record<string, SettingLabel> = {
  ...STATIC_LABELS,
  ...buildSpeedWarnLabels(),
  ...buildRevWarnLabels(),
  ...buildTempWarnLabels(),
  ...buildButtonLabels(),
  ...buildDvrLabels(),
  ...buildMisc(),
}

/**
 * cfg の生値を辞書ベースに整形する。
 *
 * - 辞書に該当キーがあれば: ラベル + (scale適用 + 小数桁) + 単位 + (enum 意味)
 * - 該当なし: ラベルは null、formatted は raw を文字列化しただけ
 */
export function formatSetting(key: string, raw: string | number): FormattedSetting {
  const def = VEHICLE_SETTING_LABELS[key]
  const isNum = typeof raw === 'number'

  let scaledValue: number | null = null
  let valueStr: string
  if (isNum) {
    if (def?.scale != null) {
      const v = raw * def.scale
      const decimals = def.decimals ?? Math.max(0, -Math.floor(Math.log10(def.scale)))
      scaledValue = v
      valueStr = v.toFixed(decimals)
    } else {
      scaledValue = raw
      valueStr = String(raw)
    }
  } else {
    // 文字列値 (引用符はもう剥がされている)
    valueStr = raw === '' ? '""' : `"${raw}"`
  }

  const enumMeaning =
    def?.enums && isNum ? (def.enums[String(raw)] ?? null) : null

  const parts: string[] = [valueStr]
  if (def?.unit) parts.push(def.unit)
  if (enumMeaning) parts.push(`(${enumMeaning})`)

  return {
    key,
    label: def?.label ?? null,
    raw,
    formatted: parts.join(' '),
    enumMeaning,
    unit: def?.unit ?? null,
    scaledValue,
  }
}
