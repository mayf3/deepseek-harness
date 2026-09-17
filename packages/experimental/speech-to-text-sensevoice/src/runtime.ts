/** Verified runtime assets and managed command execution for local transcription. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'
import type { SpeechPreparationState } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Release-pinned downloadable file. */
export interface Asset {
  readonly name: string
  readonly url: string
  readonly sha256: string
  readonly bytes: number
}

interface RuntimeLock {
  models: Record<Config['precision'], Asset>
  tokens: Asset
  vad: Asset
}

/** Prepared model and process paths, private to the local provider. */
export interface RuntimePaths {
  readonly model: string
  readonly tokens: string
  readonly vad: string
  readonly worker: string
}

/**
 * Download into a unique partial file, verify, then publish it atomically.
 * @param asset - pinned release identity.
 * @param root - provider-owned cache directory.
 * @param signal - preparation cancellation.
 * @param report - Host-owned progress publisher.
 * @returns verified local file path.
 */
export async function downloadAsset(asset: Asset, root: string, signal: AbortSignal,
  report: (state: SpeechPreparationState) => void = () => {}): Promise<string> {
  signal.throwIfAborted()
  await mkdir(root, { recursive: true })
  const destination = join(root, asset.name)
  try {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(destination, { signal })) digest.update(chunk as Buffer)
    if (digest.digest('hex') === asset.sha256) return destination
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const partial = `${destination}.${randomUUID()}.part`
  try {
    const response = await fetch(asset.url, { signal })
    if (!response.ok || !response.body) throw new Error(`Speech asset download failed: HTTP ${response.status}`)
    const digest = createHash('sha256')
    let completedBytes = 0
    const publish = (): void => { report({ phase: 'downloading', resource: asset.name, completedBytes, totalBytes: asset.bytes }) }
    publish()
    const hashing = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      completedBytes += chunk.length
      if (completedBytes > asset.bytes) { callback(new Error(`Speech asset exceeds its pinned size: ${asset.name}`)); return }
      digest.update(chunk); publish(); callback(null, chunk)
    } })
    await pipeline(response.body, hashing, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal })
    if (completedBytes !== asset.bytes || digest.digest('hex') !== asset.sha256) {
      throw new Error(`Speech asset checksum or size mismatch: ${asset.name}`)
    }
    signal.throwIfAborted()
    await rename(partial, destination)
    return destination
  } finally {
    await rm(partial, { force: true })
  }
}

/**
 * Resolve the bundled native runtime and prepare verified ONNX models on demand.
 * @param _ctx - Host context owning the preparation task.
 * @param config - model paths, precision, and download origin.
 * @param signal - preparation cancellation or deadline.
 * @param report - Host-owned progress publisher.
 * @returns verified model and worker paths.
 */
export async function prepareRuntime(_ctx: Context, config: Config, signal: AbortSignal,
  report: (state: SpeechPreparationState) => void = () => {}): Promise<RuntimePaths> {
  const supported = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']
  if (!supported.includes(`${process.platform}-${process.arch}`)) throw new Error(`Local speech is unavailable for ${process.platform}-${process.arch}`)
  const lock = JSON.parse(readFileSync(new URL('../runtime/assets.json', import.meta.url), 'utf8')) as RuntimeLock
  const modelRoot = config.modelDirectory ?? join(config.dataRoot, 'models', 'sensevoice-onnx')
  const model = join(modelRoot, lock.models[config.precision].name), tokens = join(modelRoot, lock.tokens.name)
  const vad = config.vadModelPath ?? join(config.dataRoot, 'models', 'silero', lock.vad.name)
  const download = async (asset: Asset, root: string, step: 'model' | 'vad'): Promise<void> => {
    const url = new URL(asset.url)
    const pinned = { ...asset, url: `${config.modelOrigin.replace(/\/$/, '')}${url.pathname}` }
    await downloadAsset(pinned, root, signal, (state) => { report({ ...state, step }) })
  }
  if (config.modelDirectory === undefined) {
    report({ phase: 'checking', step: 'model', startedAt: Date.now() })
    await download(lock.models[config.precision], modelRoot, 'model')
    await download(lock.tokens, modelRoot, 'model')
  }
  if (config.vadModelPath === undefined) {
    report({ phase: 'checking', step: 'vad', startedAt: Date.now() })
    await download(lock.vad, join(config.dataRoot, 'models', 'silero'), 'vad')
  }
  report({ phase: 'checking', step: 'verify', startedAt: Date.now() })
  await Promise.all([model, tokens, vad].map(path => access(path)))
  const verified = [
    ...config.modelDirectory === undefined ? [[model, lock.models[config.precision]], [tokens, lock.tokens]] as const : [],
    ...config.vadModelPath === undefined ? [[vad, lock.vad]] as const : [],
  ]
  for (const [path, asset] of verified) {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path, { signal })) digest.update(chunk as Buffer)
    if (digest.digest('hex') !== asset.sha256) throw new Error(`Speech model verification failed: ${asset.name}`)
  }
  signal.throwIfAborted()
  /* v8 ignore next -- built worker resolution is exercised by real Node and Electron process smokes */
  return { model, tokens, vad, worker: fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url)) }
}
