/** Developer-tool choices share settings validation, persistence and accepted-state publication. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply } from '../src/index.ts'
import { DEVELOPER_TOOLS_NAMESPACE, type DeveloperToolsSettings } from '../src/developer-tools-settings.ts'
import { DeveloperToolsPreference } from '../src/client/developer-tools.ts'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

describe('developer tools settings', () => {
  it('defaults off, persists valid choices and removes its schema on disposal', async () => {
    const ctx = new Context()
    const provider = ctx.plugin(MemorySettings)
    onTestFinished(() => provider.dispose())
    await provider.await()
    const fiber = ctx.plugin({ apply })
    onTestFinished(() => fiber.dispose())
    await fiber.await()
    expect(ctx.settings.get(DEVELOPER_TOOLS_NAMESPACE)).toEqual({ enabled: false })
    await ctx.settings.update(DEVELOPER_TOOLS_NAMESPACE, { enabled: true })
    expect(ctx.settings.get(DEVELOPER_TOOLS_NAMESPACE)).toEqual({ enabled: true })
    await expect(ctx.settings.update(DEVELOPER_TOOLS_NAMESPACE, { enabled: 'yes' })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(DEVELOPER_TOOLS_NAMESPACE)
  })

  it('stays off until accepted settings arrive and follows external changes', async () => {
    const host = stubSettingsScope<DeveloperToolsSettings>()
    const preference = new DeveloperToolsPreference(host.scope)
    const notify = vi.fn()
    const dispose = preference.enabled.subscribe(notify)
    expect(preference.enabled.getSnapshot()).toBe(false)
    host.publish({ status: 'ready', value: { enabled: true } })
    expect(preference.enabled.getSnapshot()).toBe(true)
    expect(notify).toHaveBeenCalledOnce()
    await preference.setEnabled(false)
    expect(host.set).toHaveBeenCalledWith('enabled', false)
    host.publish({ value: { enabled: false } })
    expect(preference.enabled.getSnapshot()).toBe(false)
    dispose()
  })
})

it('keeps remote browser choices local and publishes only changed values', async () => {
  const host = stubSettingsScope<DeveloperToolsSettings>()
  host.publish({ mode: 'memory' })
  const preference = new DeveloperToolsPreference(host.scope)
  const notify = vi.fn()
  const dispose = preference.enabled.subscribe(notify)
  expect(preference.enabled.getSnapshot()).toBe(false)
  await preference.setEnabled(true)
  expect(preference.enabled.getSnapshot()).toBe(true)
  await preference.setEnabled(true)
  expect(notify).toHaveBeenCalledOnce()
  await preference.setEnabled(false)
  expect(preference.enabled.getSnapshot()).toBe(false)
  expect(host.set).not.toHaveBeenCalled()
  dispose()
})

it('ignores host revisions that do not change enablement', () => {
  const host = stubSettingsScope<DeveloperToolsSettings>()
  const preference = new DeveloperToolsPreference(host.scope)
  const notify = vi.fn()
  const dispose = preference.enabled.subscribe(notify)
  host.publish({ revision: 1 })
  host.publish({ value: { enabled: false } })
  expect(notify).not.toHaveBeenCalled()
  host.publish({ value: { enabled: true } })
  expect(notify).toHaveBeenCalledOnce()
  dispose()
})
