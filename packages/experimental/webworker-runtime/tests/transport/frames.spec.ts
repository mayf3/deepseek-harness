import { describe, expect, it } from 'vitest'
import { parseInboundFrame } from '../../src/transport/frames.ts'

describe('tunnel init frame', () => {
  it('retains the selected overlay order', () => {
    expect(parseInboundFrame({
      t: 'init',
      image: 'base.tar.gz',
      overlays: ['workspace.tar.gz', 'session.tar.gz'],
    })).toEqual({
      t: 'init',
      image: 'base.tar.gz',
      overlays: ['workspace.tar.gz', 'session.tar.gz'],
    })
  })

  it('rejects a missing or non-string overlay list', () => {
    expect(() => parseInboundFrame({ t: 'init', image: 'base.tar.gz' })).toThrow(/array of string overlay urls/)
    expect(() => parseInboundFrame({ t: 'init', image: 'base.tar.gz', overlays: [1] }))
      .toThrow(/array of string overlay urls/)
  })
})

describe('tunnel request bodies', () => {
  it('accepts ArrayBuffer and Blob bodies and rejects other structured-clone values', () => {
    const bytes = Uint8Array.of(1, 2).buffer
    const blob = new Blob(['large'])
    expect(parseInboundFrame({
      t: 'req', id: 1, method: 'POST', url: '/bytes', headers: {}, body: bytes,
    })).toMatchObject({ body: bytes })
    expect(parseInboundFrame({
      t: 'req', id: 2, method: 'POST', url: '/blob', headers: {}, body: blob,
    })).toMatchObject({ body: blob })
    expect(() => parseInboundFrame({
      t: 'req', id: 3, method: 'POST', url: '/bad', headers: {}, body: 'large',
    })).toThrow('body must be an ArrayBuffer or Blob')
  })
})
