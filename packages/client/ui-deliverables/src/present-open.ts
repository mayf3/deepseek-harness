/** Private editable copies keep native applications away from immutable attachment objects. */
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { basename } from './presented.ts'

/**
 * Own native-open work and its temporary copies for one plugin lifetime.
 * Successful copies remain until disposal because desktop applications may read lazily.
 * @param ctx - attachment provider and plugin lifetime.
 * @returns an opener that verifies the entire snapshot before launching its default application.
 */
export function createPresentedOpener(ctx: Context): (ref: FileAttachmentRef, signal: AbortSignal) => Promise<void> {
  const lifetime = new AbortController()
  const directories = new Set<string>()
  const pending = new Set<Promise<void>>()
  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(pending)
    await Promise.all([...directories].map(directory => rm(directory, { recursive: true, force: true })))
  })

  async function open(ref: FileAttachmentRef, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (basename(ref.name) !== ref.name || ref.name === '.' || ref.name === '..' || ref.name.includes('\0')) {
      throw new Error('Presented file name must be a leaf name.')
    }
    const directory = await mkdtemp(join(tmpdir(), 'dsh-present-'))
    directories.add(directory)
    try {
      const path = join(directory, ref.name)
      await pipeline(ctx.attachments.readFileStream(ref, signal), createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal })
      signal.throwIfAborted()
      await ctx.sessionController.openWorkspacePath({ path }, signal)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      directories.delete(directory)
      throw error
    }
  }

  return (ref, signal) => {
    const task = open(ref, AbortSignal.any([signal, lifetime.signal]))
    pending.add(task)
    void task.then(() => { pending.delete(task) }, () => { pending.delete(task) })
    return task
  }
}
