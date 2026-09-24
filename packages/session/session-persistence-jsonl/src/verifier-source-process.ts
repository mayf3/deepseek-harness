/** Source-only verifier isolation without TypeScript hooks inside Worker Threads. */

import { fork, type ChildProcess, type Serializable } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Start the source verifier in a Node process with advanced IPC serialization.
 * @param entry - source verifier entry module.
 * @param request - request validated by the verifier entry.
 * @returns message and exit events, plus termination that waits for process closure.
 */
export function spawnSourceVerifier(
  entry: URL, request: Serializable,
): Pick<ChildProcess, 'once'> & { terminate(): Promise<number | null> } {
  const child = fork(fileURLToPath(entry), [], {
    execArgv: ['--import', import.meta.resolve('tsx/esm')],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  let closed = false
  const completion = new Promise<number | null>((resolve) => {
    child.once('close', (code) => {
      closed = true
      resolve(code)
    })
  })
  child.send(request)
  return {
    once: child.once.bind(child),
    terminate(): Promise<number | null> {
      if (!closed) child.kill('SIGKILL')
      return completion
    },
  }
}
