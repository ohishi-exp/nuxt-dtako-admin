/**
 * server route の **role 認可** (Refs #1004)。`requireAuth` (= 認証) の戻り値を受け、
 * **許可する role の一覧**に含まれなければ 403 を投げるだけの薄い層。
 *
 * ## ★ `role === 'admin'` をベタ書きしない理由
 *
 * いま `role` は上流 `rust-alc-api` の DB で `CHECK (role IN ('admin','viewer'))` の
 * **2 値**しかない。だが「**給与用の role (salary viewer のような)**」が要るのでは、と
 * いう指摘がオーナーから出ており、**3 値目が増える見込み**がある (3 値目そのものは
 * 上流の migration が要るので別 issue)。
 *
 * `role === 'admin'` を 24 ファイルに散らすと、そのとき **24 ファイルを触り直す**。
 * ⇒ 一覧を {@link ALLOWED_ROLES} 1 か所に持ち、判定は
 * 「**その一覧に含まれるか**」({@link roleIsIn}) だけにする。**3 値目の追加は
 * `ALLOWED_ROLES` の 1 行**で済み、route も {@link assertAllowedRole} も無変更。
 *
 * ## ★ これは「admin を通行証にする」変更ではない (誤読されやすいので明記)
 *
 * `workers/dtako-scraper-relay/src/restraint-viewer-auth.ts` の module docs に
 * 「role と email allowlist は**優先関係ではなく直交した別の軸で、AND で効く**」
 * 「**admin に allowlist を無視させる (fail-open) 案は却下**」とある。
 *
 * 却下されているのは **admin を通行証にして allowlist を上書きすること (fail-open)**
 * であって、**admin を追加条件として要求すること (fail-closed)** ではない。
 * ここで入れるのは後者 — **既存の担保に AND で 1 本足すだけ**で、どの担保も緩めない。
 *
 * ## ★ 判定は fail-closed
 *
 * auth-worker の introspect は JWT の `role` claim を**そのまま返すだけ**で値の制約を
 * 掛けておらず、claim 欠落時は `payload.role || ""` で **空文字**になる。
 * `""` も `undefined` も一覧に含まれないので、そのまま拒否される
 * (`role !== ''` のような**冗長なガードは足さない** — 足すと偽側が到達不能な分岐が
 * 増えるだけで、fail-closed の強さは 1 ミリも変わらない)。
 *
 * ## ★ tenant / email はここで判定しない (2026-08-28 オーナー判断)
 *
 * - **tenant** の正本は auth-worker 側の ACL (`checkOrgAccess` / `checkAppTenant`)。
 *   この repo で二重化すると壊れる。
 * - **email** の正本は上流 rust-ichibanboshi の allowlist (`/api/kyuyo/**`)。
 *
 * ## ★ 403 の本文: `statusMessage` は ASCII、日本語は `message`
 *
 * 日本語を `statusMessage` に載せると **本番 (workerd) で reason phrase が壊れる**
 * (`HTTP/1.1 403 <非 ASCII が落ちた断片>`。Refs #1032/#886、`server/api/ichiban/[...path].get.ts`
 * に実測つきの注記がある)。h3 の `createError` は `message` 未指定なら `statusMessage`
 * を写すので、**写させずに両方明示する**。
 *
 * **★ ただし画面に何が出るかは route ごとに違う** (注記を 1 本にすると 2 枚目で嘘になる):
 *
 * | front の読み方 | 対象 | 画面に出る文字列 |
 * |---|---|---|
 * | `message` 先 (`describeApiError` = `[error, message, statusMessage]`) | 大半の A 段 route | **日本語** (`message`) |
 * | **`statusMessage` 先** | `/api/net780/archive` (`app/utils/api.ts:784`) / `/api/netprint/targets` GET・PUT (`app/utils/api.ts:826`) / `/api/netprint/run` (`app/utils/netprint-run.ts:139`) | **ASCII** (`statusMessage`) |
 *
 * ⇒ **その 4 本では英文が出る。**「日本語が出る」と一律に書かないこと。
 * 英文のままでも理由は読めるので実害は無いと判断した (front を message 先へ直すのは
 * 別の変更 — `server/api/ichiban/[...path].get.ts` の「**この直しを front の他の経路へ
 * 広げないこと**」に従い、ここでは front を触らない)。
 */
import { createError } from 'h3'

/**
 * server route を触ってよい role の**一覧**。**3 値目が増えたら、この配列に 1 行足すだけ**
 * で全 route に効く (判定は {@link roleIsIn} が一覧を引くだけなので、他は無変更)。
 *
 * **いまの中身は `admin` 1 つだけ。**増やすのは別 issue (上流の
 * `migrations/003_create_users.sql` の `CHECK` を広げる migration が先に要る)。
 */
export const ALLOWED_ROLES = ['admin'] as const satisfies readonly string[]

/**
 * `role` が一覧に含まれるか。**一覧を引数に取る純関数**なので、
 * 「一覧に 2 つ目を足したらどうなるか」を**実装を変えずにテストで示せる**。
 *
 * 文字列以外 (`undefined` / claim 欠落) は `typeof` で落ち、空文字は一覧に無いので
 * 落ちる — どちらも fail-closed。
 */
export function roleIsIn(allowed: readonly string[], role: unknown): boolean {
  return typeof role === 'string' && allowed.includes(role)
}

/** `requireAuth` の戻り値のうち、この層が見る唯一の項目。 */
export interface RoleBearingAuth {
  readonly role?: unknown
}

/**
 * `requireAuth` の戻り値を受け、{@link ALLOWED_ROLES} に無ければ **403** を投げる。
 * 通る場合は何も返さない (呼び出し側は `auth` をそのまま使い続ける)。
 *
 * **`requireAuth` の後に呼ぶこと** — 未ログインを 403 で返すと「ログインしたら通る」が
 * 読めなくなる (`server/api/ichiban/[...path].get.ts` の順序の注記と同じ理由)。
 */
export function assertAllowedRole(auth: RoleBearingAuth): void {
  if (roleIsIn(ALLOWED_ROLES, auth.role)) return
  throw createError({
    statusCode: 403,
    statusMessage: 'administrator role is required',
    message: 'この操作には管理者権限が必要です',
  })
}
