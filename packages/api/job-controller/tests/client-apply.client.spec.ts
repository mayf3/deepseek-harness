import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { RemoteStream, type RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it } from 'vitest'
import * as JobClient from '../src/client/index.ts'
import type { JobObserveFrame } from '../src/types.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...contexts].map(async (ctx) => { await ctx.fiber.dispose() }))
  contexts.clear()
})

/** Mount the client half over a captured `remote.job` namespace and a real Gateway stream carrier. */
async function mount(): Promise<{ ctx: Context; observeCalls: unknown[]; killCalls: unknown[] }> {
  const ctx = new Context()
  contexts.add(ctx)
  const observeCalls: unknown[] = []
  const killCalls: unknown[] = []
  const connection: ConnectionHandle = {
    isLoopback: true,
    generation: { getSnapshot: () => ({ id: 1, host: { home: '/home/fixture' } }), subscribe: () => () => {} },
    state: { getSnapshot: () => 'connected' as const, subscribe: () => () => {} },
    rpc: { call: () => Promise.reject(new Error('unexpected generic RPC call')) },
    reconnect: () => {},
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
  }
  const job = {
    // The fake stream never yields; opening and releasing must leave no view behind.
    observe: (request: unknown) => {
      observeCalls.push(request)
      return (async function* (): AsyncGenerator<JobObserveFrame> {})()
    },
    kill: async (request: unknown) => {
      killCalls.push(request)
      return { ok: true as const, value: { outcome: 'requested' as const } }
    },
  }
  ctx.reflect.provide('remote', {
    $stream: <Item>(options: RemoteStreamOptions<Item>) => new RemoteStream(connection, options),
    job,
  })
  ctx.reflect.provide('remote.job', job)
  await ctx.plugin(JobClient)
  return { ctx, observeCalls, killCalls }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

describe('Job Controller Client apply', () => {
  it('declares the Remote services it binds', () => {
    expect(JobClient.inject).toEqual(['remote', 'remote.job'])
  })

  it('installs ctx.jobOutput over the captured job namespace', async () => {
    const { ctx, observeCalls } = await mount()
    expect(ctx.jobOutput).toBeDefined()
    const stop = ctx.jobOutput.observe('session-1' as SessionId, 'bash-1' as never)
    await flush()
    expect(observeCalls).toEqual([{ sessionId: 'session-1', jobId: 'bash-1' }])
    stop()
    await flush()
    expect(ctx.jobOutput.state.getSnapshot().observed).toEqual({})
  })

  it('forwards a kill to the job namespace with the row\'s session', async () => {
    const { ctx, killCalls } = await mount()
    await expect(ctx.jobOutput.kill('session-1' as SessionId, 'bash-1' as never))
      .resolves.toEqual({ ok: true, value: { outcome: 'requested' } })
    expect(killCalls).toEqual([{ sessionId: 'session-1', jobId: 'bash-1' }])
  })
})
