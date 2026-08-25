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
 */
export const NUXT_UI_PAGE_STUBS = {
  UIcon: UIconStub,
  UButton: { name: 'UButton', props: ['label'], template: '<button><slot />{{ label }}</button>' },
  UAlert: {
    name: 'UAlert',
    props: ['title', 'description'],
    template: '<div><slot />{{ title }} {{ description }}</div>',
  },
  UBadge: { name: 'UBadge', template: '<span><slot /></span>' },
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
