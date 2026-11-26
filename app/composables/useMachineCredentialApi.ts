import { useAuth } from '@ippoan/auth-client'
import { caughtErrorStatus } from '~/utils/api-error'
import { PURPOSE, createMachineCredentialApi, type Fetcher, type MachineCredentialApi, type Purpose } from '~/utils/machine-credentials'

/**
 * 機械用の資格情報 (purpose `fuel-utran` / `etc-scan`) の管理 API
 * (Refs yhonda-ohishi/nginx#814)。auth-worker を**直接** (cross-origin で) 叩く —
 * `/api/proxy` は alc 向けで auth-worker の管理 API を通らない。
 * Bearer は dtako の browser JWT。401 (ログイン切れ) は認証状態を捨てて /login へ戻す
 * (`app/app.vue` の onUnauthorized と同じ扱い)。
 * `purpose` は呼ぶたびに読む (部品 `MachineCredentials` の props、Refs #1287)。省略時は `fuel-utran`。
 */
export function useMachineCredentialApi(purpose: () => Purpose = () => PURPOSE): MachineCredentialApi {
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

  const authWorkerUrl = String(useRuntimeConfig().public.authWorkerUrl ?? '')
  const api = () => createMachineCredentialApi(fetcher, authWorkerUrl, purpose())
  return {
    list: () => api().list(),
    issue: label => api().issue(label),
    revoke: username => api().revoke(username),
    rotate: username => api().rotate(username),
  }
}
