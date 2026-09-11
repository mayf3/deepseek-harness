import { Context, Service } from '@deepseek-ai/cordis'
import { SandboxUnavailableError, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshSandboxProvider } from '../src/index.ts'

const policy: SandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/remote/link/..' }
const completeFacts = {
  argv: ['/usr/bin/bwrap', '--', 'true'], enforcement: 'full', denialSignatures: ['EROFS', 'EACCES'],
  runnerFailureRules: [{ allowedExitCodes: [1], fatalSignatures: ['bwrap:'], informationalLines: ['notice'] }],
}

async function setup(raw: unknown = completeFacts) {
  const ready = Promise.withResolvers<{ node: string; workspace: string }>()
  const entered = Promise.withResolvers<undefined>()
  const dispatch = vi.fn(async (_method: string, _params: unknown) => { entered.resolve(undefined); return raw })
  class Connection extends Service {
    readonly helperPath = '/opt/dsh/helper.js'
    readonly ready = ready.promise
    constructor(ctx: Context) { super(ctx, 'ssh') }
    async request<T>(method: string, params: unknown, result: z.ZodType<T>): Promise<T> {
      return result.parse(await dispatch(method, params))
    }
  }
  const ctx = new Context()
  const connection = await ctx.plugin(Connection)
  const fiber = ctx.plugin(SshSandboxProvider)
  onTestFinished(async () => {
    ready.resolve({ node: '/usr/bin/node', workspace: '/remote/work' })
    await fiber.dispose()
    await connection.dispose()
  })
  return { ctx, fiber, ready, dispatch, entered }
}

describe('SSH sandbox provider', () => {
  it('refuses wrapping before remote backend readiness and then carries verified facts', async () => {
    const state = await setup()
    expect(() => state.ctx.sandbox.confine(['/usr/bin/node', '-e', '42'], policy)).toThrow(SandboxUnavailableError)
    expect(state.dispatch).not.toHaveBeenCalled()
    state.ready.resolve({ node: '/usr/bin/node', workspace: '/remote/work' })
    await state.fiber
    expect(state.dispatch).toHaveBeenCalledWith('sandbox', {
      argv: ['true'], policy: { mode: 'read-only', workspaceRoot: '/remote/work' },
    })
    const argv = ['/usr/bin/node', '-e', 'console.log("shell $() ; quotes")']
    const confined = state.ctx.sandbox.confine(argv, policy)
    expect(confined.argv.slice(0, 3)).toEqual(['/usr/bin/node', '/opt/dsh/helper.js', '--confine'])
    expect(JSON.parse(confined.argv[3]!)).toEqual({
      policy, runner: '/usr/bin/bwrap', enforcement: 'full', denialSignatures: ['EROFS', 'EACCES'],
    })
    expect(confined.argv.slice(4)).toEqual(['--', ...argv])
    expect(confined.enforcement).toBe('full')
    expect(confined.denialSignatures).toEqual(['EROFS', 'EACCES'])
    expect(confined.runnerFailureRules).toEqual([
      ...completeFacts.runnerFailureRules, { allowedExitCodes: [127], fatalSignatures: ['dsh-ssh-sandbox: '] },
    ])
    expect(state.dispatch).toHaveBeenCalledTimes(1)
  })

  it('preserves partial enforcement and omitted runner-rule fields', async () => {
    const state = await setup({ ...completeFacts, enforcement: 'partial', runnerFailureRules: [{ fatalSignatures: ['runner unavailable'] }] })
    state.ready.resolve({ node: '/usr/bin/node', workspace: '/remote/work' })
    await state.fiber
    const confined = state.ctx.sandbox.confine(['true'], policy)
    expect(confined.enforcement).toBe('partial')
    expect(confined.runnerFailureRules[0]).toEqual({ fatalSignatures: ['runner unavailable'] })
  })

  it.each([null, { ...completeFacts, enforcement: 'unknown' }, { ...completeFacts, runnerFailureRules: [{ fatalSignatures: 1 }] }])(
    'refuses malformed backend observations during service readiness', async (raw) => {
      const state = await setup(raw)
      const rejected = expect(state.fiber).rejects.toThrow()
      state.ready.resolve({ node: '/usr/bin/node', workspace: '/remote/work' })
      await rejected
      expect(() => state.ctx.sandbox.confine(['true'], policy)).toThrow()
    },
  )

  it('propagates remote backend discovery failure before publishing a wrapper', async () => {
    const state = await setup()
    state.dispatch.mockRejectedValueOnce(new Error('remote sandbox unavailable'))
    const rejected = expect(state.fiber).rejects.toThrow('remote sandbox unavailable')
    state.ready.resolve({ node: '/usr/bin/node', workspace: '/remote/work' })
    await rejected
    expect(state.dispatch).toHaveBeenCalledTimes(1)
  })
})
