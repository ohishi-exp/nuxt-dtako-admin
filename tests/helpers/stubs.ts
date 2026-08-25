export const UIconStub = { template: '<span />' }

/**
 * ページ (`app/pages/*.vue`) を `mount` するための Nuxt UI stub 一式 (Refs #903)。
 *
 * ## なぜ全部 stub するのか
 *
 * **Nuxt UI の実コンポーネントは vitest で mount できない。** `UButton` は setup で
 * `useAppConfig()` を呼ぶため `[nuxt] instance unavailable` で落ちる (実測 2026-08-25、
 * `app/pages/members.vue` を素で mount して確認)。**1 つでも stub し忘れると
 * ページ全体が mount できず、原因が「Invalid vnode type ... undefined」や
 * 「instance unavailable」という、そのコンポーネント名が出ない形で出る。**
 *
 * ## stub が「本物と同じ意味」を保つために必要なこと
 *
 * 素の `{ template: '<div />' }` にすると、**画面に出ている文字がテストから消える**。
 * `UButton label="削除"` / `UAlert :title="error"` は slot ではなく **prop で文字を
 * 渡す**ので、prop を宣言して描画しないと `wrapper.text()` に現れず、
 * 「出ていないのに通るテスト」になる。だからここでは:
 *
 * - **文字を持つ prop (`label` / `title` / `description`) は必ず描画する**
 * - **`UButton` の根は本物の `<button>`** — `@click` は fallthrough で根に付くので
 *   `trigger('click')` がそのまま効き、**`:disabled` も本物の DOM 属性として効く**
 *   (VTU は disabled 要素の click を発火しないので、押せないことも測れる)
 * - **`USelect` の根は本物の `<select>` + `<option>`** — `setValue()` が本物の
 *   `change` を起こして `update:modelValue` が出るので、`v-model` と
 *   `@update:model-value` の**配線**をテストから叩ける
 *
 * ## ★★ 全部 stub することで**測れなくなるもの** (型と一緒に必ず読むこと)
 *
 * stub は「本物が何を描くか」を再現しない。**測れる範囲がここで切れる:**
 *
 * 1. **色・見た目そのものは測れない。** `:color="statusColor(item.status)"` を渡しても
 *    本物のような赤や緑にはならない。⇒ **渡した prop の値で見る**
 *    (`w.findAllComponents({ name: 'UBadge' })[0].props('color') === 'warning'`)。
 *    **だから `color` を props に宣言してある** — 宣言が無いと `attrs` に落ちて
 *    `props()` から消え、「色を出し分ける関数が実行されただけ」で緑になる
 *    (v8 の行カバレッジは通るが、戻り値が何であってもテストは落ちない)
 * 2. **本物のコンポーネント内部の分岐は 1 つも通らない。** ただしこれは
 *    `coverage.include: ['app/**']` の外なので gate には影響しない
 * 3. **`v-if` の中身や `:color` の出し分けは template 側**なので、`BR()` の
 *    instrumented 計測 (= `<script setup>` ブロックだけ) には**出ない**。
 *    template 側の分岐は **v8 の branches でしか見えない** (`SKILL.md` の
 *    「側の一言の `v-if` は template 側」と同じ話)
 * 4. **`w.text()` は textContent の連結**なので、隣り合う区画の文字がくっついて
 *    存在しない語ができる (実測: 見出し「アップロード履歴 / CSV分割」+ 直後のバッジ
 *    「完了」で `w.text()` には**常に**「分割完了」が現れる)。
 *    ⇒ **区画の生死は文言ではなく、その区画の要素で見る**
 */
export const NUXT_UI_PAGE_STUBS = {
  UIcon: UIconStub,
  UButton: { name: 'UButton', props: ['label'], template: '<button><slot />{{ label }}</button>' },
  UAlert: {
    name: 'UAlert',
    props: ['title', 'description', 'color'],
    template: '<div><slot />{{ title }} {{ description }}</div>',
  },
  UBadge: { name: 'UBadge', props: ['color'], template: '<span><slot /></span>' },
  UCard: { name: 'UCard', template: '<div><slot /></div>' },
  USelect: {
    name: 'USelect',
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template: `<select :value="modelValue" @change="$emit('update:modelValue', $event.target.value)">
      <option v-for="i in items" :key="i.value" :value="i.value">{{ i.label }}</option>
    </select>`,
  },
}
