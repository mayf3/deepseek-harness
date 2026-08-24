/**
 * Shared poll pump for producers whose output substrate is a non-consuming
 * offset reader (the subprocess `readFrom(fromByte)` family). Pure utility —
 * no cordis, no timers retained past settlement.
 * @module
 */

import type { ActivityChannel, ActivityHandle } from './types.ts'

/** One non-consuming offset read from a producer-owned stream. */
export interface ActivityPumpRead {
  /** Text captured since the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the source's retained window. */
  lossy: boolean
}

/** One producer-owned stream the pump copies into a process. */
export interface ActivityPumpSource {
  /** Stream label attached to every chunk this source yields. */
  channel?: ActivityChannel
  /**
   * Read everything captured since `fromByte` without consuming it.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 first).
   * @returns the delta text, the next offset, and the lossy flag.
   */
  read(fromByte: number): ActivityPumpRead
}

/** Cadence and settlement for one {@link pumpActivityOutput} run. */
export interface ActivityPumpOptions {
  /** Poll interval in milliseconds; a positive finite number. */
  pollMs: number
  /**
   * Settles when the producer's work finished and its sources hold their
   * final bytes. The pump drains once more after settlement and returns;
   * a rejection is treated as settlement.
   */
  done: Promise<unknown>
}

/**
 * Copy producer streams into a process at a bounded cadence: drain every
 * source, sleep `pollMs` or until `done` settles, repeat, then drain one
 * final time. A lossy source read appends its surviving tail with
 * `gapBefore`, so the discontinuity stays visible to observers. The pump
 * never calls `handle.end()` — the producer maps its own outcome.
 * @param handle - the open process receiving the copied chunks.
 * @param sources - producer streams, each pumped at its own offset.
 * @param options - poll cadence and the producer's settlement promise.
 * @returns resolves after the final post-settlement drain.
 */
export async function pumpActivityOutput(
  handle: ActivityHandle,
  sources: readonly ActivityPumpSource[],
  options: ActivityPumpOptions,
): Promise<void> {
  if (!Number.isFinite(options.pollMs) || options.pollMs <= 0) {
    throw new Error(`invalid pump pollMs: expected a positive finite number of milliseconds, got ${JSON.stringify(options.pollMs)}`)
  }
  const states = sources.map(source => ({ source, cursor: 0 }))
  const drain = (): void => {
    for (const state of states) {
      const { source } = state
      const read = source.read(state.cursor)
      state.cursor = read.nextOffset
      if (read.text.length === 0) continue
      if (source.channel === undefined && !read.lossy) {
        handle.append(read.text)
      } else {
        handle.append(read.text, {
          ...source.channel !== undefined ? { channel: source.channel } : {},
          ...read.lossy ? { gapBefore: true as const } : {},
        })
      }
    }
  }
  let settled = false
  const settlement = options.done.then(() => { settled = true }, () => { settled = true })
  while (!settled) {
    drain()
    await Promise.race([
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.pollMs)
        // The settlement branch wins the race; clear the loser so a finished
        // pump holds no pending timer for up to one poll interval.
        void settlement.then(() => { clearTimeout(timer); resolve() })
      }),
      settlement,
    ])
  }
  drain()
}
