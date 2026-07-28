import { describe, expect, it } from 'vitest'
import { UpstreamMemo } from '../src/upstream-memo'

/** 手動で解決できる Promise (in-flight 状態を作るため)。 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('UpstreamMemo', () => {
  it('TTL 内の値は load を呼ばずに返す', async () => {
    const memo = new UpstreamMemo(60_000, 8)
    let calls = 0
    const load = async () => {
      calls += 1
      return 'v'
    }
    expect(await memo.get('k', 0, load)).toBe('v')
    expect(await memo.get('k', 59_999, load)).toBe('v')
    expect(calls).toBe(1)
  })

  it('TTL が切れたら取り直す', async () => {
    const memo = new UpstreamMemo(60_000, 8)
    let calls = 0
    const load = async () => {
      calls += 1
      return calls
    }
    expect(await memo.get('k', 0, load)).toBe(1)
    expect(await memo.get('k', 60_000, load)).toBe(2)
  })

  it('同時発行は 1 本の load に畳まれる (in-flight 共有)', async () => {
    const memo = new UpstreamMemo(60_000, 8)
    const d = deferred<string>()
    let calls = 0
    const load = () => {
      calls += 1
      return d.promise
    }
    const first = memo.get('k', 0, load)
    const second = memo.get('k', 0, load)
    d.resolve('shared')
    expect(await first).toBe('shared')
    expect(await second).toBe('shared')
    expect(calls).toBe(1)
  })

  it('null は memo しない — 次の呼び出しで再試行する', async () => {
    const memo = new UpstreamMemo(60_000, 8)
    let calls = 0
    const load = async () => {
      calls += 1
      return calls === 1 ? null : 'ok'
    }
    expect(await memo.get('k', 0, load)).toBeNull()
    expect(await memo.get('k', 1, load)).toBe('ok')
    expect(calls).toBe(2)
  })

  it('load の失敗は同時に待っていた側へも伝わり、memo されない', async () => {
    const memo = new UpstreamMemo(60_000, 8)
    const d = deferred<string>()
    const first = memo.get('k', 0, () => d.promise)
    const second = memo.get('k', 0, async () => 'never called')
    d.reject(new Error('boom'))
    await expect(first).rejects.toThrow('boom')
    await expect(second).rejects.toThrow('boom')
    // 失敗は残らない — 次は取り直せる
    expect(await memo.get('k', 1, async () => 'retried')).toBe('retried')
  })

  it('溢れたら最古の 1 件だけが落ちる', async () => {
    const memo = new UpstreamMemo(60_000, 2)
    await memo.get('a', 0, async () => 'a1')
    await memo.get('b', 1, async () => 'b1')
    await memo.get('c', 2, async () => 'c1') // a (@0) が落ちる
    let loads = 0
    expect(await memo.get('b', 3, async () => {
      loads += 1
      return 'b2'
    })).toBe('b1')
    expect(await memo.get('a', 4, async () => {
      loads += 1
      return 'a2'
    })).toBe('a2')
    expect(loads).toBe(1)
  })

  it('溢れたら古い順に落とす (既存 key の上書きでは落とさない)', async () => {
    const memo = new UpstreamMemo(60_000, 2)
    let loads = 0
    const load = (v: string) => async () => {
      loads += 1
      return v
    }
    await memo.get('a', 0, load('a1'))
    await memo.get('b', 1, load('b1'))
    // 上書き (期限切れの a) — サイズは 2 のままで eviction は起きない
    await memo.get('a', 60_001, load('a2'))
    expect(await memo.get('b', 2, load('b2'))).toBe('b1')
    // 新 key で最古 (b @1) が落ちる
    await memo.get('c', 3, load('c1'))
    loads = 0
    expect(await memo.get('b', 4, load('b3'))).toBe('b3')
    expect(loads).toBe(1)
    // a (@60_001) は生き残っている
    loads = 0
    expect(await memo.get('a', 60_002, load('a3'))).toBe('a2')
    expect(loads).toBe(0)
  })
})
