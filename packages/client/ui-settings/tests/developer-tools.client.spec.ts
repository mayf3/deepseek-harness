/** Developer-tool choices share settings validation, persistence and accepted-state publication. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { stubSettingsScope, TestRemote, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { apply } from '../src/index.ts'
import { DEVELOPER_TOOLS_NAMESPACE, DeveloperToolsSettingsSchema, type DeveloperToolsSettings } from '../src/developer-tools-settings.ts'
import { DeveloperToolsPreference } from '../src/client/developer-tools.ts'
import { apply as clientApply, inject } from '../src/client/index.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('developer tools settings', () => {
  it('reports a refused Host write after recovering accepted state', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const describeCall = vi.fn().mockResolvedValue({ ok: true, value: {
      writable: true, hasDocument: true, namespaces: [{
        ns: DEVELOPER_TOOLS_NAMESPACE,
        schema: DeveloperToolsSettingsSchema.toJSON(),
        value: { enabled: false }, revision: 1, applies: 'live', secrets: [],
      }],
    } })
    const mutate = vi.fn().mockResolvedValue({
      ok: false, error: new RemoteError('settings/rejected', 'conflict', { ns: DEVELOPER_TOOLS_NAMESPACE }),
    })
    new TestRemote(ctx, { settings: { describe: describeCall, mutate } })
    await ctx.plugin({ inject, apply: clientApply }).await()
    await ctx.settingsScope.describe().ensure()
    await expect(ctx.settingsScope.developerTools.setEnabled(true)).rejects.toThrow('not saved')
    expect(mutate).toHaveBeenCalledWith(DEVELOPER_TOOLS_NAMESPACE, [{ op: 'set', path: ['enabled'], value: true }], 1)
    expect(describeCall).toHaveBeenCalledTimes(2)
    expect(ctx.settingsScope.developerTools.enabled.getSnapshot()).toBe(false)
  })

  it('shares one remote-browser preference across consumers and disposes it with the plugin', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const describeCall = vi.fn()
    const remote = new TestRemote(ctx, { settings: { describe: describeCall } })
    remote.$host = { home: undefined, isLoopback: false }
    const fiber = ctx.plugin({ inject, apply: clientApply })
    await fiber.await()
    const preference = ctx.settingsScope.developerTools
    expect(fiber.ctx.settingsScope.developerTools.enabled).toBe(preference.enabled)
    expect(preference.enabled.getSnapshot()).toBe(true)
    await preference.setEnabled(true)
    expect(fiber.ctx.settingsScope.developerTools.enabled.getSnapshot()).toBe(true)
    expect(describeCall).not.toHaveBeenCalled()
    await fiber.dispose()
    expect(ctx.get('settingsScope')).toBeUndefined()
  })
  it('defaults on, keeps an explicit false, persists valid choices and removes its schema on disposal', async () => {
    const ctx = new Context()
    const provider = ctx.plugin(MemorySettings)
    onTestFinished(() => provider.dispose())
    await provider.await()
    const fiber = ctx.plugin({ apply })
    onTestFinished(() => fiber.dispose())
    await fiber.await()
    expect(ctx.settings.get(DEVELOPER_TOOLS_NAMESPACE)).toEqual({ enabled: true })
    await ctx.settings.update(DEVELOPER_TOOLS_NAMESPACE, { enabled: false })
    expect(ctx.settings.get(DEVELOPER_TOOLS_NAMESPACE)).toEqual({ enabled: false })
    await ctx.settings.update(DEVELOPER_TOOLS_NAMESPACE, { enabled: true })
    expect(ctx.settings.get(DEVELOPER_TOOLS_NAMESPACE)).toEqual({ enabled: true })
    await expect(ctx.settings.update(DEVELOPER_TOOLS_NAMESPACE, { enabled: 'yes' })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(DEVELOPER_TOOLS_NAMESPACE)
  })

  it('stays on until accepted settings arrive, then follows a stored false and external changes', async () => {
    const host = stubSettingsScope<DeveloperToolsSettings>()
    const preference = new DeveloperToolsPreference(host.scope)
    expect(preference.enabled.getSnapshot()).toBe(true)
    const notify = vi.fn()
    const dispose = preference.enabled.subscribe(notify)
    host.publish({ status: 'ready', value: { enabled: false } })
    expect(preference.enabled.getSnapshot()).toBe(false)
    expect(notify).toHaveBeenCalledOnce()
    await preference.setEnabled(true)
    expect(host.set).toHaveBeenCalledWith('enabled', true)
    host.publish({ value: { enabled: true } })
    expect(preference.enabled.getSnapshot()).toBe(true)
    dispose()
  })
})

it('keeps remote browser choices local and publishes only changed values', async () => {
  const host = stubSettingsScope<DeveloperToolsSettings>()
  host.publish({ mode: 'memory' })
  const preference = new DeveloperToolsPreference(host.scope)
  const notify = vi.fn()
  const dispose = preference.enabled.subscribe(notify)
  expect(preference.enabled.getSnapshot()).toBe(true)
  await preference.setEnabled(false)
  expect(preference.enabled.getSnapshot()).toBe(false)
  await preference.setEnabled(false)
  expect(notify).toHaveBeenCalledOnce()
  await preference.setEnabled(true)
  expect(preference.enabled.getSnapshot()).toBe(true)
  expect(notify).toHaveBeenCalledTimes(2)
  expect(host.set).not.toHaveBeenCalled()
  dispose()
})

it('ignores host revisions that do not change enablement', () => {
  const host = stubSettingsScope<DeveloperToolsSettings>()
  const preference = new DeveloperToolsPreference(host.scope)
  const notify = vi.fn()
  const dispose = preference.enabled.subscribe(notify)
  host.publish({ revision: 1 })
  host.publish({ value: { enabled: true } })
  expect(notify).not.toHaveBeenCalled()
  host.publish({ value: { enabled: false } })
  expect(notify).toHaveBeenCalledOnce()
  dispose()
})
