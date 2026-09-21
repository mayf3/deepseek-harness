/** The shell page's form over a scripted settings scope: what it projects and what a save writes. */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { ShellCardController, type ShellSettings } from '../src/client/shell-card-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubSettingsScope<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value } as T, user: { ...layer(), [field]: value } })
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...section(), [field]: base?.[field] } as T, user })
  })
}

describe('ShellCardController', () => {
  it('projects both fields and saves them in one write pass', async () => {
    const host = stubSettingsScope<ShellSettings>()
    acceptWrites(host)
    const controller = new ShellCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 5_000, maxOutputBytes: 64_000 },
      base: { timeoutMs: 60_000, maxOutputBytes: 64_000 },
      user: { timeoutMs: 5_000 },
    })
    const face = controller.inject()

    expect(face.hooks.shellCard.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      dirty: false,
      timeoutMs: { text: '5000', overridden: true },
      maxOutputBytes: { text: '64000', overridden: false },
    })

    face.edit('timeoutMs', '9000')
    face.edit('maxOutputBytes', '1024')
    expect(face.hooks.shellCard.getSnapshot().dirty).toBe(true)

    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledTimes(2) })

    expect(host.set.mock.calls).toEqual([['timeoutMs', 9_000], ['maxOutputBytes', 1_024]])
    expect(face.hooks.shellCard.getSnapshot().dirty).toBe(false)
  })

  it('stages a reset and applies it on save', async () => {
    const host = stubSettingsScope<ShellSettings>()
    acceptWrites(host)
    const controller = new ShellCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 5_000 },
      base: { timeoutMs: 60_000 },
      user: { timeoutMs: 5_000 },
    })
    const face = controller.inject()

    face.resetField('timeoutMs')
    expect(face.hooks.shellCard.getSnapshot().timeoutMs.text).toBe('60000')

    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledWith('timeoutMs') })

    expect(face.hooks.shellCard.getSnapshot()).toMatchObject({
      dirty: false,
      timeoutMs: { text: '60000', overridden: false },
    })
  })

  it('discards staged edits without writing', () => {
    const host = stubSettingsScope<ShellSettings>()
    const controller = new ShellCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { timeoutMs: 5_000 }, user: {} })
    const face = controller.inject()

    face.edit('timeoutMs', '9000')
    face.discard()

    expect(face.hooks.shellCard.getSnapshot().timeoutMs.text).toBe('5000')
    expect(host.set).not.toHaveBeenCalled()
  })
})
