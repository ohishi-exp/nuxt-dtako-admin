/**
 * 給与データ (`/api/kyuyo/*`) を見てよいか **upstream が返した答え**を、画面の 1 文に
 * 翻訳するだけの純粋ロジック (Refs #556)。
 *
 * ## ★ ここは認可ではない — 認可は upstream にしかない
 *
 * **判断しているのは rust-ichibanboshi の `kyuyo::introspect::authorize()` だけ**
 * (`ohishi-exp/rust-ichibanboshi#82`、`src/kyuyo/introspect.rs`)。auth-worker の
 * introspect で browser JWT を検証し、応答の `email` を allowlist と突き合わせる。
 * `/api/kyuyo/{companies,databases,payroll,employees,sync,synced-months}` の 6 本すべてが
 * ハンドラ冒頭で同じ関数を通る。この repo の `server/api/kyuyo/[...path].{get,post}.ts` は
 * **status も本文もそのまま passthrough する thin proxy** で、JWT を検証しない。
 *
 * **画面で隠しても API を直接叩けば取れる。**だからこの module は
 * 「見せる / 見せない」を決めない — **upstream が返した status を人が読める 1 文にする**
 * のが全部で、隠すことで制限したつもりになるのを避けている。
 *
 * ## ★ 403 と 503 は別物 (混ぜると逆方向の誤読が出る)
 *
 * upstream の `authorize()` が返す status は 3 通りに分かれる:
 *
 * | status | upstream 側の条件 | 意味 |
 * | --- | --- | --- |
 * | **403** | allowlist 外の email | **その人の権限の話** |
 * | **503** | introspect 未設定 / allowlist 空 / 認可サーバに不達 | **設定・障害の話。権限とは無関係** |
 * | **401** | Bearer 無し / `active:false` | ログインの話 (セッション側の担当) |
 *
 * **503 を「権限がありません」と読ませないこと。**権限があるのに「自分には権限が無い」と
 * 誤解して管理者に問い合わせる、という逆方向の誤読が出る (2026-08-26 親判断)。
 * 逆に **503 を無言にするのも駄目** — 列が空なのに理由が無い状態は、この repo で最も多い
 * 欠陥の型 (**「読まなかった」と「読めなかった」が同じ見た目**) そのものになる。
 *
 * ## 401 / その他 / 未確定は**無言**
 *
 * 権限とも設定とも言えないので何も言わない。とくに **`unknown` を「権限あり」と
 * 言い換えないこと** — 判らないものを「見られます」と書くと、空欄の理由がまた消える。
 */

/** 給与データを見てよいかについて、upstream から得られた答え。 */
export type KyuyoAccessState =
  /** 200 が返った = allowlist に載っている。 */
  | 'allowed'
  /** 403 = allowlist 外。**その人の権限の話。** */
  | 'denied'
  /** 503 = 認可が未設定、または認可サーバに不達。**権限とは無関係。** */
  | 'unconfigured'
  /** まだ聞いていない / 401 / それ以外の status。**何も言えない。** */
  | 'unknown'

/**
 * `$fetch` のエラーから HTTP status を取り出す。取れなければ null。
 *
 * ofetch の `FetchError` は `status` と `statusCode` の**両方**を持つが、
 * `createError` 由来の値が `statusCode` だけのこともあるので両方見る
 * (`theearthSessionErrorStatus` は `status` しか見ておらず、そちらは theearth
 * セッション専用なので広げていない)。
 */
export function kyuyoErrorStatus(e: unknown): number | null {
  const err = (e ?? {}) as { status?: unknown, statusCode?: unknown }
  if (typeof err.status === 'number') return err.status
  if (typeof err.statusCode === 'number') return err.statusCode
  return null
}

/**
 * upstream が返した status を `KyuyoAccessState` にする。
 *
 * **403 と 503 だけを名前のついた状態にする** — それ以外は `unknown` に倒す。
 * 「知らない status を勝手に権限の話にしない」ため。
 */
export function classifyKyuyoAccess(status: number | null): KyuyoAccessState {
  if (status === 403) return 'denied'
  if (status === 503) return 'unconfigured'
  return 'unknown'
}

/** `$fetch` のエラーを直接 `KyuyoAccessState` にする (status 抽出込み)。 */
export function kyuyoAccessFromError(e: unknown): KyuyoAccessState {
  return classifyKyuyoAccess(kyuyoErrorStatus(e))
}

/**
 * 画面に出す 1 文。**出さない状態では null** を返す (`allowed` / `unknown`)。
 *
 * `denied` と `unconfigured` で**文を分ける**のが要点 — 上の表のとおり、
 * 片方は権限の話、もう片方は設定・障害の話で、**利用者が次に取る行動が違う**
 * (前者は管理者に許可を頼む / 後者は待つか復旧を待つ)。
 *
 * ## ★ 「何が起きるか」は呼び出し側から受け取る (`consequence`)
 *
 * **理由は共通でも、結果は画面ごとに違う。**拘束×賃金は「給与DB 由来の金額列が
 * 空欄になる」だが、`/kyuyo-fetch` は**そもそも金額を 1 つも出さない画面**で、
 * 実際に起きるのは「アーカイブ一覧が空のままで、引き直しても失敗する」。
 * 文を 1 本に固定していたら、**金額列の無い画面に「金額列は空欄になります」と
 * 書く**ことになっていた (2026-08-26 のスタブ実測で発覚。読みでは出なかった)。
 *
 * `consequence` は**句点を付けずに**渡す — ここで文に組む。
 */
export function kyuyoAccessNotice(state: KyuyoAccessState, consequence: string): string | null {
  if (state === 'denied') {
    return `給与データの閲覧権限がありません (email 単位の許可制です)。${consequence}。`
      + '必要なら管理者に許可の追加を依頼してください。'
  }
  if (state === 'unconfigured') {
    return '給与データの認可設定が未完了か、認可サーバに繋がりません (権限の問題ではありません)。'
      + `復旧するまで${consequence}。`
  }
  return null
}

/** 拘束×賃金 (`/restraint-wage`) の**期間集計以外**のタブで起きること。
 * 給与由来の値は表の**列**として並ぶので、空欄になるのは列。 */
export const KYUYO_CONSEQUENCE_WAGE = '給与DB 由来の金額列は空欄のままになります'

/** 同じ `/restraint-wage` の**期間集計タブ**で起きること (Refs #951)。
 *
 * ## ★ 理由が同じでも結果が違うのは「画面ごと」だけではない — **タブごと**でも起きる
 *
 * `kyuyoAccessNotice` の docs にある「金額列の無い画面に『金額列は空欄になります』と
 * 書く」欠陥 (#949) の、**一段深い形**。注記の `<p>` は最初の `activeTab === '...'`
 * ブロックより前 = **全タブ共通領域**にあるので、句を 1 本に固定すると
 * **期間集計タブを開いていても「金額列は空欄のままになります」と出る**。
 *
 * 期間集計タブで実際に起きるのは**別のこと**:
 *
 * | | 金額の出どころ | 拒否されたときの見え方 |
 * | --- | --- | --- |
 * | 最低賃金チェック等 | `/api/kyuyo/payroll` を**列ごとに**引く | 表は出て、**給与由来の列だけ空欄** |
 * | **期間集計** | `GET /restraint-api/wage-range` **1 本**で行ごと引く | **表そのものが出ない** (`rangeError` に理由) |
 *
 * 期間集計は保存済みスナップショットを 1 往復で読む口で、`paid` (実支給額) と
 * 計算額が**同じ応答に同居する**。⇒ 部分的に伏せる余地が無く、口ごと 403 になる。
 * 「空欄」と書くと**表は出ると誤解させる**ので、`表示されません` と書く。 */
export const KYUYO_CONSEQUENCE_RANGE = '保存済みの期間集計 (給与支払額・差) は表示されません'

/** 給与DB取得 (`/kyuyo-fetch`) で起きること。**この画面は金額を 1 つも出さない**
 * ので、金額列の話を書いてはいけない。 */
export const KYUYO_CONSEQUENCE_FETCH = 'サーバー側の給与アーカイブ一覧は空のままで、引き直しても失敗します'
