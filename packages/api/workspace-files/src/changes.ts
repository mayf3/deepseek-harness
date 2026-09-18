/**
 * Target-scoped filesystem watches and `fs/observed` invalidations for `changes`.
 * Each generation sends `ready` after watcher initialization, then reads current
 * target metadata for matching queued and live invalidations.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { FsObservation, FsTarget } from '@deepseek-ai/dsh-fs'
import type { WorkspaceFileWatchFrame, WorkspaceWatchRequest } from './types.ts'

/** One `fs/observed` emission as received, before any generation filters it. */
type Observed = readonly [target: FsTarget, observation?: FsObservation]

/** Owns `fs/observed` observation and every open `changes` generation. */
export class WorkspaceChangeFeed {
  private readonly followers = new Set<ChangeFollower>()

  /** @param ctx - Host context carrying the filesystem the observations come from. */
  constructor(private readonly ctx: Context) {
    ctx.on('fs/observed', (target, observation) => {
      for (const follower of this.followers) follower.push([target, observation])
    })
    ctx.effect(() => async () => {
      const followers = [...this.followers]
      for (const follower of followers) follower.close()
      await Promise.all(followers.map(follower => follower.done.promise))
      this.followers.clear()
    }, 'workspace-files.changes')
  }

  /**
   * Open one target watch; directory targets remain inside `workspaceRoot`.
   * @param workspaceRoot - the session's workspace root path.
   * @param request - file or directory target, resolved relative to the workspace root.
   * @param signal - generation cancellation.
   * @returns `ready` after watching starts, then current metadata for target invalidations.
   */
  async *follow(workspaceRoot: string, request: WorkspaceWatchRequest, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame> {
    signal.throwIfAborted()
    // Registered before the root resolves, so nothing observed while it does is
    // missed; the root only filters at drain time.
    const follower = new ChangeFollower()
    signal = AbortSignal.any([signal, follower.controller.signal])
    const aborted = (): boolean => signal.aborted
    this.followers.add(follower)
    let unwatch: (() => Promise<void>) | undefined
    try {
      // Under the generation's signal, so a consumer leaving mid-resolve on a slow
      // backend releases the follower now rather than when the resolve settles;
      // a rejection the abort caused is the quiet end every other abort takes here.
      const root = await this.ctx.fs.resolve(workspaceRoot, { signal }).catch((error: unknown) => {
        if (aborted()) return undefined
        throw error
      })
      if (root === undefined || aborted() || follower.isClosed) return
      const target = await this.ctx.fs.resolve(request.path, { cwd: workspaceRoot, signal }).catch((error: unknown) => {
        if (aborted()) return undefined
        throw error
      })
      if (target === undefined || aborted()) return
      if (request.kind === 'directory' && !this.ctx.fs.contains(root, target)) {
        throw new RemoteError('workspace-file/outside-workspace', 'Directory is outside the workspace', { path: request.path })
      }
      try {
        unwatch = await this.ctx.fs.watch(target, (error) => {
          if (error !== undefined) follower.fail(error)
          else if (!follower.isClosed) follower.push([target])
        }, signal)
        if (follower.error !== undefined) throw follower.error
      } catch (error) {
        if (aborted() && follower.error === undefined) return
        const failure = follower.error ?? error
        throw new RemoteError('workspace-file/watch-unsupported',
          failure instanceof Error ? failure.message : String(failure), { path: request.path })
      }
      if (aborted()) return
      yield { kind: 'ready' }
      for await (const [observed] of follower.read(signal)) {
        if (observed.targetKey !== target.targetKey) continue
        const info = await this.ctx.fs.stat(target, signal).catch((error: unknown) => {
          if (aborted()) return undefined
          throw error
        })
        if (aborted()) return
        const absolutePath = this.ctx.fs.processPath(target)
        yield {
          kind: 'change',
          change: info !== undefined
            ? { absolutePath, version: info.version }
            : { absolutePath, absent: true },
        }
      }
    } finally {
      follower.close()
      try {
        await unwatch?.()
      } finally {
        this.followers.delete(follower)
        follower.done.resolve()
      }
    }
  }
}

/** One generation's queue: observations wait here until its consumer pulls them. */
class ChangeFollower {
  readonly controller = new AbortController()
  readonly done = Promise.withResolvers<void>()
  error: Error | undefined
  private readonly queue = new Deque<Observed>()
  private wake: (() => void) | undefined
  private closed = false

  /** Whether the generation was closed while its workspace root resolved. */
  get isClosed(): boolean {
    return this.closed
  }

  push(observed: Observed): void {
    this.queue.pushBack(observed)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.controller.abort()
    this.wake?.()
  }

  fail(error: Error): void {
    this.error = error
    this.close()
  }

  /** Drain until closed or aborted; anything still queued then is dropped with the generation. */
  async *read(signal: AbortSignal): AsyncIterable<Observed> {
    const abort = (): void => { this.close() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      while (!this.closed) {
        const observed = this.queue.popFront()
        if (observed !== undefined) {
          yield observed
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
      if (this.error !== undefined) throw this.error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}
