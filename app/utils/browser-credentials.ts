/**
 * ブラウザのパスワードマネージャに資格情報を預ける (Refs #693)。
 *
 * **なぜ明示的に呼ぶのか。** ふつうのログイン画面なら、フォームを submit して
 * 画面が遷移した時点でブラウザが「保存しますか」を出す。SPA は遷移しないので
 * 推測に頼ることになり、実際 `/remote-app` では出なかった。Credential Management
 * API で「いま資格情報が通った」と伝えれば、保存の可否は利用者が決められる。
 *
 * **保存するのはブラウザで、このアプリは持たない。** localStorage にも
 * サーバーにも書かない — 預け先は OS/ブラウザの資格情報ストアだけ。
 *
 * Chrome 系にしか無い API なので、無いブラウザでは何もしない (`false` を返す)。
 * その場合も `<form>` の `autocomplete` 属性は効くので、ブラウザ独自の判断で
 * 保存が提案されることはある。
 */

/** テストから差し替えるための、この関数が触る global の写し。 */
export interface CredentialScope {
  PasswordCredential?: new (init: { id: string, password: string }) => unknown
  navigator?: { credentials?: { store: (credential: unknown) => Promise<unknown> } }
}

/**
 * 保存を促す。**提案が出たか / 利用者が保存したかは分からない** — 返すのは
 * 「API を呼べたか」だけ。呼べなくても接続そのものには影響しない。
 */
export async function saveBrowserCredential(
  username: string,
  password: string,
  scope: CredentialScope = globalThis as CredentialScope,
): Promise<boolean> {
  const Ctor = scope.PasswordCredential
  const store = scope.navigator?.credentials?.store
  // 空で呼ぶと Chrome が空の資格情報を提案してくる。手前で止める。
  if (!Ctor || !store || !username || !password) return false

  try {
    await store.call(scope.navigator!.credentials, new Ctor({ id: username, password }))
    return true
  }
  catch {
    // 保存を断られた / 安全でない文脈 (http) などは黙って諦める。接続は続く。
    return false
  }
}
