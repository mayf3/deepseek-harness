import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ActivityId } from '@deepseek-ai/dsh-activity'
import type { ActivityHandle, ActivitySnapshot } from '@deepseek-ai/dsh-activity'
import LocalActivityRegistry, { type Config as ProcessConfig } from '@deepseek-ai/dsh-activity-local'

declare module '@deepseek-ai/dsh-activity' {
  interface ActivityKindMap {
    workflow: 'workflow'
  }
}

const agentScopeDisposers = new WeakMap<Agent, () => Promise<void>>()

/**
 * A minimal live agent whose ctx carries its own scope on a disposable plugin
 * fiber, mirroring the harness convention that a live agent keys its scope.
 */
function stubAgent(ctx: Context, rawId: string): Agent {
  const id = SessionId(rawId)
  const scopeFiber = ctx.plugin(() => {})
  const agentCtx = createScope(scopeFiber.ctx, {}).ctx
  const session = Session.create(id)
  const agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle' as const,
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  agentScopeDisposers.set(agent, async () => { await scopeFiber.dispose() })
  return agent
}

async function disposeAgentScope(agent: Agent): Promise<void> {
  const dispose = agentScopeDisposers.get(agent)
  if (dispose === undefined) throw new Error(`missing test scope for agent "${agent.id}"`)
  await dispose()
}

async function harness(config: ProcessConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalActivityRegistry, config)
  return ctx
}

/** Concatenated retained text of one process, as an observer from `from` sees it. */
function textFrom(ctx: Context, id: ActivityId, from = 0): string {
  return ctx.activities.read(id, from).chunks.map(chunk => chunk.text).join('')
}

describe('LocalActivityRegistry.open', () => {
  it('mints per-kind ordinal ids and announces the new visible row', async () => {
    const ctx = await harness()
    const changes: (Agent | undefined)[] = []
    ctx.activities.onActivitiesChanged((owner) => { changes.push(owner) })
    const first = ctx.activities.open({ kind: 'bash', label: 'sleep 60' })
    const second = ctx.activities.open({ kind: 'workflow', label: 'run docs' })
    const third = ctx.activities.open({ kind: 'bash', label: 'build' })
    expect([first.id, second.id, third.id]).toEqual(['bash-1', 'workflow-1', 'bash-2'])
    expect(changes).toEqual([undefined, undefined, undefined])
    expect(ctx.activities.list().map(snapshot => snapshot.id)).toEqual(['bash-1', 'workflow-1', 'bash-2'])
  })

  it('rejects an empty kind or label without minting an id', async () => {
    const ctx = await harness()
    expect(() => ctx.activities.open({ kind: '' as never, label: 'x' })).toThrow(/invalid activity kind/)
    expect(() => ctx.activities.open({ kind: 'bash', label: '' })).toThrow(/invalid activity label/)
    expect(ctx.activities.list()).toEqual([])
  })

  it('rejects an owned open when no agent registry is loaded', async () => {
    const bare = new Context()
    await bare.plugin(LocalActivityRegistry)
    const ghost = { id: SessionId('ghost'), ctx: bare } as unknown as Agent
    expect(() => bare.activities.open({ kind: 'bash', label: 'x', owner: ghost }))
      .toThrow(/activity ownership requires the agent registry/)
  })

  it('rejects an owner that is not the registered agent instance', async () => {
    const ctx = await harness()
    const ghost = stubAgent(ctx, 'ghost')
    expect(() => ctx.activities.open({ kind: 'bash', label: 'x', owner: ghost }))
      .toThrow(/not the registered agent instance/)
  })

  it('carries owner session and correlation into snapshots', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const handle = ctx.activities.open({
      kind: 'bash',
      label: 'npm test',
      owner,
      correlation: { jobId: 'bash-9' as never, callId: 'call-3' as never },
    })
    const snapshot = ctx.activities.get(handle.id, owner)
    expect(snapshot.ownerSession).toBe(owner.id)
    expect(snapshot.correlation).toEqual({ jobId: 'bash-9', callId: 'call-3' })
    expect(snapshot.status).toBe('running')
  })
})

describe('LocalActivityRegistry output', () => {
  it('appends advance absolute offsets and reads are non-consuming', async () => {
    const ctx = await harness()
    const handle = ctx.activities.open({ kind: 'bash', label: 'echo' })
    handle.append('hello ')
    handle.append('world', { channel: 'stderr' })
    const first = ctx.activities.read(handle.id, 0)
    expect(first.lossy).toBe(false)
    expect(first.next).toBe(11)
    expect(first.chunks).toEqual([
      { at: 0, text: 'hello ' },
      { at: 6, text: 'world', channel: 'stderr' },
    ])
    // A second identical read proves nothing was consumed.
    expect(ctx.activities.read(handle.id, 0)).toEqual(first)
    // Resuming from `next` yields nothing until more output arrives.
    expect(ctx.activities.read(handle.id, first.next).chunks).toEqual([])
    handle.append('!')
    expect(ctx.activities.read(handle.id, first.next).chunks).toEqual([{ at: 11, text: '!' }])
    const snapshot = ctx.activities.get(handle.id)
    expect(snapshot.outputTotal).toBe(12)
    expect(snapshot.outputEarliest).toBe(0)
  })

  it('drops an empty append without waking observers', async () => {
    const ctx = await harness()
    const signals: ActivityId[] = []
    ctx.activities.onOutput((id) => { signals.push(id) })
    const handle = ctx.activities.open({ kind: 'bash', label: 'quiet' })
    handle.append('')
    expect(signals).toEqual([])
    expect(ctx.activities.get(handle.id).outputTotal).toBe(0)
  })

  it('rejects a negative or fractional read offset', async () => {
    const ctx = await harness()
    const handle = ctx.activities.open({ kind: 'bash', label: 'echo' })
    expect(() => ctx.activities.read(handle.id, -1)).toThrow(/invalid read offset/)
    expect(() => ctx.activities.read(handle.id, 0.5)).toThrow(/invalid read offset/)
  })

  it('evicts whole head chunks past the live cap and flags stale readers lossy', async () => {
    const ctx = await harness({ retainBytes: 8 })
    const handle = ctx.activities.open({ kind: 'bash', label: 'spam' })
    handle.append('aaaa')
    handle.append('bbbb')
    handle.append('cccc')
    const read = ctx.activities.read(handle.id, 0)
    expect(read.lossy).toBe(true)
    expect(read.chunks).toEqual([{ at: 4, text: 'bbbb' }, { at: 8, text: 'cccc' }])
    expect(read.next).toBe(12)
    const snapshot = ctx.activities.get(handle.id)
    expect(snapshot.outputEarliest).toBe(4)
    expect(snapshot.outputTotal).toBe(12)
    // A reader at the retained boundary is not lossy.
    expect(ctx.activities.read(handle.id, 4).lossy).toBe(false)
  })

  it('keeps only the UTF-8-safe tail of a single oversized chunk', async () => {
    const ctx = await harness({ retainBytes: 5 })
    const handle = ctx.activities.open({ kind: 'bash', label: 'wide' })
    // '你好' is six UTF-8 bytes; a five-byte budget must not split the second code point.
    handle.append('你好')
    const read = ctx.activities.read(handle.id, 0)
    expect(read.lossy).toBe(true)
    expect(read.chunks).toEqual([{ at: 3, text: '好', gapBefore: true }])
    const snapshot = ctx.activities.get(handle.id)
    expect(snapshot.outputEarliest).toBe(3)
    expect(snapshot.outputTotal).toBe(6)
  })

  it('returns the whole overlapped chunk for a foreign mid-chunk offset', async () => {
    const ctx = await harness()
    const handle = ctx.activities.open({ kind: 'bash', label: 'echo' })
    handle.append('abcdef')
    const read = ctx.activities.read(handle.id, 3)
    expect(read.chunks).toEqual([{ at: 0, text: 'abcdef' }])
    expect(read.lossy).toBe(false)
  })

  it('preserves a producer-reported gap marker through reads', async () => {
    const ctx = await harness()
    const handle = ctx.activities.open({ kind: 'bash', label: 'lossy source' })
    handle.append('tail after drop', { gapBefore: true, channel: 'stdout' })
    expect(ctx.activities.read(handle.id, 0).chunks).toEqual([
      { at: 0, text: 'tail after drop', channel: 'stdout', gapBefore: true },
    ])
  })
})

describe('LocalActivityRegistry settlement', () => {
  it('records the first terminal outcome and trims retention to the settled cap', async () => {
    const ctx = await harness({ retainBytes: 1024, settledRetainBytes: 4 })
    const handle = ctx.activities.open({ kind: 'bash', label: 'build' })
    handle.append('abcdefgh')
    handle.end({ status: 'completed', detail: 'exit code: 0' })
    const snapshot = ctx.activities.get(handle.id)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.detail).toBe('exit code: 0')
    expect(snapshot.finishedAt).toBeDefined()
    const read = ctx.activities.read(handle.id, 0)
    expect(read.lossy).toBe(true)
    expect(read.chunks).toEqual([{ at: 4, text: 'efgh', gapBefore: true }])
  })

  it('is first-wins: a later end and post-end writes are dropped without throwing', async () => {
    const ctx = await harness()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const handle = ctx.activities.open({ kind: 'bash', label: 'build' })
    handle.end({ status: 'killed', detail: 'owner disposed' })
    handle.end({ status: 'completed' })
    handle.append('late')
    handle.updateDetail('late detail')
    const snapshot = ctx.activities.get(handle.id)
    expect(snapshot.status).toBe('killed')
    expect(snapshot.detail).toBe('owner disposed')
    expect(snapshot.outputTotal).toBe(0)
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining('append to ended activity'),
      expect.stringContaining('detail update on ended activity'),
    ])
  })

  it('signals observers for appends and once more at settlement', async () => {
    const ctx = await harness()
    const signals: ActivityId[] = []
    ctx.activities.onOutput((id) => { signals.push(id) })
    const handle = ctx.activities.open({ kind: 'bash', label: 'echo' })
    handle.append('a')
    handle.append('b')
    handle.end({ status: 'completed' })
    expect(signals).toEqual([handle.id, handle.id, handle.id])
  })

  it('updateDetail changes the visible row without touching output offsets', async () => {
    const ctx = await harness()
    const changes: (Agent | undefined)[] = []
    ctx.activities.onActivitiesChanged((owner) => { changes.push(owner) })
    const handle = ctx.activities.open({ kind: 'workflow', label: 'docs run' })
    handle.updateDetail('3/10 agents done')
    expect(ctx.activities.get(handle.id).detail).toBe('3/10 agents done')
    expect(ctx.activities.get(handle.id).outputTotal).toBe(0)
    expect(changes).toHaveLength(2)
  })
})

describe('LocalActivityRegistry visibility and delivery', () => {
  it('fences owned processes by session id and keeps unowned ones open', async () => {
    const ctx = await harness()
    const alice = stubAgent(ctx, 'alice')
    const bob = stubAgent(ctx, 'bob')
    ctx.agents.register(alice)
    ctx.agents.register(bob)
    const owned = ctx.activities.open({ kind: 'bash', label: 'alice job', owner: alice })
    const open = ctx.activities.open({ kind: 'bash', label: 'shared' })
    owned.append('secret')
    expect(ctx.activities.list(alice).map(snapshot => snapshot.id)).toEqual([owned.id, open.id])
    expect(ctx.activities.list(bob).map(snapshot => snapshot.id)).toEqual([open.id])
    expect(ctx.activities.list().map(snapshot => snapshot.id)).toEqual([open.id])
    expect(() => ctx.activities.get(owned.id, bob)).toThrow(/belongs to another session/)
    expect(() => ctx.activities.read(owned.id, 0)).toThrow(/belongs to another session/)
    expect(textFrom(ctx, open.id)).toBe('')
    expect(ctx.activities.read(owned.id, 0, alice).chunks[0]?.text).toBe('secret')
  })

  it('delivers scoped listeners only their own agents and global listeners everything', async () => {
    const ctx = await harness()
    const alice = stubAgent(ctx, 'alice')
    const bob = stubAgent(ctx, 'bob')
    ctx.agents.register(alice)
    ctx.agents.register(bob)
    const globalOwners: (string | undefined)[] = []
    ctx.activities.onActivitiesChanged((owner) => { globalOwners.push(owner?.id) })
    const scopedOwners: (string | undefined)[] = []
    await alice.ctx.plugin({
      inject: ['activities'],
      apply(scopedCtx: Context) {
        scopedCtx.activities.onActivitiesChanged((owner) => { scopedOwners.push(owner?.id) })
      },
    })
    const scopedOutputs: string[] = []
    const scopedFiber = await alice.ctx.plugin({
      inject: ['activities'],
      apply(scopedCtx: Context) {
        scopedCtx.activities.onOutput((id) => { scopedOutputs.push(String(id)) })
      },
    })
    const aliceHandle = ctx.activities.open({ kind: 'bash', label: 'alice work', owner: alice })
    aliceHandle.append('scoped delivery probe')
    expect(scopedOutputs).toEqual([String(aliceHandle.id)])
    ctx.activities.open({ kind: 'bash', label: 'bob work', owner: bob })
    ctx.activities.open({ kind: 'bash', label: 'unowned' })
    expect(globalOwners).toEqual(['alice', 'bob', undefined])
    expect(scopedOwners).toEqual(['alice'])
    // Disposing one scoped registrant probes layer reclamation; the sibling
    // scoped changed-listener keeps the layer alive and keeps delivering.
    await scopedFiber.dispose()
    ctx.activities.open({ kind: 'bash', label: 'alice later', owner: alice })
    expect(scopedOwners).toEqual(['alice', 'alice'])

    // A scope whose only contribution goes empties on disposal and is reclaimed.
    const bobFiber = await bob.ctx.plugin({
      inject: ['activities'],
      apply(scopedCtx: Context) {
        scopedCtx.activities.onOutput(() => {})
      },
    })
    await bobFiber.dispose()
  })

  it('contains throwing listeners without breaking the commit', async () => {
    const ctx = await harness()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    ctx.activities.onActivitiesChanged(() => { throw new Error('changed boom') })
    ctx.activities.onOutput(() => { throw new Error('output boom') })
    const seen: (Agent | undefined)[] = []
    ctx.activities.onActivitiesChanged((owner) => { seen.push(owner) })
    const handle = ctx.activities.open({ kind: 'bash', label: 'echo' })
    handle.append('x')
    expect(seen).toHaveLength(1)
    expect(ctx.activities.get(handle.id).outputTotal).toBe(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onActivitiesChanged listener threw'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onOutput listener threw'))
  })

  it('unregisters listeners with their registering fiber', async () => {
    const ctx = await harness()
    const signals: ActivityId[] = []
    const fiber = ctx.plugin({
      inject: ['activities'],
      apply(pluginCtx: Context) {
        pluginCtx.activities.onOutput((id) => { signals.push(id) })
      },
    })
    await fiber
    const handle = ctx.activities.open({ kind: 'bash', label: 'echo' })
    handle.append('a')
    expect(signals).toHaveLength(1)
    await fiber.dispose()
    handle.append('b')
    expect(signals).toHaveLength(1)
  })
})

describe('LocalActivityRegistry lifecycle', () => {
  it('owner disposal ends open records, removes rows, and announces the removal', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const handle = ctx.activities.open({ kind: 'bash', label: 'sleep', owner })
    handle.append('partial')
    const settledEarly = ctx.activities.open({ kind: 'bash', label: 'done already', owner })
    settledEarly.end({ status: 'completed' })
    const changes: (string | undefined)[] = []
    ctx.activities.onActivitiesChanged((changed) => { changes.push(changed?.id) })
    await disposeAgentScope(owner)
    expect(ctx.activities.list(owner)).toEqual([])
    expect(() => ctx.activities.get(handle.id, owner)).toThrow(/unknown activity/)
    // The forced end and the removal both announced under the owner.
    expect(changes.length).toBeGreaterThanOrEqual(2)
    expect(new Set(changes)).toEqual(new Set(['owner']))
    // The producer's own late report is dropped silently, not thrown.
    expect(() => { handle.end({ status: 'completed' }) }).not.toThrow()
  })

  it('service disposal ends everything, clears the store, and announces emptied owners', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const registryFiber = ctx.plugin(LocalActivityRegistry, {})
    await registryFiber
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const processes = ctx.activities
    const owned = processes.open({ kind: 'bash', label: 'owned', owner })
    processes.open({ kind: 'bash', label: 'unowned' })
    const preSettled = processes.open({ kind: 'bash', label: 'already settled' })
    preSettled.end({ status: 'completed' })
    const changes: (string | undefined)[] = []
    ctx.activities.onActivitiesChanged((changed) => { changes.push(changed?.id) })
    await registryFiber.dispose()
    expect(changes).toEqual(expect.arrayContaining(['owner', undefined]))
    expect(() => { owned.append('late') }).not.toThrow()
  })
})

describe('LocalActivityRegistry snapshots', () => {
  it('hands out fresh snapshots, never live registry state', async () => {
    const ctx = await harness()
    const handle: ActivityHandle = ctx.activities.open({ kind: 'bash', label: 'echo' })
    const before: ActivitySnapshot = ctx.activities.get(handle.id)
    handle.append('grow')
    expect(before.outputTotal).toBe(0)
    expect(ctx.activities.get(handle.id).outputTotal).toBe(4)
  })
})
