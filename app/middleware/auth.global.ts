export default defineNuxtRouteMiddleware((to) => {
  const publicPaths = ['/login', '/auth/callback']
  if (publicPaths.some(p => to.path.startsWith(p))) return

  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading.value) return
  if (!isAuthenticated.value) {
    return navigateTo('/login')
  }
})
