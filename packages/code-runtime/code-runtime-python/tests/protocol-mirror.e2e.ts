import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { logTruncationMarker } from '../src/protocol.ts'

/**
 * Cross-language mirror check between `src/protocol.ts` and `py/protocol.py`,
 * spawning a real `python3` to read the Python side. Two things are asserted:
 * the runtime surfaces both sides EXECUTE against — `PROTOCOL_FD` and the log
 * truncation marker text, where a drift silently corrupts a live run — and the
 * per-frame wire field sets (required/optional keys of each `TypedDict`), which
 * turns the otherwise review-only shape mirror into an executable check that
 * catches the round-12 kind of drift (a renamed/dropped field, or one side
 * making a field optional the other requires). Self-skips when no `python3` is
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
    // fd 3 is the wire contract, not a tunable: the host pins it positionally
    // when it spawns the child.
    expect(seen.fd).toBe(3)
    expect(seen.markers).toEqual(budgets.map(budget => logTruncationMarker(budget)))
  })

  it('agrees on every frame type\'s wire field set between the TS and Python declarations', async () => {
    // Turn the TypedDict mirror from a review-only obligation into an executable
    // check: read each Python TypedDict's required/optional key sets and assert
    // them against the wire field names the TS side declares. `global` is the
    // reserved-keyword key the Python side carries via functional TypedDict —
    // catching exactly the round-12 kind of drift (a renamed/dropped field, an
    // optional field the other side made required).
    const probe = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(pyDir)})`,
      'import protocol as p',
      'def keys(td): return {"required": sorted(td.__required_keys__), "optional": sorted(td.__optional_keys__)}',
      'print(json.dumps({',
      '  "BootMessage": keys(p.BootMessage),',
      '  "Namespace": keys(p.Namespace),',
      '  "RunMessage": keys(p.RunMessage),',
      '  "BootAckMessage": keys(p.BootAckMessage),',
      '  "CallMessage": keys(p.CallMessage),',
      '  "LogMessage": keys(p.LogMessage),',
      '  "DoneErrorField": keys(p.DoneErrorField),',
      '  "DoneMessage": keys(p.DoneMessage),',
      '  "ErrorClass": keys(p.ErrorClass),',
      '}))',
    ].join('\n')
    const { stdout } = await execFileAsync('python3', ['-I', '-c', probe])
    const seen = JSON.parse(stdout) as Record<string, { required: string[]; optional: string[] }>
    // The wire field sets each frame carries, mirroring src/protocol.ts. `global`
    // is the JSON key `CallMessage`/`Namespace` send (a Python keyword, declared
    // functionally on the Python side).
    expect(seen).toEqual({
      BootMessage: { required: ['addressSpaceBytes', 'cpuSeconds', 'maxLogBytes', 'maxValueBytes', 'namespaces', 'type'], optional: [] },
      Namespace: { required: ['global', 'names'], optional: ['errorClass'] },
      RunMessage: { required: ['program', 'type'], optional: [] },
      BootAckMessage: { required: ['type'], optional: [] },
      CallMessage: { required: ['args', 'global', 'id', 'name', 'type'], optional: [] },
      LogMessage: { required: ['text', 'type'], optional: ['truncated'] },
      DoneErrorField: { required: ['kind', 'message'], optional: [] },
      DoneMessage: { required: ['type'], optional: ['error', 'value'] },
      ErrorClass: { required: ['memberNameProperty', 'name'], optional: [] },
    })
  })
})

it('names the py/ directory that ships with the package', () => {
  // Resolves py/ relative to this test file; the same directory ships in the
  // package.json `files` whitelist (`py/**/*.py`). The tests/ directory itself
  // is not published — this asserts the source-tree layout the mirror test
  // depends on, so it holds even when python3 is absent from the runner.
  expect(existsSync(pyDir)).toBe(true)
})
