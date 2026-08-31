/**
 * Service Definition for the `ctx.shell` capability seam, covering foreground commands and background process
 * handles. Job ids, ownership, polling, and notices belong to
 * `@deepseek-ai/dsh-jobs`, keeping executors independent of sessions.
 * @module @deepseek-ai/dsh-shell
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from './types.ts'

/**
 * Settings namespace of this capability, owned here rather than by either
 * executor family because it names the capability, not an implementation: a
 * host composes exactly one provider of `ctx.shell` (the win32 layer swaps the
 * POSIX rows for the pwsh ones, and mounting both fails loud on a duplicate
 * service registration), so the providers share one namespace without ever
 * registering it twice, and a settings document carried between platforms
 * keeps resolving on both.
 */
export const SHELL_SETTINGS_NAMESPACE = 'shell'

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellExpiryPolicy,
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellPromotionOffer,
  ShellRunResult,
  ShellSandboxInfo,
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
} from './types.ts'
export { parseExitStatus } from './render.ts'
export type { ParsedExitStatus } from './render.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellExecutor
  }
}

/**
 * Abstract bash execution service. Subclass, implement the abstract methods,
 * and load the subclass as a plugin — it registers as `ctx.shell` (one
 * implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * There is one way to execute: {@link execute} spawns the process and returns
 * its live handle. "Foreground" is a property of what the caller awaits, not
 * of the spawn — a caller that awaits {@link ShellExecution.result} ran the
 * command in the foreground; one that keeps the handle ran it in the
 * background; one that awaits {@link ShellExecution.promotion} under
 * `onExpiry: 'offer'` decides at the deadline.
 *
 * Implementations must honor these semantics:
 * - {@link ShellExecution.result} rejects only for infrastructure failures.
 *   Nonzero exits, timeout kills, and abort kills resolve with a descriptive
 *   result: first-cause `timedOut`/`aborted`, the spec's `timeoutMs` echoed.
 * - The handle is live immediately. `done` settles at process close and never
 *   rejects; spawn failures settle as `killed` with the error on the read
 *   path, while `result()` carries the same failure as its rejection.
 * - `onExpiry: 'none'` arms no deadline; `'kill'` kills at expiry; `'offer'`
 *   resolves {@link ShellExecution.promotion} instead of killing, and an
 *   unanswered offer is treated as declined.
 * - {@link ShellProcess.readOutput} is incremental: consecutive reads never
 *   repeat output. Lossy reads report truncation and available spill files.
 * - A still-running process is stopped and awaited when its owning
 *   composition tears down. With the subprocess seam that boundary is
 *   `ctx.subprocess` disposal, so a process survives an executor-only reload.
 */
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  /**
   * The sandbox mode this executor applies by default, or `undefined` when it
   * does not sandbox commands.
   * @returns the configured default sandbox mode, when supported.
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * Apply implementation-owned defaults and caps to a request before execution.
   * @param request - the caller's request; omitted fields get this
   *   implementation's defaults, capped fields are clamped.
   * @returns the fully-specified spec to hand to {@link execute}.
   */
  abstract resolve(request: ShellExecRequest): ShellExecSpec

  /**
   * Spawn the command and return its live execution handle immediately.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the handle: the live process plus its foreground `result()`
   *   projection and the deadline's `promotion` signal.
   */
  abstract execute(spec: ShellExecSpec): ShellExecution
}

export default ShellExecutor
