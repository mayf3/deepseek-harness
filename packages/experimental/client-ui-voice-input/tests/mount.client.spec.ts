/** The optional namespace and microphone ownership follow Client plugin disposal. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { mountVoiceInput, inject } from '../src/client/mount.ts'
import { apply as hostApply } from '../src/index.ts'
import { VoiceInput, type VoiceInputInjected } from '../src/client/VoiceInput.tsx'

const REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-experimental-api-speech-to-text',
  descriptors: [],
}

vi.mock('../src/client/readiness.ts', () => ({ observeReadiness: () => ({
  state: createSnapshotStore({ catalog: null, connected: true, error: null }), dispose: async () => {},
}) }))

async function fixture(fail = false) {
  const ctx = new Context(), unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  const configure = vi.fn(async () => ({ ok: true, value: {} }))
  const prepare = vi.fn(async () => ({ ok: true, value: {} }))
  const cancelPreparation = vi.fn(async () => ({ ok: true, value: {} }))
  const transcribe = vi.fn(async () => ({ ok: true, value: {} }))
  ctx.provide('remote.speech', { configure, prepare, cancelPreparation, transcribe })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'conversation.input.activity': { kind: 'single', scope: 'session' },
    'plugins.bundle.activation': { kind: 'keyed', scope: 'root' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  } } as never,
  () => null)
  if (fail) vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  return { ctx, unmount, configure, prepare, cancelPreparation, transcribe }
}

it('withdraws its Remote, localized slot and microphone captures on disposal', async () => {
  hostApply()
  const b = await fixture()
  try {
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountVoiceInput(ctx, REMOTE) })
    await fiber
    const entry = b.ctx.slots.entries('conversation.input.activity').find(item => item.component === VoiceInput)
    expect(entry).toMatchObject({ locale: 'voice-input' })
    const actions = (entry!.inject as unknown as () => VoiceInputInjected)()
    const finished = actions.createRecording()
    await finished.dispose()
    const pending = actions.createRecording()
    const dispose = vi.spyOn(pending, 'dispose')
    await actions.configure({ language: 'zh' })
    await actions.prepare('local' as SpeechProviderId)
    await actions.cancelPreparation('local' as SpeechProviderId)
    for (const slot of ['plugins.bundle.config', 'plugins.bundle.activation'] as const) {
      const item = b.ctx.slots.entries(slot)[0]!
      expect(item.locale).toBe('voice-input')
      const injected = (item.inject as unknown as () => VoiceInputInjected & { compact?: boolean })()
      expect(injected.hooks).toBe(actions.hooks)
    }
    const failure = { ok: false, error: new RemoteError('gateway/internal', 'offline', {}) }
    b.configure.mockResolvedValueOnce(failure as never)
    b.prepare.mockResolvedValueOnce(failure as never)
    b.cancelPreparation.mockResolvedValueOnce(failure as never)
    await expect(actions.configure({ language: 'en' })).rejects.toThrow('offline')
    await expect(actions.prepare('local' as SpeechProviderId)).rejects.toThrow('offline')
    await expect(actions.cancelPreparation('local' as SpeechProviderId)).rejects.toThrow('offline')
    const request = { providerId: 'local' as SpeechProviderId, audioBase64: '' }, signal = new AbortController().signal
    await actions.transcribe(request, signal)
    expect(b.configure).toHaveBeenCalledTimes(2)
    expect(b.transcribe).toHaveBeenCalledWith(request, signal)
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
    expect(b.ctx.slots.entries('conversation.input.activity')).toHaveLength(0)
    expect(b.ctx.slots.entries('plugins.bundle.activation')).toHaveLength(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})

it('rolls back the Remote contribution when the slot registration fails', async () => {
  const b = await fixture(true)
  try {
    await expect(mountVoiceInput(b.ctx, REMOTE)).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally { await b.ctx.fiber.dispose() }
})
