/**
 * server route の **role 認可** (Refs #1004)。`requireAuth` (= 認証) の戻り値を受け、
 * **許可する role の一覧**に含まれなければ 403 を投げるだけの薄い層。
 *
 * ## ★ `role === 'admin'` をベタ書きしない理由
 *
 * 「**給与用の role**」が要るとオーナーが決め、値は **`payroll`** に確定した (Refs #1048)。
 * ⇒ {@link ALLOWED_ROLES} の中身は **`admin` と `payroll` の 2 つ**。
 *
 * `role === 'admin'` を 24 ファイルに散らしていたら、ここで **24 ファイルを触り直して
 * いた**。⇒ 一覧を {@link ALLOWED_ROLES} 1 か所に持ち、判定は
 * 「**その一覧に含まれるか**」({@link roleIsIn}) だけにしてある。**`payroll` の追加は
 * 実際に `ALLOWED_ROLES` の 1 行だけ**で済み、route も {@link assertAllowedRole} も
 * 無変更だった (4 値目が要るときも同じ)。
 *
 * **★ この repo 側だけでは `payroll` を持つ利用者は生まれない。** role に使える値を
 * 決めているのは上流 `rust-alc-api` の `migrations/003_create_users.sql` の
 * `CHECK (role IN (…))` で、そこへ `payroll` を足す migration は**上流の別 PR**。
 * ⇒ **上流が広がるまで、この 2 値目は誰にも当たらない** — ここを先に出しても、
 * 通る人・落ちる人は 1 人も変わらない (安全に先行できるのが狙い)。
 *
 * ## ★ これは「admin を通行証にする」変更ではない (誤読されやすいので明記)
 *
 * `workers/dtako-scraper-relay/src/restraint-viewer-auth.ts` の module docs に
 * 「「金額の軸」と「会社の軸」は**直交していて AND で効く**」
 * 「どちらかがもう一方を上書きすることは無い」
 * 「**admin に給与 allowlist を無視させる (fail-open) 案は却下**」とある。
 *
 * **★ 引用元の「軸」の呼び方は #1049 で変わった** (言葉が違って見えても中身は同じ)。
 * あちらは元々「role と email allowlist」の 2 軸と書いていたが、**#1049 で会社の軸から
 * role が外れた**ため、いまは **「給与 allowlist」(上流 rust-ichibanboshi) と
 * 「tenant + 全社閲覧 allowlist」(auth-worker の `USER_ACL`)** の 2 軸。
 * **直交していて AND で効く**という中身は変わっていない
 * (email allowlist が 2 つになったので、あちらでは呼び分けている)。
 *
 * 却下されているのは **admin を通行証にして allowlist を上書きすること (fail-open)**
 * であって、**admin を追加条件として要求すること (fail-closed)** ではない。
 * ここで入れるのは後者 — **既存の担保に AND で 1 本足すだけ**で、どの担保も緩めない。
 * **#1049 が会社の軸から role を外したのも同じ向き** (role で特別扱いしない)。
 *
 * **★ `payroll` も同じ** (Refs #1048)。この role が決めるのは「給与画面に**入れるか**」
 * だけで、「給与の実額を**見てよいか**」の正本は上流 rust-ichibanboshi の email
 * allowlist のまま。**role が allowlist を上書きすることは無い — AND で効く。**
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
 * **★ 画面に出るのは `message` (日本語) — front 全数がそう読む** (#1050 以降)。
 * 拾い順は `app/utils/api-error.ts` の `describeApiError` が正本で
 * (`[error, message, statusMessage]` の**文字列である最初の 1 つ**)、そこから切り出した
 * `pickBodyReason` を生 `fetch` 経路が使う。
 *
 * **かつては route ごとに違った (#1050 で解消)。**`statusMessage` を先に読む front が
 * **4 経路 5 か所**あり、そこだけ **ASCII** が出ていた。**「この gate の下に居るか」
 * まで込みで書く** — 居ないなら、いま英文が出ることは無い:
 *
 * | front | 対象の server route | この gate の下 |
 * |---|---|---|
 * | `app/utils/api.ts:784` `postNet780Archive` | `/api/net780/archive` | **はい** |
 * | `app/utils/api.ts:826` `readNetprintTargetsResponse` | `/api/netprint/targets` GET・PUT | **はい** (2 本とも) |
 * | `app/utils/netprint-run.ts:139` `normalizeNetprintRunOutcome` | `/api/netprint/run` | **はい** |
 * | `app/pages/kyuyo-fetch.vue:150` `refreshList` | `/api/kyuyo-master/refresh`・`refresh-full` | **いいえ** |
 * | `app/pages/kyuyo-fetch.vue:214` `fetchRange` | `/api/kyuyo/sync` | **いいえ** |
 *
 * ⇒ **実際に ASCII が出ていたのは上の 4 か所** (`assertAllowedRole` を呼ぶ 25 route の
 * うち、この 4 つを読む front だけが `statusMessage` 先だった)。下の 2 つは
 * `statusMessage` だけが渡る route なので h3 の写しで同じ文になり、**見た目は
 * 変わらなかった** (直ったのは Nitro 既定の本文で `(true)` / 空文字が出ていた方)。
 *
 * **5 か所とも `pickBodyReason` に揃えた**ので、いまはどの route でも日本語が出る。
 * dev + **role gate と同じ形のスタブ 403** で 5 か所とも実機確認し、往復 1 回で
 * base の ASCII も再現した (下の 2 つは「この gate に載ったら何が出るか」の測定)。
 *
 * ⇒ **それでも `statusMessage` に日本語を入れてはいけない。** 禁止の理由は front の
 * 読み順ではなく**本番 (workerd) の reason phrase が壊れること** (上の段落) で、
 * そちらは #1050 では 1 ミリも変わっていない。
 */
import { createError } from 'h3'

/**
 * server route を触ってよい role の**一覧**。**値が増えたら、この配列に 1 行足すだけ**
 * で全 route に効く (判定は {@link roleIsIn} が一覧を引くだけなので、他は無変更)。
 *
 * **いまの中身は `admin` と `payroll` の 2 つ** (`payroll` は Refs #1048 で追加。
 * 綴りはオーナーが決めたもので `kyuyo` / `wage` ではない)。
 *
 * **★ `payroll` を発行できるかは上流次第。** role に使える値は上流 `rust-alc-api` の
 * `migrations/003_create_users.sql` の `CHECK (role IN (…))` が決めており、そこへ
 * `payroll` を足す migration は**上流の別 PR**。**この一覧に先に足してあるだけ**なので、
 * 上流が広がるまで通る人・落ちる人は 1 人も変わらない。
 *
 * ## ★ この配列を触る人へ: 403 の文言の見直しの引き金 (Refs #1048)
 *
 * {@link assertAllowedRole} が返す 403 は **`administrator role is required` /
 * 「この操作には管理者権限が必要です」のまま据え置いてある**。
 *
 * **上流の `CHECK` が広がっただけでは、まだ嘘ではない。** 誰も `payroll` を持っていない
 * 間、拒否されるのは今日と同じ「`admin` でない人」で、その人への次の一手 (管理者に依頼)
 * も真のまま。**先回りして文言を変えると、存在しない選択肢を案内することになる。**
 *
 * **★ 引き金は「`payroll` role を持つ利用者が 1 人でも実在したら」。** そのとき初めて
 * この文言は嘘になる (`payroll` でも入れる人が居るのに「管理者権限が必要」と言うため)。
 * ⇒ **その時点で `statusMessage` / `message` の 2 行と、それを固定している
 * `tests/server/require-role.test.ts` の期待値を一緒に見直すこと。**
 *
 * **同じ申し送りは #1048 の issue 側にも置く** — `grep` も `scripts/xref.sh` も issue には
 * 届かず、逆に役割を配る作業をする人は issue から入ってくる。**片方だけだともう片方が腐る。**
 */
export const ALLOWED_ROLES = ['admin', 'payroll'] as const satisfies readonly string[]

/**
 * `role` が一覧に含まれるか。**一覧を引数に取る純関数**なので、
 * 「一覧に値を足したらどうなるか」を**実装を変えずにテストで示せる**
 * (`payroll` を足す前に、この形で先に測ってあった)。
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
 *
 * **★ 下の 403 の文言 2 行は `payroll` を足した後も「管理者」のまま据え置いてある。
 * 見直しの引き金 (「`payroll` を持つ利用者が 1 人でも実在したら」) は
 * {@link ALLOWED_ROLES} の注記が正本** (Refs #1048。説明を 2 か所に増やさない)。
 */
export function assertAllowedRole(auth: RoleBearingAuth): void {
  if (roleIsIn(ALLOWED_ROLES, auth.role)) return
  throw createError({
    statusCode: 403,
    statusMessage: 'administrator role is required',
    message: 'この操作には管理者権限が必要です',
  })
}
