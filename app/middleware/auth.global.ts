import { authMiddleware } from '@ippoan/auth-client'

export default defineNuxtRouteMiddleware(
  // /dvr-viewer /dvr-map (DVR 動画・位置情報) は管理者専用ページ。管理画面 (auth-worker)
  // ログインを必須にし、その上で theearth credential で DVR データにアクセスする二段構え
  // (Refs #90)。publicPaths には入れない = 未ログインは login にリダイレクトされる。
  authMiddleware({ publicPaths: ['/login', '/auth/callback'] }),
)
