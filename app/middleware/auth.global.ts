import { authMiddleware } from '@ippoan/auth-client'

export default defineNuxtRouteMiddleware(
  // /dvr-viewer は theearth credential でログインする外部利用者向けページ (Refs #90)。
  // auth-worker のログインは要求しない (認証は theearth 本体に委譲)。
  authMiddleware({ publicPaths: ['/login', '/auth/callback', '/dvr-viewer'] }),
)
