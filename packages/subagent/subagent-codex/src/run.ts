/**
 * One-shot Codex child lifecycle: spawn the real app-server through the
 * subprocess seam, publish only after initialization and ephemeral thread
 * creation, flatten post-publication failures, and dispose to whole-tree
 * quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-codex/run
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { CodexAppServerWire } from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000
/** Bounded stderr tail retained only to recognize the wrapper's payload error. */
const CODEX_STDERR_TAIL_BYTES = 16 * 1024

interface CodexPackageManifest {
  readonly bin: {
    readonly codex: string
  }
}

const codexPackageJsonPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackageManifest = JSON.parse(
  readFileSync(codexPackageJsonPath, 'utf8'),
) as CodexPackageManifest

/** Absolute package-local JavaScript wrapper selected by the package manifest. */
const CODEX_PACKAGE_BIN = resolve(
  dirname(codexPackageJsonPath),
  codexPackageManifest.bin.codex,
)

function missingPayloadDiagnostic(stderr: string): string | undefined {
  const platformPackage = /Missing optional dependency (@openai\/codex-[a-z0-9-]+)/
    .exec(stderr)?.[1]
  return platformPackage === undefined
    ? undefined
    : `Missing optional dependency ${platformPackage}`
}

function withMissingPayloadDiagnostic(
  error: Error,
  stderr: string,
): Error {
  const diagnostic = missingPayloadDiagnostic(stderr)
  if (diagnostic === undefined || error.message.includes(diagnostic)) return error
  return new Error(`${error.message}: ${diagnostic}`, { cause: error })
}

/** Profile-selectable non-interactive Codex permission mode. */
export type CodexPermissionMode =
  | 'never'
  | 'approve-for-me'
  | 'dangerously-bypass-approvals-and-sandbox'

/** Native non-interactive Codex modes mapped to official `thread/start` fields. */
export const CODEX_PERMISSION_MODES = [
  'never',
  'approve-for-me',
  'dangerously-bypass-approvals-and-sandbox',
] as const satisfies readonly CodexPermissionMode[]

/** Safe default for unattended Codex runs. */
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'never'

/**
 * Fixed package-local app-server command, independent of the host `PATH`.
 * @returns Node, the official wrapper, and the fixed app-server arguments.
 */
export function codexAppServerArgv(): string[] {
  return [process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']
}

/** Fully resolved inputs for one Codex app-server run. */
export interface CodexRunSpec {
  /** Parent Session workspace, also supplied to `thread/start`. */
  readonly cwd: string
  /** Profile-selected native non-interactive permission mode. */
  readonly permissionMode: CodexPermissionMode
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-codex: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-codex: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-codex: the one-shot task must not be empty')
  }
  return texts
}

/**
 * Close the private wire, terminate the managed process tree, and wait for the
 * subprocess owner to prove it is gone.
 * @param wire - private app-server protocol connection.
 * @param child - shared-service handle that owns the process tree.
 */
export async function disposeCodexChild(
  wire: CodexAppServerWire,
  child: SubprocessHandle,
): Promise<void> {
  wire.close()
  if (child.pid <= 0) {
    await child.done.catch(() => {})
    return
  }
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change tree ownership below.
  }
  child.terminate()
  await child.waitForExit()
  await child.done
}

/**
 * Start the real `codex app-server --stdio` child and publish its one-shot run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after initialization and ephemeral thread creation.
 */
export async function startCodexRun(
  request: SubagentStartRequest,
  spec: CodexRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-codex: request was aborted before app-server startup')
  }

  const child = spec.spawn({
    argv: codexAppServerArgv(),
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  })

  const wire = new CodexAppServerWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
    spec.permissionMode,
  )
  let stderrTail = Buffer.alloc(0)
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    const combined = Buffer.concat([stderrTail, bytes])
    stderrTail = combined.length > CODEX_STDERR_TAIL_BYTES
      ? Buffer.from(combined.subarray(combined.length - CODEX_STDERR_TAIL_BYTES))
      : combined
    wire.observeStderr(bytes.toString())
    try {
      // Synchronous fd forwarding preserves byte order without owning a
      // backpressure queue. A slow host sink can block this event-loop turn.
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr is an observation sink, not a child-run failure authority.
    }
  }
  const onStderrError = (): void => {
    // Stderr observation is auxiliary. JSON-RPC and child.done remain the
    // only terminal authorities if the diagnostic stream itself fails.
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  const disposeProcess = async (): Promise<void> => {
    try {
      await disposeCodexChild(wire, child)
      // Let stderr already queued by the process close reach both bounded
      // diagnostic consumers before their listeners are detached.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  }

  const processFailure: Promise<never> = child.done.then(
    outcome => Promise.reject(new Error(
      'subagent-codex: app-server exited before the run settled '
      + `(code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})`,
    )),
    (error: unknown) => Promise.reject(thrown(error)),
  )
  // A normal post-result dispose also closes the process. Keep that expected
  // late rejection observed after the result race has already settled.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-codex: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  try {
    wire.start()
    await Promise.race([wire.initialize(request.signal), processFailure])
    await Promise.race([wire.startThread(spec.cwd, request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const startupCause = thrown(error)
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      throw new AggregateError(
        [withMissingPayloadDiagnostic(startupCause, stderrTail.toString()), thrown(disposeError)],
        'subagent-codex: startup failed and app-server cleanup also failed',
      )
    }
    if (runAbort.signal.aborted) {
      throw new Error('subagent-codex: request was aborted before run publication')
    }
    throw withMissingPayloadDiagnostic(startupCause, stderrTail.toString())
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        return await Promise.race([
          wire.runTurn(texts, runAbort.signal),
          processFailure,
        ])
      } catch (error: unknown) {
        // Give stderr data already queued in Node one turn to reach the wire
        // before settlement snapshots the diagnostic; later OS data is best-effort.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        throw withMissingPayloadDiagnostic(thrown(error), stderrTail.toString())
      }
    },
    collectOutput,
    collectDiagnostic: () => wire.collectDiagnostic(),
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
