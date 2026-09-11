/**
 * Records the files each top-level turn changed as a durable `workspace/changes`
 * Session event, derived from git working-tree snapshots taken at turn start
 * and turn end plus the hunks file tools persist for paths git does not cover.
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { GitRunner } from './git.ts'
import { temporaryRoots } from './paths.ts'
import { TurnRecorder } from './recorder.ts'

export type { WorkspaceChangedFile, WorkspaceChangesData } from './types.ts'

/** Stable Loader identity. */
export const name = 'workspace-changes'

/** Services used to run git and observe turns. */
export const inject = ['subprocess']

/** Directories excluded from shadow repositories, where no `.gitignore` exists. */
export const DEFAULT_SHADOW_EXCLUDES: readonly string[] = [
  '.git/', '.dsh/', '.DS_Store', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.pytest_cache/', '.mypy_cache/',
  'dist/', 'build/', 'out/', 'target/', '.cache/', '.next/', '.nuxt/', '.turbo/', 'coverage/',
]

/** Snapshot bounds and shadow repository placement. Invalid values fail plugin load. */
export interface Config {
  /** Harness home that holds shadow repositories under `workspace-changes/`; defaults to `$DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Milliseconds one git command may run before the turn's record is abandoned. */
  timeoutMs: number
  /** Bytes of git output retained per command; a larger diff listing abandons the record. */
  outputMaxBytes: number
  /** Maximum files carried by one event; `total` still reports the complete count. */
  maxFiles: number
  /** `info/exclude` patterns for shadow repositories. */
  shadowExcludes: string[]
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  dshHome: z.string(),
  timeoutMs: z.number().default(30_000),
  outputMaxBytes: z.number().default(8 * 1024 * 1024),
  maxFiles: z.number().default(500),
  shadowExcludes: z.array(z.string()).default([...DEFAULT_SHADOW_EXCLUDES]),
})

function eligible(session: Session): string | undefined {
  const { cwd, origin, delegationDepth } = session.header
  return origin === 'subagent' || (delegationDepth ?? 0) > 0 ? undefined : cwd
}

/**
 * Resolve the git executable once. On macOS the Xcode stub at `/usr/bin/git`
 * opens an installer dialog instead of running, so it counts as absent until
 * developer tools are selected.
 * @param ctx - subprocess capability.
 * @param signal - plugin lifetime.
 * @returns the executable path, or null when git is unavailable.
 */
async function resolveGit(ctx: Context, signal: AbortSignal): Promise<string | null> {
  let executable: string
  try {
    executable = await ctx.subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return null
  }
  if (process.platform !== 'darwin' || executable !== '/usr/bin/git') return executable
  const probe = ctx.subprocess.spawn({
    argv: ['/usr/bin/xcode-select', '-p'], cwd: homedir(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 1_000, signal,
  })
  const outcome = await probe.done.catch(() => ({ exitCode: null }))
  return outcome.exitCode === 0 ? executable : null
}

/**
 * Observe top-level turns of every Session with a working directory and append
 * their change summaries.
 * @param ctx - host context with `subprocess`.
 * @param config - validated bounds and placement.
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [['timeoutMs', config.timeoutMs], ['outputMaxBytes', config.outputMaxBytes], ['maxFiles', config.maxFiles]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`workspace-changes requires a positive integer ${field}`)
  }
  const lifetime = new AbortController()
  const recorders = new Map<Session, TurnRecorder>()
  ctx.effect(() => () => {
    lifetime.abort()
    for (const recorder of recorders.values()) recorder.dispose()
    recorders.clear()
  })
  const shadow = { home: join(resolveDshHome(config.dshHome), 'workspace-changes'), excludes: config.shadowExcludes }
  const roots = temporaryRoots()
  const home = realpathSync.native(homedir())
  let runner: Promise<GitRunner | null> | undefined
  const gitRunner = (): Promise<GitRunner | null> => {
    runner ??= resolveGit(ctx, lifetime.signal).then((executable) => {
      if (executable === null) {
        ctx.logger.info('workspace-changes: git is unavailable; turn file changes are not recorded')
        return null
      }
      return new GitRunner(ctx.subprocess, executable, { timeoutMs: config.timeoutMs, outputMaxBytes: config.outputMaxBytes })
    })
    return runner
  }
  const recorderFor = (session: Session, cwd: string): TurnRecorder => {
    let recorder = recorders.get(session)
    if (recorder === undefined) {
      recorder = new TurnRecorder(session, cwd, {
        git: gitRunner(), shadow, home, temporaryRoots: roots, maxFiles: config.maxFiles,
        warn: (message) => { ctx.logger.warn(message) },
      })
      recorders.set(session, recorder)
    }
    return recorder
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      const cwd = eligible(session)
      if (cwd !== undefined) recorderFor(session, cwd).start(event.data.turn)
      return
    }
    if (event.type === 'tool/result') recorders.get(session)?.observe(event)
    else if (event.type === 'turn/end') recorders.get(session)?.end(event.data.turn)
  })
  ctx.on('session/disposed', (session) => {
    recorders.get(session)?.dispose()
    recorders.delete(session)
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    await recorders.get(agent.session)?.stopping(turn)
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session
    if (session !== undefined) await recorders.get(session)?.settled()
    return next()
  })
}
