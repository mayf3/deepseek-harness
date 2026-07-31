import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { logTruncationMarker } from '../src/protocol.ts'

/**
 * Cross-language mirror check for the two protocol surfaces the host and the
 * CPython subprocess share at runtime, spawning a real `python3` to read them
 * from `py/protocol.py`. `src/protocol.ts` and `py/protocol.py` declare the same
 * frame vocabulary on two sides of the wire; the only values both sides EXECUTE
 * against are `PROTOCOL_FD` (the fd the channel is pinned to) and the log
 * truncation marker text (emitted verbatim by whichever ledger exhausts first),
 * so a drift there silently corrupts a live run. Self-skips when no `python3` is
 * on PATH — CI provides one; the pure-TS `protocol.spec.ts` covers the host
 * codec unconditionally.
 */

const execFileAsync = promisify(execFile)
const pyDir = fileURLToPath(new URL('../py', import.meta.url))

async function hasPython3(): Promise<boolean> {
  try {
    await execFileAsync('python3', ['--version'])
    return true
  } catch {
    return false
  }
}

const python3Available = await hasPython3()

describe.skipIf(!python3Available)('protocol.py mirrors protocol.ts at runtime', () => {
  it('agrees on PROTOCOL_FD and the log truncation marker across byte budgets', async () => {
    const budgets = [1, 65536, 1048576]
    const probe = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
      'from protocol import PROTOCOL_FD, log_truncation_marker',
      `budgets = ${JSON.stringify(budgets)}`,
      'print(json.dumps({',
      '  "fd": PROTOCOL_FD,',
      '  "markers": [log_truncation_marker(b) for b in budgets],',
      '}))',
    ].join('\n')
    const { stdout } = await execFileAsync('python3', ['-I', '-c', probe])
    const seen = JSON.parse(stdout) as { fd: number; markers: string[] }
    // fd 3 is the wire contract, not a tunable: index.ts pins it positionally.
    expect(seen.fd).toBe(3)
    expect(seen.markers).toEqual(budgets.map(budget => logTruncationMarker(budget)))
  })
})

it('names the py/ directory that ships with the package', () => {
  // Resolves py/ relative to this test file; the same directory ships in the
  // package.json `files` whitelist (`py/**/*.py`). The tests/ directory itself
  // is not published — this asserts the source-tree layout the mirror test
  // depends on, so it holds even when python3 is absent from the runner.
  expect(existsSync(pyDir)).toBe(true)
})
