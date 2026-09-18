// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatSettings } from '../src/chat-settings.ts'
import { TranscriptViewPolicy } from '../src/client/transcript-view.ts'

describe('TranscriptViewPolicy', () => {
  it('defaults to Compact and publishes explicit choices before persistence settles', () => {
    const host = stubSettingsScope<ChatSettings>()
    const observed: string[] = []
    let current = (): string => 'unconstructed'
    const scope: typeof host.scope = {
      ...host.scope,
      set: (field, value) => {
        observed.push(`${field}=${String(value)}:${current()}`)
        return host.scope.set(field, value)
      },
    }
    const policy = new TranscriptViewPolicy(scope)
    current = () => policy.mode.getSnapshot()

    expect(policy.mode.getSnapshot()).toBe('compact')
    policy.setMode('expanded')
    expect(policy.mode.getSnapshot()).toBe('expanded')
    expect(observed).toEqual(['transcriptView=expanded:expanded'])
    expect(host.set).toHaveBeenCalledWith('transcriptView', 'expanded')
  })

  it('adopts Host state and ignores identical writes', () => {
    const host = stubSettingsScope<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope)

    host.publish({ status: 'ready', value: { transcriptView: 'expanded', performanceUsage: 'detailed' }, revision: 1, writable: true })
    expect(policy.mode.getSnapshot()).toBe('expanded')
    policy.setMode('expanded')
    expect(host.set).not.toHaveBeenCalled()

    host.publish({ value: { transcriptView: 'compact', performanceUsage: 'detailed' }, revision: 2 })
    expect(policy.mode.getSnapshot()).toBe('compact')
  })

  it('adopts an accepted section standing at construction', () => {
    const host = stubSettingsScope<ChatSettings>()
    host.publish({ status: 'ready', value: { transcriptView: 'expanded', performanceUsage: 'detailed' }, revision: 1, writable: true })
    expect(new TranscriptViewPolicy(host.scope).mode.getSnapshot()).toBe('expanded')
  })
  it.each([
    ['compact', 'compact'],
    ['normal', 'detailed'],
    ['detailed', 'detailed'],
    ['expanded', 'expanded'],
  ] as const)('reads saved %s as %s without rewriting settings', (saved, resolved) => {
    const host = stubSettingsScope<ChatSettings>()
    host.publish({ status: 'ready', value: { transcriptView: saved, performanceUsage: 'detailed' }, revision: 1, writable: true })
    const policy = new TranscriptViewPolicy(host.scope)
    expect(policy.mode.getSnapshot()).toBe(resolved)
    expect(host.set).not.toHaveBeenCalled()
  })

  it('persists Expanded only when explicitly selected after legacy Normal', () => {
    const host = stubSettingsScope<ChatSettings>()
    host.publish({ status: 'ready', value: { transcriptView: 'normal', performanceUsage: 'detailed' }, revision: 1, writable: true })
    const policy = new TranscriptViewPolicy(host.scope)
    policy.setMode('expanded')
    expect(policy.mode.getSnapshot()).toBe('expanded')
    expect(host.set).toHaveBeenCalledWith('transcriptView', 'expanded')
  })
})
