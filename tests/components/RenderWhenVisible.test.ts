// 画面に入るまで描かない入れ物のテスト (Refs #472)
//
// happy-dom は IntersectionObserver を持たないので、**観測対象と callback を掴める
// 偽物**を差して「いつ描くか」を固定する。実ブラウザでの発火そのものは検証できないが、
// ①最初は描かない ②交差したら描く ③一度描いたら消さない ④force で即描く
// ⑤IntersectionObserver が無ければ最初から描く の 5 点はここで守れる。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import RenderWhenVisible from '../../app/components/RenderWhenVisible.vue'

interface FakeObserver {
  callback: IntersectionObserverCallback
  observed: Element[]
  disconnected: boolean
}

const observers: FakeObserver[] = []

function installFakeObserver() {
  observers.length = 0
  class Fake {
    callback: IntersectionObserverCallback
    observed: Element[] = []
    disconnected = false
    constructor(cb: IntersectionObserverCallback) {
      this.callback = cb
      observers.push(this as unknown as FakeObserver)
    }

    observe(el: Element) { this.observed.push(el) }
    disconnect() { this.disconnected = true }
    unobserve() {}
    takeRecords() { return [] }
  }
  vi.stubGlobal('IntersectionObserver', Fake as unknown as typeof IntersectionObserver)
}

/** 観測中の要素が画面に入ったことにする。 */
function intersect(index = 0, isIntersecting = true) {
  const o = observers[index]!
  o.callback(
    [{ isIntersecting } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const slot = { default: () => '中身' }

describe('RenderWhenVisible', () => {
  it('最初は描かず、高さだけ確保する', () => {
    installFakeObserver()
    const w = mount(RenderWhenVisible, { props: { minHeight: '34rem' }, slots: slot })
    expect(w.text()).toBe('')
    expect(w.attributes('style')).toContain('min-height: 34rem')
    // 自分自身を観測している
    expect(observers[0]!.observed.length).toBe(1)
  })

  it('画面に入ったら描き、確保していた高さを外す', async () => {
    installFakeObserver()
    const w = mount(RenderWhenVisible, { slots: slot })
    intersect()
    await w.vm.$nextTick()
    expect(w.text()).toBe('中身')
    expect(w.attributes('style')).toBeUndefined()
    // 描いたら観測はやめる
    expect(observers[0]!.disconnected).toBe(true)
  })

  it('交差していない通知では描かない', async () => {
    installFakeObserver()
    const w = mount(RenderWhenVisible, { slots: slot })
    intersect(0, false)
    await w.vm.$nextTick()
    expect(w.text()).toBe('')
    expect(observers[0]!.disconnected).toBe(false)
  })

  it('一度描いたら消さない (往復のたびに作り直さない)', async () => {
    installFakeObserver()
    const w = mount(RenderWhenVisible, { slots: slot })
    intersect()
    await w.vm.$nextTick()
    intersect(0, false)
    await w.vm.$nextTick()
    expect(w.text()).toBe('中身')
  })

  it('force を立てると即描く (印刷は一覧が揃っていないと意味が無い)', async () => {
    installFakeObserver()
    const w = mount(RenderWhenVisible, { props: { force: false }, slots: slot })
    expect(w.text()).toBe('')
    await w.setProps({ force: true })
    expect(w.text()).toBe('中身')
  })

  it('最初から force なら観測しない', () => {
    installFakeObserver()
    const w = mount(RenderWhenVisible, { props: { force: true }, slots: slot })
    expect(w.text()).toBe('中身')
    expect(observers.length).toBe(0)
  })

  // 「IntersectionObserver が無い環境では最初から描く」経路はここでは検証できない —
  // happy-dom の `IntersectionObserver` は消せず (`vi.stubGlobal(..., undefined)` も
  // `delete` も効かない)、実装を差し替える手立てが無い。実装側の保険として残す。

  it('外されたら観測を止める', () => {
    installFakeObserver()
    const w = mount(RenderWhenVisible, { slots: slot })
    w.unmount()
    expect(observers[0]!.disconnected).toBe(true)
  })
})
