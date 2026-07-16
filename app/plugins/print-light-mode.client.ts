// 印刷 (Ctrl+P / window.print()) の間だけダークモードを解除する。
// ダークモードは <html class="dark"> ベース (@nuxt/ui の color-mode) のため、
// @media print の CSS だけでは dark: variant や Nuxt UI の --ui-* 変数を
// 打ち消せない。beforeprint で class を外し afterprint で戻すのが確実。
export default defineNuxtPlugin({
  name: 'print-light-mode',
  setup() {
    let removedDark = false

    window.addEventListener('beforeprint', () => {
      const el = document.documentElement
      if (el.classList.contains('dark')) {
        el.classList.remove('dark')
        removedDark = true
      }
    })

    window.addEventListener('afterprint', () => {
      if (removedDark) {
        document.documentElement.classList.add('dark')
        removedDark = false
      }
    })
  },
})
