import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { FirstDraft } from '../src/client/input/first-draft.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { SubmitOutcome } from '../src/client/contract/input.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  const opened = Promise.withResolvers<SessionId | undefined>()
  ctx.effect(() => () => { opened.resolve(undefined) })
  const submitted = vi.fn(async (): Promise<SubmitOutcome> => ({ kind: 'success' }))
  const target = new SessionInputShell({
    actx: ctx,
    defaultSink: submitted,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
  })
  ctx.effect(() => () => { target.dispose() })
  let beforeOpen: ((id: SessionId) => void) | undefined
  const open = vi.fn((prepare: (id: SessionId) => void) => {
    beforeOpen = prepare
    return opened.promise
  })
  const first = new FirstDraft(ctx, { open, shell: () => target })
  return {
    ctx, first, target, submitted, open, opened,
    complete: () => {
      const id = SessionId('default')
      beforeOpen!(id)
      opened.resolve(id)
    },
  }
}

describe('first message draft', () => {
  it('retains a local draft without opening a Session until send', async () => {
    const h = harness()
    h.first.shell.setDraft('first message')
    expect(h.open).not.toHaveBeenCalled()
    h.first.shell.submit('steer')
    expect(h.open).toHaveBeenCalledTimes(1)
    expect(h.first.state.getSnapshot().busy).toBe(true)
    h.first.shell.submit('steer')
    expect(h.open).toHaveBeenCalledTimes(1)
    h.complete()
    await vi.waitFor(() => { expect(h.submitted).toHaveBeenCalledTimes(1) })
    expect(h.submitted.mock.calls[0]).toEqual(['first message', [], 'steer', expect.any(AbortSignal)])
    expect(h.first.state.getSnapshot()).toEqual({ busy: false, failed: false })
  })

  it.each([false, true])('waits for first-use settings and keeps the Session draft on refusal (refused: %s)', async (refused) => {
    const h = harness()
    const settings = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<SessionId>()
    h.ctx.on('conversation/prepare-first-send', (id) => {
      started.resolve(id)
      return settings.promise
    })
    try {
      h.first.shell.setDraft('use my selected mode')
      h.first.shell.submit()
      h.complete()
      expect(await started.promise).toBe(SessionId('default'))
      expect(h.submitted).not.toHaveBeenCalled()
      if (refused) settings.reject(new Error('preset refused'))
      else settings.resolve(undefined)
      await vi.waitFor(() => { expect(h.first.state.getSnapshot().busy).toBe(false) })
      expect(h.first.state.getSnapshot().failed).toBe(false)
      if (refused) {
        expect(h.submitted).not.toHaveBeenCalled()
        expect(h.target.snapshot.draft).toBe('use my selected mode')
        expect(h.target.notices.getSnapshot()?.text).toBe('preset refused')
      } else {
        expect(h.submitted).toHaveBeenCalledOnce()
      }
    } finally {
      settings.resolve(undefined)
      await vi.waitFor(() => { expect(h.first.state.getSnapshot().busy).toBe(false) })
    }
  })

  it('restores input on preparation failure and dismisses the modal without losing it', async () => {
    const h = harness()
    h.first.shell.setDraft('preserve me')
    h.first.shell.submit()
    h.opened.reject(new Error('permission denied'))
    await vi.waitFor(() => { expect(h.first.shell.snapshot.draft).toBe('preserve me') })
    expect(h.first.state.getSnapshot()).toEqual({ busy: false, failed: true })
    expect(h.submitted).not.toHaveBeenCalled()
    h.first.dismiss()
    expect(h.first.state.getSnapshot().failed).toBe(false)
    expect(h.first.shell.snapshot.draft).toBe('preserve me')
  })

  it('hands a draft to a manual selection without sending it', async () => {
    const h = harness()
    h.first.shell.setDraft('manual folder')
    h.first.transfer(SessionId('manual'))
    expect(h.target.snapshot.draft).toBe('manual folder')
    expect(h.first.shell.snapshot.draft).toBe('')
    expect(h.submitted).not.toHaveBeenCalled()
  })

  it('lets manual navigation take the pending draft and cancels automatic submission', async () => {
    const h = harness()
    h.first.shell.setDraft('pending text')
    h.first.shell.submit()
    h.first.transfer(SessionId('manual'))
    h.opened.resolve(undefined)
    await vi.waitFor(() => { expect(h.first.state.getSnapshot().busy).toBe(false) })
    expect(h.target.snapshot.draft).toBe('pending text')
    expect(h.first.shell.snapshot.draft).toBe('')
    expect(h.submitted).not.toHaveBeenCalled()
  })

  it('restores a superseded draft without a directory error', async () => {
    const h = harness()
    h.first.shell.setDraft('later')
    h.first.shell.submit()
    h.opened.resolve(undefined)
    await vi.waitFor(() => { expect(h.first.shell.snapshot.draft).toBe('later') })
    expect(h.first.state.getSnapshot().failed).toBe(false)
  })

  it('leaves ordinary send failures in the selected Session input', async () => {
    const h = harness()
    h.submitted.mockResolvedValue({ kind: 'error' })
    h.first.shell.setDraft('retry the prompt')
    h.first.shell.submit()
    h.complete()
    await vi.waitFor(() => { expect(h.target.snapshot.draft).toBe('retry the prompt') })
    expect(h.first.shell.snapshot.draft).toBe('')
    expect(h.first.state.getSnapshot().failed).toBe(false)
  })
})
