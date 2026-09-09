/**
 * The one-shot app's command-line provider: it parses the task positional,
 * `--session-id`, `--json`, and `--help`, then publishes
 * {@link HEADLESS_STARTUP_SERVICE}. The runner is an ordinary consumer whose
 * lazy config waits for that service.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the one-shot runner. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}. */
export interface HeadlessStartupValues {
  /** The task text this invocation asked for; absent when the runner reads stdin. */
  task: string | undefined
  /** Exact Session identity to adopt or create; absent for a fresh random identity. */
  sessionId: string | undefined
  /** Whether stdout carries the machine-readable event stream instead of final text. */
  json: boolean
}

/** Process facts the provider reads; tests substitute them. */
export const internals: { stdinIsTty: () => boolean } = {
  stdinIsTty: () => process.stdin.isTTY,
}

/**
 * This app's command: the task positional, its options, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task, stream reasoning to stderr, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .option('--json', 'write newline-delimited run events to stdout instead of the final message')
    .option('--session-id <id>', 'adopt the persisted Session with this id, or create it when absent')
    .argument('[task...]', 'the task text; multiple words are joined by spaces, and `-` reads stdin')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"          answer one task and exit
  echo "run the tests" | dsh --profile headless   read the task from stdin
  dsh --profile headless --json "run the tests"   emit machine-readable run events
  dsh --profile headless --session-id session-… "continue"   adopt a Session
`)
}

/**
 * Parse and provide the one-shot task as an ordinary Cordis service. The
 * command's action publishes the task; a missing task on an interactive stdin
 * is a usage error, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  program.action(() => {
    const joined = program.args.join(' ')
    const task = joined.trim() === '' ? undefined : joined
    if (task === undefined && internals.stdinIsTty()) {
      program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    }
    const options = program.opts<{ json?: boolean; sessionId?: string }>()
    const sessionId = options.sessionId?.trim()
    if (options.sessionId !== undefined && sessionId === '') {
      program.error('error: --session-id requires a non-empty session id')
    }
    ctx.provide(HEADLESS_STARTUP_SERVICE, {
      task,
      sessionId,
      json: options.json === true,
    } satisfies HeadlessStartupValues)
  })
  parseCmdline(ctx, program)
}
