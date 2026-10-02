/**
 * Experimental bridge for Claude Code mods: loads each configured plugin
 * directory's hooks module, runs `register(on, options)`, and raises the mod
 * events from harness extension points — `session.start` on `agent/created`,
 * `prompt.submit` and `turn.start` on `agent/pre-step`, `tool.call` around
 * `tools/execute`, `turn.complete` on `turn/end`, `session.end` on
 * `agent/disposed`, and `command.run` from the commands a mod registers. The
 * `$` a hook receives is served by {@link createHostOps} over the composed
 * harness services.
 * @module @deepseek-ai/dsh-experimental-claude-code-mods
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, ContextFormed, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { ModsEngine } from './engine.ts'
import { createHostOps, toolCallResultOf } from './host-ops.ts'
import type { AgentBinding } from './host-ops.ts'
import { readModManifest, resolvePluginOptions } from './manifest.ts'
import { loadHooksModule } from './module.ts'
import { createToolNameAliases } from './tool-names.ts'
import { messageOf, record, stringify } from './values.ts'
import type {
  PromptSubmitInput, PromptSubmitResult, SessionEndInput, SessionEndResult, SessionStartInput,
  SessionStartResult, ToolCallInput, ToolCallResult, TurnCompleteInput, TurnCompleteResult, TurnStartInput,
  TurnStartResult, TurnUsage,
} from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Context a mod added through `prompt.submit`, or a prompt a mod submitted
     * through `$.prompt.submit`; the text names the mod. Readers preserve the
     * message without this producer; nothing reads the kind back.
     * @persistenceAttribution
     */
    'claude-code-mods': { kind: 'claude-code-mods' } & ContextFormed
  }
}

export type * from './types.ts'
export { createModTestKit, mock, type ModTestKit, type ModTestKitOptions, type StubHook, type TestKitRaisers, type TestModule } from './testing.ts'
export { DEFAULT_TOOL_ALIASES } from './tool-names.ts'
export { KNOWN_EVENTS } from './matcher.ts'
export { MODS_API_VERSION } from './host-ops.ts'

export const name = 'claude-code-mods'
// Every harness service is read through `ctx.get` when a mod's call needs it,
// so a deployment composes only what its mods use.
export const inject: string[] = []

/** Plugin config: which mod directories to load and the limits their hooks run under. */
export interface Config {
  /**
   * Plugin directories to load, each holding `.claude-plugin/plugin.json` and
   * `hooks/hooks.json`, as `claude --plugin-dir` takes them. A relative path
   * resolves against the process launch cwd. Load order is chain order.
   */
  pluginDirs: string[]
  /** `register` option values by plugin name, overlaid on the manifest's `userConfig` defaults. */
  options?: Record<string, Record<string, string | number | boolean | string[]>>
  /** A hook's own running-time limit in milliseconds (Claude Code: 10 seconds). */
  hookTimeoutMs?: number
  /** A `.catch` handler's running-time limit in milliseconds (Claude Code: 1 second). */
  catchTimeoutMs?: number
  /** Default `$.process.run` and `$.http.fetch` timeout in milliseconds (Claude Code: 30 seconds). */
  processTimeoutMs?: number
  /** Claude Code tool name → harness tool name entries added to the built-in alias table. */
  toolAliases?: Record<string, string>
}

const optionValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])

export const Config: z<Config> = z.object({
  pluginDirs: z.array(z.string()).required(),
  options: z.dict(z.dict(optionValue)),
  hookTimeoutMs: z.number().default(10_000),
  catchTimeoutMs: z.number().default(1_000),
  processTimeoutMs: z.number().default(30_000),
  toolAliases: z.dict(z.string()),
})

function assertPositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`claude-code-mods: ${field} must be a positive number of milliseconds`)
}

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text).join('')
}

/**
 * Replace the prompt text across the claimed messages with one rewritten
 * text: the first text block carries it, other text blocks go, every
 * non-text block stays in place.
 */
function rewritePromptText(claimed: readonly UserMessage[], text: string): UserMessage[] {
  let placed = false
  return claimed.map((message) => {
    if (!message.content.some(block => block.type === 'text')) return message
    const content: ContentBlock[] = []
    for (const block of message.content) {
      if (block.type !== 'text') {
        content.push(block)
      } else if (!placed) {
        placed = true
        content.push({ type: 'text', text })
      }
    }
    return { ...message, content }
  })
}

/** What the bridge folds from one session's event stream about its open turn. */
interface TurnRecord {
  turn: number
  startedAt: number
  /** The last committed assistant text of the turn. */
  answer: string
  usage: TurnUsage | undefined
}

/** Fold one committed assistant message into the turn's answer and usage. */
function foldAssistantMessage(turnRecord: TurnRecord, data: { message: AssistantMessage; usage?: TokenUsage }): void {
  turnRecord.answer = textOf(data.message.content)
  if (data.usage === undefined) return
  const model = data.message.source.model
  const usage = turnRecord.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model }
  usage.input_tokens += data.usage.inputTokens
  usage.output_tokens += data.usage.outputTokens
  usage.cache_read_input_tokens += data.usage.cacheReadTokens ?? 0
  usage.cache_creation_input_tokens += data.usage.cacheWriteTokens ?? 0
  usage.model = model
  turnRecord.usage = usage
}

/** Detached mod runs the bridge tracks so disposal can await them. */
class DetachedRuns {
  private readonly pending = new Set<Promise<unknown>>()
  readonly controller = new AbortController()

  track(run: Promise<unknown>): void {
    this.pending.add(run)
    void run.finally(() => { this.pending.delete(run) })
  }

  async drain(): Promise<void> {
    this.controller.abort(new Error('claude-code-mods disposed'))
    await Promise.allSettled([...this.pending])
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const hookTimeoutMs = config.hookTimeoutMs ?? 10_000
  const catchTimeoutMs = config.catchTimeoutMs ?? 1_000
  const processTimeoutMs = config.processTimeoutMs ?? 30_000
  assertPositive('hookTimeoutMs', hookTimeoutMs)
  assertPositive('catchTimeoutMs', catchTimeoutMs)
  assertPositive('processTimeoutMs', processTimeoutMs)
  const aliases = createToolNameAliases(config.toolAliases)
  const registrations = new Set<() => void>()
  const modCommands = new Set<string>()
  const modTools = new Set<string>()
  const report = (line: string): void => { ctx.logger.warn(`claude-code-mods: ${line}`) }
  const ops = createHostOps({ ctx, aliases, processTimeoutMs, registrations, modCommands, modTools })
  const engine = new ModsEngine<AgentBinding>({
    ops: op => ops[op],
    stateKey: binding => binding.agent?.session.id ?? '',
    budgetMs: hookTimeoutMs,
    catchBudgetMs: catchTimeoutMs,
    report,
  })
  const detached = new DetachedRuns()
  ctx.effect(() => async () => {
    for (const dispose of registrations) dispose()
    registrations.clear()
    engine.dispose()
    await detached.drain()
  }, 'claude-code-mods: unload mods')

  // A plugin directory that does not read as a mod is a deployment error and
  // fails the load; a module that does not import or whose `register` throws is
  // the mod author's, so the session continues without that mod.
  const directories = config.pluginDirs.map(dir => readModManifest(dir, process.cwd()))
  for (const [order, directory] of directories.entries()) {
    if (directory.hasSettingsHooks) {
      ctx.logger.warn(`claude-code-mods: ${directory.manifest.name}: settings hooks in hooks.json are not run by this bridge; mount @deepseek-ai/dsh-hooks-claude-code for them`)
    }
    const options = resolvePluginOptions(directory.manifest, config.options?.[directory.manifest.name])
    try {
      const { mod, hooks } = await loadHooksModule(directory, options, order)
      engine.registry.add(mod, hooks)
      ctx.logger.info(`claude-code-mods: hooks module ${mod.name}@inline loaded (tier user); events: ${engine.describe(mod) || '(none)'}`)
    } catch (error: unknown) {
      ctx.logger.warn(`claude-code-mods: ${messageOf(error)}`)
    }
  }

  const agents = ctx.get('agents')
  const isRoot = (agent: Agent): boolean => agents === undefined || agents.roots().includes(agent)
  /** Root agents that received `session.start`; the registry no longer lists an agent once it is disposed. */
  const startedRoots = new Set<string>()
  const agentIdOf = (agent: Agent | undefined): { agentId: string } | Record<never, never> =>
    agent !== undefined && !isRoot(agent) ? { agentId: agent.id } : {}

  /** Per-session fold of the open turn, keyed by session id. */
  const turns = new Map<string, TurnRecord>()
  /** `<session>:<turn>` keys whose first pre-step already raised `turn.start`. */
  const startedTurns = new Set<string>()
  /** Rewritten tool results the post-execute listener installs as content. */
  const replacements = new Map<ToolExecutionToken, string>()
  /** Tools whose argument rewrite was already reported. */
  const rewritesReported = new Set<string>()

  ctx.on('agent/created', async ({ agent }) => {
    if (!isRoot(agent)) return
    startedRoots.add(agent.session.id)
    const input: SessionStartInput = {
      cwd: agent.session.header.cwd ?? process.cwd(),
      surface: null,
      isInteractive: ctx.get('userQuestions') !== undefined,
    }
    await engine.raise<SessionStartInput, SessionStartResult>(
      'session.start', input, e => ({ cwd: e.cwd }), { binding: { agent }, signal: detached.controller.signal },
    )
  })

  ctx.on('agent/disposed', ({ agent }) => {
    turns.delete(agent.session.id)
    engine.forgetState(agent.session.id)
    if (!startedRoots.delete(agent.session.id)) return
    const input: SessionEndInput = { reason: 'other', sessionId: agent.session.id }
    detached.track(engine.raise<SessionEndInput, SessionEndResult>(
      'session.end', input, e => ({ sessionId: e.sessionId }), { binding: { agent }, signal: detached.controller.signal },
    ))
  })

  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    const binding: AgentBinding = { agent }
    const turnKey = `${agent.session.id}:${turn}`
    const first = !startedTurns.has(turnKey)
    startedTurns.add(turnKey)
    const text = textOf(messages.flatMap(message => message.content))
    let submitted: PromptSubmitResult = { text }
    if (messages.length > 0) {
      const input: PromptSubmitInput = { text, wait: false, origin: { kind: 'composer' } }
      submitted = await engine.raise<PromptSubmitInput, PromptSubmitResult>(
        'prompt.submit', input, e => ({ text: e.text, ...e.context === undefined ? {} : { context: e.context } }), { binding, signal },
      )
      if (submitted.drop !== undefined) {
        ctx.logger.info(`claude-code-mods: prompt dropped: ${submitted.drop}`)
        return { kind: 'reject' }
      }
    }
    if (first) {
      const input: TurnStartInput = { text: submitted.text, turnId: String(turn), ...agentIdOf(agent) }
      await engine.raise<TurnStartInput, TurnStartResult>('turn.start', input, e => ({ turnId: e.turnId }), { binding, signal })
    }
    const downstream = await next()
    if (downstream.kind !== 'enter' || messages.length === 0) return downstream
    let entered = downstream.messages
    if (submitted.text !== text) {
      const claimed = new Set<UserMessage>(messages)
      entered = [...rewritePromptText(messages, submitted.text), ...downstream.messages.filter(message => !claimed.has(message))]
    }
    const context = submitted.context ?? []
    if (context.length > 0) {
      entered = [...entered, createUserMessage({
        content: context.map(line => ({ type: 'text', text: line })),
        source: { kind: 'claude-code-mods' },
      })]
    }
    return { ...downstream, messages: entered }
  })

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (engine.registry.select('tool.call').length === 0) return next()
    const agent = exec.agent
    const callArguments = record(exec.arguments)
    const input: ToolCallInput = { ...callArguments, tool: aliases.toMod(exec.name), tool_use_id: exec.callId, ...agentIdOf(agent) }
    let beneath: ToolExecutionResult | undefined
    const answer = await engine.raise<ToolCallInput, ToolCallResult>('tool.call', input, async (e) => {
      const { tool: _tool, tool_use_id: _id, agentId: _agentId, ...rewritten } = e
      if (JSON.stringify(rewritten) !== JSON.stringify(callArguments) && !rewritesReported.has(exec.name)) {
        rewritesReported.add(exec.name)
        ctx.logger.warn(`claude-code-mods: a tool.call hook rewrote the arguments of ${exec.name}; this bridge runs the call with its logged arguments`)
      }
      beneath = await next()
      return toolCallResultOf(beneath)
    }, { binding: { agent }, signal: exec.signal })
    if (answer.deny !== undefined) {
      return {
        isError: true,
        error: { message: answer.deny, info: { name: 'ModDenied', code: 'MOD_DENIED' } },
        content: [{ type: 'text', text: `Error: ${answer.deny}` }],
      }
    }
    const text = typeof answer.result === 'string' ? answer.result : stringify(answer.result) ?? ''
    if (beneath !== undefined) {
      const mapped = toolCallResultOf(beneath)
      if (mapped.result === answer.result && mapped.isError === answer.isError) return beneath
      replacements.set(exec.token, text)
      return beneath
    }
    if (modTools.has(exec.name) && answer.isError !== true) {
      return { isError: false, value: text, content: [{ type: 'text', text }] }
    }
    // A built-in tool's success value must satisfy its own output schema, so a
    // mod's answer in its place is reported as an error-shaped result.
    return { isError: true, error: { message: text, info: { name: 'ModAnswered', code: 'MOD_ANSWERED' } }, content: [{ type: 'text', text }] }
  })

  ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
    const replacement = replacements.get(exec.token)
    if (replacement === undefined) return next()
    replacements.delete(exec.token)
    const downstream = await next()
    if (downstream.kind === 'block') return downstream
    return {
      kind: 'accept',
      content: [{ type: 'text', text: replacement }],
      ...downstream.additionalContexts === undefined ? {} : { additionalContexts: downstream.additionalContexts },
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      turns.set(session.id, { turn: event.data.turn, startedAt: Date.now(), answer: '', usage: undefined })
      return
    }
    if (event.type === 'assistant/message') {
      const turnRecord = turns.get(session.id)
      if (turnRecord !== undefined) foldAssistantMessage(turnRecord, event.data)
      return
    }
    if (event.type !== 'turn/end') return
    const { turn, reason } = event.data
    startedTurns.delete(`${session.id}:${turn}`)
    const agent = agents?.get(session.id)
    if (agent === undefined) return
    const turnRecord = turns.get(session.id)
    const folded = turnRecord?.turn === turn ? turnRecord : undefined
    const input: TurnCompleteInput = {
      turnId: String(turn),
      answer: folded?.answer ?? '',
      durationMs: folded === undefined ? 0 : Date.now() - folded.startedAt,
      isAborted: reason.kind === 'aborted',
      reason: reason.kind === 'aborted' ? 'aborted' : reason.kind === 'error' ? 'error' : 'answer',
      ...agentIdOf(agent),
      ...folded?.usage === undefined ? {} : { usage: folded.usage },
    }
    detached.track(engine.raise<TurnCompleteInput, TurnCompleteResult>(
      'turn.complete', input, () => ({ text: '' }), { binding: { agent }, signal: detached.controller.signal },
    ).then((result) => {
      if (result.text.length > 0) ctx.logger.info(`claude-code-mods: ${result.text}`)
    }))
  })
}
