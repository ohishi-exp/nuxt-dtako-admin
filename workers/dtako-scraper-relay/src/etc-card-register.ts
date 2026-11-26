/**
 * ETC コーポレートカードの「カード追加登録」(etc-meisai.jp) を無人で行うための
 * pure ロジック (Refs ohishi-exp/nuxt-dtako-admin#1287)。
 *
 * 2 段に分ける (I/O は `etc-card-register-run.ts`・`etc-meisai-client.ts` の `registerEtcCard`):
 *
 * 1. **確認 = dtako の zip 登録時** (`DTAKO_CRON`)。alc へ上げた csvdata.zip の `KUDGSIR.csv`
 *    (料金所) を読み、`waiting_run` の行のナンバー下 4 桁 (`plate4`) に一致する車両
 *    (`車輌CD % 10000`) の ETC 走行の **終了日時の日付**のうち、範囲 (61 日前〜今日、かつ今年、
 *    かつカード行の登録日 (空なら明細書の受信日) 以降) で最も新しい日を `run_date` に書く
 * 2. **登録 = ETC cron の 21 時 (UTC) の tick**。`run_date` のある行について、もう一度範囲を
 *    確かめてから etc-meisai.jp の「カードの追加登録」へ カード番号・走行日・車載器管理番号・
 *    ナンバー下 4 桁を入れて確認画面まで進める (`live` のときだけ完了まで)
 *
 * **限界**: カードの明細書が届く前にその車両の走行が zip 登録済みだった場合、次に走って
 * zip が登録されるまで `run_date` は入らない (運行は日々あるので許容)。
 *
 * ## なぜ終了日時の日付か
 *
 * etc-meisai.jp は「その日にそのカードで ETC 無線走行した記録」と照合する。日跨ぎの
 * 走行は**出口 (終了) の日**で記録されるので、開始日で入れると弾かれる (ユーザー指示)。
 *
 * ## なぜ今年だけか
 *
 * 登録画面の「利用年」select の選択肢が空と今年しか無い (2026-11-26 実測)。
 * 年初の 61 日間は前年の走行が条件を満たしても入れられないので、範囲を今年で切る。
 *
 * ## 数字は架空値で書く
 *
 * この repo は public。テストの fixture にも実在のカード番号・車載器番号を載せない。
 */

/** 登録の進め方。**`live` 以外はすべて dry-run** (確認画面で止める)。 */
export type CardRegisterMode = "dry_run" | "live";

/** `ETC_CARD_REGISTER_MODE` の解釈。`off` = 登録段も確認段 (zip の走行日) も回さない。 */
export type CardRegisterSetting = CardRegisterMode | "off";

/**
 * `ETC_CARD_REGISTER_MODE` を読む。`"live"` と完全一致のときだけ完了まで進め、`"off"` と完全一致の
 * ときは機能ごと止める。それ以外 (未設定を含む) は dry-run。
 *
 * `off` は staging / preview 用 (wrangler.toml の `[env.*.vars]` が宣言する)。どちらも D1 と
 * ETC_ACCOUNTS (KV) を本番と共有し ETC_CRON・DTAKO_CRON も持つので、止めないと本番の行に
 * run_date を書き、同じカードの登録を本番と並んで回す。本番 (top-level) は宣言しない。
 */
export function resolveCardRegisterMode(raw: string | undefined): CardRegisterSetting {
  if (raw === "off") return "off";
  return raw === "live" ? "live" : "dry_run";
}

/** `off` のときに手動口が返す文言 (503)。 */
export const CARD_REGISTER_OFF_MESSAGE = "この環境では ETC カード追加登録を止めています (ETC_CARD_REGISTER_MODE=off)";

/** ETC の cron (`ETC_CRON` = 21,22,23,0 時 UTC) のうち、登録を走らせる tick か。
 * **21 時 (UTC) = JST 6 時の 1 回だけ**。cron 式は増やさない (wrangler.toml と
 * `cron.ts` の一致を壊さないため)。 */
export function isCardRegisterTick(now: Date): boolean {
  return now.getUTCHours() === 21;
}

// ---------------------------------------------------------------------------
// 日付 (JST)
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
const JST_OFFSET_MS = 9 * 3600 * 1000;

/** JST の日付 `YYYY-MM-DD`。 */
export function jstDate(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** etc-meisai.jp の条件「過去 62 日以内」に合わせ、今日を含めて 62 日 (= 61 日前まで)。 */
export const RUN_LOOKBACK_DAYS = 61;

export interface RunSearchWindow {
  /** `YYYY-MM-DD` (含む)。 */
  from: string;
  /** `YYYY-MM-DD` (含む) = 今日 (JST)。 */
  to: string;
}

/**
 * カード行の**実効の登録日** (`YYYY-MM-DD`、JST)。画面で入れた `registration_date` があればそれ、
 * 無ければ明細書を受けた時刻 (`etc_card_scans.received_at`、UTC の ISO8601) の JST の日付。
 *
 * **この日より前の走行は、そのカードの利用日にしない** — カードを受け取る前の走行は
 * 古いカードで走った分なので、新しいカードの利用日として登録すると etc-meisai.jp の照合が
 * 別のカードの記録に当たる (発行明細書に発行日は書かれていないので、受けた日で代える)。
 *
 * front (`app/utils/etc-cards.ts` の `effectiveRegistrationDate`) にも同じ関数がある
 * (front は relay を import できない)。入出力は両方のテストで同じ値に固定している。
 */
export function effectiveRegistrationDate(registrationDate: string | null, receivedAt: string): string {
  return registrationDate ?? jstDate(new Date(receivedAt));
}

/**
 * 走行日を探す範囲。`今日 - 61 日`・`今年の 1/1`・**`registrationDate` (実効の登録日)** の
 * いちばん遅い日〜今日 (JST)。登録日が今日より後なら `from > to` (= 何も拾わない)。
 */
export function runSearchWindow(now: Date, registrationDate: string): RunSearchWindow {
  const to = jstDate(now);
  const lookback = jstDate(new Date(now.getTime() - RUN_LOOKBACK_DAYS * DAY_MS));
  const yearStart = `${to.slice(0, 4)}-01-01`;
  const from = [lookback, yearStart, registrationDate].reduce((a, b) => (b > a ? b : a));
  return { from, to };
}

/** `YYYYMMDDHHMMSS` (JST)。R2 key の時刻部分。 */
export function jstStamp(now: Date): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 19).replace(/[-T:]/g, "");
}

// ---------------------------------------------------------------------------
// 車両の突き合わせ
// ---------------------------------------------------------------------------

/** 車輌CD → ナンバー下 4 桁 (`車輌CD % 10000`、先頭 0 なし)。数字でなければ null。
 * nginx の `car_id` の慣例と同じ。 */
export function plate4OfVehicleCd(vehicleCd: string | null | undefined): string | null {
  const s = (vehicleCd ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  return String(Number(s) % 10000);
}

export class CardRegisterDataError extends Error {}

// ---------------------------------------------------------------------------
// 料金所 CSV (KUDGSIR) から走行日を拾う
// ---------------------------------------------------------------------------

/** `ETC利用` 列が ETC 走行を示す値。nginx の取り込み (`DtakoEtcTable`) と集計
 * (`where(['etc' => 1])`) がこの値で ETC 料金を数えている。 */
export const ETC_USED_VALUE = "1";

/** CSV のバイト列を文字列にする。UTF-8 として正しく読めればそれ、読めなければ Shift_JIS
 * (theearth の CSV は Shift_JIS。nginx も SJIS-win から変換している)。 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/** 1 行を `,` で切る。`"` で囲まれた値の中の `,` と `""` を扱う。 */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** `2026/11/20 14:23:00` / `2026-11-20T14:23` 等の先頭の日付を `YYYY-MM-DD` に。読めなければ null。 */
export function dateOfDateTime(value: string): string | null {
  const m = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** 料金所 CSV の 1 行のうち、ここで使う列だけ。 */
export interface TollRow {
  unkoNo: string;
  vehicleCd: string;
  /** `終了日時` の日付 (`YYYY-MM-DD`)。読めなければ null。 */
  endDate: string | null;
  etc: string;
}

/** `KUDGSIR.csv` の本文を読む。必要な列 (運行NO / 車輌CD / 終了日時 / ETC利用) が無ければ loud fail。 */
export function parseTollCsv(text: string): TollRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const headers = splitCsvLine(lines[0] ?? "");
  const idx = (name: string) => {
    const i = headers.indexOf(name);
    if (i < 0) throw new CardRegisterDataError(`料金所 CSV (KUDGSIR) に ${name} の列がありません`);
    return i;
  };
  const unko = idx("運行NO");
  const vehicle = idx("車輌CD");
  const end = idx("終了日時");
  const etc = idx("ETC利用");
  return lines.slice(1).map((line) => {
    const c = splitCsvLine(line);
    return {
      unkoNo: c[unko] ?? "",
      vehicleCd: c[vehicle] ?? "",
      endDate: dateOfDateTime(c[end] ?? ""),
      etc: c[etc] ?? "",
    };
  });
}

/** `ETC利用` が "1" でない行の数 (ログに出す。数えない行)。 */
export function countNonEtcRows(rows: readonly TollRow[]): number {
  return rows.filter((r) => r.etc !== ETC_USED_VALUE).length;
}

export type PlateRun =
  | { kind: "none" }
  | { kind: "multiple"; vehicleCds: string[] }
  | { kind: "found"; runDate: string; unkoNo: string };

/**
 * `plate4` の車両がこの料金所 CSV で ETC 走行した日のうち、範囲内で最も新しい日 (終了日時の日付)。
 * plate4 に一致する車輌CD が 2 種類以上あれば `multiple` (どの車両のカードか決められない)。
 * 同じ日の走行が複数あれば、運行NO の大きい方 (= 開始が遅い方) を採る。
 */
export function findRunForPlate(rows: readonly TollRow[], plate4: string, window: RunSearchWindow): PlateRun {
  const mine = rows.filter((r) => plate4OfVehicleCd(r.vehicleCd) === plate4);
  const cds = [...new Set(mine.map((r) => r.vehicleCd.trim()))].sort();
  if (cds.length > 1) return { kind: "multiple", vehicleCds: cds };
  let best: { runDate: string; unkoNo: string } | null = null;
  for (const r of mine) {
    if (r.etc !== ETC_USED_VALUE || r.endDate === null) continue;
    if (r.endDate < window.from || r.endDate > window.to) continue;
    if (best === null || r.endDate > best.runDate || (r.endDate === best.runDate && r.unkoNo > best.unkoNo)) {
      best = { runDate: r.endDate, unkoNo: r.unkoNo };
    }
  }
  return best ? { kind: "found", ...best } : { kind: "none" };
}

/** 登録の直前の再確認: 走行日がまだ {@link runSearchWindow} (61 日前・今年・登録日〜今日) に入っているか。
 * 確認段と同じ窓を使う (確認の後に登録日を後ろへ直された行も、ここで外れる)。 */
export function isRunDateUsable(runDate: string | null, now: Date, registrationDate: string): boolean {
  if (!runDate || !/^\d{4}-\d{2}-\d{2}$/.test(runDate)) return false;
  const w = runSearchWindow(now, registrationDate);
  return runDate >= w.from && runDate <= w.to;
}

// ---------------------------------------------------------------------------
// 登録フォームの値
// ---------------------------------------------------------------------------

/** 登録画面 (funccode 1034000000) の入力欄。**これ以外の名前は送らない**
 * (同じ form に削除用の checkbox とボタンが同居しているため。`registerEtcCard` の doc)。 */
export interface CardRegisterFields {
  icCardID: string;
  icCardIDConfirm: string;
  riyonengappiYear: string;
  riyonengappimonth: string;
  riyonengappiDay: string;
  syasaikiNoL: string;
  syasaikiNoC: string;
  syasaikiNoR: string;
  sharyoNo: string;
}

export interface CardRegisterInput {
  cardNumber: string | null;
  obuNumber: string | null;
  plate4: string | null;
  /** `YYYY-MM-DD`。 */
  runDate: string;
}

/**
 * フォームの値を組む。桁や年が条件に合わなければ `ok: false` (理由つき) で返し、
 * **etc-meisai.jp へは送らない** (サイト側の入力エラーを待たずに弾く)。
 */
export function buildCardRegisterFields(
  input: CardRegisterInput,
  now: Date,
): { ok: true; fields: CardRegisterFields } | { ok: false; reason: string } {
  const card = input.cardNumber ?? "";
  const obu = input.obuNumber ?? "";
  const plate = input.plate4 ?? "";
  if (!/^\d{16}$/.test(card)) return { ok: false, reason: "カード番号が数字 16 桁ではありません" };
  if (!/^\d{19}$/.test(obu)) return { ok: false, reason: "車載器管理番号が数字 19 桁ではありません" };
  if (!/^[1-9]\d{0,3}$/.test(plate)) {
    return { ok: false, reason: "ナンバー下 4 桁が 1〜4 桁の数字 (先頭 0 なし) ではありません" };
  }
  const m = input.runDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, reason: "走行日が YYYY-MM-DD ではありません" };
  if (m[1] !== jstDate(now).slice(0, 4)) {
    return { ok: false, reason: "走行日が今年ではありません (利用年は今年しか選べません)" };
  }
  return {
    ok: true,
    fields: {
      icCardID: card,
      icCardIDConfirm: card,
      riyonengappiYear: m[1],
      riyonengappimonth: m[2],
      riyonengappiDay: m[3],
      syasaikiNoL: obu.slice(0, 5),
      syasaikiNoC: obu.slice(5, 13),
      syasaikiNoR: obu.slice(13),
      sharyoNo: plate,
    },
  };
}

// ---------------------------------------------------------------------------
// 画面の判定
// ---------------------------------------------------------------------------

/** 登録画面 (入力) の funccode。 */
export const ETC_FUNC_CARD_REGISTER = "1034000000";
/** 確認画面 (step 2) の nextfunc。 */
export const ETC_FUNC_CARD_CONFIRM = "1034100000";
/** 完了画面 (step 3) の nextfunc。確認画面の「次へ」の遷移先 (2026-11-26 dry-run で実物を確認)。 */
export const ETC_FUNC_CARD_COMPLETE = "1034110000";

/** 入力画面に戻されたか (= 入力エラー)。確認欄 `icCardIDConfirm` の入力欄 (hidden でない) が
 * まだ在れば入力画面とみなす。確認画面の実物は 2026-11-26 dry-run で確認 (確認欄の入力欄は無い)。 */
export function isCardInputPage(html: string): boolean {
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bname=["']icCardIDConfirm["']/i.test(tag)) continue;
    if (!/\btype=["']?hidden\b/i.test(tag)) return true;
  }
  return false;
}

/** 完了画面の印。**仮置き** — 完了画面の実物はまだ誰も見ていない。最初の live の原本を見て親が確定する。
 * 完了画面の原本は `cardRegisterDoneKey` (`-done.html`) に残る (2026-11-26 以降)。 */
export const CARD_REGISTER_DONE_MARKERS = ["登録が完了", "追加登録しました", "登録しました"] as const;

/** 完了画面か。印を含み、かつ入力画面でないこと。 */
export function isCardRegisterDonePage(html: string): boolean {
  return !isCardInputPage(html) && CARD_REGISTER_DONE_MARKERS.some((m) => html.includes(m));
}

/** 画面のエラー文らしき部分 (class に error を含む要素の文字) を短く拾う。無ければ空。 */
export function extractPageError(html: string): string {
  const m = html.match(/<(\w+)[^>]*class=["'][^"']*error[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i);
  return m ? m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

// ---------------------------------------------------------------------------
// R2 key / 表示
// ---------------------------------------------------------------------------

/** dry-run の確認画面の保存先。 */
export function cardRegisterConfirmKey(prefix: string, id: number, now: Date): string {
  return `${prefix}-card-register/${id}/${jstStamp(now)}-confirm.html`;
}

/** live で完了と判定した画面の保存先 (確認画面と同じディレクトリ、接尾辞だけ違う)。 */
export function cardRegisterDoneKey(prefix: string, id: number, now: Date): string {
  return `${prefix}-card-register/${id}/${jstStamp(now)}-done.html`;
}

/** 判定できなかった画面の原本の保存先 (既存の `{prefix}-errors/` の下)。 */
export function cardRegisterErrorKey(prefix: string, id: number, now: Date): string {
  return `${prefix}-errors/card-register/${id}/${jstStamp(now)}.html`;
}

/** カード番号は末尾 5 桁まで (メール・ログ・画面に全桁を出さない)。 */
export function maskCardNumber(card: string | null): string {
  const s = card ?? "";
  return s.length >= 5 ? `*${s.slice(-5)}` : "(不明)";
}

/** ETC アカウントの user_id は末尾 4 文字まで (診断ログに全桁を出さない)。 */
export function maskUserId(id: string): string {
  return id.length >= 4 ? `*${id.slice(-4)}` : "(不明)";
}

// ---------------------------------------------------------------------------
// 1 件の結末とメール
// ---------------------------------------------------------------------------

export type CardRegisterResultKind =
  /** 走行日が範囲から外れていたので run_date を消して待ちに戻した。 */
  | "expired"
  /** 確認画面まで進めて止めた。 */
  | "dry_run_ok"
  /** 完了画面まで進んだ。 */
  | "registered"
  /** 登録しない / できなかった (status を failed に)。 */
  | "failed"
  /** 通信が途中で落ちた (status は変えず last_error だけ)。 */
  | "error";

export interface CardRegisterResult {
  id: number;
  cardNumber: string | null;
  kind: CardRegisterResultKind;
  runDate?: string;
  detail?: string;
}

/** メールの件名と本文。**結末が 0 件なら null** (登録する行が無い日は送らない)。 */
export function buildCardRegisterEmail(
  results: readonly CardRegisterResult[],
  mode: CardRegisterMode,
  now: Date,
): { subject: string; body: string } | null {
  const shown = results;
  if (shown.length === 0) return null;
  const count = (k: CardRegisterResultKind) => shown.filter((r) => r.kind === k).length;
  const label: Record<CardRegisterResultKind, string> = {
    expired: "走行日が古くなったので待ちに戻した",
    dry_run_ok: "確認画面まで (dry-run)",
    registered: "登録済み",
    failed: "失敗",
    error: "通信で失敗",
  };
  const lines = shown.map((r) => {
    const run = r.runDate ? ` 走行日 ${r.runDate}` : "";
    const detail = r.detail ? ` — ${r.detail}` : "";
    return `id ${r.id} カード ${maskCardNumber(r.cardNumber)}: ${label[r.kind]}${run}${detail}`;
  });
  return {
    subject:
      `[dtako] ETC カード登録 ${mode === "live" ? "" : "(dry-run) "}${jstDate(now)} ` +
      `登録 ${count("registered")} / dry-run ${count("dry_run_ok")} / 失敗 ${count("failed") + count("error")}`,
    body: [`【ETC カード追加登録】${mode === "live" ? "本登録" : "dry-run (確認画面で停止)"}`, ...lines].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// 確認 (zip 登録時) のメール
// ---------------------------------------------------------------------------

export interface RunConfirmResult {
  id: number;
  cardNumber: string | null;
  /** found = run_date を書いた / kept = 既にもっと新しい run_date がある / none = 走行なし /
   * multiple = 車両が複数一致で failed にした */
  kind: "found" | "kept" | "none" | "multiple";
  runDate?: string;
  detail?: string;
}

/** 確認段の結果を `kind` ごとに数える (メールと進捗記録の `etc_confirm_counts`)。0 件の種類も 0 と書く。 */
export function countRunConfirmKinds(
  results: readonly RunConfirmResult[],
): Record<RunConfirmResult["kind"], number> {
  const counts = { found: 0, kept: 0, none: 0, multiple: 0 };
  for (const r of results) counts[r.kind] += 1;
  return counts;
}

/** 確認段が動いた回の結果 (止めている環境で飛ばした回は含まない)。 */
export type RunConfirmOutcome =
  | { state: "confirmed"; results: readonly RunConfirmResult[]; nonEtcRows: number }
  | { state: "failed"; error: string }
  | { state: "no_kudgsir" };

/**
 * 確認段 (dtako の zip 登録時) のメール。**確認段が動いた回は毎回送る** — 成功も、確かめる行が
 * 無い日も、料金所 CSV が無い日も (Refs #1287)。失敗だけを送っていたときは、届かない日が
 * 「通った」のか「動いていない」のか分からなかった。件名で要対応 (車両が複数一致・処理の失敗)
 * かどうかを分ける。
 */
export function buildRunConfirmEmail(
  outcome: RunConfirmOutcome,
  readingDate: string,
): { subject: string; body: string } {
  const head = `【ETC カード追加登録】読取日 ${readingDate} の zip 登録時の走行日の確認`;
  if (outcome.state === "failed") {
    return {
      subject: `[dtako] ETC カードの走行日の確認で要対応 (読取日 ${readingDate})`,
      body: [head, `走行日の確認が失敗: ${outcome.error}`].join("\n"),
    };
  }
  if (outcome.state === "no_kudgsir") {
    return {
      subject: `[dtako] ETC カードの走行日の確認 料金所 CSV なし (読取日 ${readingDate})`,
      body: [head, "zip に料金所 CSV (KUDGSIR.csv) が無いので、確かめる走行がありませんでした。"].join("\n"),
    };
  }
  const { results, nonEtcRows } = outcome;
  const c = countRunConfirmKinds(results);
  const lines = [
    head,
    `走行待ちのカード ${results.length} 件: 走行日を書いた ${c.found} / 既に新しい走行日 ${c.kept} / ` +
      `走行なし ${c.none} / 車両が複数一致 ${c.multiple}`,
    `ETC利用でない料金所の行 ${nonEtcRows} 件は数えていません。`,
    ...results.map((r) => {
      const card = `id ${r.id} カード ${maskCardNumber(r.cardNumber)}`;
      if (r.kind === "found") return `${card}: 走行日 ${r.runDate}`;
      if (r.kind === "multiple") return `${card}: 失敗 — ${r.detail}`;
      return null;
    }),
  ].filter((l): l is string => l !== null);
  return {
    subject:
      c.multiple > 0
        ? `[dtako] ETC カードの走行日の確認で要対応 (読取日 ${readingDate})`
        : `[dtako] ETC カードの走行日の確認 完了 (読取日 ${readingDate})`,
    body: lines.join("\n"),
  };
}

// ---------------------------------------------------------------------------
// 登録を担当するアカウント
// ---------------------------------------------------------------------------

/** ETC アカウントの種別 (`etc-meisai-client.ts` の `EtcAccountType` と同じ値)。 */
export type CardRegisterAccountType = "personal" | "corporate";

/** 各 `etc-{user_id}` DO が、CSV 取得のログインで分かった種別を自分の storage に置くキー。 */
export const ETC_ACCOUNT_TYPE_STORAGE_KEY = "etc_account_type";

/** 同じログインで分かったログイン後ページの pathname (クエリは捨てる) を置くキー。種別判定
 * (`detectAccountType`) が実物で外れていないかを見るための記録 (Refs #1287)。 */
export const ETC_LOGIN_PATH_STORAGE_KEY = "etc_login_path";

/** 同じログインで集めたメニューの機能コード一覧 (`collectMenuFuncCodes`) を置くキー。 */
export const ETC_MENU_FUNCCODES_STORAGE_KEY = "etc_menu_funccodes";

/** 最後の CSV 取得 (`performEtcScrape`) の時刻と成否を置くキー。エラー本文は置かない。 */
export const ETC_LAST_SCRAPE_STORAGE_KEY = "etc_last_scrape";

/** `etc_last_scrape` の中身。`status` は `performEtcScrape` の outcome の status。 */
export interface EtcLastScrape {
  at: string;
  status: "success" | "skipped" | "error";
}

/** 各 `etc-{user_id}` DO の `GET /internal/etc-account-type` の応答 (記録が無い欄は `null`)。 */
export interface EtcAccountRecord {
  account_type: CardRegisterAccountType | null;
  login_path: string | null;
  menu_funccodes: string[] | null;
  last_scrape: EtcLastScrape | null;
}

/** storage / 応答の値を `EtcAccountRecord` に絞る (形の合わない欄は `null`)。DO が応答を作るときと
 * 読む側が受けるときの両方で使う。 */
export function parseEtcAccountRecord(raw: unknown): EtcAccountRecord {
  const r = (raw ?? {}) as Record<string, unknown>;
  const codes = r.menu_funccodes;
  const last = r.last_scrape as Partial<EtcLastScrape> | null | undefined;
  return {
    account_type: parseAccountType(r.account_type),
    login_path: typeof r.login_path === "string" ? r.login_path : null,
    menu_funccodes:
      Array.isArray(codes) && codes.every((c) => typeof c === "string") ? (codes as string[]) : null,
    last_scrape:
      last &&
      typeof last.at === "string" &&
      (last.status === "success" || last.status === "skipped" || last.status === "error")
        ? { at: last.at, status: last.status }
        : null,
  };
}

/** `readEtcAccountStates` の 1 行 (user_id は末尾 4 文字だけ)。 */
export interface EtcAccountState extends EtcAccountRecord {
  idx: number;
  user_tail: string;
  /** 読み取りに失敗した (`account_type` 等は `null`) */
  error?: true;
}

/**
 * `ETC_ACCOUNTS` の並び順で、各アカウントの DO が記録した種別・ログイン後パス・機能コード・最後の取得を
 * 読む (画面の表・MCP・担当判定の診断ログが同じ値を見る。Refs #1287)。読み失敗の行は
 * `account_type: null` + `error: true` (担当判定では未記録と同じ扱いになる)。
 */
export async function readEtcAccountStates(
  userIds: readonly string[],
  read: (userId: string) => Promise<EtcAccountRecord>,
): Promise<EtcAccountState[]> {
  const states: EtcAccountState[] = [];
  for (const [idx, userId] of userIds.entries()) {
    const base = { idx, user_tail: maskUserId(userId) };
    try {
      states.push({ ...base, ...(await read(userId)) });
    } catch {
      states.push({ ...base, ...parseEtcAccountRecord(null), error: true });
    }
  }
  return states;
}

/** `readEtcAccountStates` の読み値から担当を決める (DO への読みを打ち直さない)。 */
export function pickFromStates(
  userIds: readonly string[],
  states: readonly EtcAccountState[],
): Promise<CardRegisterAccountPick> {
  return pickCardRegisterAccount([...userIds], async (userId) => states[userIds.indexOf(userId)].account_type);
}

/** 種別を読む DO 内部 route (GET。storage を読むだけで、キューにもログインにも触れない)。 */
export const ETC_ACCOUNT_TYPE_PATH = "/internal/etc-account-type";

/** 手動口が担当を決められないときの文言 (503)。 */
export const CARD_REGISTER_UNCONFIRMED_MESSAGE = "法人アカウントが未確認 (次の ETC cron で確認される)";

/** 手動口で、記録済みの全アカウントが個人だったときの文言 (503。`unconfirmed` と分ける)。 */
export const CARD_REGISTER_NO_CORPORATE_MESSAGE =
  "法人アカウントが見つかりません (ETC_ACCOUNTS の全アカウントが個人と判定)";

export type CardRegisterAccountPick =
  /** この user_id が担当 */
  | { kind: "found"; userId: string }
  /** この user_id の種別がまだ記録されておらず、それより後ろは決められない */
  | { kind: "unconfirmed"; userId: string }
  /** 全アカウントが個人 */
  | { kind: "none" };

/**
 * カード追加登録を担当するアカウントを決める (Refs #1287)。**`ETC_ACCOUNTS` の並び順で最初の法人**。
 *
 * 登録に使うアカウントは、ETC cron が毎日ログインしている `ETC_ACCOUNTS` の中にある
 * (手で入れる var を持たない)。カードの追加登録は法人のメニューにしか無いので、
 * 個人は飛ばす。法人が 2 つ以上あっても登録するのは 1 つだけ (同じカードを二重に入れない)。
 *
 * 種別はログインするまで分からないので、各 DO が記録した値 (`readType`) を前から読む。
 * **前に未記録のアカウントが居たら決めない** (`unconfirmed`) — そこが法人かもしれないのに
 * 後ろの法人で登録すると、記録が揃った翌日から担当が入れ替わる。読み取りの失敗も未記録と同じ扱い。
 */
export async function pickCardRegisterAccount(
  userIds: string[],
  readType: (userId: string) => Promise<CardRegisterAccountType | null>,
): Promise<CardRegisterAccountPick> {
  for (const userId of userIds) {
    const type = await readType(userId).catch(() => null);
    if (type === "corporate") return { kind: "found", userId };
    if (type !== "personal") return { kind: "unconfirmed", userId };
  }
  return { kind: "none" };
}

/** `fetchEtcAccountRecord` が使う DO namespace の形 (`DurableObjectNamespace` の部分)。 */
export interface EtcAccountTypeNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string): Promise<Response> };
}

/** `etc-{userId}` の DO が記録した種別等を読む。異常応答は throw (`readEtcAccountStates` が
 * `error: true` の行にする)。 */
export async function fetchEtcAccountRecord(
  ns: EtcAccountTypeNamespace,
  userId: string,
): Promise<EtcAccountRecord> {
  const res = await ns.get(ns.idFromName(`etc-${userId}`)).fetch(`https://relay.internal${ETC_ACCOUNT_TYPE_PATH}`);
  if (!res.ok) throw new Error(`etc-account-type HTTP ${res.status}`);
  return parseEtcAccountRecord(await res.json());
}

/** storage / 応答の値を種別に絞る。それ以外は `null`。 */
export function parseAccountType(raw: unknown): CardRegisterAccountType | null {
  return raw === "corporate" || raw === "personal" ? raw : null;
}
