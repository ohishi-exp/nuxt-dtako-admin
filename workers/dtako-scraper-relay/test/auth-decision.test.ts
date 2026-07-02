import { describe, expect, it } from 'vitest'
import { decideRelayAuth } from '../src/auth-decision'

describe('decideRelayAuth', () => {
  it('accepts when introspect is active', () => {
    expect(decideRelayAuth({ active: true })).toEqual({ status: 101 })
  })

  it('rejects when introspect is inactive', () => {
    expect(decideRelayAuth({ active: false })).toEqual({ status: 401 })
  })

  it('rejects when result is null', () => {
    expect(decideRelayAuth(null)).toEqual({ status: 401 })
  })

  it('rejects when result is undefined', () => {
    expect(decideRelayAuth(undefined)).toEqual({ status: 401 })
  })
})
