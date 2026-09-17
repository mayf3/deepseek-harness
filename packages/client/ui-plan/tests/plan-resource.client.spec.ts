import { describe, expect, it, vi } from 'vitest'
import { planResourceProvider } from '../src/client/plan-resource.ts'

const address = 'dsh-resource://plan/session/call'
const event = { type: 'tool/call', seq: 1, data: { callId: 'call', name: 'exit_plan_mode', arguments: '{"plan":"# Saved plan"}' } }
const entry = { type: 'event', event }

function setup(records: unknown[], hasMore = false) {
  const closed = vi.fn()
  const follow = vi.fn(async function* () {
    try { yield { type: 'snapshot', cursor: 100, records, hasMore } }
    finally { closed() }
  })
  const page = vi.fn(async () => ({ ok: true, value: { records: [entry], hasMore: false } }))
  const provider = planResourceProvider({ follow, page } as unknown as Parameters<typeof planResourceProvider>[0])
  return { provider, follow, page, closed }
}

async function read(provider: ReturnType<typeof planResourceProvider>, url = address, signal = new AbortController().signal) {
  const values = []
  for await (const value of provider.open(url, { signal })) values.push(value)
  return values
}

describe('plan history resource', () => {
  it('restores the exact invocation and releases its snapshot stream', async () => {
    const b = setup([entry])
    expect(await read(b.provider)).toEqual([{ ok: true, value: { callId: 'call', markdown: '# Saved plan', title: 'Saved plan' } }])
    expect(b.closed).toHaveBeenCalledOnce()
    expect(b.page).not.toHaveBeenCalled()
  })
  it('pages older history with the fixed opening cursor without changing the chat window', async () => {
    const b = setup([{ type: 'event', event: { type: 'user/message', seq: 80, data: {} } }], true)
    expect((await read(b.provider))[0]).toMatchObject({ ok: true })
    expect(b.page).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 'session' }, throughSeq: 100, beforeSeq: 80 }, expect.any(AbortSignal))
    expect(b.closed).toHaveBeenCalledOnce()
  })
  it('reports missing plans and invalid saved addresses', async () => {
    const b = setup([])
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/not-found' } }])
    expect(await read(b.provider, 'dsh-resource://plan/s/%')).toMatchObject([{ ok: false, error: { code: 'plan/invalid-address' } }])
    expect(b.follow).toHaveBeenCalledOnce()
  })
  it('does not publish a response after cancellation', async () => {
    const b = setup([entry])
    const controller = new AbortController()
    controller.abort()
    expect(await read(b.provider, address, controller.signal)).toEqual([])
    expect(b.follow).not.toHaveBeenCalled()
  })
  it('reports stream failures and closes an empty stream', async () => {
    const b = setup([])
    b.follow.mockImplementationOnce(async function* () { throw new Error('connection lost') })
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/read-failed', message: 'connection lost' } }])
    b.follow.mockImplementationOnce(async function* () {})
    expect(await read(b.provider)).toMatchObject([{ ok: false, error: { code: 'plan/unavailable' } }])
  })
})
