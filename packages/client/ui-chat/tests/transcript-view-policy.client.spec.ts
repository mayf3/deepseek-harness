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
    policy.setMode('detailed')
    expect(policy.mode.getSnapshot()).toBe('detailed')
    expect(observed).toEqual(['transcriptView=detailed:detailed'])
    expect(host.set).toHaveBeenCalledWith('transcriptView', 'detailed')
  })

  it('adopts Host state, reads the legacy value as Detailed, and ignores identical writes', () => {
    const host = stubSettingsScope<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope)

    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'normal', performanceUsage: 'detailed' }, revision: 1, writable: true })
    expect(policy.mode.getSnapshot()).toBe('detailed')
    policy.setMode('detailed')
    expect(host.set).not.toHaveBeenCalled()

    host.publish({ value: { linkOpening: 'sidebar', transcriptView: 'compact', performanceUsage: 'detailed' }, revision: 2 })
    expect(policy.mode.getSnapshot()).toBe('compact')
  })

  it('adopts an accepted section standing at construction', () => {
    const host = stubSettingsScope<ChatSettings>()
    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'expanded', performanceUsage: 'detailed' }, revision: 1, writable: true })
    expect(new TranscriptViewPolicy(host.scope).mode.getSnapshot()).toBe('expanded')
  })
})
