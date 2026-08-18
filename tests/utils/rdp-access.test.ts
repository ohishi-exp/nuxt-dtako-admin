import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  accessLoginUrl,
  browserDeps,
  ensureAccessSession,
  LOGIN_CLOSED,
  LOGIN_TIMEOUT,
  LOGIN_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POPUP_BLOCKED,
  probeAccessSession,
  PROBE_TIMEOUT_MS,
  rdpWsUrl,
  type AccessDeps,
} from '~/utils/rdp-access'

const BASE = 'wss://rdp.example.org'

/**
 * `new WebSocket()` の代役。**イベントは自分で起こす** — 実機で何が起きたかを
 * (open / error / close / 無反応) 1 件ずつ書き分けたいため。
 */
class FakeSocket {
  static last: FakeSocket | null = null
  static opened: string[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = 0
  constructor(public url: string) {
    FakeSocket.last = this
    FakeSocket.opened.push(url)
  }

  close() { this.closed++ }
}

/** 台本どおりに open / error を返す偽 WebSocket を作る。`'silent'` は無反応。 */
function scripted(script: Array<'open' | 'error' | 'silent'>) {
  let i = 0
  return class extends FakeSocket {
    constructor(url: string) {
      super(url)
      const step = script[i++] ?? 'error'
      if (step === 'silent') return
      // コンストラクタから同期で呼ぶとハンドラがまだ付いていないので次の tick に回す。
      queueMicrotask(() => (step === 'open' ? this.onopen?.() : this.onerror?.()))
    }
  } as unknown as typeof WebSocket
}

function fakeWindow() {
  return { closed: false, close: vi.fn(function (this: { closed: boolean }) { this.closed = true }) }
}

function deps(over: Partial<AccessDeps> = {}): AccessDeps {
  return {
    WebSocketCtor: scripted(['open']),
    openWindow: () => fakeWindow() as unknown as Window,
    sleep: () => Promise.resolve(),
    ...over,
  }
}

afterEach(() => {
  FakeSocket.last = null
  FakeSocket.opened = []
  vi.useRealTimers()
})

describe('URL 組み立て', () => {
  it('WS は base に /rdp を足す', () => {
    expect(rdpWsUrl(BASE)).toBe('wss://rdp.example.org/rdp')
  })

  it('末尾の / は落とす', () => {
    expect(rdpWsUrl('wss://rdp.example.org/')).toBe('wss://rdp.example.org/rdp')
    expect(accessLoginUrl('wss://rdp.example.org//')).toBe('https://rdp.example.org/health')
  })

  it('ログイン遷移は http scheme の /health', () => {
    expect(accessLoginUrl(BASE)).toBe('https://rdp.example.org/health')
    expect(accessLoginUrl('ws://localhost:3390')).toBe('http://localhost:3390/health')
  })
})

describe('probeAccessSession', () => {
  it('open まで来たら通ったと見なし、握った WebSocket は閉じる', async () => {
    const d = deps({ WebSocketCtor: scripted(['open']) })
    await expect(probeAccessSession(rdpWsUrl(BASE), d)).resolves.toBe(true)
    expect(FakeSocket.opened).toEqual(['wss://rdp.example.org/rdp'])
    expect(FakeSocket.last?.closed).toBe(1)
  })

  it('error なら通っていない (Access の 302 は WebSocket からはこう見える)', async () => {
    await expect(probeAccessSession(rdpWsUrl(BASE), deps({ WebSocketCtor: scripted(['error']) })))
      .resolves.toBe(false)
  })

  it('open の後に close が来ても結果は変わらない', async () => {
    const d = deps({ WebSocketCtor: scripted(['open']) })
    const result = probeAccessSession(rdpWsUrl(BASE), d)
    await Promise.resolve()
    FakeSocket.last?.onclose?.()
    await expect(result).resolves.toBe(true)
    // 2 度目の finish で閉じ直していない。
    expect(FakeSocket.last?.closed).toBe(1)
  })

  it('close だけ来たら通っていない', async () => {
    const d = deps({ WebSocketCtor: scripted(['silent']) })
    const result = probeAccessSession(rdpWsUrl(BASE), d)
    await Promise.resolve()
    FakeSocket.last?.onclose?.()
    await expect(result).resolves.toBe(false)
  })

  it('無反応なら制限時間で false (window.open が activation を外さない長さ)', async () => {
    vi.useFakeTimers()
    const result = probeAccessSession(rdpWsUrl(BASE), deps({ WebSocketCtor: scripted(['silent']) }))
    expect(PROBE_TIMEOUT_MS).toBeLessThan(5_000)
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS)
    await expect(result).resolves.toBe(false)
  })
})

describe('ensureAccessSession', () => {
  it('cookie があるならログイン画面を開かない', async () => {
    const openWindow = vi.fn(() => fakeWindow() as unknown as Window)
    await ensureAccessSession(BASE, deps({ WebSocketCtor: scripted(['open']), openWindow }))
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('cookie が無ければ /health を別窓で開き、通った時点で閉じる', async () => {
    const win = fakeWindow()
    const openWindow = vi.fn(() => win as unknown as Window)
    const sleep = vi.fn(() => Promise.resolve())
    await ensureAccessSession(BASE, deps({
      // 1 回目 = 未ログイン、2 回目 = まだ、3 回目でログインが済んだ
      WebSocketCtor: scripted(['error', 'error', 'open']),
      openWindow,
      sleep,
    }))
    expect(openWindow).toHaveBeenCalledWith('https://rdp.example.org/health')
    expect(sleep).toHaveBeenCalledWith(POLL_INTERVAL_MS)
    expect(win.close).toHaveBeenCalled()
  })

  it('ポップアップがブロックされたらその旨で失敗する', async () => {
    await expect(ensureAccessSession(BASE, deps({
      WebSocketCtor: scripted(['error']),
      openWindow: () => null,
    }))).rejects.toThrow(POPUP_BLOCKED)
  })

  it('ログイン画面を閉じられたら待ち続けない', async () => {
    const win = fakeWindow()
    await expect(ensureAccessSession(BASE, deps({
      WebSocketCtor: scripted(['error', 'error']),
      openWindow: () => {
        // 利用者がログインせずに閉じた。
        win.closed = true
        return win as unknown as Window
      },
    }))).rejects.toThrow(LOGIN_CLOSED)
  })

  it('待っても通らなければ制限時間で諦め、開いた窓は閉じる', async () => {
    const win = fakeWindow()
    const sleep = vi.fn(() => Promise.resolve())
    await expect(ensureAccessSession(BASE, deps({
      WebSocketCtor: scripted([]), // 常に error
      openWindow: () => win as unknown as Window,
      sleep,
    }))).rejects.toThrow(LOGIN_TIMEOUT)
    expect(sleep).toHaveBeenCalledTimes(LOGIN_TIMEOUT_MS / POLL_INTERVAL_MS)
    expect(win.close).toHaveBeenCalled()
  })

  it('deps 省略時はブラウザの WebSocket / window.open / setTimeout を使う', async () => {
    vi.useFakeTimers()
    const globalAny = globalThis as unknown as { WebSocket: unknown }
    const original = globalAny.WebSocket
    globalAny.WebSocket = scripted(['open'])
    try {
      const d = browserDeps()
      expect(d.WebSocketCtor).toBe(globalAny.WebSocket)
      const slept = d.sleep(5)
      await vi.advanceTimersByTimeAsync(5)
      await slept
      // 既定の window.open は Access のログイン画面を別窓で開く。
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
      expect(d.openWindow('https://rdp.example.org/health')).toBeNull()
      expect(openSpy).toHaveBeenCalledWith(
        'https://rdp.example.org/health', 'rdp-access-login', 'width=520,height=680')
      openSpy.mockRestore()

      // ensureAccessSession も deps 省略で通る (既定が組み立てられている)。
      await expect(ensureAccessSession(BASE)).resolves.toBeUndefined()
    }
    finally {
      globalAny.WebSocket = original
    }
  })
})
