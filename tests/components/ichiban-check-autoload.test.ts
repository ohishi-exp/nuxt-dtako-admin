/**
 * `/ichiban-check` は開いた時 (新規読み込み・更新) に今月の突合を自動で読む。
 * 月を変えただけでは読まない (1 回 40 秒の重い計算なので、押すのは人)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

vi.mock('~/utils/api', () => ({
  currentAccessToken: vi.fn(() => 'dummy-token'),
}))

import IchibanCheckPage from '~/pages/ichiban-check.vue'

afterEach(() => { vi.unstubAllGlobals() })

/** `$fetch` の呼び出しを `path?month=…` で記録し、空の突合 (差なし) を返す。 */
function stubFetch() {
  const calls: string[] = []
  vi.stubGlobal('$fetch', async (url: string, opts?: { query?: Record<string, string> }) => {
    calls.push(`${url}?${new URLSearchParams(opts?.query ?? {})}`)
    return {}
  })
  return calls
}

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

describe('/ichiban-check の自動読み込み', () => {
  it('開いた時に今月の突合を 1 回だけ読む', async () => {
    const calls = stubFetch()
    const w = mount(IchibanCheckPage, {
      global: {
        stubs: {
          ...NUXT_UI_PAGE_STUBS,
          UInput: { props: ['modelValue'], emits: ['update:modelValue'], template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
        },
      },
    })
    await flushPromises()
    const checks = calls.filter(u => u.includes('/restraint-api/kintai/ichiban-check'))
    expect(checks).toHaveLength(1)
    expect(checks[0]).toContain(`month=${thisMonth()}`)
    expect(w.text()).toContain('一番星とデジタコの差がありません')

    // 月を変えただけでは読まない
    await w.find('input').setValue('2020-01')
    await flushPromises()
    expect(calls.filter(u => u.includes('/restraint-api/kintai/ichiban-check'))).toHaveLength(1)
  })
})
