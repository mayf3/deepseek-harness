import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  createSessionTestController,
  createSessionTestRemote,
  testSessionPersistence,
} from './test-remote.ts'

async function context(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

describe('session/openWorkspacePath', () => {
  it('resolves a relative path against the attached Session cwd', async () => {
    const ctx = await context()
    const sessionId = SessionId('open-relative')
    ctx.sessions.create(sessionId, { meta: { cwd: '/workspace/project' } })
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })
    const signal = new AbortController().signal

    await expect(remote.openWorkspacePath({ sessionId, path: 'src/a.ts' }, signal))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(openPath).toHaveBeenCalledWith('/workspace/project/src/a.ts', signal)
    expect(ctx.agents.list()).toEqual([])
  })

  it('preserves absolute paths and cwd-less Session paths', async () => {
    const ctx = await context()
    const withCwd = SessionId('open-absolute')
    const withoutCwd = SessionId('open-without-cwd')
    ctx.sessions.create(withCwd, { meta: { cwd: '/workspace/project' } })
    ctx.sessions.create(withoutCwd)
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })

    await remote.openWorkspacePath({ sessionId: withCwd, path: '/tmp/result.html' })
    await remote.openWorkspacePath({ sessionId: withoutCwd, path: 'result.html' })
    expect(openPath.mock.calls.map(call => call[0])).toEqual(['/tmp/result.html', 'result.html'])
  })

  it('rejects empty paths and missing Sessions before opening anything', async () => {
    const ctx = await context()
    const sessionId = SessionId('open-validation')
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([]),
      inspect: () => Promise.resolve(undefined),
    }) as never)
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })

    await expect(remote.openWorkspacePath({ sessionId, path: '' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
    await expect(remote.openWorkspacePath({ sessionId, path: 'result.html' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('preserves native opener failure and cancellation results', async () => {
    const ctx = await context()
    const sessionId = SessionId('open-failure')
    ctx.sessions.create(sessionId, { meta: { cwd: '/workspace/project' } })
    const openPath = vi.fn((_path: string, _signal: AbortSignal) =>
      Promise.reject(new Error('desktop unavailable')))
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })

    await expect(remote.openWorkspacePath({ sessionId, path: 'result.html' }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'internal', message: 'path open failed: desktop unavailable' },
      })

    const aborted = new AbortController()
    aborted.abort(new Error('cancelled'))
    await expect(remote.openWorkspacePath({ sessionId, path: 'result.html' }, aborted.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('classifies inspection cancellation and non-session failures', async () => {
    const ctx = await context()
    const controller = createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
    })
    const inspect = vi.spyOn(controller, 'inspect')
    const aborted = new AbortController()
    inspect.mockImplementationOnce(async () => {
      aborted.abort(new Error('cancelled'))
      throw new Error('inspection stopped')
    })
    await expect(controller.openWorkspacePath({
      sessionId: SessionId('inspection-cancelled'), path: 'result.html',
    }, aborted.signal)).rejects.toMatchObject({ failure: { code: 'cancelled' } })

    inspect.mockRejectedValueOnce('storage offline')
    const failed = controller.openWorkspacePath({
      sessionId: SessionId('inspection-failed'), path: 'result.html',
    }, new AbortController().signal)
    await expect(failed).rejects.toMatchObject({ failure: { code: 'internal' } })
    await expect(failed).rejects.toThrow('storage offline')
  })

  it('classifies opener cancellation and non-Error failures', async () => {
    const ctx = await context()
    const sessionId = SessionId('open-error-kinds')
    ctx.sessions.create(sessionId, { meta: { cwd: '/workspace/project' } })
    const aborted = new AbortController()
    const openPath = vi.fn()
      .mockImplementationOnce(async () => {
        aborted.abort(new Error('cancelled'))
        throw new Error('opening stopped')
      })
      .mockRejectedValueOnce('desktop unavailable')
    const controller = createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })

    await expect(controller.openWorkspacePath({ sessionId, path: 'first.html' }, aborted.signal))
      .rejects.toMatchObject({ failure: { code: 'cancelled' } })
    await expect(controller.openWorkspacePath({
      sessionId, path: 'second.html',
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'internal', message: 'path open failed: desktop unavailable' },
    })
  })
})
