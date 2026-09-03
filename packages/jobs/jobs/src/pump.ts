/**
 * Shared poll pump for producers whose output substrate is a non-consuming
 * offset reader (the subprocess `readFrom(fromByte)` family). Pure utility —
 * no cordis, no timers retained past settlement.
 * @module
 */

import type { JobChannel, RecordingJob } from './types.ts'

/** One non-consuming offset read from a producer-owned stream. */
export interface JobPumpRead {
  /** Text captured since the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the source's retained window. */
  lossy: boolean
}

/**
 * One producer-owned stream the pump copies into a job record.
 *
 * The source is a pull-by-offset snapshot reader, not a Node.js `Readable`,
 * because the substrate it reads (the subprocess `readFrom` family) is a
 * retained ring that several readers share: the model-facing consuming
 * cursor, the foreground result collector, and this record pump each hold
 * their own absolute offset and read without disturbing the others. A
 * `Readable` is single-consumer and consuming, so wrapping the ring in one
 * would need a tee per reader and could not express `lossy` — the reader's
 * offset having slid out of the retained window — which the record turns
 * into a visible `gapBefore` instead of a silent splice.
 */
export interface JobPumpSource {
  /** Stream label attached to every chunk this source yields. */
  channel?: JobChannel
  /**
   * Read everything captured since `fromByte` without consuming it.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 first).
   * @returns the delta text, the next offset, and the lossy flag.
   */
  read(fromByte: number): JobPumpRead
}

/** Cadence and settlement for one {@link pumpJobOutput} run. */
export interface JobPumpOptions {
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
 * Copy producer streams into a job record at a bounded cadence: drain every
 * source, sleep `pollMs` or until `done` settles, repeat, then drain one
 * final time. A lossy source read appends its surviving tail with
 * `gapBefore`, so the discontinuity stays visible to observers. Fold the
 * returned promise into the producer's `JobHooks.done` chain so the final
 * drain lands before settlement trims and closes the record.
 *
 * Each round drains the sources in array order, so bytes two sources
 * produced inside one poll window land in that order, not in the order they
 * were written; the record is a best-effort live view whose cross-source
 * reordering is bounded by `pollMs`, not a terminal transcript.
 *
 * The wait holds constant resources however long the job runs: one
 * subscription on `done` for the whole run and one pending timer at a time.
 * @param job - the running job's producer face receiving the copied chunks.
 * @param sources - producer streams, each pumped at its own offset.
 * @param options - poll cadence and the producer's settlement promise.
 * @returns resolves after the final post-settlement drain.
 */
export async function pumpJobOutput(
  job: RecordingJob,
  sources: readonly JobPumpSource[],
  options: JobPumpOptions,
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
        job.append(read.text)
      } else {
        job.append(read.text, {
          ...source.channel !== undefined ? { channel: source.channel } : {},
          ...read.lossy ? { gapBefore: true as const } : {},
        })
      }
    }
  }
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  const finish = (): void => {
    settled = true
    // Clear the pending poll so a finished pump holds no timer for up to one
    // interval, and release the current wait so the final drain runs at once.
    if (timer !== undefined) clearTimeout(timer)
    wake?.()
  }
  void options.done.then(finish, finish)
  while (!settled) {
    drain()
    await new Promise<void>((resolve) => {
      wake = resolve
      timer = setTimeout(resolve, options.pollMs)
    })
    wake = undefined
    timer = undefined
  }
  drain()
}
