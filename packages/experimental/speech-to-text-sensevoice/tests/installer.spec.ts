/** ONNX preparation reuses verified files and honors explicit offline deployments. */
import { writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import type { SpeechPreparationState } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { prepareRuntime, type Asset } from '../src/runtime.ts'
import { Config } from '../src/config.ts'

const bytes = Buffer.from('pinned ONNX fixture')
const asset = (name: string): Asset => ({ name, url: `https://huggingface.co/owner/model/resolve/revision/${name}`,
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
const fake = vi.hoisted(() => ({ lock: {} }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (args[0] instanceof URL && args[0].pathname.endsWith('/runtime/assets.json')) return JSON.stringify(fake.lock)
    return actual.readFileSync(...args)
  } }
})
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-speech-onnx-')); roots.push(root)
  fake.lock = { models: { int8: asset('model.int8.onnx'), fp32: asset('model.onnx') }, tokens: asset('tokens.txt'), vad: asset('silero_vad.onnx') }
  const fetcher = vi.fn(async (_url: string) => new Response(bytes)); vi.stubGlobal('fetch', fetcher)
  return { root, fetcher }
}
it.each(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])('prepares only model files on %s', async (target) => {
  const { root, fetcher } = await fixture(), [platform, arch] = target.split('-')
  vi.stubGlobal('process', { ...process, platform, arch })
  const report = vi.fn<(state: SpeechPreparationState) => void>()
  const config = Config({ dataRoot: root, modelOrigin: 'https://mirror.example' })
  const runtime = await prepareRuntime(new Context(), config, new AbortController().signal, report)
  expect(await readFile(runtime.model)).toEqual(bytes)
  expect(runtime.tokens).toContain('tokens.txt')
  expect(runtime.vad).toContain('silero_vad.onnx')
  expect(report.mock.calls.map(([state]) => state.step)).toEqual(expect.arrayContaining(['model', 'vad', 'verify']))
  expect(report.mock.calls.map(([state]) => state.phase)).not.toContain('installing')
  expect(fetcher.mock.calls.every(args => args[0].startsWith('https://mirror.example/'))).toBe(true)
  await prepareRuntime(new Context(), config, new AbortController().signal)
  expect(fetcher).toHaveBeenCalledTimes(3)
})
it('selects FP32 explicitly and skips downloads for existing model paths', async () => {
  const { root, fetcher } = await fixture()
  const config = Config({ dataRoot: root, precision: 'fp32' })
  const runtime = await prepareRuntime(new Context(), config, new AbortController().signal)
  expect(runtime.model).toMatch(/model\.onnx$/)
  fetcher.mockClear()
  const offline = await prepareRuntime(new Context(), Config(Object.assign({}, config, { modelDirectory: join(root, 'models', 'sensevoice-onnx'),
    vadModelPath: runtime.vad })), new AbortController().signal)
  expect(offline).toEqual(runtime)
  expect(fetcher).not.toHaveBeenCalled()
  await rm(runtime.model)
  const missing = Config(Object.assign({}, config, { modelDirectory: root, vadModelPath: runtime.vad }))
  await expect(prepareRuntime(new Context(), missing, new AbortController().signal)).rejects.toThrow()
})
it('rejects unsupported platforms, invalid model paths and cancelled preparation', async () => {
  const { root } = await fixture()
  const config = Config({ dataRoot: root })
  vi.stubGlobal('process', { ...process, platform: 'win32', arch: 'arm64' })
  await expect(prepareRuntime(new Context(), config, new AbortController().signal)).rejects.toThrow('unavailable')
  vi.unstubAllGlobals()
  await mkdir(join(root, 'models', 'sensevoice-onnx', 'model.int8.onnx'), { recursive: true })
  await expect(prepareRuntime(new Context(), config, new AbortController().signal)).rejects.toThrow()
  await writeFile(join(root, 'model.int8.onnx'), bytes); await writeFile(join(root, 'tokens.txt'), bytes)
  await expect(prepareRuntime(new Context(), Config({ dataRoot: root, modelDirectory: root, vadModelPath: join(root, 'tokens.txt') }),
    AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled')
})

it('rejects cached files changed before the final verification stage', async () => {
  const { root } = await fixture()
  await expect(prepareRuntime(new Context(), Config({ dataRoot: root }), new AbortController().signal, (state) => {
    if (state.step === 'verify') writeFileSync(join(root, 'models', 'sensevoice-onnx', 'model.int8.onnx'), 'changed')
  })).rejects.toThrow('verification failed')
})
