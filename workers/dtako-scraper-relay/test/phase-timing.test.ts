import { describe, expect, it } from 'vitest'
import { measurePhase, PhaseTimer, phaseTimingLogLine } from '../src/phase-timing'

/** 呼ばれるたびに進む注入クロック。tick で任意に進められる。 */
function fakeClock(step = 0) {
  let t = 0
  const now = () => {
    const v = t
    t += step
    return v
  }
  return { now, tick: (ms: number) => { t += ms } }
}

describe('PhaseTimer', () => {
  it('measure は非同期フェーズの所要を記録して結果を素通しする', async () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    const result = await timer.measure('fetch', async () => {
      clock.tick(120)
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(timer.report().phases).toEqual([{ name: 'fetch', ms: 120 }])
  })

  it('measure は例外でも所要を記録して素通しする (計測がリクエストを壊さない)', async () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    await expect(
      timer.measure('fetch', async () => {
        clock.tick(50)
        throw new Error('upstream down')
      }),
    ).rejects.toThrow('upstream down')
    expect(timer.report().phases).toEqual([{ name: 'fetch', ms: 50 }])
  })

  it('measureSync は同期フェーズを記録する (例外も素通し)', () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    expect(
      timer.measureSync('merge', () => {
        clock.tick(3)
        return 42
      }),
    ).toBe(42)
    expect(() =>
      timer.measureSync('rows', () => {
        clock.tick(7)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(timer.report().phases).toEqual([
      { name: 'merge', ms: 3 },
      { name: 'rows', ms: 7 },
    ])
  })

  it('mark は 0ms フェーズとして出来事を残す (bytes は任意)', () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    timer.mark('cache-skip-kosoku-cur', 2_000_000)
    timer.mark('note')
    expect(timer.report().phases).toEqual([
      { name: 'cache-skip-kosoku-cur', ms: 0, bytes: 2_000_000 },
      { name: 'note', ms: 0 },
    ])
  })

  it('begin/end は既存コードを包みにくい区間を記録する', () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    const end = timer.begin('build')
    clock.tick(9)
    end()
    expect(timer.report().phases).toEqual([{ name: 'build', ms: 9 }])
  })

  it('setBytes はフェーズ確定後なら直接、確定前なら pending 経由で載る', async () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    // フェーズ確定前 (fetch 内部からの先行報告) → 確定時に合流
    await timer.measure('kosoku-cur', async () => {
      timer.setBytes('kosoku-cur', 1_700_000)
    })
    // フェーズ確定後の報告 → 既存エントリに直接載る
    await timer.measure('daily-cur', async () => {})
    timer.setBytes('daily-cur', 500)
    expect(timer.report().phases).toEqual([
      { name: 'kosoku-cur', ms: 0, bytes: 1_700_000 },
      { name: 'daily-cur', ms: 0, bytes: 500 },
    ])
  })

  it('totalMs は生成時からの経過、report の phases はコピー', () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    clock.tick(200)
    const report = timer.report()
    expect(report.totalMs).toBe(200)
    report.phases.push({ name: 'tamper', ms: 1 })
    expect(timer.report().phases).toEqual([])
  })

  it('serverTimingHeader は各フェーズ + total を dur で並べ、名前を token に落とす', async () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    await timer.measure('daily cur/1', async () => {
      clock.tick(1234)
    })
    clock.tick(66)
    expect(timer.serverTimingHeader()).toBe('daily-cur-1;dur=1234, total;dur=1300')
  })
})

describe('measurePhase', () => {
  it('timer があれば記録し、無ければ素通しする', async () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    expect(
      await measurePhase(timer, 'fetch', async () => {
        clock.tick(10)
        return 'a'
      }),
    ).toBe('a')
    expect(await measurePhase(undefined, 'fetch', async () => 'b')).toBe('b')
    expect(timer.report().phases).toEqual([{ name: 'fetch', ms: 10 }])
  })
})

describe('phaseTimingLogLine', () => {
  it('route/month/phases/totalMs/cacheState を 1 行 JSON にする', async () => {
    const clock = fakeClock()
    const timer = new PhaseTimer(clock.now)
    await timer.measure('kosoku-cur', async () => {
      timer.setBytes('kosoku-cur', 42)
      clock.tick(250)
    })
    clock.tick(5)
    const line = phaseTimingLogLine('wage-report', '2026-06', timer, 'live')
    expect(JSON.parse(line)).toEqual({
      phase_timing: 'wage-report',
      month: '2026-06',
      phases: [{ name: 'kosoku-cur', ms: 250, bytes: 42 }],
      totalMs: 255,
      cacheState: 'live',
    })
  })
})

describe('PhaseTimer (既定クロック)', () => {
  it('now 未注入でも動く (Date.now)', async () => {
    const timer = new PhaseTimer()
    await timer.measure('noop', async () => {})
    const { phases, totalMs } = timer.report()
    expect(phases).toHaveLength(1)
    expect(phases[0].ms).toBeGreaterThanOrEqual(0)
    expect(totalMs).toBeGreaterThanOrEqual(0)
  })
})
