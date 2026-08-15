import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as codex from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import {
  CODEX_PERMISSION_MODES,
  DEFAULT_CODEX_PERMISSION_MODE,
  codexAppServerArgv,
  DEFAULT_DISPOSE_GRACE_MS,
  disposeCodexChild,
  startCodexRun,
  textTask,
  type CodexRunSpec,
} from '../src/run.ts'
import { CodexAppServerWire } from '../src/wire.ts'

type JsonObject = Record<string, unknown>

const fakeParent = {
  id: 'parent',
  session: { header: { cwd: process.cwd() } },
} as unknown as Agent

function request(
  prompt: ContentBlock[] = [{ type: 'text', text: 'do the task' }],
  signal = new AbortController().signal,
) {
  return { prompt, parent: fakeParent, signal }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

class ProtocolPeer {
  private buffer = ''
  private readonly frames: JsonObject[] = []
  private readonly wakeups = new Set<() => void>()

  constructor(
    input: PassThrough,
    private readonly output: PassThrough,
  ) {
    input.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString()
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim().length > 0) this.frames.push(JSON.parse(line) as JsonObject)
      }
      for (const wake of this.wakeups) wake()
      this.wakeups.clear()
    })
  }

  async next(predicate: (frame: JsonObject) => boolean): Promise<JsonObject> {
    for (;;) {
      const index = this.frames.findIndex(predicate)
      if (index >= 0) return this.frames.splice(index, 1)[0]!
      await new Promise<void>((resolve) => { this.wakeups.add(resolve) })
    }
  }

  nextMethod(method: string): Promise<JsonObject> {
    return this.next(frame => frame.method === method)
  }

  nextResponse(id: unknown): Promise<JsonObject> {
    return this.next(frame => frame.id === id && frame.method === undefined)
  }

  send(...frames: readonly JsonObject[]): void {
    this.output.write(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)
  }

  respond(requestFrame: JsonObject, result: unknown): void {
    this.send({ id: requestFrame.id, result })
  }
}

interface FakeChildOptions {
  readonly pid?: number
  readonly exitOnTerminate?: boolean
  readonly doneError?: Error
}

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly peer: ProtocolPeer
  readonly fromChild: PassThrough
  readonly toChild: PassThrough
  readonly stderr: PassThrough
  readonly settle: (outcome?: SubprocessOutcome) => void
  readonly fail: (error: Error) => void
  readonly terminate: () => void
  readonly waitForExit: (signal?: AbortSignal) => Promise<boolean>
}

function fakeChild(options: FakeChildOptions = {}): FakeChild {
  const fromChild = new PassThrough()
  const toChild = new PassThrough()
  const stderr = new PassThrough()
  const peer = new ProtocolPeer(toChild, fromChild)
  let exited = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const settle = (
    outcome: SubprocessOutcome = { exitCode: 0, signal: null },
  ): void => {
    if (exited) return
    exited = true
    resolveDone(outcome)
  }
  const fail = (error: Error): void => {
    if (exited) return
    exited = true
    rejectDone(error)
  }
  if (options.doneError !== undefined) fail(options.doneError)
  const terminate = vi.fn(() => {
    if (options.exitOnTerminate !== false) settle()
  })
  const waitForExit = vi.fn(async (signal?: AbortSignal) => {
    if (exited) return true
    if (signal === undefined) {
      await done.catch(() => {})
      return true
    }
    return await new Promise<boolean>((resolve) => {
      const onAbort = (): void => { resolve(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void done.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve(true)
        },
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve(true)
        },
      )
    })
  })
  const handle: SubprocessHandle = {
    pid: options.pid ?? 1234,
    stdin: toChild,
    stdout: fromChild,
    stderr,
    collected: {},
    done,
    terminate,
    waitForExit,
  }
  return {
    handle,
    peer,
    fromChild,
    toChild,
    stderr,
    settle,
    fail,
    terminate,
    waitForExit,
  }
}

function runSpec(
  child: FakeChild,
  overrides: Partial<CodexRunSpec> = {},
): CodexRunSpec {
  return {
    cwd: process.cwd(),
    permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
    env: {},
    disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    spawn: () => child.handle,
    ...overrides,
  }
}

async function initializeWire(): Promise<{
  readonly child: FakeChild
  readonly wire: CodexAppServerWire
}> {
  const child = fakeChild()
  const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
  wire.start()
  const initializing = wire.initialize(new AbortController().signal)
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
  await initializing
  expect(await child.peer.nextMethod('initialized')).toEqual({
    jsonrpc: '2.0',
    method: 'initialized',
  })
  const starting = wire.startThread(process.cwd(), new AbortController().signal)
  const threadStart = await child.peer.nextMethod('thread/start')
  child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
  await starting
  return { child, wire }
}

async function publishRun(
  child = fakeChild(),
  signal = new AbortController().signal,
  specOverrides: Partial<CodexRunSpec> = {},
) {
  const starting = startCodexRun(request(undefined, signal), runSpec(child, specOverrides))
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
  await child.peer.nextMethod('initialized')
  const threadStart = await child.peer.nextMethod('thread/start')
  child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
  const run = await starting
  const turnStart = await child.peer.nextMethod('turn/start')
  return { child, run, turnStart }
}

function agentMessage(
  text: unknown,
  phase: unknown,
  turnId = 'turn-1',
  threadId = 'thread-1',
): JsonObject {
  return {
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'agentMessage', text, phase },
    },
  }
}

function turnCompleted(
  status: unknown,
  turnId = 'turn-1',
  threadId = 'thread-1',
  error: unknown = null,
): JsonObject {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status, error },
    },
  }
}

describe('task admission and package contracts', () => {
  it('keeps the app-server command fixed on POSIX and Windows', () => {
    expect(codexAppServerArgv('linux')).toEqual([
      'codex', 'app-server', '--stdio',
    ])
    expect(codexAppServerArgv('win32')).toEqual([
      'cmd.exe',
      '/d',
      '/s',
      '/c',
      'codex',
      'app-server',
      '--stdio',
    ])
  })

  it('accepts one or more text blocks and rejects empty or non-text tasks', () => {
    expect(textTask([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])).toEqual(['one', 'two'])
    expect(() => textTask([])).toThrow('only text blocks')
    expect(() => textTask([{ type: 'reasoning', text: 'hidden' }]))
      .toThrow('only text blocks')
    expect(() => textTask([{ type: 'text', text: ' \n ' }]))
      .toThrow('must not be empty')
  })

  it('registers one fixed descriptor, validates config, and unregisters on HMR', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(codex, {})
    const provider = ctx.subagents.getProvider('codex')!
    expect(provider).toMatchObject({
      name: 'codex',
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    })
    expect(ctx.subagents.list()).toEqual(['codex'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])

    for (const disposeGraceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(ctx.plugin(codex, { disposeGraceMs }))
        .rejects.toThrow('disposeGraceMs must be a positive finite number')
    }
    await expect(ctx.plugin(codex, { disposeGraceMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(`disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    await ctx.fiber.dispose()
  })

  it('accepts only the three fixed non-interactive permission modes', () => {
    expect(codex.Config({}).permissionMode).toBe(DEFAULT_CODEX_PERMISSION_MODE)
    for (const permissionMode of CODEX_PERMISSION_MODES) {
      expect(codex.Config({ permissionMode }).permissionMode).toBe(permissionMode)
    }
    for (const permissionMode of ['on-request', 'untrusted', 'future-mode']) {
      expect(() => codex.Config({ permissionMode } as never)).toThrow()
    }
  })

  it('resolves the safe permission default when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    codex.apply(ctx, { env: {}, disposeGraceMs: 3_000 })
    expect(ctx.subagents.getProvider('codex')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it.each([
    ['never', { approvalPolicy: 'never' }],
    ['approve-for-me', {
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
    }],
    ['dangerously-bypass-approvals-and-sandbox', {
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    }],
  ] as const)('maps %s to the official thread/start fields', async (permissionMode, expected) => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(
      child.handle.stdout!,
      child.handle.stdin!,
      permissionMode,
    )
    wire.start()
    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await initializing
    await child.peer.nextMethod('initialized')
    const starting = wire.startThread('/workspace', new AbortController().signal)
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: '/workspace',
      ephemeral: true,
      ...expected,
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    await starting
    wire.close()
  })

  it('requires a parent session cwd without suggesting unsupported config', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await ctx.plugin(codex, {})

    await expect(ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: {
        id: 'parent-without-cwd',
        session: { header: {} },
      } as unknown as Agent,
      signal: new AbortController().signal,
    })).rejects.toThrow(
      'subagent-codex: no working directory for the child — delegate from a parent session that has one',
    )
    expect(spawn).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('keeps the namespace export shape and package-owned empty invariant', async () => {
    expect('default' in codex).toBe(false)
    expect(codex.name).toBe('subagent-codex')
    expect(codex.inject).toEqual(['subagents', 'subprocess'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(codex)).toBe(codex)

    const dispose = vi.fn()
    const register = vi.fn((
      _packageName: string,
      _installer: InvariantInstaller,
    ) => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-subagent-codex',
      expect.any(Function),
    )
    const install = register.mock.calls[0]![1]
    await install(new Context(), (message) => { throw new Error(message) })
    expect(invariant.name).toBe('subagent-codex-invariant')
    expect(invariant.inject).toEqual(['invariants'])
  })
})

describe('CodexAppServerWire', () => {
  it('sends the fixed handshake, thread, and turn payloads and keeps final_answer', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    expect(wire.collectOutput()).toEqual([])
    wire.start()

    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    expect(initialize.params).toEqual({
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    })
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await initializing
    await child.peer.nextMethod('initialized')

    const starting = wire.startThread('/workspace', new AbortController().signal)
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: '/workspace',
      ephemeral: true,
      approvalPolicy: 'never',
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    await starting

    const result = wire.runTurn(
      ['first', 'second'],
      new AbortController().signal,
    )
    const turnStart = await child.peer.nextMethod('turn/start')
    expect(turnStart.params).toEqual({
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'first', text_elements: [] },
        { type: 'text', text: 'second', text_elements: [] },
      ],
    })
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      },
      agentMessage('other thread', 'final_answer', 'turn-1', 'thread-2'),
      agentMessage('other turn', 'final_answer', 'turn-2'),
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'reasoning', text: 'not output' },
        },
      },
      agentMessage('commentary', 'commentary'),
      agentMessage('unphased', null),
      agentMessage('first final', 'final_answer'),
      agentMessage('last final', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'last final' }],
      stopReason: 'completed',
    })
    expect(wire.collectOutput()).toEqual([{ type: 'text', text: 'last final' }])
    wire.close()
    wire.close()
  })

  it('uses the last nullable-phase answer when no explicit final exists', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      agentMessage('first', null),
      agentMessage('fallback', null),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'fallback' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('maps only an explicit context-window failure to max-tokens', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      agentMessage('partial answer', null),
      turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'too much context',
        codexErrorInfo: 'contextWindowExceeded',
      }),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'partial answer' }],
      stopReason: 'max-tokens',
    })
    wire.close()
  })

  it('rejects invalid handshake, thread, and turn response shapes', async () => {
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      const frame = await child.peer.nextMethod('initialize')
      child.peer.respond(frame, null)
      await expect(pending).rejects.toThrow('invalid initialize response')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.startThread('/workspace', new AbortController().signal)
      const frame = await child.peer.nextMethod('thread/start')
      child.peer.respond(frame, { thread: { id: 'thread-1', ephemeral: false } })
      await expect(pending).rejects.toThrow('did not create an ephemeral thread')
      wire.close()
    }
    {
      const { child, wire } = await initializeWire()
      const pending = wire.runTurn(['task'], new AbortController().signal)
      const frame = await child.peer.nextMethod('turn/start')
      child.peer.respond(frame, { turn: { id: '' } })
      await expect(pending).rejects.toThrow('turn/start turn id')
      wire.close()
    }
  })

  it('fails closed for empty output, malformed messages, phases, and terminal status', async () => {
    const scenarios: Array<{
      readonly frames: JsonObject[]
      readonly message: string
    }> = [
      {
        frames: [turnCompleted('completed')],
        message: 'without a final answer',
      },
      {
        frames: [
          agentMessage('fallback', null),
          agentMessage(' \n ', 'final_answer'),
          turnCompleted('completed'),
        ],
        message: 'without a final answer',
      },
      {
        frames: [agentMessage(42, 'final_answer')],
        message: 'invalid agent message',
      },
      {
        frames: [agentMessage('answer', 'future_phase')],
        message: 'unknown agent message phase',
      },
      {
        frames: [turnCompleted('failed', 'turn-1', 'thread-1', { message: 'no' })],
        message: 'status failed',
      },
      {
        frames: [turnCompleted('interrupted')],
        message: 'status interrupted',
      },
      {
        frames: [turnCompleted('inProgress')],
        message: 'invalid terminal turn status',
      },
    ]
    for (const scenario of scenarios) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(...scenario.frames)
      await expect(result).rejects.toThrow(scenario.message)
      wire.close()
    }
  })

  it('fails closed when terminal notification params are not an object', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send({ method: 'turn/completed', params: null })
    await expect(result).rejects.toThrow('invalid turn/completed thread id')
    wire.close()
  })

  it('keeps an unsupported request authoritative over an early terminal in the same chunk', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      { id: 'future-request', method: 'future/request', params: {} },
      agentMessage('early answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).rejects.toThrow('unsupported app-server request')
    wire.close()
  })

  it('answers all five unattended request classes without granting authority', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')

    child.peer.send({
      id: 'command',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['decline', 'cancel'],
        command: 'cat /private/secret.txt',
      },
    })
    expect(await child.peer.nextResponse('command')).toMatchObject({
      result: { decision: 'cancel' },
    })
    expect(wire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: never; request: command approval; decision: cancelled): the provider does not grant interactive approval',
    )

    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    const requests = [
      {
        id: 'file',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['decline'],
        },
        result: { decision: 'decline' },
        diagnostic: 'Codex unattended decision (mode: never; request: file approval; decision: declined): the provider does not grant interactive approval',
      },
      {
        id: 'file-default',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        result: { decision: 'decline' },
        diagnostic: 'Codex unattended decision (mode: never; request: file approval; decision: declined): the provider does not grant interactive approval',
      },
      {
        id: 'permissions',
        method: 'item/permissions/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        result: { permissions: {}, scope: 'turn' },
        diagnostic: 'Codex unattended decision (mode: never; request: permission grant; decision: denied): the provider grants no additional turn permissions',
      },
      {
        id: 'user-input',
        method: 'item/tool/requestUserInput',
        params: { threadId: 'thread-1', turnId: 'turn-1', questions: [] },
        result: { answers: {} },
        diagnostic: 'Codex unattended decision (mode: never; request: user input; decision: empty response): the provider does not collect interactive answers',
      },
      {
        id: 'mcp',
        method: 'mcpServer/elicitation/request',
        params: { threadId: 'thread-1', turnId: null },
        result: { action: 'decline', content: null, _meta: null },
        diagnostic: 'Codex unattended decision (mode: never; request: MCP elicitation; decision: declined): the provider does not collect interactive MCP input',
      },
    ] as const
    for (const serverRequest of requests) {
      child.peer.send(serverRequest)
      expect(await child.peer.nextResponse(serverRequest.id)).toMatchObject({
        result: serverRequest.result,
      })
      expect(wire.collectDiagnostic()).toBe(serverRequest.diagnostic)
    }
    expect(wire.collectDiagnostic()).not.toContain('/private/secret.txt')

    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('records only a safe diagnostic for an explicit sandbox failure', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'failed at /private/secret.txt with SECRET_TOKEN',
      additionalDetails: 'raw command payload',
      codexErrorInfo: 'sandboxError',
    }))
    await expect(result).rejects.toThrow('status failed')
    expect(wire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: never; request: sandbox execution; decision: failed): Codex reported a sandbox failure',
    )
    expect(wire.collectDiagnostic()).not.toContain('SECRET_TOKEN')
    expect(wire.collectDiagnostic()).not.toContain('/private/secret.txt')
    wire.close()
  })

  it('records a declined command item without retaining its payload', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'commandExecution',
            status: 'declined',
            command: 'cat /private/secret.txt',
          },
        },
      },
      turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'SECRET_TOKEN in /private/secret.txt',
        codexErrorInfo: 'other',
      }),
    )
    await expect(result).rejects.toThrow('status failed')
    expect(wire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: never; request: command execution; decision: declined): Codex declined the command under the selected permission mode',
    )
    expect(wire.collectDiagnostic()).not.toContain('SECRET_TOKEN')
    expect(wire.collectDiagnostic()).not.toContain('/private/secret.txt')
    wire.close()
  })

  it('recognizes large, split, and ordered stderr signatures without retaining raw text', () => {
    const first = fakeChild()
    const largeWire = new CodexAppServerWire(
      first.handle.stdout!,
      first.handle.stdin!,
      'never',
    )
    largeWire.observeStderr(
      `SECRET_TOKEN approval policy is Never; reject command${'x'.repeat(2_048)}`,
    )
    expect(largeWire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: never; request: command execution; decision: denied): Codex rejected an escalation because the selected policy never asks for approval',
    )
    expect(largeWire.collectDiagnostic()).not.toContain('SECRET_TOKEN')

    const second = fakeChild()
    const splitWire = new CodexAppServerWire(
      second.handle.stdout!,
      second.handle.stdin!,
      'never',
    )
    splitWire.observeStderr('SECRET_TOKEN approval policy is Ne')
    splitWire.observeStderr('ver; reject command — /private/secret.txt')
    expect(splitWire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: never; request: command execution; decision: denied): Codex rejected an escalation because the selected policy never asks for approval',
    )
    expect(splitWire.collectDiagnostic()).not.toContain('SECRET_TOKEN')
    expect(splitWire.collectDiagnostic()).not.toContain('/private/secret.txt')

    const third = fakeChild()
    const orderedWire = new CodexAppServerWire(
      third.handle.stdout!,
      third.handle.stdin!,
      'dangerously-bypass-approvals-and-sandbox',
    )
    orderedWire.observeStderr(
      'approval policy is Never; reject command; recorded sandbox violation: path=/private/secret.txt',
    )
    expect(orderedWire.collectDiagnostic()).toBe(
      'Codex unattended decision (mode: dangerously-bypass-approvals-and-sandbox; request: sandbox execution; decision: failed): Codex reported a sandbox violation',
    )
    expect(orderedWire.collectDiagnostic()).not.toContain('/private/secret.txt')
  })

  it('does not reapply an old stderr signature after a newer request diagnostic', async () => {
    const { child, wire } = await initializeWire()
    wire.observeStderr('approval policy is Never; reject command')
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send({
      id: 'file-approval',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['decline'],
      },
    })
    await child.peer.nextResponse('file-approval')
    expect(wire.collectDiagnostic()).toContain('request: file approval')
    wire.observeStderr('later benign stderr')
    expect(wire.collectDiagnostic()).toContain('request: file approval')
    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
  })

  it('fails the run on unknown requests or wrong request association', async () => {
    for (const serverRequest of [
      {
        id: 'unknown',
        method: 'future/request',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      },
      {
        id: 'approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['accept'],
        },
      },
      {
        id: 'malformed-approval',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: 'decline',
        },
      },
      {
        id: 'thread',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-2', turnId: 'turn-1' },
      },
      {
        id: 'turn',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-2' },
      },
    ]) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      await nextTask()
      child.peer.send(serverRequest)
      const response = await child.peer.nextResponse(serverRequest.id)
      expect(response.error).toMatchObject({ code: -32603 })
      await expect(result).rejects.toThrow()
      wire.close()
    }
  })

  it('rejects conflicting early turn identities before accepting output', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-early' } },
    })
    child.peer.respond(turnStart, { turn: { id: 'turn-response' } })
    await expect(result).rejects.toThrow('did not match the active turn')
    wire.close()
  })

  it('rejects conflicting early notifications and requests before turn/start', async () => {
    {
      const { child, wire } = await initializeWire()
      child.peer.send({
        id: 'too-early',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      })
      const response = await child.peer.nextResponse('too-early')
      expect(response.error).toMatchObject({ code: -32603 })
      wire.close()
    }
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      await child.peer.nextMethod('turn/start')
      child.peer.send(
        {
          method: 'turn/started',
          params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        },
        agentMessage('wrong', 'final_answer', 'turn-2'),
      )
      await expect(result).rejects.toThrow('conflicting turns')
      wire.close()
    }
  })

  it('interrupts only an active open turn and contains remote interrupt failure', async () => {
    const { child, wire } = await initializeWire()
    wire.interrupt()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    wire.interrupt()
    const interrupt = await child.peer.nextMethod('turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
    child.peer.send({
      id: interrupt.id,
      error: { code: -32000, message: 'already done' },
    })
    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
    wire.interrupt()
  })

  it('ignores unrelated and out-of-window notifications', async () => {
    const { child, wire } = await initializeWire()
    child.peer.send(
      {
        method: 'turn/started',
        params: { threadId: 'thread-2', turn: { id: 'turn-other' } },
      },
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-before' } },
      },
      agentMessage('before', 'final_answer'),
      { method: 'future/notification', params: {} },
      turnCompleted('completed'),
      turnCompleted('completed', 'turn-other', 'thread-2'),
    )
    await nextTask()

    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      agentMessage('wrong turn', 'final_answer', 'turn-2'),
      turnCompleted('completed', 'turn-2'),
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('rejects pending work on abort, EOF, and stream error', async () => {
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const controller = new AbortController()
      controller.abort('pre-aborted')
      await expect(wire.initialize(controller.signal))
        .rejects.toThrow('app-server request aborted: pre-aborted')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const controller = new AbortController()
      const pending = wire.initialize(controller.signal)
      await child.peer.nextMethod('initialize')
      controller.abort(new Error('cancel initialize'))
      await expect(pending).rejects.toThrow('cancel initialize')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.fromChild.end()
      await expect(pending).rejects.toThrow(/(?:protocol stream|JSON-RPC input) closed/)
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.fromChild.emit('error', new Error('stdout broke'))
      await expect(pending).rejects.toThrow('stdout broke')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.toChild.emit('error', new Error('stdin broke'))
      await expect(pending).rejects.toThrow('stdin broke')
      wire.close()
      child.toChild.emit('error', new Error('late stdin close'))
    }
  })
})

describe('run lifecycle and quiescence', () => {
  it('spawns the fixed app-server, publishes after thread creation, and disposes once', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child.handle)
    const starting = startCodexRun(
      request([{ type: 'text', text: 'task' }]),
      runSpec(child, { env: { OPENAI_API_KEY: 'fake' }, spawn }),
    )
    let published = false
    void starting.then(() => { published = true })
    const initialize = await child.peer.nextMethod('initialize')
    expect(published).toBe(false)
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(published).toBe(false)
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    expect(spawn).toHaveBeenCalledWith({
      argv: codexAppServerArgv(),
      cwd: process.cwd(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: DEFAULT_DISPOSE_GRACE_MS,
      env: { OPENAI_API_KEY: 'fake' },
    })
    expect(run.localAgent).toBeUndefined()

    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    const disposal = run.dispose()
    expect(run.dispose()).toBe(disposal)
    await disposal
    await nextTask()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
  })

  it('settles local cancellation immediately and sends best-effort interrupt', async () => {
    const controller = new AbortController()
    const { child, run, turnStart } = await publishRun(
      fakeChild(),
      controller.signal,
    )
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    controller.abort(new Error('stop'))
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    expect(await child.peer.nextMethod('turn/interrupt')).toMatchObject({
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    })
    await run.dispose()
  })

  it('flattens child exit and protocol failures after publication', async () => {
    const errors: string[] = []
    {
      const child = fakeChild({ exitOnTerminate: false })
      const { run } = await publishRun(child, undefined, {
        onError: (error) => { errors.push(error.message) },
      })
      child.settle({ exitCode: 9, signal: null })
      await expect(run.result).resolves.toEqual({ output: [], stopReason: 'error' })
      expect(errors.at(-1)).toContain('code 9')
      await run.dispose().catch(() => {})
    }
    {
      const child = fakeChild()
      const { run, turnStart } = await publishRun(child, undefined, {
        onError: () => { throw new Error('diagnostic sink') },
      })
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.fromChild.end()
      await expect(run.result).resolves.toEqual({ output: [], stopReason: 'error' })
      await run.dispose()
    }
    {
      const child = fakeChild()
      const { run, turnStart } = await publishRun(child, undefined, {
        onError: (error) => { errors.push(error.message) },
      })
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.stderr.emit('error', new Error('stderr broke'))
      await expect(run.result).resolves.toEqual({ output: [], stopReason: 'error' })
      expect(errors.at(-1)).toContain('stderr broke')
      await run.dispose()
      expect(child.stderr.listenerCount('error')).toBe(0)
    }
  })

  it('attaches a safe permission diagnostic when a published run fails', async () => {
    const { child, run, turnStart } = await publishRun()
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send({
      id: 'approval-diagnostic',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['cancel'],
        command: 'cat /private/secret.txt',
      },
    })
    expect(await child.peer.nextResponse('approval-diagnostic')).toMatchObject({
      result: { decision: 'cancel' },
    })
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'SECRET_TOKEN in /private/secret.txt',
      codexErrorInfo: 'other',
    }))
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: 'Codex unattended decision (mode: never; request: command approval; decision: cancelled): the provider does not grant interactive approval',
      stopReason: 'error',
    })
    await run.dispose()
  })

  it('forwards stderr while extracting only a fixed safe permission signature', async () => {
    const child = fakeChild()
    const forwarded: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      forwarded.push(String(chunk))
      return true
    })
    const { run, turnStart } = await publishRun(child)
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.stderr.write('SECRET_TOKEN approval policy is Ne')
    child.stderr.write('ver; reject command — /private/secret.txt')
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'fixture terminal failure',
      codexErrorInfo: 'badRequest',
    }))
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: 'Codex unattended decision (mode: never; request: command execution; decision: denied): Codex rejected an escalation because the selected policy never asks for approval',
      stopReason: 'error',
    })
    expect(forwarded.join('')).toContain('SECRET_TOKEN')
    await run.dispose()
    expect(child.stderr.listenerCount('data')).toBe(0)
    write.mockRestore()
  })

  it('rejects before spawn when pre-aborted and rolls back startup failures', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()
    await expect(startCodexRun(
      request(undefined, controller.signal),
      {
        cwd: process.cwd(),
        permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
        env: {},
        disposeGraceMs: 10,
        spawn,
      },
    )).rejects.toThrow('aborted before app-server startup')
    expect(spawn).not.toHaveBeenCalled()

    const child = fakeChild()
    const starting = startCodexRun(request(), runSpec(child))
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, null)
    await expect(starting).rejects.toThrow('invalid initialize response')
    expect(child.terminate).toHaveBeenCalledTimes(1)

    const stderrChild = fakeChild()
    const stderrStarting = startCodexRun(request(), runSpec(stderrChild))
    await stderrChild.peer.nextMethod('initialize')
    stderrChild.stderr.emit('error', new Error('startup stderr broke'))
    await expect(stderrStarting).rejects.toThrow('startup stderr broke')
    expect(stderrChild.terminate).toHaveBeenCalledTimes(1)
    expect(stderrChild.stderr.listenerCount('error')).toBe(0)
  })

  it('rolls back an abort that wins immediately after thread creation', async () => {
    const controller = new AbortController()
    const child = fakeChild()
    const starting = startCodexRun(
      request(undefined, controller.signal),
      runSpec(child),
    )
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: process.cwd(),
      ephemeral: true,
      approvalPolicy: 'never',
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    controller.abort('startup race')
    await expect(starting).rejects.toThrow('aborted before run publication')
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('rolls back a subprocess done rejection during startup', async () => {
    const child = fakeChild({ doneError: new Error('spawn observer failed') })
    const error: unknown = await startCodexRun(request(), runSpec(child)).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) {
      throw new Error('expected startup and rollback failures')
    }
    expect(error.errors).toEqual([
      expect.objectContaining({ message: 'spawn observer failed' }),
      expect.objectContaining({ message: 'spawn observer failed' }),
    ])
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('keeps overlapping runs isolated', async () => {
    const first = fakeChild()
    const second = fakeChild()
    const runs = await Promise.all([
      publishRun(first),
      publishRun(second),
    ])
    for (const [index, entry] of runs.entries()) {
      const id = `turn-${index + 1}`
      entry.child.peer.send(
        { id: entry.turnStart.id, result: { turn: { id } } },
        agentMessage(`answer-${index + 1}`, 'final_answer', id),
        turnCompleted('completed', id),
      )
    }
    const results = await Promise.all(runs.map(entry => entry.run.result))
    expect(results.map(result => result.output)).toEqual([
      [{ type: 'text', text: 'answer-1' }],
      [{ type: 'text', text: 'answer-2' }],
    ])
    expect(runs[0].run.id).not.toBe(runs[1].run.id)
    await Promise.all(runs.map(entry => entry.run.dispose()))
  })

  it('isolates permission modes and diagnostics across overlapping runs', async () => {
    const first = await publishRun(fakeChild(), undefined, {
      permissionMode: 'never',
    })
    const second = await publishRun(fakeChild(), undefined, {
      permissionMode: 'dangerously-bypass-approvals-and-sandbox',
    })
    first.child.peer.respond(first.turnStart, { turn: { id: 'turn-never' } })
    second.child.peer.respond(second.turnStart, { turn: { id: 'turn-bypass' } })
    await nextTask()
    first.child.peer.send({
      id: 'never-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-never',
        availableDecisions: ['cancel'],
      },
    })
    second.child.peer.send({
      id: 'bypass-elicitation',
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread-1', turnId: null },
    })
    await Promise.all([
      first.child.peer.nextResponse('never-approval'),
      second.child.peer.nextResponse('bypass-elicitation'),
    ])
    first.child.peer.send(turnCompleted('failed', 'turn-never', 'thread-1', {
      message: 'first failure',
      codexErrorInfo: 'other',
    }))
    second.child.peer.send(turnCompleted('failed', 'turn-bypass', 'thread-1', {
      message: 'second failure',
      codexErrorInfo: 'other',
    }))
    await expect(first.run.result).resolves.toEqual({
      output: [],
      diagnostic: 'Codex unattended decision (mode: never; request: command approval; decision: cancelled): the provider does not grant interactive approval',
      stopReason: 'error',
    })
    await expect(second.run.result).resolves.toEqual({
      output: [],
      diagnostic: 'Codex unattended decision (mode: dangerously-bypass-approvals-and-sandbox; request: MCP elicitation; decision: declined): the provider does not collect interactive MCP input',
      stopReason: 'error',
    })
    await Promise.all([first.run.dispose(), second.run.dispose()])
  })

  it('uses the registered provider config and logs flattened errors', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const child = fakeChild()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => {
      warnings.push(String(message))
    }) as typeof ctx.logger.warn
    await ctx.plugin(codex, {
      env: { OPENAI_API_KEY: 'fake' },
      permissionMode: 'approve-for-me',
      disposeGraceMs: 25,
    })
    const starting = ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: fakeParent,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: process.cwd(),
      ephemeral: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send({
      id: 'provider-approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['cancel'],
        command: 'cat /private/secret.txt',
      },
    })
    await child.peer.nextResponse('provider-approval')
    child.peer.send(turnCompleted('failed', 'turn-1', 'thread-1', {
      message: 'SECRET_TOKEN in /private/secret.txt',
      codexErrorInfo: 'other',
    }))
    await expect(run.result).resolves.toEqual({
      output: [],
      diagnostic: 'Codex unattended decision (mode: approve-for-me; request: command approval; decision: cancelled): the provider does not grant interactive approval',
      stopReason: 'error',
    })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      argv: ['codex', 'app-server', '--stdio'],
      env: { OPENAI_API_KEY: 'fake' },
      graceMs: 25,
      cwd: process.cwd(),
    }))
    expect(warnings).toEqual([
      expect.stringContaining('subagent-codex: child run failed (error): subagent-codex: Codex turn ended with status failed: error'),
    ])
    expect(warnings.join('\n')).not.toContain('SECRET_TOKEN')
    expect(warnings.join('\n')).not.toContain('/private/secret.txt')
    await run.dispose()
    await ctx.fiber.dispose()
  })
})

describe('disposeCodexChild', () => {
  it('closes stdin, terminates, and waits for the managed tree', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    const end = vi.spyOn(child.toChild, 'end')
    await disposeCodexChild(wire, child.handle)
    expect(end).toHaveBeenCalled()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledWith()
  })

  it('does not finish disposal before the managed tree exits', async () => {
    const child = fakeChild({ exitOnTerminate: false })
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    let disposed = false
    const disposal = disposeCodexChild(wire, child.handle).then(() => {
      disposed = true
    })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(disposed).toBe(false)
    child.settle()
    await disposal
    expect(disposed).toBe(true)
  })

  it('contains a concurrently closed stdin error', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    vi.spyOn(child.toChild, 'end').mockImplementation(() => {
      throw new Error('already closed')
    })
    await expect(disposeCodexChild(wire, child.handle))
      .resolves.toBeUndefined()
  })

  it('handles a spawn-level failure with no process tree', async () => {
    const child = fakeChild({
      pid: -1,
      doneError: new Error('spawn failed'),
    })
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    await expect(disposeCodexChild(wire, child.handle))
      .resolves.toBeUndefined()
    expect(child.terminate).not.toHaveBeenCalled()
    expect(child.waitForExit).not.toHaveBeenCalled()
  })

  it('reports direct-child observer failure and accepts absent stdin', async () => {
    {
      const child = fakeChild({
        doneError: new Error('close observer failed'),
      })
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      await expect(disposeCodexChild(wire, child.handle))
        .rejects.toThrow('close observer failed')
    }
    {
      const child = fakeChild()
      const handle = { ...child.handle, stdin: undefined }
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      await expect(disposeCodexChild(wire, handle)).resolves.toBeUndefined()
    }
  })
})
