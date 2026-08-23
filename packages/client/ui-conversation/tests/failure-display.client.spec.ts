import { describe, expect, it } from 'vitest'
import { displayFailure } from '../src/client/conversation/failure-display.ts'

describe('displayFailure', () => {
  it('keeps ordinary diagnostics and stable provider codes', () => {
    expect(displayFailure(null)).toEqual({ message: 'null' })
    expect(displayFailure('disconnected')).toEqual({ message: 'disconnected' })
    expect(displayFailure({ code: 'RATE_LIMIT', message: 'try later' })).toEqual({
      code: 'RATE_LIMIT',
      message: 'try later',
    })
    expect(displayFailure({ detail: 'unknown' })).toEqual({
      message: '{"detail":"unknown"}',
    })
  })

  it('removes the provider message when AUTH owns localized display copy', () => {
    expect(displayFailure({ code: 'AUTH', message: 'credential sk-secret failed' })).toEqual({
      code: 'AUTH',
      message: '',
    })
  })
})
