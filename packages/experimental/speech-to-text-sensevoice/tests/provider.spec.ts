/** Provider activation remains lazy and rejects relative deployment paths. */
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text'
import { afterEach, expect, it, vi } from 'vitest'
import * as Provider from '../src/index.ts'
import { SenseVoiceWorker } from '../src/recognizer.ts'

afterEach(() => { vi.restoreAllMocks() })

it.each(['int8', 'fp32'] as const)('registers %s lazily and joins inference before withdrawal completes', async (precision) => {
  const ctx = new Context()
  try {
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(SpeechToText)
    const transcribe = vi.spyOn(SenseVoiceWorker.prototype, 'transcribe')
      .mockResolvedValue({ text: 'hello', audioSeconds: 1, inferenceSeconds: 0.1 })
    const fiber = ctx.plugin(Provider, { dataRoot: process.cwd(), precision })
    await fiber
    expect(transcribe).not.toHaveBeenCalled()
    const speech = ctx.get('speechToText')!
    expect(speech.listProviders()).toMatchObject([{ id: 'sensevoice-local', location: 'host-local' }])
    await expect(speech.transcribe(speech.resolve({ audio: new Uint8Array() }), new AbortController().signal)).rejects.toThrow('Prepare')
    vi.spyOn(SenseVoiceWorker.prototype, 'snapshot').mockReturnValue({ phase: 'ready' })
    expect((await speech.transcribe(speech.resolve({ audio: new Uint8Array() }), new AbortController().signal)).text).toBe('hello')
    await fiber.dispose()
    expect(speech.listProviders()).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it('refuses relative runtime, model and cache paths before registration', () => {
  for (const field of ['dataRoot', 'modelDirectory', 'vadModelPath']) {
    expect(() => { Provider.apply(new Context(), Provider.Config({ dataRoot: process.cwd(), [field]: 'relative' })) })
      .toThrow('absolute')
  }
  expect(() => Provider.Config({ dataRoot: process.cwd(), threads: 0 })).toThrow()
})
