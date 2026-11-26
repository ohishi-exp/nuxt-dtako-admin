/**
 * 機械用の資格情報の部品 `MachineCredentials` を、どの画面がどの用途で置くか (Refs #1287)。
 *
 * #1288 では `/fuel/credentials` に用途の選択 (select) を足して `etc-scan` も出していたが、
 * 「給油の画面から ETC の資格情報を出す」のは不自然なので `/etc-cards` へ移した。
 * ここで固定するのは:
 *   - `/fuel/credentials` に用途の選択が無く、API は `fuel-utran` でしか呼ばれない
 *   - 部品は渡された用途で API を呼び、`etc-scan` だけ発行直後に複合機の設定例 (curl つき) を出す
 *   - `/etc-cards` が部品を `etc-scan` で置いている
 * **カバレッジ目的ではない** (UI は coverage_100 の対象外)。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'
import type { Purpose } from '~/utils/machine-credentials'

const { calls, api } = vi.hoisted(() => {
  const calls: { method: string, purpose: string }[] = []
  return {
    calls,
    api: { getter: null as null | (() => string) },
  }
})

mockNuxtImport('useMachineCredentialApi', () => (purpose: () => string) => {
  api.getter = purpose
  return {
    list: async () => { calls.push({ method: 'list', purpose: purpose() }); return [] },
    issue: async () => { calls.push({ method: 'issue', purpose: purpose() }); return { username: 'mc_new', password: 'secret' } },
    revoke: async () => ({}),
    rotate: async () => ({ username: 'mc_new', password: 'secret2' }),
  }
})
mockNuxtImport('useRuntimeConfig', () => () => ({ public: { authWorkerUrl: 'https://auth.example.test/' } }))

import CredentialsPage from '~/pages/fuel/credentials.vue'
import MachineCredentials from '~/components/MachineCredentials.vue'

const STUBS = {
  ...NUXT_UI_PAGE_STUBS,
  UFormField: { name: 'UFormField', props: ['label', 'error', 'description'], template: '<label>{{ label }}<slot /></label>' },
  UInput: {
    name: 'UInput',
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  UModal: { name: 'UModal', props: ['open'], template: '<div v-if="open"><slot name="content" /></div>' },
}

beforeEach(() => {
  calls.length = 0
  api.getter = null
})

describe('/fuel/credentials は fuel-utran 固定', () => {
  it('用途の選択が無く、一覧は fuel-utran で読む', async () => {
    const w = mount(CredentialsPage, { global: { stubs: STUBS } })
    await flushPromises()
    expect(w.find('select').exists()).toBe(false)
    expect(w.find('[data-testid="purpose-select"]').exists()).toBe(false)
    expect(w.find('[data-purpose]').attributes('data-purpose')).toBe('fuel-utran')
    expect(calls).toEqual([{ method: 'list', purpose: 'fuel-utran' }])
    expect(w.text()).toContain('給油アップローダーの資格情報')
    expect(w.text()).not.toContain('複合機')
  })
})

async function issueOn(purpose: Purpose) {
  const w = mount(MachineCredentials, { props: { purpose }, global: { stubs: STUBS } })
  await flushPromises()
  await w.find('input').setValue('本社')
  await w.findAll('button').find(b => b.text() === '発行')!.trigger('click')
  await flushPromises()
  return w
}

describe('MachineCredentials の発行直後の表示', () => {
  it('etc-scan は複合機の設定例と curl を出す (API も etc-scan)', async () => {
    const w = await issueOn('etc-scan')
    expect(calls.map(c => c.purpose)).toEqual(['etc-scan', 'etc-scan', 'etc-scan'])
    const shown = w.find('[data-testid="issued-credential"]')
    expect(shown.text()).toContain('WebDAV')
    expect(shown.text()).toContain('https://auth.example.test')
    expect(shown.text()).toContain('/m/etc-scan/scan')
    expect(w.find('[data-testid="issued-curl"]').text()) // gitleaks:allow (テスト用のダミー値)
      .toBe('curl -T test.pdf -u mc_new:secret https://auth.example.test/m/etc-scan/scan/test.pdf') // gitleaks:allow (テスト用のダミー値)
  })
  it('fuel-utran は username / password だけ (設定例も curl も無い)', async () => {
    const w = await issueOn('fuel-utran')
    expect(calls.map(c => c.purpose)).toEqual(['fuel-utran', 'fuel-utran', 'fuel-utran'])
    const shown = w.find('[data-testid="issued-credential"]')
    expect(shown.text()).toContain('mc_new')
    expect(shown.text()).toContain('secret')
    expect(shown.text()).not.toContain('WebDAV')
    expect(w.find('[data-testid="issued-curl"]').exists()).toBe(false)
  })
})

describe('/etc-cards は部品を etc-scan で置く', () => {
  it('テンプレートに <MachineCredentials purpose="etc-scan" /> がある', () => {
    // etc-cards.vue の mount は D1 の一覧取得まで偽物が要るので、置き方だけを source で見る
    const src = readFileSync(resolve(import.meta.dirname!, '../../app/pages/etc-cards.vue'), 'utf8')
    expect(src).toContain('<MachineCredentials purpose="etc-scan" />')
    expect(src).not.toContain('to="/fuel/credentials"')
  })
})
