// notify-realtime-bus Worker (nuxt-notify deploy) を経由した Y時間 export の async job
// 起動 + WebSocket 完了通知 composable。
//
// 仕様:
//   1. start({ driverCd, from, to }) を呼ぶと:
//      a. POST /api/dtako/y-time-export/jobs に投げて 202 + { job_id } を受領
//      b. realtime-bus へ WebSocket subscribe (singleton 共有)
//      c. `kind === 'y_time_export'` && `job_id` 一致のメッセージを待機
//      d. status='completed' → result を resolve、'failed' → reject
//   2. realtimeBusUrl 未設定 (env 未設定 / 旧環境) は同期 GET にフォールバック
//   3. 接続切断時は 5 秒後に自動再接続 (hibernation 60s idle disconnect 対策)
//
// 参考 (paste from): nuxt-notify の `app/composables/useRedactionWatch.ts`
// - WebSocket 接続管理ロジックは流用、event 型と job 解決ロジックを Y時間 用に差し替え
//
// realtime-bus ペイロード仕様 (rust-alc-api `crates/alc-dtako/src/dtako_y_time_export/mod.rs`
// の `YTimeJobEvent` と一致):
//   { kind: 'y_time_export', tenant_id, document_id, job_id, status, result?, error? }
//   document_id は Worker validation を通すため job_id と同値が入っている (filter には kind+job_id を使う)

import { useAuth } from '@ippoan/auth-client'
import type { YTimeExportResponse } from '~/types'

export interface YTimeJobEvent {
  kind: 'y_time_export' | string
  tenant_id: string
  document_id: string
  job_id: string
  status: 'completed' | 'failed' | string
  result?: YTimeExportResponse
  error?: string
}

interface JobWaiter {
  resolve: (r: YTimeExportResponse) => void
  reject: (e: Error) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

const RECONNECT_DELAY_MS = 5000
/** 1 job の最大待ち時間。並列化後は 5-15s 想定だが cold start や R2 swing で +60s 程度を許容 */
const JOB_TIMEOUT_MS = 120_000

export interface YTimeExportJobOptions {
  driverCd: string
  from: string
  to: string
}

export function useYTimeExportJob() {
  const { token, orgId } = useAuth()
  const config = useRuntimeConfig()
  const realtimeBusUrl = (config.public.realtimeBusUrl as string | undefined) ?? ''
  const apiBase = (config.public.apiBase as string | undefined) ?? ''

  // job_id → waiter のマップ。同 composable インスタンスで複数 job 並走可。
  const waiters = new Map<string, JobWaiter>()

  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function clearTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function connect() {
    if (!realtimeBusUrl) return // 未設定 → start() 側でフォールバック
    if (!token.value) return // 未ログイン → 接続不可
    if (socket && socket.readyState <= WebSocket.OPEN) return // 既接続/接続中

    let sock: WebSocket
    try {
      // Sec-WebSocket-Protocol で JWT 送信。
      // ブラウザは `new WebSocket(url, ['bearer', jwt])` を
      // `Sec-WebSocket-Protocol: bearer, <jwt>` ヘッダで送る。
      sock = new WebSocket(`${realtimeBusUrl}/subscribe`, ['bearer', token.value])
    } catch {
      scheduleReconnect()
      return
    }
    socket = sock

    sock.addEventListener('message', (e) => {
      try {
        const ev = JSON.parse(typeof e.data === 'string' ? e.data : '') as YTimeJobEvent
        if (ev.kind !== 'y_time_export') return // 他 channel (redact 等) は無視
        const w = waiters.get(ev.job_id)
        if (!w) return // 対応する待機者なし → drop
        clearTimeout(w.timeoutHandle)
        waiters.delete(ev.job_id)
        if (ev.status === 'completed' && ev.result) {
          w.resolve(ev.result)
        } else {
          w.reject(new Error(ev.error || `job ${ev.job_id}: ${ev.status}`))
        }
      } catch {
        // malformed JSON or parse error → drop
      }
    })

    sock.addEventListener('close', () => {
      socket = null
      scheduleReconnect()
    })

    sock.addEventListener('error', () => {
      // close も発火するので reconnect は close 側に任せる
    })
  }

  function scheduleReconnect() {
    if (stopped) return
    clearTimer()
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
  }

  /** 同期 GET フォールバック (realtime-bus 未設定環境、CI 等で動かす用) */
  async function fallbackToSyncGet(opts: YTimeExportJobOptions): Promise<YTimeExportResponse> {
    if (!apiBase) throw new Error('apiBase not configured')
    const params = new URLSearchParams({
      driver_cd: opts.driverCd,
      from: opts.from,
      to: opts.to,
    })
    const headers: Record<string, string> = {}
    if (token.value) headers['Authorization'] = `Bearer ${token.value}`
    if (orgId.value) headers['X-Tenant-ID'] = orgId.value
    const res = await fetch(`${apiBase}/api/dtako/y-time-export?${params.toString()}`, {
      headers,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`backend (sync GET) error ${res.status}: ${text || res.statusText}`)
    }
    return res.json() as Promise<YTimeExportResponse>
  }

  /** Job を起動し、WS で完了通知を受け取って result を返す */
  async function start(opts: YTimeExportJobOptions): Promise<YTimeExportResponse> {
    if (!apiBase) throw new Error('apiBase not configured')

    // realtime-bus 未設定 → 同期 GET フォールバック
    if (!realtimeBusUrl) return fallbackToSyncGet(opts)

    // 接続準備 (socket 初回 or 再接続中なら待機)
    connect()

    // 1. POST /jobs で job 起動
    const params = new URLSearchParams({
      driver_cd: opts.driverCd,
      from: opts.from,
      to: opts.to,
    })
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (token.value) headers['Authorization'] = `Bearer ${token.value}`
    if (orgId.value) headers['X-Tenant-ID'] = orgId.value

    const res = await fetch(`${apiBase}/api/dtako/y-time-export/jobs?${params.toString()}`, {
      method: 'POST',
      headers,
    })
    if (res.status === 503) {
      // backend が realtime-bus 未設定 → fallback
      return fallbackToSyncGet(opts)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`POST /jobs error ${res.status}: ${text || res.statusText}`)
    }
    const { job_id } = (await res.json()) as { job_id: string }

    // 2. WS で job_id 完了を待機
    return new Promise<YTimeExportResponse>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        waiters.delete(job_id)
        reject(new Error(`job ${job_id} timed out after ${JOB_TIMEOUT_MS}ms`))
      }, JOB_TIMEOUT_MS)
      waiters.set(job_id, { resolve, reject, timeoutHandle })
    })
  }

  onMounted(connect)
  onUnmounted(() => {
    stopped = true
    clearTimer()
    // 残った waiter は中断扱い
    for (const [, w] of waiters) {
      clearTimeout(w.timeoutHandle)
      w.reject(new Error('component unmounted before job completed'))
    }
    waiters.clear()
    if (socket) {
      try {
        socket.close()
      } catch {
        // already closed
      }
      socket = null
    }
  })

  return { start }
}
