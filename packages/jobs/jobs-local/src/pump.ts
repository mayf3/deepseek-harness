/**
 * The registry-owned pull pump: copies a job's {@link JobOutputSource}s into
 * its ring at a bounded cadence and drains them once more after the
 * producer settles, so the ring holds every byte before settlement trims and
 * closes it. A lossy source read lands as a gap chunk that names the source's
 * spill file when it keeps one. Pure utility — no cordis, no timers retained
 * past settlement.
 * @module @deepseek-ai/dsh-jobs-local/pump
 */

import type { JobAppendOptions, JobOutputSource } from '@deepseek-ai/dsh-jobs'

/** One pump run; `done` resolves after the final post-settlement drain. */
export interface PumpHandle {
  done: Promise<void>
}

/**
 * Drain every source in array order, sleep `pollMs` or until `until`
 * settles, repeat, then drain one final time. A lossy source read appends
 * its surviving tail with `gapBefore`, so the discontinuity stays visible to
 * observers. Sources drain in array order each round, so bytes two sources
 * produced inside one poll window land in that order, not in the order they
 * were written: the ring is a best-effort live view whose cross-source
 * reordering is bounded by `pollMs`.
 *
 * The wait holds constant resources however long the job runs: one
 * subscription on `until` for the whole run and one pending timer at a time.
 * @param sources - producer streams, each pumped at its own offset.
 * @param append - the ring append; receives each copied chunk.
 * @param pollMs - poll interval in milliseconds; a positive finite number.
 * @param until - settles (or rejects, which counts as settlement) when the producer finished.
 * @returns the handle whose `done` resolves after the final drain.
 */
export function startPump(
  sources: readonly JobOutputSource[],
  append: (text: string, options?: JobAppendOptions) => void,
  pollMs: number,
  until: Promise<unknown>,
): PumpHandle {
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`invalid pump pollMs: expected a positive finite number of milliseconds, got ${JSON.stringify(pollMs)}`)
  }
  const states = sources.map(source => ({ source, cursor: 0 }))
  const drain = (): void => {
    for (const state of states) {
      const { source } = state
      const read = source.read(state.cursor)
      state.cursor = read.nextOffset
      if (read.text.length === 0) continue
      if (source.channel === undefined && !read.lossy) {
        append(read.text)
      } else {
        append(read.text, {
          ...source.channel !== undefined ? { channel: source.channel } : {},
          ...read.lossy ? { gapBefore: true as const } : {},
          ...read.lossy && read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
        })
      }
    }
  }
  const done = (async (): Promise<void> => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let wake: (() => void) | undefined
    const finish = (): void => {
      settled = true
      // Clear the pending poll so a finished pump holds no timer for up to one
      // interval, and release the current wait so the final drain runs at once.
      // `finish` always runs from a microtask, after the loop parked on its
      // first timer, so the timer is never absent here.
      clearTimeout(timer)
      wake?.()
    }
    void until.then(finish, finish)
    while (!settled) {
      drain()
      await new Promise<void>((resolve) => {
        wake = resolve
        timer = setTimeout(resolve, pollMs)
      })
      wake = undefined
      timer = undefined
    }
    drain()
  })()
  return { done }
}
