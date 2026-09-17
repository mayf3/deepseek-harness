/** Provider routing, cancellation, and fiber-owned registration lifetimes. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SpeechToText from '../src/index.ts'
import type { SpeechPreparationState, SpeechProvider, SpeechProviderId, Transcript } from '../src/types.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'

const result: Transcript = { text: 'hello', audioSeconds: 1, inferenceSeconds: 0.1 }
const audio = new Uint8Array([1, 2])
const input = new AbortController().signal
function provider(id: string, transcribe: SpeechProvider['transcribe'] = async () => result): SpeechProvider {
  return { info: { id: id as SpeechProviderId, name: id, location: 'host-local' }, transcribe }
}

it('shares Host preparation across observers and does not cancel work when observation ends', async () => {
  const ctx = new Context(), base = ctx.plugin(SpeechToText)
  await base
  try {
    const service = ctx.get('speechToText')!, id = 'local' as SpeechProviderId
    let state: SpeechPreparationState = { phase: 'unprepared' }, notify = (): void => {}
    const prepare = vi.fn(), cancel = vi.fn(async () => {}), unsubscribe = vi.fn()
    const remove = service.register({ ...provider(id), preparation: {
      snapshot: () => state, prepare, cancel, subscribe: (listener) => { notify = listener; return unsubscribe },
    } })
    const lifetime = new AbortController(), stream = service.follow(lifetime.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ providers: [{ id, preparation: { phase: 'unprepared' } }] })
    service.prepare(id)
    expect(prepare).toHaveBeenCalledOnce()
    const next = stream.next()
    state = { phase: 'downloading', resource: 'model', completedBytes: 638, totalBytes: 936 }; notify()
    expect((await next).value).toMatchObject({ providers: [{ preparation: state }] })
    lifetime.abort()
    expect((await stream.next()).done).toBe(true)
    expect(cancel).not.toHaveBeenCalled()
    await service.cancelPreparation(id)
    expect(cancel).toHaveBeenCalledOnce()
    await remove()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(() =>{  service.prepare(id) }).toThrow('unavailable')
    await expect(service.cancelPreparation(id)).rejects.toThrow('unavailable')
    await expect(service.follow(lifetime.signal)[Symbol.asyncIterator]().next()).rejects.toThrow()
  } finally { await base.dispose() }
})

it('persists explicit provider and language changes and publishes them with readiness', async () => {
  const ctx = new Context()
  const settings = ctx.plugin(MemorySettings)
  await settings
  const base = ctx.plugin(SpeechToText)
  await base
  try {
    const speech = ctx.get('speechToText')!
    speech.register(provider('sensevoice-local')); speech.register(provider('cloud'))
    await speech.configure({ providerId: 'cloud' as SpeechProviderId })
    await speech.configure({ language: 'en' })
    expect(speech.snapshot().selection).toEqual({ providerId: 'cloud', language: 'en' })
    expect(speech.resolve({ audio })).toMatchObject({ provider: { info: { id: 'cloud' } }, language: 'en' })
    expect((ctx.get('settings') as MemorySettings).doc['voice-input']).toEqual({ defaultProvider: 'cloud', language: 'en' })
    await expect(speech.configure({ providerId: 'missing' as SpeechProviderId })).rejects.toThrow('unavailable')
    await expect(speech.configure({ language: '' })).rejects.toThrow()
    await settings.dispose()
    expect(speech.snapshot().selection).toEqual({ providerId: 'sensevoice-local', language: 'auto' })
    await expect(speech.configure({ language: 'zh' })).rejects.toThrow('user-settings')
  } finally { await ctx.fiber.dispose() }
})

it('ends waiting observers and rejects registration after service disposal', async () => {
  const ctx = new Context(), base = ctx.plugin(SpeechToText)
  await base
  const service = ctx.get('speechToText')!, stream = service.follow(new AbortController().signal)[Symbol.asyncIterator]()
  await stream.next()
  const waiting = stream.next()
  await base.dispose()
  expect((await waiting).done).toBe(true)
  expect(() => service.register(provider('late'))).toThrow('disposed')
})

describe('speech providers', () => {
  it('resolves composition defaults and explicit provider choices without fallback', async () => {
    const ctx = new Context()
    const base = ctx.plugin(SpeechToText, { defaultProvider: 'local', language: 'zh' })
    await base
    const service = ctx.get('speechToText')!
    const a = provider('local'), b = provider('cloud')
    const removeA = service.register(a), removeB = service.register(b)
    expect(service.listProviders()).toEqual([a.info, b.info])
    const spec = service.resolve({ audio })
    expect(spec).toEqual({ audio, language: 'zh', provider: a })
    expect(service.resolve({ audio, providerId: b.info.id, language: 'en' })).toEqual({ audio, language: 'en', provider: b })
    expect(await service.transcribe(spec, input)).toEqual(result)
    expect(() => service.register(a)).toThrow('already registered')
    expect(() => service.resolve({ audio, providerId: 'missing' as SpeechProviderId })).toThrow('unavailable')
    await removeA(); await removeA()
    await expect(service.transcribe(spec, input)).rejects.toThrow('no longer registered')
    await removeB(); await base.dispose()
  })

  it('withdraws a provider before joining accepted work and keeps a replacement registration', async () => {
    const ctx = new Context()
    const base = ctx.plugin(SpeechToText, { defaultProvider: 'local', language: 'auto' })
    await base
    const service = ctx.get('speechToText')!
    let enter!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const p = provider('local', async (_value, signal) => {
      enter()
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      return result
    })
    const remove = service.register(p)
    const operation = service.transcribe(service.resolve({ audio }), input)
    const rejection = expect(operation).rejects.toThrow('unloaded')
    await entered
    const removing = remove()
    expect(service.listProviders()).toEqual([])
    const next = provider('local')
    const removeNext = service.register(next)
    await removing; await rejection; await remove()
    expect(service.listProviders()).toEqual([next.info])
    await removeNext(); await base.dispose()
  })

  it('rejects pre-aborted and withdrawn queued work before the recognizer starts', async () => {
    const ctx = new Context()
    const base = ctx.plugin(SpeechToText, { defaultProvider: 'local', language: 'auto' })
    await base
    const service = ctx.get('speechToText')!
    let calls = 0
    const remove = service.register(provider('local', async () => { calls++; return result }))
    const spec = service.resolve({ audio })
    await expect(service.transcribe(spec, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
    const run = service.transcribe(spec, input)
    const rejected = expect(run).rejects.toThrow('unloaded')
    await remove(); await rejected
    expect(calls).toBe(0)
    await base.dispose()
  })

  it('removes a registration with its contributing fiber', async () => {
    const ctx = new Context()
    const base = ctx.plugin(SpeechToText)
    await base
    const fiber = ctx.inject(['speechToText'], (owner) => {
      owner.effect(() => owner.speechToText.register(provider('sensevoice-local')))
    })
    await fiber
    expect(ctx.get('speechToText')!.listProviders()).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.get('speechToText')!.listProviders()).toEqual([])
    await base.dispose()
  })
})
