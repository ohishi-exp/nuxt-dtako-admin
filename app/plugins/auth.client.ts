import { useAuth } from '@ippoan/auth-client'

export default defineNuxtPlugin({
  name: 'auth-init',
  enforce: 'pre',
  parallel: false,
  setup() {
    const { consumeFragment, loadFromStorage, recoverFromCookie, isAuthenticated } = useAuth()

    consumeFragment()
    loadFromStorage()

    if (!isAuthenticated.value) {
      recoverFromCookie()
    }

    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      if (url.searchParams.has('lw_callback')) {
        url.searchParams.delete('lw_callback')
        history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
      }
    }
  },
})
