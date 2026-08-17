/**
 * Fixed Claude Code one-shot subagent provider. Every accepted run invokes
 * the official Agent SDK in the delegating Session's workspace and places
 * the SDK-spawned real CLI under the shared subprocess owner.
 *
 * @module @deepseek-ai/dsh-subagent-claude-code
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  CLAUDE_CODE_PERMISSION_MODES,
  DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
  DEFAULT_DISPOSE_GRACE_MS,
  claudeCodeStartupFailure,
  startClaudeCodeRun,
  type ClaudeCodePermissionMode,
  type ClaudeCodeRunSpec,
} from './run.ts'

export const name = 'subagent-claude-code'
export const inject = ['subagents', 'subprocess']

/* jscpd:ignore-start -- sibling product providers intentionally expose
 * overlapping deployment-owned fields without adding a shared config owner. */
/** Deployment-owned permission, environment, and process-release settings. */
export interface Config {
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /**
   * Native non-interactive mode fixed for this Provider instance. Defaults to
   * `dontAsk`; `acceptEdits` accepts edits, `auto` uses the native classifier,
   * `plan` returns a plan without approving execution, and
   * `bypassPermissions` explicitly skips permission checks.
   */
  permissionMode?: ClaudeCodePermissionMode
  /** Grace in milliseconds for Claude Code process-tree termination. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  env: z.dict(z.string()).default({}),
  permissionMode: z.union([...CLAUDE_CODE_PERMISSION_MODES])
    .default(DEFAULT_CLAUDE_CODE_PERMISSION_MODE),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Required<Config>
/* jscpd:ignore-end */

/* jscpd:ignore-start -- Cordis registration and shared-seam plumbing mirror
 * the Codex sibling; each product's lifecycle remains package-private. */
class ClaudeCodeProvider implements SubagentProvider {
  readonly name = 'claude-code'
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-claude-code: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    let executable: string
    try {
      cwd = resolveChildCwd(
        'subagent-claude-code',
        undefined,
        parentCwd,
      )
      executable = await this.ctx.subprocess.resolveExecutable(
        'claude',
        this.config.env,
        request.signal,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-claude-code: request was aborted before SDK startup',
        )
      }
      const failure = claudeCodeStartupFailure(error)
      this.ctx.logger.warn(
        'subagent-claude-code: child start failed: %o',
        failure,
      )
      throw failure
    }
    const spec: ClaudeCodeRunSpec = {
      cwd,
      executable,
      permissionMode: this.config.permissionMode,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-claude-code: child run failed (${stopReason}): %o`,
          error,
        )
      },
    }
    return startClaudeCodeRun(request, spec)
  }
}

/**
 * Register the fixed `claude-code` provider.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - permission mode, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    env: config.env as Record<string, string>,
    permissionMode: config.permissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    disposeGraceMs: config.disposeGraceMs as number,
  }
  assertPositiveFinite(
    'subagent-claude-code',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-claude-code: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new ClaudeCodeProvider(ctx, resolved))
}
/* jscpd:ignore-end */
