/**
 * 車輌動態 (`dtako_logs`) を rust-alc-api へ取り込むための pure ロジック (Refs #1098)。
 *
 * 旧 pipeline (VPS 上のヘッドレス Chrome が 10 分おきに theearth を scrape → auth-worker の
 * `/device-data-proxy` 経由で `POST /api/dtako-logs/bulk`) を relay の cron へ寄せる移行。
 * VPS 側を止めた結果 `dtako-logs` の画面が更新されなくなったのが直接の動機。
 *
 * ## 依存の向き
 *
 * - theearth 側は `theearth-venus-client.ts` の `getVehicleStatesRaw()` が唯一の実装元。
 *   ここは VenusBridge を自分では叩かない (**theearth クライアントの 4 本目を作らない**)。
 * - 送信は **auth-worker の RPC** (`InternalEntrypoint.forwardAlcTenantData`)。型と
 *   応答の畳み方は `alc-tenant-rpc.ts` が唯一の実装元で、**新しい送信の型を作らない**。
 *
 * ## なぜ RPC 経路か (再検討しないで済むよう理由を残す)
 *
 * rust-alc-api の `/api/dtako-logs/bulk` は `src/routes/mod.rs` で
 * `tenant_protected` (`require_tenant_header`) に nest されている **data 経路**で、
 * `internal_shared_secret_router` には入っていない (2026-09-03 に origin/main を実読)。
 * よって `alc-internal-proxy` の shared-secret class では通らない — あちらの
 * `classifyInternalPath` に `/api/dtako-logs/bulk` の行が無いため。
 * (**「data 経路だから禁止」ではない** — 同じ class に `/api/upload` = これも
 * `require_tenant_header` が現に載っている。見るのは allowlist の行。)
 *
 * 通る口は 2 つあり、**RPC を採った**:
 *
 * - `/device-data-proxy/api/dtako-logs/bulk` — 旧 pipeline (VPS) が使っていた口。
 *   auth-worker 無変更で通るが、**device credential の発行・投入・失効管理が要る**
 * - **`InternalEntrypoint.forwardAlcTenantData`** — service binding からしか呼べない
 *   名前付き RPC で **HTTP の面に出ない**。`FORWARDABLE_PATHS` に 1 行足すだけで通り、
 *   **credential は要らない** (Refs ippoan/auth-worker の同 issue)
 *
 * ★ この repo は **#950 で device credential 経路を捨てて RPC に寄せた** —
 * 「直接呼べる相手に bearer を提示していた」形をやめるため (`alc-tenant-rpc.ts` の doc)。
 * ここで device-data-proxy に戻すと、その判断を 1 か所だけ巻き戻すことになる。
 *
 * 書き先 tenant は **呼び手が渡す値**。この cron は `VEHICLE_STATE_TARGETS` が名指しした
 * `comp_id` を `DTAKO_ACCOUNTS` で引いた `tenant_id` しか渡さず、**theearth の応答も
 * request body も tenant を決める材料にしない** (`/api/employees/bulk-by-code` を
 * allowlist に足したときと同じ根拠)。
 *
 * ## 生レコードをそのまま送る (射影しない)
 *
 * `getVehicleStates()` が返す `VehicleStatePoint` は **12 フィールドの射影**で、
 * 送信には使えない。理由は 2 つとも実測:
 *
 * 1. 受け手 `DtakologInput` は 57 フィールドあり、画面 (`dtako-logs`) が読む列
 *    (`address_disp_p` / `all_state` / `state2` / `sub_driver_cd` / `recive_type_color_name`
 *    ...) が射影に含まれていない。
 * 2. `VehicleStatePoint.latitude` / `.longitude` は **DDMM から十進度に変換済み**だが、
 *    DB `alc_api.dtakologs` の `gps_latitude` / `gps_longitude` は **INTEGER**。
 *    十進度 (35.68…) を入れると `35` に落ちて地図が壊れる。
 *
 * ⇒ **旧 pipeline と同じく生レコードを転送し、`DataDateTime` だけ差し替える**
 * (`ohishi-exp/browser-render-rust` の `send_dtakologs`)。199 件/回で
 * `records_added=199` が返っていた**実績のある形をそのまま踏襲する**のが、
 * 57 フィールドを手で組み直すより安全。
 */
import {
  unwrapAlcTenantData,
  type AlcTenantDataForwarder,
} from "./alc-tenant-rpc";

/**
 * `VehicleStateTableForBranchEx` の事業所コード。**`"00000000"` は「全事業所」**で、
 * 旧 pipeline が使っていた値 (`browser-render-rust` の `DtakologConfig.branch_id`)。
 * `getDvrMasters()` の `branches[].code` を 1 件ずつ回すと、同じ 199 台を
 * 事業所ぶん分割して取ることになり theearth への往復だけが増える。
 */
export const VEHICLE_STATE_ALL_BRANCHES = "00000000";

/** 車輌動態の投入先 (rust-alc-api 側の path)。auth-worker の `FORWARDABLE_PATHS` に
 * この文字列が**完全一致で**載っていること。前方一致では通らない。 */
export const DTAKO_LOGS_BULK_PATH = "/api/dtako-logs/bulk";

/**
 * `DataDateTime` が空 / 非文字列のときに rust 側が入れる既定値。
 *
 * **rust の `bulk_upsert` が `None` に対して入れる値と 1 文字も違わないこと**が要点
 * (`crates/alc-dtako/src/repo/dtako_logs.rs`)。PK は
 * `(tenant_id, data_date_time, vehicle_cd)` なので、ここがずれると同じ車輌の
 * 「GPS 未捕捉」行が 2 つに割れる。
 */
export const DTAKO_LOGS_DATETIME_FALLBACK = "2020-01-01T00:00:00+09:00";

export class VehicleStateIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VehicleStateIngestError";
  }
}

/** theearth の `DataDateTime` ("YY/MM/DD HH:mm"、theearth サーバーローカル = JST)。 */
const VEHICLE_STATE_DATETIME_RE = /^(\d{2})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{1,2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * theearth の `DataDateTime` を rust が受ける RFC3339 (+09:00) に直す。
 *
 * ## ★ 旧 pipeline と**バイト等価**にすること
 *
 * この値は PK の一部 (`(tenant_id, data_date_time, vehicle_cd)`) なので、同じ瞬間に
 * 違う文字列を出すと **upsert が当たらず行が二重になる** — 画面には同じ車輌が
 * 2 行並ぶ。旧 pipeline (`browser-render-rust` の `convert_data_date_time`) の 3 分岐を
 * そのまま写す:
 *
 * | 入力 | 出力 |
 * |---|---|
 * | `""` | `2020-01-01T00:00:00+09:00` |
 * | `"26/09/03 07:20"` | `2026-09-03T07:20:00+09:00` |
 * | 解釈できない値 | `"20" + 入力` (**捨てない**) |
 *
 * 3 つ目が奇妙に見えるが意図的で、あちらの `format!("20{}", date_str)` fallback と
 * 同じ。**1 件を捨てて欠測にするより、壊れた値のまま入れて後から気づける方を選ぶ**
 * (`dvr-ingest.ts` の `toDvrDatetimeRfc3339` が「捨てる」を選んでいるのと逆なのは、
 * あちらが `Option<DateTime<Utc>>` で **body 全体が 422 になる**のに対し、
 * こちらは `TEXT` 列で 1 行に閉じるため)。
 *
 * 妥当性の判定は `Date.UTC` の繰り上げで見る (`26/02/30` は 03/02 へ繰り上がるので
 * 不一致で弾ける)。chrono の `%Y/%m/%d %H:%M` と同じ範囲を落とす。
 */
export function toDtakoLogsDataDateTime(raw: string): string {
  if (raw === "") return DTAKO_LOGS_DATETIME_FALLBACK;
  const m = VEHICLE_STATE_DATETIME_RE.exec(raw);
  if (m === null) return `20${raw}`;
  const [year, month, day, hour, minute] = [
    2000 + Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  ];
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const rolled =
    at.getUTCMonth() !== month - 1 ||
    at.getUTCDate() !== day ||
    at.getUTCHours() !== hour ||
    at.getUTCMinutes() !== minute;
  if (rolled) return `20${raw}`;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00+09:00`;
}

/**
 * `VehicleStateTableForBranchEx` の生レコード配列を bulk の body に整える。
 *
 * **触るのは `DataDateTime` だけ** — 残り 56 フィールドは名前も型も一切変えずに通す
 * (`__type` / `VehicleCD` の JSON 型 / `GPSLatitude` の DDMM スケールを含む)。
 * 旧 pipeline の `send_dtakologs` と同じで、**「実績のある body をそのまま送る」**のが
 * 57 フィールドを手で組み直すより安全。`DataDateTime` が文字列でない (欠損 / null)
 * ときは触らない — rust 側の `Option<String>` が受けて既定値に落とす。
 */
export function toDtakoLogsBulkRecords(
  rows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const raw = row.DataDateTime;
    if (typeof raw !== "string") return { ...row };
    return { ...row, DataDateTime: toDtakoLogsDataDateTime(raw) };
  });
}

/** `POST /api/dtako-logs/bulk` の応答 (`BulkUpsertResponse`) のうち使う分。 */
export interface DtakoLogsBulkOutcome {
  success: boolean;
  /** `null` は「応答に無い = 不明」。**0 に丸めない** (`parseAlcUploadResponse` と同じ)。 */
  recordsAdded: number | null;
  totalRecords: number | null;
}

/** rust の `BulkUpsertResponse` をパースする。読めないフィールドは `null` / `false`。 */
export function parseDtakoLogsBulkResponse(body: string): DtakoLogsBulkOutcome {
  const unknown: DtakoLogsBulkOutcome = { success: false, recordsAdded: null, totalRecords: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unknown;
  }
  if (typeof parsed !== "object" || parsed === null) return unknown;
  const obj = parsed as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    success: obj.success === true,
    recordsAdded: num(obj.records_added),
    totalRecords: num(obj.total_records),
  };
}

/**
 * auth-worker の RPC 越しに `POST /api/dtako-logs/bulk` する。
 *
 * `tenantId` は **呼び手 (DO) が `DTAKO_ACCOUNTS` から引いた値**。theearth の応答から
 * 作らない — 上流はこの header だけを identity にする data 経路なので、取得元の
 * データに tenant を決めさせると、theearth 側の変更で書き先が動く。
 *
 * **空配列を送らない** — theearth が 0 台を返したら「送るものが無い」のではなく
 * **取得に失敗している** (実測は 199 台/回で、0 になる正常系が無い)。rust 側は
 * 空 body に `200` + `records_added: 0` + `"No records provided"` を返してしまうので、
 * ここで落とさないと「毎回成功しているのに画面が更新されない」無音故障になる
 * (#1094 で空バッチを送って踏んだのと同型)。
 *
 * 非 2xx は `unwrapAlcTenantData` が status と本文抜粋つきで throw する。
 * **`403 path_not_forwardable` が返るなら auth-worker の allowlist 未反映** —
 * 本文で「呼び手の path 誤り」と「上流の tenant 拒否」が割れる。
 */
export async function ingestVehicleStates(
  input: { tenantId: string; rows: ReadonlyArray<Record<string, unknown>> },
  rpc: AlcTenantDataForwarder,
): Promise<DtakoLogsBulkOutcome> {
  const records = toDtakoLogsBulkRecords(input.rows);
  if (records.length === 0) {
    throw new VehicleStateIngestError(
      "車輌が 1 台も取れませんでした (空バッチは送りません)",
    );
  }
  const body = unwrapAlcTenantData(
    "alc dtako-logs bulk upsert",
    await rpc.forwardAlcTenantData({
      tenantId: input.tenantId,
      path: DTAKO_LOGS_BULK_PATH,
      method: "POST",
      body: JSON.stringify(records),
      contentType: "application/json",
    }),
  );
  const outcome = parseDtakoLogsBulkResponse(body);
  if (!outcome.success) {
    throw new VehicleStateIngestError(
      `${DTAKO_LOGS_BULK_PATH} が success=true を返しませんでした: ${body.slice(0, 300)}`,
    );
  }
  return outcome;
}
