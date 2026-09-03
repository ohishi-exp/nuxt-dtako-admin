/**
 * DVR (ドラレコ映像) 通知を rust-alc-api へ取り込むための pure ロジック (Refs #1094)。
 *
 * 旧 pipeline (VPS が 10 分おきに theearth を scrape → Cloud Run へ gRPC push →
 * 通知 + GCS 保存) を relay の cron へ寄せる移行の、**「取ってきて渡す」までの半分**。
 * 通知は後続 PR — この module は `lineworks-notify.ts` を import しない。
 *
 * ## 依存の向き
 *
 * - theearth 側の DVR クライアントは `theearth-venus-client.ts` が唯一の実装元。
 *   ここは `DvrNotification` を**読むだけ**で、VenusBridge を自分では叩かない。
 * - rust への送信は `alc-internal-upload.ts` の `sendViaAlcInternalProxy`
 *   (`AUTH_WORKER` service binding → `alc-internal-proxy` の shared-secret class)。
 *   **3 本目の同型を生やさない** — ヘッダ (`X-Alc-Proxy-Secret` + `X-Tenant-ID`) と
 *   非 2xx の loud fail はあちらに閉じている。
 *
 * ## ingest の I/F は rust 側と合わせてある (勝手に変えない)
 *
 * ```
 * POST /api/dvr/notifications  → { inserted, skipped, pending: [{id, serial_no, file_name}] }
 * POST /api/dvr/files/{id}     → { id, file_status, size, r2_key }   (413 = 32MB 超)
 * ```
 *
 * `pending` を rust が持つので relay 側にリトライ表は要らない — **1 回の cron で
 * 取りこぼしても次回に回る**。
 */
import { sendViaAlcInternalProxy, type FetchLike } from "./alc-internal-upload";
import type { DvrNotification } from "./theearth-venus-client";

/** 通知メタデータの batch ingest。auth-worker の allowlist に shared-secret class で載る。 */
export const DVR_NOTIFICATIONS_INGEST_PATH = "/alc-internal-proxy/api/dvr/notifications";

/** `.vdf` 本体の投入先。`id` は notifications ingest が返した `pending[].id`。 */
export function dvrFileIngestPath(id: string): string {
  return `/alc-internal-proxy/api/dvr/files/${encodeURIComponent(id)}`;
}

/**
 * 通知一覧から拾う時間窓 [時間]。
 *
 * theearth の `Monitoring_DvrNotification2` は先頭 100 件しか返さない (sort 引数
 * `",,0,100"`) ので、窓を広げても取れる件数は増えない。実測 15 件/日 に対して
 * **48h = 2 日ぶんの余裕**があれば、cron が丸 1 日止まっても復帰時に拾い直せる。
 */
export const DVR_NOTIFICATION_WINDOW_HOURS = 48;

/**
 * 1 回の cron で扱うファイル数の上限 (ダウンロード転送・車両への転送要求それぞれ)。
 *
 * **根拠** — cron は 10 分おき (1 日 144 回) なので、上限 10 件で 1 日 1440 件を
 * 吐き出せる。実測は 15 件/日・平均 375KB/件 なので**定常の 96 倍**の余力があり、
 * theearth が丸 1 日落ちた後でも 1〜2 回の cron で追いつく。上限に当たった分は
 * rust 側に `pending` として残るので取りこぼさない (次回の cron が続きを引く)。
 *
 * 上限を置く理由は最悪ケースの方 — rust が 32MB で 413 を返す設計なので、
 * 上限が無いと 1 回の cron で理論上 3.2GB を theearth から引くことになる。
 * 10 件なら最悪 320MB・実測平均なら 4MB で、scheduled event の実行時間に収まる。
 */
export const DVR_MAX_FILES_PER_RUN = 10;

/**
 * 「最後に成功してから何時間で無音故障とみなすか」。
 *
 * cron は 10 分おきなので **3 時間 = 18 回連続で失敗**。1〜2 回の失敗は theearth の
 * 一時的な 500 で普通に起きるが、18 回続くなら人が見る必要がある。
 * **この PR では通知を出さない** (通知は後続 PR) — 超えたら `console.error` に
 * 落として Tail Worker / Workers Logs から読めるようにするところまで。
 */
export const DVR_STALE_ALERT_HOURS = 3;

/** theearth の日時 (`2026/07/03 01:56:56` / `2026-07-01T23:00:59`、どちらも実データで
 * 観測済み) を **JST 壁時計として** epoch ms に直す。読めなければ null。
 *
 * 秒は省略されることがある。月日の桁溢れ (`2026/13/45` 等) は `Date.UTC` の繰り上げに
 * 任せる — 上流が壊れた値を出したときに**弾くより通した方が rust 側の重複判定に乗る**
 * (自然キーは serial_no + file_name であって日時ではない)。 */
const THEEARTH_DATETIME_RE = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export function parseTheearthDatetimeJst(raw: string | null): number | null {
  if (!raw) return null;
  const m = THEEARTH_DATETIME_RE.exec(raw.trim());
  if (!m) return null;
  const seconds = m[6] === undefined ? 0 : Number(m[6]);
  const utcish = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    seconds,
  );
  return utcish - 9 * 3_600_000;
}

/**
 * theearth の日時を rust の `Option<DateTime<Utc>>` が読める **RFC3339 (UTC)** に直す。
 * 読めない値・空文字・欠損はすべて `null`。
 *
 * **空文字を送らないのが要点** — rust 側は `Option<DateTime<Utc>>` なので、`""` も
 * theearth の生表記 (`2026/07/03 18:32:26`) も同じく deserialize に失敗し、
 * **その 1 件だけでなく body 全体が 422** になる (本番で実際に出た。Refs #1094)。
 *
 * JST の扱いは `parseTheearthDatetimeJst` を**再利用する**ので、日時の解釈が
 * この module 内で 2 通りに割れない (theearth のサーバーローカル = JST。
 * `theearth-venus-client.ts` の `開始日時` の doc 参照)。
 *
 * 最後に RFC3339 の形へ当て直しているのは、`parseTheearthDatetimeJst` が
 * 月日の桁溢れ (`2026/99/99`) を繰り上げに任せているため — 繰り上がって西暦 5 桁に
 * なると `toISOString()` が拡張表記 (`+010008-…`) を返し、これは RFC3339 ではない。
 * **そこで 1 件を捨てる方が、body 全体を 422 にするより安い。**
 */
export function toDvrDatetimeRfc3339(raw: string | null): string | null {
  const at = parseTheearthDatetimeJst(raw);
  if (at === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{3}Z$/.exec(new Date(at).toISOString());
  return m === null ? null : `${m[1]}Z`;
}

export interface DvrWindowSelection {
  /** 窓に入った通知 (**日時が読めなかったものも含む**)。 */
  recent: DvrNotification[];
  /** 日時が読めなかった件数。**捨てない** — 重複は rust が自然キーで弾くので、
   * 「読めなかったから落とした」で映像を静かに失う方が高くつく。 */
  undated: number;
  /** 窓より古くて落とした件数。 */
  stale: number;
}

/** 通知一覧を直近 `windowHours` 時間に絞る。 */
export function selectRecentDvrNotifications(
  notifications: DvrNotification[],
  now: Date,
  windowHours: number,
): DvrWindowSelection {
  const floor = now.getTime() - windowHours * 3_600_000;
  const recent: DvrNotification[] = [];
  let undated = 0;
  let stale = 0;
  for (const n of notifications) {
    const at = parseTheearthDatetimeJst(n.dvrDatetime);
    if (at === null) {
      undated += 1;
      recent.push(n);
    } else if (at < floor) {
      stale += 1;
    } else {
      recent.push(n);
    }
  }
  return { recent, undated, stale };
}

/** `POST /api/dvr/notifications` の `items[]` 1 件 (rust 側と合わせた snake_case)。 */
export interface DvrIngestItem {
  serial_no: string;
  file_name: string;
  vehicle_cd: string;
  vehicle_name: string;
  driver_name: string;
  event_type: string;
  /**
   * 録画日時を **RFC3339 (UTC)** に直したもの。rust 側は `Option<DateTime<Utc>>` で
   * 受けるので、theearth の生表記 (`2026/07/03 18:32:26` / `2026-07-01T23:00:59`、
   * **どちらもタイムゾーン表記なし**) をそのまま送ると body 全体が 422 になる。
   *
   * ★ **`source_url` と並んで `null` を送る 2 欄のうちの 1 つ。** 読めない値も空文字も
   * 欠損もすべて `null` に畳む (`toDvrDatetimeRfc3339` 参照) — 空文字は RFC3339 として
   * 不正なので、倒した先が生の文字列と同じ 422 になる。
   */
  dvr_datetime: string | null;
  /**
   * 由来 — theearth 通知行の `FilePath`。**fetch できる URL ではない**
   * (`/dvrData/` の実パスは `Request_DvrFileDownload` がその都度作る一時パスで、
   * 通知行から決定論的には組み立てられない。`theearth-venus-client.ts` 参照)。
   * rust 側は nullable・URL 検証なし・重複判定に使わない (provenance だけの欄)。
   *
   * ★ **`dvr_datetime` と並んで `null` を送る 2 欄のうちの 1 つ。** 他の文字列列と
   * 違って空文字に倒さない —
   * 空文字と null が混ざると「theearth が値を持っていなかった」と「欄ごと無かった」を
   * 後から区別できなくなる。**空文字も null に畳む** (theearth は `FilePath: ""` を
   * 実際に返す) ので、**`null` = 由来なし の 1 通りだけ**になる。
   */
  source_url: string | null;
}

export interface DvrIngestItemBuild {
  items: DvrIngestItem[];
  /** `serial_no` / `file_name` が欠けていて送れなかった件数。**0 でないなら黙らせない**
   * — この 2 つは rust 側の自然キーなので、空で送ると重複判定ごと壊れる。 */
  unusable: number;
}

/** 通知行を ingest の `items[]` に直す。欠けている**表示用の**文字列列は空文字に倒す
 * (rust 側が `NOT NULL` を期待している列に `null` を送らない)。
 * **例外は nullable な 2 欄 `source_url` と `dvr_datetime`** — 前者は空文字ごと
 * `null` に畳み、後者は RFC3339 (UTC) に直して読めなければ `null` にする
 * (それぞれの欄の doc 参照)。 */
export function toDvrIngestItems(notifications: DvrNotification[]): DvrIngestItemBuild {
  const items: DvrIngestItem[] = [];
  let unusable = 0;
  for (const n of notifications) {
    const serialNo = n.serialNo ?? "";
    const fileName = n.fileName ?? "";
    if (serialNo === "" || fileName === "") {
      unusable += 1;
      continue;
    }
    items.push({
      serial_no: serialNo,
      file_name: fileName,
      vehicle_cd: n.vehicleCd ?? "",
      vehicle_name: n.vehicleName ?? "",
      driver_name: n.driverName ?? "",
      event_type: n.eventType ?? "",
      // ★ 生の theearth 表記も空文字も rust の `DateTime<Utc>` では 422。
      dvr_datetime: toDvrDatetimeRfc3339(n.dvrDatetime),
      // ★ 空文字も null に畳む (dvr_datetime と並ぶ nullable な 2 列目)。
      source_url: n.filePath === "" ? null : n.filePath,
    });
  }
  return { items, unusable };
}

export class DvrIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DvrIngestError";
  }
}

/** rust がまだ `.vdf` を持っていない行。`id` が `POST /api/dvr/files/{id}` の宛先。 */
export interface DvrPendingFile {
  id: string;
  serial_no: string;
  file_name: string;
}

export interface DvrNotificationsIngestResult {
  /** 応答に無い / 数値でないときは null (「0 件」と「不明」を混ぜない)。 */
  inserted: number | null;
  skipped: number | null;
  pending: DvrPendingFile[];
}

function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * `POST /api/dvr/notifications` の応答をパースする。
 *
 * **`pending` が読めなければ loud fail** (`inserted` / `skipped` と扱いが違う)。
 * あちらは診断用の数字なので `null` に倒せるが、`pending` は**次に何を転送するか**を
 * 決める唯一の入力で、壊れた応答を「空配列 = やることなし」に倒すと
 * **1 件も映像が保存されないまま cron が成功し続ける**。
 */
export function parseDvrNotificationsResponse(body: string): DvrNotificationsIngestResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DvrIngestError(
      `DVR notifications ingest の応答が JSON ではありません: ${body.slice(0, 300)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DvrIngestError(
      `DVR notifications ingest の応答が JSON オブジェクトではありません: ${body.slice(0, 300)}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.pending)) {
    throw new DvrIngestError(
      `DVR notifications ingest の応答に pending 配列がありません: ${body.slice(0, 300)}`,
    );
  }
  const pending: DvrPendingFile[] = [];
  for (const [index, entry] of obj.pending.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new DvrIngestError(
        `DVR notifications ingest の pending[${index}] がオブジェクトではありません`,
      );
    }
    const row = entry as Record<string, unknown>;
    const id = readText(row.id);
    const serialNo = readText(row.serial_no);
    const fileName = readText(row.file_name);
    if (id === null || serialNo === null || fileName === null) {
      throw new DvrIngestError(
        `DVR notifications ingest の pending[${index}] に id / serial_no / file_name が揃っていません`,
      );
    }
    pending.push({ id, serial_no: serialNo, file_name: fileName });
  }
  return { inserted: readCount(obj.inserted), skipped: readCount(obj.skipped), pending };
}

/** `POST /api/dvr/files/{id}` の応答。**診断用なので読めない欄は null に倒す**
 * (`parseAlcUploadResponse` と同じ流儀 — 保存の成否は HTTP status が答えている)。 */
export interface DvrFileIngestResult {
  id: string | null;
  fileStatus: string | null;
  size: number | null;
  r2Key: string | null;
}

export function parseDvrFileResponse(body: string): DvrFileIngestResult {
  const unreadable: DvrFileIngestResult = { id: null, fileStatus: null, size: null, r2Key: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unreadable;
  const obj = parsed as Record<string, unknown>;
  return {
    id: readText(obj.id),
    fileStatus: readText(obj.file_status),
    size: readCount(obj.size),
    r2Key: readText(obj.r2_key),
  };
}

/** 1 回の cron でファイルに対して何をするかの割り振り。 */
export interface DvrFileWorkPlan {
  /** サーバーに映像があるので**今すぐ落として rust へ流す**もの (上限まで)。 */
  ready: DvrPendingFile[];
  /** まだ車両にしか無いので**転送要求を出す**もの (上限まで)。要求は非同期で、
   * 次回以降の cron で `ready` に変わる。 */
  toRequest: DvrPendingFile[];
  /** この回は触らないもの — 転送要求中 / 受信エラー / 通知一覧に見つからない /
   * 上限を超えた分。**次回の cron が引き継ぐ** (`pending` は rust が持っている)。 */
  waiting: DvrPendingFile[];
}

/** 通知行と `pending` 行を突き合わせるキー。` ` 区切りは、区切り文字が
 * serial_no / file_name のどちらにも現れないことを保証するため。 */
function pendingKey(serialNo: string, fileName: string): string {
  return `${serialNo} ${fileName}`;
}

/**
 * rust が返した `pending` と theearth の通知一覧を突き合わせ、この回の仕事を決める。
 *
 * 受信状態 (`receiveState`) は theearth 側の 3 段フロー (車両 → サーバー受信 →
 * 再生可能) を表す。**`requestDvrDownloadPath` は未受信だと例外を投げる**ので、
 * 状態を見ずに全件ダウンロードしにいくと「まだ車両にある」だけの正常な行が
 * 毎回エラーとして積み上がる。
 */
export function planDvrFileWork(
  pending: DvrPendingFile[],
  notifications: DvrNotification[],
  limit: number,
): DvrFileWorkPlan {
  const states = new Map<string, DvrNotification["receiveState"]>();
  for (const n of notifications) {
    states.set(pendingKey(n.serialNo ?? "", n.fileName ?? ""), n.receiveState);
  }
  const plan: DvrFileWorkPlan = { ready: [], toRequest: [], waiting: [] };
  for (const row of pending) {
    const state = states.get(pendingKey(row.serial_no, row.file_name));
    if (state === "ready" && plan.ready.length < limit) {
      plan.ready.push(row);
    } else if (state === "requestable" && plan.toRequest.length < limit) {
      plan.toRequest.push(row);
    } else {
      plan.waiting.push(row);
    }
  }
  return plan;
}

export interface DvrNotificationsIngestInput {
  /** `INTERNAL_SHARED_SECRET` (consumer worker proof)。 */
  sharedSecret: string;
  /** `DTAKO_ACCOUNTS` の `tenant_id` (comp_id から引いたもの)。 */
  tenantId: string;
  items: DvrIngestItem[];
}

/** 通知メタデータを batch で渡し、まだ `.vdf` が無い行 (`pending`) を受け取る。 */
export async function postDvrNotifications(
  input: DvrNotificationsIngestInput,
  fetchImpl: FetchLike,
): Promise<DvrNotificationsIngestResult> {
  const text = await sendViaAlcInternalProxy(
    {
      path: DVR_NOTIFICATIONS_INGEST_PATH,
      sharedSecret: input.sharedSecret,
      tenantId: input.tenantId,
      contentType: "application/json",
      body: JSON.stringify({ items: input.items }),
    },
    fetchImpl,
  );
  return parseDvrNotificationsResponse(text);
}

export interface DvrFileIngestInput {
  sharedSecret: string;
  tenantId: string;
  /** `pending[].id`。 */
  id: string;
  /**
   * `.vdf` の生バイト。**`openDvrFileStream` の戻り値をそのまま渡す** — DO 側で
   * `arrayBuffer()` に読み切らないので、**relay の DO はファイル全体を持たない**。
   *
   * ★ **「end-to-end でストリームのまま流れる」わけではない。** 経路の途中の
   * auth-worker (`alc-internal-proxy`) が forward の前に `await request.arrayBuffer()`
   * で body を全部メモリに載せる (2026-09-03 に `ippoan/auth-worker` の origin/main を
   * 実読して確認)。**proxy hop で 1 度バッファされる**ので、
   * - **1 リクエスト = 1 ファイル**にする (複数を 1 body にまとめない)
   * - 呼び出し側は**逐次**で回す (並列にすると同時に持つバッファが件数ぶんになる)
   * 実データは平均 375KB・上限 32MB (Cloud Run の body 上限) で、Worker のメモリ上限
   * 128MB に対して 1 件ずつなら収まる。
   */
  body: ReadableStream<Uint8Array>;
}

/** `.vdf` を 1 ファイル 1 リクエストで rust へ送る。非 2xx は `sendViaAlcInternalProxy`
 * が本文付きで throw する (413 = 32MB 超 / 404 = id が無いか tenant 不一致)。 */
export async function putDvrFile(
  input: DvrFileIngestInput,
  fetchImpl: FetchLike,
): Promise<DvrFileIngestResult> {
  const text = await sendViaAlcInternalProxy(
    {
      path: dvrFileIngestPath(input.id),
      sharedSecret: input.sharedSecret,
      tenantId: input.tenantId,
      contentType: "application/octet-stream",
      body: input.body,
    },
    fetchImpl,
  );
  return parseDvrFileResponse(text);
}

export interface DvrStaleness {
  /** 最後の成功からの経過時間。**1 度も成功していなければ null** — 初回デプロイ直後は
   * これが正常。null が続くこと自体が「1 度も通っていない」の合図になる。 */
  hoursSinceLastSuccess: number | null;
  /** 閾値を超えたか。`hoursSinceLastSuccess` が null のときは false。 */
  stale: boolean;
}

/** 最終成功時刻から無音故障を判定する (**通知は出さない** — 呼び出し側が
 * `console.error` に落とすところまでがこの PR の範囲、Refs #1094 の設計注意 8)。 */
export function judgeDvrStaleness(
  lastSuccessAt: string | null,
  now: Date,
  thresholdHours: number,
): DvrStaleness {
  if (!lastSuccessAt) return { hoursSinceLastSuccess: null, stale: false };
  const at = Date.parse(lastSuccessAt);
  if (Number.isNaN(at)) return { hoursSinceLastSuccess: null, stale: false };
  const hours = (now.getTime() - at) / 3_600_000;
  return { hoursSinceLastSuccess: hours, stale: hours >= thresholdHours };
}
