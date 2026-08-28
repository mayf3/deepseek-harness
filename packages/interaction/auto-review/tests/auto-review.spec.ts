import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-instructions'
import { compactCheckpointSource, CompactionId } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type ContentBlock,
  type GenerateOptions,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import PermissionPresetService, {
  AUTO_PRESET,
  type Config as PermissionConfig,
} from '@deepseek-ai/dsh-permission-presets'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-shell'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  defineContentToolFixture,
  RUN_CODE_NAME,
  TOOL_ABORTED_BEFORE_DISPATCH,
  type ToolExecutionToken,
} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import * as AutoReview from '@deepseek-ai/dsh-auto-review'

type ReviewScript = readonly StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>)

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ReviewScript[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.script.shift()
    if (response === undefined) throw new Error('review adapter script exhausted')
    if (typeof response === 'function') {
      yield* response(options)
      return
    }
    for (const chunk of response) yield chunk
  }
}

interface PluginFiber {
  dispose(): Promise<void>
}

const PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask', name: 'Read only' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'Workspace write' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Full access' },
} satisfies NonNullable<PermissionConfig['presets']>

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (contexts.length > 0) await contexts.pop()!.fiber.dispose()
})

function decisionChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(
  script: ReviewScript[],
  permissionConfig: PermissionConfig = { presets: PRESETS, defaultPreset: 'workspace-write' },
): Promise<{ ctx: Context; adapter: RecordingAdapter; auto: PluginFiber }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('auto-review tests do not execute shell requests') },
    run() { throw new Error('auto-review tests do not execute shell requests') },
    start() { throw new Error('auto-review tests do not execute shell requests') },
  })
  ctx.provide('approval', { config: { policy: 'ask' } })
  await ctx.plugin(PermissionPresetService, permissionConfig)
  const adapter = new RecordingAdapter(script)
  ctx.llm.registerAdapter(['review'], adapter)
  const auto = await ctx.plugin(AutoReview)
  return { ctx, adapter, auto }
}

function agentFor(session: Session): Agent {
  return { id: session.id, session } as Agent
}

function autoSession(ctx: Context, id: string, cwd = '/workspace'): { session: Session; agent: Agent } {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  ctx.permissionPresets.set(session, AUTO_PRESET)
  return { session, agent: agentFor(session) }
}

function appendHeader(
  session: Session,
  tools?: readonly ToolSchema[],
  config: { provider: string; model: string } = { provider: 'review', model: 'same-model' },
): void {
  session.append('request/header', {
    header: { config, ...tools === undefined ? {} : { tools: [...tools] } },
    reason: session.requestHeader() === undefined ? 'initial' : 'change',
  })
}

function appendUser(session: Session, text: string, source: Parameters<typeof createUserMessage>[0]['source']): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source,
  }), { surfaceOp: 'append' })
}

function appendAssistant(
  session: Session,
  content: ContentBlock[],
  turn = 1,
  step = 1,
): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'review', model: 'same-model' },
    }),
  }, { surfaceOp: 'append' })
}

function appendNativeCall(
  session: Session,
  callId: ToolCallId,
  name: string,
  rawArguments: string,
  turn = 1,
  step = 1,
): void {
  session.append('tool/call', { turn, step, callId, name, arguments: rawArguments })
}

function registerProbe(ctx: Context, name = 'probe'): { readonly runs: () => number } {
  let runs = 0
  ctx.tools.register(defineContentToolFixture({
    name,
    description: `live ${name} description`,
    parameters: { path: { type: 'string' } },
    async execute() {
      runs += 1
      return [{ type: 'text', text: 'ran' }]
    },
  }))
  return { runs: () => runs }
}

function requestSections(request: GenerateOptions): Record<string, unknown> {
  const block = request.messages[0]?.content[0]
  if (block?.type !== 'text') throw new Error('review request has no text body')
  const labels = ['ENVIRONMENT', 'PROJECT_INSTRUCTIONS', 'FILTERED_HISTORY', 'PENDING_ACTION'] as const
  const sections: Record<string, unknown> = {}
  for (const [index, label] of labels.entries()) {
    const prefix = `${label}\n`
    const start = block.text.indexOf(prefix)
    if (start < 0) throw new Error(`missing ${label}`)
    const nextLabel = labels[index + 1]
    const end = nextLabel === undefined ? block.text.length : block.text.indexOf(`\n\n${nextLabel}\n`, start)
    sections[label] = JSON.parse(block.text.slice(start + prefix.length, end)) as unknown
  }
  return sections
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && !predicate(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  if (!predicate()) throw new Error('condition did not become true')
}

describe('native review request', () => {
  it('uses the latest route and exactly the filtered logged five-section input', async () => {
    const { ctx, adapter } = await harness([decisionChunks('{"decision":"allow"}')])
    const probe = registerProbe(ctx)
    const { session, agent } = autoSession(ctx, 'native-sections', '/workspace/project')
    const oldCallId = ToolCallId('old-call')
    const outerCallId = ToolCallId('outer-call')
    const historicalInnerId = ToolCallId('outer-call:code:0')
    const secondHistoricalInnerId = ToolCallId('outer-call:code:1')
    const currentCallId = ToolCallId('current-call')
    const unstartedCallId = ToolCallId('unstarted-call')
    const loggedSchema: ToolSchema = {
      name: 'probe',
      description: 'logged probe description',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }

    appendHeader(session, [{ ...loggedSchema, description: 'obsolete description' }], {
      provider: 'obsolete-provider', model: 'obsolete-model',
    })
    appendHeader(session, [loggedSchema])
    appendUser(session, 'direct authority', { kind: 'user' })
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: 'plugin evidence' },
        {
          type: 'tool-result',
          toolCallId: ToolCallId('result-source'),
          content: [{ type: 'text', text: 'tool result secret' }],
          isError: false,
        },
      ],
      source: { kind: 'plugin', plugin: 'evidence' },
    }), { surfaceOp: 'append' })
    appendUser(session, 'checkpoint authority', compactCheckpointSource(CompactionId('checkpoint-1')))
    appendUser(session, 'project authority', {
      kind: 'agent-instructions', form: 'instructions', changes: [],
    })
    appendUser(session, 'tool-source secret', { kind: 'tool', callId: ToolCallId('result-source') })
    appendAssistant(session, [
      { type: 'text', text: 'assistant secret' },
      { type: 'reasoning', text: 'reasoning secret' },
      { type: 'tool-call', id: oldCallId, name: 'old_probe', arguments: '{ "old": true }' },
      { type: 'tool-call', id: outerCallId, name: RUN_CODE_NAME, arguments: '{"code":"call probe"}' },
      { type: 'tool-call', id: currentCallId, name: 'probe', arguments: '{"path":"target"}' },
      { type: 'tool-call', id: unstartedCallId, name: 'probe', arguments: '{"path":"later"}' },
    ])
    appendNativeCall(session, oldCallId, 'old_probe', '{ "old": true }')
    appendNativeCall(session, outerCallId, RUN_CODE_NAME, '{"code":"call probe"}')
    appendNativeCall(session, currentCallId, 'probe', '{"path":"target"}')
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: oldCallId,
        content: [{ type: 'text', text: 'surface tool result secret' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/code-dispatch-start', {
      rootCallId: outerCallId,
      parentCallId: outerCallId,
      subCallId: historicalInnerId,
      name: 'read',
      description: 'Read one file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      arguments: { path: 'ptc-history' },
    })
    session.append('tool/code-dispatch-start', {
      rootCallId: outerCallId,
      parentCallId: outerCallId,
      subCallId: secondHistoricalInnerId,
      name: 'write',
      description: 'Write one file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      arguments: { path: 'second-ptc-history' },
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: currentCallId,
      name: 'probe',
      arguments: { path: 'target' },
      agent,
    })

    expect(result.isError).toBe(false)
    expect(probe.runs()).toBe(1)
    expect(adapter.requests).toHaveLength(1)
    const request = adapter.requests[0]!
    expect(request).toMatchObject({
      provider: 'review',
      model: 'same-model',
      system: AutoReview.REVIEW_POLICY,
      sessionId: session.id,
    })
    expect(request.maxTokens).toBeUndefined()
    expect(request.tools).toBeUndefined()
    expect(request.messages).toHaveLength(1)
    expect(request.messages[0]?.source).toEqual({ kind: 'plugin', plugin: 'dsh-auto-review' })
    expect(Object.isFrozen(request)).toBe(true)

    const sections = requestSections(request)
    expect(sections.ENVIRONMENT).toEqual({ cwd: '/workspace/project' })
    expect(sections.PROJECT_INSTRUCTIONS).toEqual([
      expect.objectContaining({
        kind: 'user-message',
        authority: 'may-authorize',
        source: { kind: 'agent-instructions', form: 'instructions', changes: [] },
        content: [{ type: 'text', text: 'project authority' }],
      }),
    ])
    expect(sections.FILTERED_HISTORY).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-message', authority: 'may-authorize', source: { kind: 'user' },
      }),
      expect.objectContaining({
        kind: 'user-message', authority: 'may-authorize',
        source: compactCheckpointSource(CompactionId('checkpoint-1')),
      }),
      expect.objectContaining({
        kind: 'user-message', authority: 'evidence-only', source: { kind: 'plugin', plugin: 'evidence' },
        content: [{ type: 'text', text: 'plugin evidence' }],
      }),
      expect.objectContaining({
        kind: 'tool-call', authority: 'evidence-only', mode: 'native',
        name: 'old_probe', arguments: '{ "old": true }',
      }),
      expect.objectContaining({
        kind: 'tool-call', authority: 'evidence-only', mode: 'native',
        name: RUN_CODE_NAME, arguments: '{"code":"call probe"}',
      }),
      expect.objectContaining({
        kind: 'tool-call', authority: 'evidence-only', mode: 'ptc-inner',
        name: 'read', arguments: '{\n  "path": "ptc-history"\n}',
      }),
      expect.objectContaining({
        kind: 'tool-call', authority: 'evidence-only', mode: 'ptc-inner',
        name: 'write', arguments: '{\n  "path": "second-ptc-history"\n}',
      }),
    ]))
    expect(sections.PENDING_ACTION).toEqual({
      mode: 'native',
      name: 'probe',
      description: 'logged probe description',
      parameters: loggedSchema.parameters,
      arguments: { path: 'target' },
    })
    const requestText = (request.messages[0]!.content[0] as { type: 'text'; text: string }).text
    expect(requestText).not.toContain('assistant secret')
    expect(requestText).not.toContain('reasoning secret')
    expect(requestText).not.toContain('tool result secret')
    expect(requestText).not.toContain('surface tool result secret')
    expect(requestText).not.toContain('tool-source secret')
    expect(requestText).not.toContain('unstarted-call')
    expect(requestText).not.toContain('obsolete description')
  })

  it('reconstructs empty and non-JSON native argument text exactly as the agent loop does', async () => {
    const { ctx, adapter } = await harness([
      decisionChunks('{"decision":"allow"}'),
      decisionChunks('{"decision":"allow"}'),
    ])
    registerProbe(ctx)
    const { session, agent } = autoSession(ctx, 'native-raw-arguments')
    appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])

    const emptyId = ToolCallId('empty-arguments')
    appendAssistant(session, [{ type: 'tool-call', id: emptyId, name: 'probe', arguments: '' }])
    appendNativeCall(session, emptyId, 'probe', '')
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: emptyId,
      name: 'probe',
      arguments: {},
      agent,
    })

    const invalidId = ToolCallId('invalid-json-arguments')
    appendAssistant(session, [{ type: 'tool-call', id: invalidId, name: 'probe', arguments: 'not-json' }], 1, 2)
    appendNativeCall(session, invalidId, 'probe', 'not-json', 1, 2)
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: invalidId,
      name: 'probe',
      arguments: 'not-json',
      agent,
    })

    expect(requestSections(adapter.requests[0]!).PENDING_ACTION).toMatchObject({ arguments: {} })
    expect(requestSections(adapter.requests[1]!).PENDING_ACTION).toMatchObject({ arguments: 'not-json' })
  })

  it('fail-closes every non-protocol result without retaining technical details', async () => {
    const providerFailure = async function* (): AsyncIterable<StreamChunk> {
      throw new Error('provider secret')
    }
    const invalidResponses: ReviewScript[] = [
      providerFailure,
      decisionChunks('null'),
      decisionChunks('"text"'),
      decisionChunks('[]'),
      decisionChunks('{"decision":"allow","reason":"not allowed"}'),
      decisionChunks('{"decision":"deny","reason":1}'),
      decisionChunks('{"decision":"deny","extra":true}'),
      decisionChunks('not json'),
      [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hidden' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      [
        ...decisionChunks('{"decision":"allow"}').slice(0, -1),
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'block-end', index: 1, block: { type: 'text', text: 'second' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '{"decision":"allow"}' } },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
      decisionChunks('{"decision":"allow"}').slice(0, -1),
      [
        ...decisionChunks('{"decision":"allow"}'),
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]
    const { ctx, adapter } = await harness([
      decisionChunks('{"decision":"deny"}'),
      ...invalidResponses,
    ])
    const probe = registerProbe(ctx)
    const cases = ['valid-deny', ...invalidResponses.map((_, index) => `invalid-${String(index)}`)]

    for (const id of cases) {
      const { session, agent } = autoSession(ctx, id)
      const schema: ToolSchema = {
        name: 'probe', description: 'probe', parameters: { type: 'object' },
      }
      appendHeader(session, [schema])
      const callId = ToolCallId(`${id}-call`)
      appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
      appendNativeCall(session, callId, 'probe', '{}')
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId,
        name: 'probe',
        arguments: {},
        agent,
      })
      expect(result).toMatchObject({
        isError: true,
        error: {
          message: 'the user rejected tool "probe"',
          info: {
            name: AutoReview.AUTO_REVIEW_DENIED_ERROR_NAME,
            code: AutoReview.AUTO_REVIEW_DENIED_CODE,
          },
        },
      })
      expect(result.isError && result.error.info).not.toHaveProperty('reason')
      expect(JSON.stringify(result)).not.toContain('provider secret')
    }

    expect(probe.runs()).toBe(0)
    expect(adapter.requests).toHaveLength(cases.length)
  })
})

describe('PTC and bypass semantics', () => {
  it('reviews one started inner call from its logged schema and preserves the raw deny reason', async () => {
    const rawReason = '  exact scope was not authorized\nretry with a narrower target  '
    const { ctx, adapter } = await harness([
      decisionChunks(JSON.stringify({ decision: 'deny', reason: rawReason })),
    ])
    const probe = registerProbe(ctx)
    const { session, agent } = autoSession(ctx, 'ptc-inner')
    appendHeader(session)
    appendUser(session, 'inspect only', { kind: 'user' })
    const outerCallId = ToolCallId('outer')
    const subCallId = ToolCallId('outer:code:0')
    appendAssistant(session, [
      { type: 'tool-call', id: outerCallId, name: RUN_CODE_NAME, arguments: '{"code":"probe()"}' },
    ])
    appendNativeCall(session, outerCallId, RUN_CODE_NAME, '{"code":"probe()"}')
    const parameters = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    session.append('tool/code-dispatch-start', {
      rootCallId: outerCallId,
      parentCallId: outerCallId,
      subCallId,
      name: 'probe',
      description: 'logged inner description',
      parameters,
      arguments: { path: 'inside' },
    })

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      rootCallId: outerCallId,
      parent: Symbol('outer execution') as ToolExecutionToken,
      callId: subCallId,
      name: 'probe',
      arguments: { path: 'inside' },
      agent,
    })

    expect(probe.runs()).toBe(0)
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Error: the user rejected tool "probe"' }],
      error: {
        message: 'the user rejected tool "probe"',
        info: {
          name: AutoReview.AUTO_REVIEW_DENIED_ERROR_NAME,
          code: AutoReview.AUTO_REVIEW_DENIED_CODE,
          reason: rawReason,
        },
      },
    })
    const sections = requestSections(adapter.requests[0]!)
    expect(sections.PENDING_ACTION).toEqual({
      mode: 'ptc-inner',
      name: 'probe',
      description: 'logged inner description',
      parameters,
      arguments: { path: 'inside' },
    })
    expect(sections.FILTERED_HISTORY).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'native', name: RUN_CODE_NAME, arguments: '{"code":"probe()"}' }),
    ]))
    expect(sections.FILTERED_HISTORY).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'ptc-inner', name: 'probe' }),
    ]))
  })

  it('does not review unscoped, non-Auto, or outer run_code executions', async () => {
    const { ctx, adapter } = await harness([])
    const probe = registerProbe(ctx)
    const ordinary = ctx.sessions.create(SessionId('ordinary'), { meta: { cwd: '/workspace' } })
    const ordinaryAgent = agentFor(ordinary)
    const auto = autoSession(ctx, 'outer-run-code')

    await expect(ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('without-agent'),
      name: 'probe',
      arguments: {},
    })).resolves.toMatchObject({ isError: false })
    await expect(ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('ordinary'),
      name: 'probe',
      arguments: {},
      agent: ordinaryAgent,
    })).resolves.toMatchObject({ isError: false })
    await expect(ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('outer-run-code'),
      name: RUN_CODE_NAME,
      arguments: { code: 'return 1' },
      agent: auto.agent,
    })).resolves.toMatchObject({ isError: true })

    expect(probe.runs()).toBe(2)
    expect(adapter.requests).toHaveLength(0)
  })
})

describe('cancellation and integration teardown', () => {
  it('delegates caller cancellation to the canonical before-dispatch result', async () => {
    const hanging = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      await new Promise<void>((_resolve, reject) => {
        const rejectAborted = (): void => { reject(new Error('review cancelled')) }
        if (options.signal?.aborted) rejectAborted()
        else options.signal?.addEventListener('abort', rejectAborted, { once: true })
      })
    }
    const { ctx, adapter } = await harness([hanging])
    const probe = registerProbe(ctx)
    const { session, agent } = autoSession(ctx, 'caller-cancel')
    appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
    const callId = ToolCallId('caller-cancel-call')
    appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
    appendNativeCall(session, callId, 'probe', '{}')
    const controller = new AbortController()

    const pending = ctx.tools.execute({ signal: controller.signal, callId, name: 'probe', arguments: {}, agent })
    await until(() => adapter.requests.length === 1)
    controller.abort(new Error('caller stopped'))
    const result = await pending

    expect(probe.runs()).toBe(0)
    expect(result).toMatchObject({
      isError: true,
      error: { info: { code: TOOL_ABORTED_BEFORE_DISPATCH } },
    })
  })

  it('migrates live sessions, aborts and drains reviews, then removes both registrations', async () => {
    const hanging = async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      await new Promise<void>((_resolve, reject) => {
        const rejectAborted = (): void => { reject(new Error('integration stopped')) }
        if (options.signal?.aborted) rejectAborted()
        else options.signal?.addEventListener('abort', rejectAborted, { once: true })
      })
    }
    const { ctx, adapter, auto } = await harness([hanging])
    const probe = registerProbe(ctx)
    const { session, agent } = autoSession(ctx, 'dispose-live')
    appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
    const callId = ToolCallId('dispose-call')
    appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
    appendNativeCall(session, callId, 'probe', '{}')
    const pending = ctx.tools.execute({
      signal: new AbortController().signal, callId, name: 'probe', arguments: {}, agent,
    })
    await until(() => adapter.requests.length === 1)

    const disposal = auto.dispose()
    const result = await pending
    await disposal

    expect(probe.runs()).toBe(0)
    expect(result).toMatchObject({
      isError: true,
      error: {
        message: 'the user rejected tool "probe"',
        info: { name: AutoReview.AUTO_REVIEW_DENIED_ERROR_NAME, code: AutoReview.AUTO_REVIEW_DENIED_CODE },
      },
    })
    expect(ctx.permissionPresets.current(session.events)).toBe('read-only')
    expect(ctx.permissionPresets.names).not.toContain(AUTO_PRESET)
  })

  it('retains the closed deny gate after draining when one session migration fails', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const controlled = async function* (): AsyncIterable<StreamChunk> {
      await held
      yield* decisionChunks('{"decision":"allow"}')
    }
    const { ctx, adapter, auto } = await harness([controlled])
    const probe = registerProbe(ctx)
    ctx.sessions.create(SessionId('dispose-ordinary'), { meta: { cwd: '/workspace' } })
    const { session, agent } = autoSession(ctx, 'dispose-failure')
    appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
    const firstId = ToolCallId('first-dispose-call')
    appendAssistant(session, [{ type: 'tool-call', id: firstId, name: 'probe', arguments: '{}' }])
    appendNativeCall(session, firstId, 'probe', '{}')
    const first = ctx.tools.execute({
      signal: new AbortController().signal, callId: firstId, name: 'probe', arguments: {}, agent,
    })
    await until(() => adapter.requests.length === 1)
    const originalSet = ctx.permissionPresets.set.bind(ctx.permissionPresets)
    const logged = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    vi.spyOn(ctx.permissionPresets, 'set').mockImplementation((target, preset) => {
      if (preset === 'read-only') throw new Error('migration failed')
      originalSet(target, preset)
    })

    const disposal = auto.dispose()
    await until(() => adapter.requests[0]?.signal?.aborted === true)
    expect(() => { ctx.permissionPresets.set(session, AUTO_PRESET) }).toThrow(/integration is closing/)
    const secondId = ToolCallId('second-dispose-call')
    appendAssistant(session, [{ type: 'tool-call', id: secondId, name: 'probe', arguments: '{}' }], 2, 1)
    appendNativeCall(session, secondId, 'probe', '{}', 2, 1)
    const second = await ctx.tools.execute({
      signal: new AbortController().signal, callId: secondId, name: 'probe', arguments: {}, agent,
    })
    expect(second).toMatchObject({
      isError: true,
      error: { info: { code: AutoReview.AUTO_REVIEW_DENIED_CODE } },
    })
    expect(adapter.requests).toHaveLength(1)
    release()
    await expect(disposal).resolves.toBeUndefined()
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({
      message: 'auto-review: failed to migrate live Auto sessions',
    }))
    await expect(first).resolves.toMatchObject({
      isError: true,
      error: { info: { code: AutoReview.AUTO_REVIEW_DENIED_CODE } },
    })
    const thirdId = ToolCallId('post-dispose-call')
    appendAssistant(session, [{ type: 'tool-call', id: thirdId, name: 'probe', arguments: '{}' }], 3, 1)
    appendNativeCall(session, thirdId, 'probe', '{}', 3, 1)
    await expect(ctx.tools.execute({
      signal: new AbortController().signal, callId: thirdId, name: 'probe', arguments: {}, agent,
    })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: AutoReview.AUTO_REVIEW_DENIED_CODE } },
    })
    expect(probe.runs()).toBe(0)
    expect(adapter.requests).toHaveLength(1)
    expect(ctx.permissionPresets.names).toContain(AUTO_PRESET)
    expect(() => { ctx.permissionPresets.set(session, AUTO_PRESET) }).toThrow(/integration is closing/)
  })

  it('rejects detached sessions and refuses to load without a read-only fallback', async () => {
    const { ctx } = await harness([])
    const detached = Session.create(SessionId('detached'))
    expect(() => { ctx.permissionPresets.set(detached, AUTO_PRESET) }).toThrow(/not live in this process/)
    expect(detached.events).toHaveLength(0)

    const invalid = new Context()
    contexts.push(invalid)
    await invalid.plugin(LlmRuntime)
    await invalid.plugin(SessionStore)
    await invalid.plugin(SystemPrompt, { persona: '' })
    await invalid.plugin(ToolRuntime)
    invalid.provide('shell', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('unused') },
      run() { throw new Error('unused') },
      start() { throw new Error('unused') },
    })
    invalid.provide('approval', { config: { policy: 'ask' } })
    await invalid.plugin(PermissionPresetService, {})
    await expect(invalid.plugin(AutoReview)).rejects.toThrow(/unknown preset "read-only"/)
    expect(invalid.permissionPresets.names).not.toContain(AUTO_PRESET)
  })
})

describe('logged-fact failures', () => {
  it('fails closed for missing, ambiguous, or conflicting native facts', async () => {
    const cases: Array<{
      readonly id: string
      readonly prepare: (session: Session, callId: ToolCallId) => void
    }> = [
      { id: 'missing-header', prepare: (session, callId) => {
        appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
        appendNativeCall(session, callId, 'probe', '{}')
      } },
      { id: 'empty-provider', prepare: (session, callId) => {
        appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }], { provider: '', model: 'm' })
        appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
        appendNativeCall(session, callId, 'probe', '{}')
      } },
      { id: 'empty-model', prepare: (session, callId) => {
        appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }], { provider: 'review', model: '' })
        appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
        appendNativeCall(session, callId, 'probe', '{}')
      } },
      { id: 'missing-current-surface', prepare: (session, callId) => {
        appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
        appendNativeCall(session, callId, 'probe', '{}')
      } },
      { id: 'missing-current-log', prepare: (session, callId) => {
        appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
        appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
      } },
      { id: 'duplicate-current-log', prepare: (session, callId) => {
        appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
        appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
        appendNativeCall(session, callId, 'probe', '{}')
        appendNativeCall(session, callId, 'probe', '{}')
      } },
      { id: 'wrong-current-name', prepare: (session, callId) => {
        appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
        appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'other', arguments: '{}' }])
        appendNativeCall(session, callId, 'other', '{}')
      } },
      { id: 'wrong-current-arguments', prepare: (session, callId) => {
        appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
        appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{"other":true}' }])
        appendNativeCall(session, callId, 'probe', '{"other":true}')
      } },
      { id: 'missing-schema', prepare: (session, callId) => {
        appendHeader(session, [])
        appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
        appendNativeCall(session, callId, 'probe', '{}')
      } },
      { id: 'ambiguous-schema', prepare: (session, callId) => {
        const schema = { name: 'probe', description: 'probe', parameters: { type: 'object' } }
        appendHeader(session, [schema, schema])
        appendAssistant(session, [{ type: 'tool-call', id: callId, name: 'probe', arguments: '{}' }])
        appendNativeCall(session, callId, 'probe', '{}')
      } },
      { id: 'visible-log-mismatch', prepare: (session, callId) => {
        appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
        const historical = ToolCallId('historical-mismatch')
        appendAssistant(session, [
          { type: 'tool-call', id: historical, name: 'shown', arguments: '{}' },
          { type: 'tool-call', id: callId, name: 'probe', arguments: '{}' },
        ])
        appendNativeCall(session, historical, 'logged', '{}')
        appendNativeCall(session, callId, 'probe', '{}')
      } },
      { id: 'ambiguous-visible-log', prepare: (session, callId) => {
        appendHeader(session, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
        const historical = ToolCallId('historical-duplicate')
        appendAssistant(session, [
          { type: 'tool-call', id: historical, name: 'old', arguments: '{}' },
          { type: 'tool-call', id: callId, name: 'probe', arguments: '{}' },
        ])
        appendNativeCall(session, historical, 'old', '{}')
        appendNativeCall(session, historical, 'old', '{}')
        appendNativeCall(session, callId, 'probe', '{}')
      } },
    ]
    const { ctx, adapter } = await harness([])
    const probe = registerProbe(ctx)

    for (const { id, prepare } of cases) {
      const { session, agent } = autoSession(ctx, id)
      const callId = ToolCallId(`${id}-call`)
      prepare(session, callId)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId,
        name: 'probe',
        arguments: {},
        agent,
      })
      expect(result).toMatchObject({
        isError: true,
        error: { info: { code: AutoReview.AUTO_REVIEW_DENIED_CODE } },
      })
    }

    const missingCwd = ctx.sessions.create(SessionId('missing-cwd'))
    ctx.permissionPresets.set(missingCwd, AUTO_PRESET)
    appendHeader(missingCwd, [{ name: 'probe', description: 'probe', parameters: { type: 'object' } }])
    const missingCwdId = ToolCallId('missing-cwd-call')
    appendAssistant(missingCwd, [{ type: 'tool-call', id: missingCwdId, name: 'probe', arguments: '{}' }])
    appendNativeCall(missingCwd, missingCwdId, 'probe', '{}')
    await expect(ctx.tools.execute({
      signal: new AbortController().signal,
      callId: missingCwdId,
      name: 'probe',
      arguments: {},
      agent: agentFor(missingCwd),
    })).resolves.toMatchObject({ isError: true, error: { info: { code: AutoReview.AUTO_REVIEW_DENIED_CODE } } })

    expect(probe.runs()).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('fails closed for missing, ambiguous, or conflicting PTC facts', async () => {
    const { ctx, adapter } = await harness([])
    const probe = registerProbe(ctx)
    const cases: Array<{
      readonly id: string
      readonly starts: (session: Session, outer: ToolCallId, inner: ToolCallId) => void
      readonly execute?: { root?: ToolCallId; name?: string; arguments?: unknown }
      readonly showParent?: boolean
    }> = [
      { id: 'missing-start', starts: () => {} },
      { id: 'duplicate-start', starts: (session, outer, inner) => {
        for (let index = 0; index < 2; index += 1) {
          session.append('tool/code-dispatch-start', {
            rootCallId: outer, parentCallId: outer, subCallId: inner,
            name: 'probe', description: 'probe', parameters: { type: 'object' }, arguments: {},
          })
        }
      } },
      { id: 'hidden-parent', showParent: false, starts: (session, outer, inner) => {
        session.append('tool/code-dispatch-start', {
          rootCallId: outer, parentCallId: outer, subCallId: inner,
          name: 'probe', description: 'probe', parameters: { type: 'object' }, arguments: {},
        })
      } },
      { id: 'wrong-root', execute: { root: ToolCallId('different-root') }, starts: (session, outer, inner) => {
        session.append('tool/code-dispatch-start', {
          rootCallId: outer, parentCallId: outer, subCallId: inner,
          name: 'probe', description: 'probe', parameters: { type: 'object' }, arguments: {},
        })
      } },
      { id: 'wrong-name', execute: { name: 'probe' }, starts: (session, outer, inner) => {
        session.append('tool/code-dispatch-start', {
          rootCallId: outer, parentCallId: outer, subCallId: inner,
          name: 'other', description: 'other', parameters: { type: 'object' }, arguments: {},
        })
      } },
      { id: 'wrong-arguments', execute: { arguments: {} }, starts: (session, outer, inner) => {
        session.append('tool/code-dispatch-start', {
          rootCallId: outer, parentCallId: outer, subCallId: inner,
          name: 'probe', description: 'probe', parameters: { type: 'object' }, arguments: { other: true },
        })
      } },
    ]

    for (const item of cases) {
      const { session, agent } = autoSession(ctx, `ptc-${item.id}`)
      appendHeader(session)
      const outer = ToolCallId(`${item.id}-outer`)
      const inner = ToolCallId(`${item.id}-inner`)
      if (item.showParent !== false) {
        appendAssistant(session, [
          { type: 'tool-call', id: outer, name: RUN_CODE_NAME, arguments: '{"code":"probe()"}' },
        ])
        appendNativeCall(session, outer, RUN_CODE_NAME, '{"code":"probe()"}')
      }
      item.starts(session, outer, inner)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        rootCallId: item.execute?.root ?? outer,
        parent: Symbol('parent') as ToolExecutionToken,
        callId: inner,
        name: item.execute?.name ?? 'probe',
        arguments: item.execute?.arguments ?? {},
        agent,
      })
      expect(result).toMatchObject({
        isError: true,
        error: { info: { code: AutoReview.AUTO_REVIEW_DENIED_CODE } },
      })
    }

    expect(probe.runs()).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })
})
