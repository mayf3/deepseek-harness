/**
 * One-shot Codex child lifecycle: spawn the real app-server through the
 * subprocess seam, publish only after initialization and ephemeral thread
 * creation, flatten post-publication failures, and dispose to whole-tree
 * quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-codex/run
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
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

interface CodexPackageManifest {
  readonly bin?: string | Readonly<Record<string, string>>
}

/**
 * Resolve the official package's declared `codex` bin relative to its manifest.
 * @param packageJsonPath - absolute path to the official package manifest.
 * @param manifest - parsed manifest carrying the declared bin entry.
 * @returns absolute path to the package-local JavaScript wrapper.
 */
export function codexPackageBinPath(
  packageJsonPath: string,
  manifest: CodexPackageManifest,
): string {
  const declared = typeof manifest.bin === 'string'
    ? manifest.bin
    : manifest.bin?.codex
  if (declared === undefined || declared.length === 0) {
    throw new Error('@openai/codex does not declare its codex bin')
  }
  return resolve(dirname(packageJsonPath), declared)
}

const codexPackageJsonPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackageManifest = JSON.parse(
  readFileSync(codexPackageJsonPath, 'utf8'),
) as CodexPackageManifest

/** Absolute package-local JavaScript wrapper selected by the package manifest. */
export const CODEX_PACKAGE_BIN = codexPackageBinPath(
  codexPackageJsonPath,
  codexPackageManifest,
)

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
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs: spec.disposeGraceMs,
    env: spec.env,
  })

  const wire = new CodexAppServerWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
  )
  const disposeProcess = (): Promise<void> => disposeCodexChild(wire, child)

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
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      throw new AggregateError(
        [thrown(error), thrown(disposeError)],
        'subagent-codex: startup failed and app-server cleanup also failed',
      )
    }
    if (runAbort.signal.aborted) {
      throw new Error('subagent-codex: request was aborted before run publication')
    }
    throw thrown(error)
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: () => Promise.race([
      wire.runTurn(texts, runAbort.signal),
      processFailure,
    ]),
    collectOutput,
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
