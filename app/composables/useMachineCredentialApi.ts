import { useAuth } from '@ippoan/auth-client'
import { caughtErrorStatus } from '~/utils/api-error'
import { createMachineCredentialApi, type Fetcher } from '~/utils/machine-credentials'

/**
 * 給油データ USB アップローダー用の資格情報 (purpose `fuel-utran`) の管理 API
 * (Refs yhonda-ohishi/nginx#814)。auth-worker を**直接** (cross-origin で) 叩く —
 * `/api/proxy` は alc 向けで auth-worker の管理 API を通らない。
 * Bearer は dtako の browser JWT。401 (ログイン切れ) は認証状態を捨てて /login へ戻す
 * (`app/app.vue` の onUnauthorized と同じ扱い)。
 */
export function useMachineCredentialApi() {
  const { token, clearAuth } = useAuth()

  const fetcher: Fetcher = async <T>(url: string, options: Parameters<Fetcher>[1] = {}) => {
    const headers: Record<string, string> = {}
    if (token.value) headers.Authorization = `Bearer ${token.value}`
    try {
      return await $fetch<T>(url, {
        method: options.method ?? 'GET',
        body: options.body,
        query: options.query,
        headers,
      }) as T
    }
    catch (e) {
      if (caughtErrorStatus(e) === 401) {
        clearAuth()
        await navigateTo('/login')
      }
      throw e
    }
  }

  return createMachineCredentialApi(fetcher, String(useRuntimeConfig().public.authWorkerUrl ?? ''))
}
