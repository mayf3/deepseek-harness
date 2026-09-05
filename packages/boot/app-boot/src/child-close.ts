/**
 * One settlement for a spawned child: the exit code on `close`, the spawn
 * failure on `error`, or a timeout that kills the child. Shared by the
 * package probe and the plugin manager's pnpm runs, which otherwise each
 * wrote the same first-outcome-wins guard.
 */

import type { ChildProcess } from 'node:child_process'

/**
 * Wait for a child to close, at most `timeoutMs`.
 *
 * A spawn failure emits `error` and then `close`, and a timeout kill emits
 * `close` after the rejection, so the first outcome wins and the later
 * events are ignored.
 * @param child - the spawned process; the caller consumes its streams.
 * @param timeoutMs - how long to wait before killing the child with SIGKILL.
 * @param timedOut - builds the rejection reported for a timeout.
 * @returns the exit code `close` reported; null when a signal ended the child.
 */
export function awaitChildClose(child: ChildProcess, timeoutMs: number, timedOut: () => Error): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(() => { reject(timedOut()) })
    }, timeoutMs)
    child.on('error', (error) => { settle(() => { reject(error) }) })
    child.on('close', (code) => { settle(() => { resolve(code) }) })
  })
}
