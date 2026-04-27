import { authMiddleware } from '@ippoan/auth-client'

export default defineNuxtRouteMiddleware(
  authMiddleware({ publicPaths: ['/login', '/auth/callback'] }),
)
