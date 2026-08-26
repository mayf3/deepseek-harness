import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine, classifyFailure, evaluateAdmission, renderAdmission, DeterministicCompactionError } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { CallId, CONTEXT_WINDOW_EXCEEDED_CODE, createToolResultMessage, createUserMessage, createMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, LlmFailure, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SurfaceEvent } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'

const SIGNAL = new AbortController().signal
const MODEL = 'admission-model'

/** One scripted summarization outcome per call, under test control. */
class ScriptedCompactionEngine extends BasicCompactionEngine {
  /** Outcomes per summarization call; later calls reuse the last entry. */
  readonly outcomes: Array<{ summary?: string; error?: unknown }> = []
  calls = 0
  /** Metered surface tokens observed at each summarization call. */
  readonly surfaceAtCall: number[] = []

  constructor(
    ctx: Context,
    config: BasicCompactionConfig,
    private readonly meter: TokenMeter,
    private readonly session: Session,
  ) {
    super(ctx, config)
  }

  override async summarize(): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    this.calls += 1
    this.surfaceAtCall.push(this.meter.measure(this.session).surfaceTokens)
    const outcome = this.outcomes[Math.min(this.calls - 1, this.outcomes.length - 1)]
    if (outcome?.error !== undefined) throw outcome.error
    const text = outcome?.summary ?? 'checkpoint'
    return { summary: [{ type: 'text', text }], provider: 'scripted', model: 'scripted' }
  }
}

/** Registers one route whose adapter discloses an exact context window. */
class CapacityAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function fixtureContext(contextWindow: number): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new CapacityAdapter(contextWindow))
  return ctx
}

interface Fixture {
  readonly ctx: Context
  readonly compact: ScriptedCompactionEngine
  readonly session: Session
  readonly warnings: string[]
}

/** Closed turns of priced history; `openTurn` mirrors live pressure by default. */
async function fixture(options: {
  contextWindow: number
  turns: number
  charsPerMessage?: number
  openTurn?: boolean
  engine?: BasicCompactionConfig
  system?: string
}): Promise<Fixture> {
  const ctx = fixtureContext(options.contextWindow)
  // Raw fixture sessions are not store-live; manual probes only need the flush seam.
  ;(ctx as { sessions?: unknown }).sessions = { flush: async () => {} }
  const warnings: string[] = []
  ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
  const chars = options.charsPerMessage ?? 800
  const session = Session.create(SessionId(`admission-${options.contextWindow}-${options.turns}`))
  const text = `${'history '.repeat(Math.ceil(chars / 8))} `
  for (let turn = 1; turn <= options.turns; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1) {
      session.append('request/header', {
        header: {
          config: { provider: MODEL, model: MODEL },
          ...options.system === undefined ? {} : { system: options.system },
        },
        reason: 'initial',
      })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text}user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text}assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  if (options.openTurn !== false) session.append('turn/start', { turn: options.turns + 1 })
  const compact = new ScriptedCompactionEngine(
    ctx,
    { auto: false, maxTokens: 64, ...options.engine },
    ctx.tokenMeter,
    session,
  )
  return { ctx, compact, session, warnings }
}

function owner(session: Session): Agent {
  return {
    session,
    options: { provider: MODEL, model: MODEL },
  } as Agent
}

function idleOwner(session: Session): Agent {
  const agent = owner(session) as Agent & {
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => Promise<T>
  }
  agent.runMaintenance = task => task(SIGNAL)
  return agent
}

async function pressure(f: Fixture): Promise<CompactionResult | null> {
  return f.compact.compactIfNeeded(owner(f.session), 'pressure', SIGNAL)
}

/** Drive one provider-confirmed overflow through the automatic request-error handler. */
async function overflowRecovery(f: Fixture, ownerAgent: Agent, message = 'route overflow'): Promise<boolean> {
  const failure: LlmFailure = { message, code: CONTEXT_WINDOW_EXCEEDED_CODE }
  const turn = f.session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 1
  const action: RequestErrorAction | undefined = await agentEvents(f.ctx, ownerAgent).waterfall(
    'agent/request-error',
    { turn, step: 1, provider: MODEL, failure, retryPolicy: undefined, signal: SIGNAL },
    () => Promise.resolve(undefined),
  )
  return action?.kind === 'retry'
}

/** Close the fixture's open turn so an idle manual probe is legal. */
function closeOpenTurn(session: Session): void {
  const lastTurnStart = session.events.findLast(event => event.type === 'turn/start')
  if (lastTurnStart?.type !== 'turn/start') throw new Error('expected an open turn to close')
  session.append('turn/end', { turn: lastTurnStart.data.turn, reason: { kind: 'completed' } })
}

/** Append one more priced assistant/user exchange inside the open turn. */
function appendOrdinaryExchange(session: Session, turn: number, label: string, chars: number): void {
  const text = `${'context '.repeat(Math.ceil(chars / 8))} `
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `${text}${label}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `${text}${label} answer` }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
}

/** The replacement surface event a summary event must be paired with. */
function replacementAfter(events: readonly SessionEvent[], summary: SessionEvent<'compaction/summary'>): SurfaceEvent {
  const next = events[summary.seq + 1]
  if (next?.type !== 'user/message' || typeof (next as SurfaceEvent).surfaceOp !== 'object') {
    throw new Error('compaction/summary is not immediately followed by a replacement')
  }
  return next as SurfaceEvent
}

/** A summarizer failure the provider itself classified as context overflow. */
function summarizerOverflow(): Error {
  return Object.assign(
    new Error('pi-ai detected context overflow for model "gpt-5.6-sol"'),
    { code: CONTEXT_WINDOW_EXCEEDED_CODE },
  )
}

describe('combined-context admission', () => {
  it('prices system, tools, region, instruction, the inherited 8192 reserve, and the margin in one formula', () => {
    const components = {
      pricedSystem: 500,
      pricedTools: 42,
      pricedSelectedMessages: 90_000,
      pricedInstruction: 459,
      effectiveOutputReserve: 8192,
      tokenizerSafetyMargin: 256,
      effectiveContextBudget: 99_449,
    }
    const exact = evaluateAdmission(components)
    expect(exact.admitted).toBe(true)
    expect(exact.requestTokens).toBe(99_449)
    expect(exact.selectedMessagesBudget).toBe(90_000)

    expect(evaluateAdmission({ ...components, effectiveContextBudget: 99_448 }).admitted).toBe(false)
    const rendered = renderAdmission({ ...components, effectiveContextBudget: 99_448 })
    expect(rendered).toContain('(system)')
    expect(rendered).toContain('(tools)')
    expect(rendered).toContain('(selected messages)')
    expect(rendered).toContain('(instruction)')
    expect(rendered).toContain('(output reserve)')
    expect(rendered).toContain('(safety margin)')
  })

  it('admits a real compaction with the inherited 8192 reserve, system, and margin against a large window', async () => {
    const f = await fixture({
      contextWindow: 100_000,
      turns: 3,
      charsPerMessage: 900,
      system: 'S'.repeat(2_000),
      engine: {
        thresholdRatio: 0.01,
        retainTokens: 50,
        tokenizerSafetyMargin: 256,
        // Explicit 8192 prices identically to the inherited config default,
        // which resolveConfig already covers.
        maxTokens: 8192,
      },
    })
    const result = await pressure(f)
    expect(result).not.toBeNull()
    expect(f.compact.calls).toBe(1)
  })

  it('fails loud as deterministic admission-impossible when fixed parts alone exceed the budget', async () => {
    const f = await fixture({
      contextWindow: 500,
      turns: 3,
      engine: { thresholdRatio: 0.05, retainTokens: 0 },
    })
    await expect(pressure(f)).rejects.toThrow(/admission 0 \(system\)/)
    expect(f.compact.calls).toBe(0)
  })
})

describe('bounded balanced multi-pass', () => {
  it('selects a smaller balanced region when the largest old region exceeds the budget', async () => {
    const f = await fixture({
      contextWindow: 1_500,
      turns: 8,
      charsPerMessage: 800,
      engine: { thresholdRatio: 0.6, retainTokens: 50, compactionRetries: 3 },
    })
    const result = await pressure(f)
    expect(result).not.toBeNull()
    expect(f.compact.calls).toBeGreaterThanOrEqual(2)
    const first = f.session.events.find(event => event.type === 'compaction/summary')
    if (first?.type !== 'compaction/summary') throw new Error('expected a compaction/summary')
    const priced = f.ctx.tokenMeter.measure(f.session).nodes
    const shadowed = first.data.shadowedSeqs
      .map(seq => priced.find(node => node.seq === seq)?.tokens ?? 0)
      .reduce((total, tokens) => total + tokens, 0)
    expect(shadowed).toBeLessThanOrEqual(1_500 - 459 - 64)
  })

  it('never splits an assistant tool-call/result pair across any pass boundary', async () => {
    const ctx = fixtureContext(1_500)
    const session = Session.create(SessionId('admission-tool-pairs'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
    for (let turn = 1; turn <= 4; turn += 1) {
      const callId = CallId(`call-${turn}`)
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `question ${turn} ${'padding '.repeat(160)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn, step: 1 })
      session.append('assistant/message', {
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'tool-call', id: callId, name: 'work', arguments: '{}' }],
          source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/result', {
        turn,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: `answer ${turn} ${'data '.repeat(160)}` }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    session.append('turn/start', { turn: 5 })
    const compact = new ScriptedCompactionEngine(
      ctx,
      { auto: false, maxTokens: 64, thresholdRatio: 0.4, retainTokens: 60, compactionRetries: 3 },
      ctx.tokenMeter,
      session,
    )
    const result = await compact.compactIfNeeded(owner(session), 'pressure', SIGNAL)
    expect(result).not.toBeNull()

    // Every boundary compaction created — the landed checkpoints — must be a
    // balanced cut on both sides.
    const checkpoints = session.events.filter(
      (event): event is SurfaceEvent =>
        event.type === 'user/message' && typeof (event as SurfaceEvent).surfaceOp === 'object',
    )
    expect(checkpoints.length).toBeGreaterThan(0)
    for (const checkpoint of checkpoints) {
      if (session.surface.nodes.indexOf(checkpoint.seq) === -1) continue
      expect(toolPairingBalancedBefore(session, checkpoint.seq),
        `checkpoint ${checkpoint.seq} must be a balanced start`).toBe(true)
      expect(toolPairingBalancedAfter(session, checkpoint.seq),
        `checkpoint ${checkpoint.seq} must be a balanced end`).toBe(true)
    }
    const calls = new Set<string>()
    for (const message of session.deriveMessages()) {
      for (const block of message.content) {
        if (block.type === 'tool-call') calls.add(block.id)
        if (block.type === 'tool-result') expect(calls.has(block.toolCallId)).toBe(true)
      }
    }
  })

  it('summarizes exactly the span it replaces on every pass', async () => {
    const f = await fixture({
      contextWindow: 1_500,
      turns: 8,
      charsPerMessage: 800,
      engine: { thresholdRatio: 0.6, retainTokens: 50, compactionRetries: 3 },
    })
    await pressure(f)
    const summaries = f.session.events.filter(
      (event): event is SessionEvent<'compaction/summary'> => event.type === 'compaction/summary',
    )
    expect(summaries.length).toBeGreaterThanOrEqual(2)
    for (const summary of summaries) {
      const replacement = replacementAfter(f.session.events, summary)
      expect(replacement.surfaceOp).toMatchObject({
        op: 'replace',
        start: summary.data.shadowedRange.start,
        end: summary.data.shadowedRange.end,
      })
      expect(summary.data.shadowedTokenCount).toBeGreaterThan(0)
      expect(replacement.sourceEventSeqs).toContain(summary.seq)
    }
  })

  it('strictly converges per pass and lands one checkpoint per pass', async () => {
    const f = await fixture({
      contextWindow: 1_500,
      turns: 8,
      charsPerMessage: 800,
      engine: { thresholdRatio: 0.6, retainTokens: 50, compactionRetries: 3 },
    })
    const result = await pressure(f)
    expect(result).not.toBeNull()
    const surfaces = f.compact.surfaceAtCall
    expect(surfaces.length).toBeGreaterThanOrEqual(2)
    for (let index = 1; index < surfaces.length; index += 1) {
      expect(surfaces[index]!, `pass ${index + 1} must strictly reduce surface tokens`)
        .toBeLessThan(surfaces[index - 1]!)
    }
    expect(f.ctx.tokenMeter.measure(f.session).totalTokens).toBeLessThan(900)
  })

  it('fails loud at the pass bound instead of looping', async () => {
    const f = await fixture({
      contextWindow: 1_200,
      turns: 6,
      charsPerMessage: 800,
      engine: { thresholdRatio: 0.5, retainTokens: 0, compactionRetries: 0 },
    })
    await expect(pressure(f)).rejects.toThrow(/still above threshold after 1 admitted passes/)
    expect(f.compact.calls).toBe(1)
  })
})

describe('deterministic failure latch', () => {
  it('makes at most two provider calls for one unchanged deterministic key, then holds across appends', async () => {
    const f = await fixture({
      contextWindow: 4_000,
      turns: 4,
      engine: { thresholdRatio: 0.05, retainTokens: 50 },
    })
    f.compact.outcomes.push({ error: summarizerOverflow() })

    await expect(pressure(f)).rejects.toThrow(/context overflow/)
    expect(f.compact.calls).toBe(1)
    await expect(pressure(f)).rejects.toThrow(/context overflow/)
    expect(f.compact.calls).toBe(2)

    // CALLS_WHILE_LATCHED = 0: at least 20 consecutive ordinary appends keep
    // reporting the held cause without any further summarization call.
    const before = f.session.surface.replaceGeneration
    for (let step = 0; step < 22; step += 1) {
      appendOrdinaryExchange(f.session, 5, `ordinary step ${step}`, 60)
      await expect(pressure(f)).resolves.toBeNull()
    }
    expect(f.compact.calls).toBe(2)
    expect(f.session.surface.replaceGeneration).toBe(before)
    expect(f.warnings.filter(warning => warning.includes('held (provider-context-window-exceeded)')).length)
      .toBeGreaterThanOrEqual(20)
  })

  it('treats a summary that is not smaller as deterministic and latches it', async () => {
    const f = await fixture({
      contextWindow: 4_000,
      turns: 2,
      charsPerMessage: 100,
      engine: { thresholdRatio: 0.02, retainTokens: 50 },
    })
    f.compact.outcomes.push({ summary: 'x'.repeat(400) })

    await expect(pressure(f)).rejects.toThrow(/summary is not smaller/)
    await expect(pressure(f)).rejects.toThrow(/summary is not smaller/)
    expect(f.compact.calls).toBe(2)
    await expect(pressure(f)).resolves.toBeNull()
    expect(f.compact.calls).toBe(2)
  })

  it('voids the latch when a durable replacement advances replaceGeneration', async () => {
    const f = await fixture({
      contextWindow: 6_000,
      turns: 4,
      charsPerMessage: 150,
      openTurn: false,
      engine: { thresholdRatio: 0.05, retainTokens: 50 },
    })
    f.compact.outcomes.push(
      { error: summarizerOverflow() },
      { error: summarizerOverflow() },
      { summary: 'recovered checkpoint' },
    )

    f.session.append('turn/start', { turn: 5 })
    await expect(pressure(f)).rejects.toThrow(/context overflow/)
    await expect(pressure(f)).rejects.toThrow(/context overflow/)
    expect(f.compact.calls).toBe(2)
    closeOpenTurn(f.session)

    const manual = await f.compact.compactNow(idleOwner(f.session), SIGNAL)
    expect(manual).not.toBeNull()
    expect(f.session.surface.replaceGeneration).toBe(1)

    // The advanced generation changes the latch basis: automatic compaction
    // runs again over fresh history and succeeds.
    f.session.append('turn/start', { turn: 6 })
    appendOrdinaryExchange(f.session, 6, 'post recovery', 400)
    const result = await pressure(f)
    expect(result).not.toBeNull()
    expect(f.compact.calls).toBe(4)
  })

  it('grants manual compaction exactly one probe and immediately re-latches the same deterministic failure', async () => {
    const f = await fixture({
      contextWindow: 4_000,
      turns: 4,
      openTurn: false,
      engine: { thresholdRatio: 0.02, retainTokens: 50 },
    })
    f.compact.outcomes.push({ error: summarizerOverflow() })

    f.session.append('turn/start', { turn: 5 })
    await expect(pressure(f)).rejects.toThrow(/context overflow/)
    await expect(pressure(f)).rejects.toThrow(/context overflow/)
    expect(f.compact.calls).toBe(2)
    closeOpenTurn(f.session)

    await expect(f.compact.compactNow(idleOwner(f.session), SIGNAL))
      .rejects.toMatchObject({ name: 'ManualCompactionError', code: 'summary' })
    expect(f.compact.calls).toBe(3)

    // The reproduced classification re-latched: the next automatic attempt
    // makes no summarization call.
    f.session.append('turn/start', { turn: 6 })
    await expect(pressure(f)).resolves.toBeNull()
    expect(f.compact.calls).toBe(3)
  })

  it.each([
    ['SERVER', 'server overload'],
    ['TRANSPORT', 'network link dropped'],
    ['TIMEOUT', 'stream timed out'],
    [undefined, 'terminated'],
  ] as const)('never permanently latches a %s summarizer failure', async (code, message) => {
    const f = await fixture({
      contextWindow: 4_000,
      turns: 4,
      engine: { thresholdRatio: 0.05, retainTokens: 50 },
    })
    const error: Error & { code?: string } = new Error(message)
    if (code !== undefined) error.code = code
    f.compact.outcomes.push({ error })

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(pressure(f)).rejects.toThrow(new RegExp(message.split(' ')[0]!, 'i'))
    }
    expect(f.compact.calls).toBe(4)
    expect(f.warnings.some(warning => warning.includes('held'))).toBe(false)
  })
})

describe('overflow recovery keeps its proven retry and latch coordination', () => {
  it('preserves the original provider error, latches the deterministic summarizer failure, and stops calling', async () => {
    const f = await fixture({
      contextWindow: 4_000,
      turns: 4,
      engine: { thresholdRatio: 1, retainTokens: 50, maxOverflowRetries: 1, auto: true },
    })
    f.compact.outcomes.push({ error: summarizerOverflow() })
    const ownerAgent = owner(f.session)

    expect(await overflowRecovery(f, ownerAgent)).toBe(false)
    expect(f.compact.calls).toBe(1)
    expect(f.warnings.some(warning => warning.includes('preserving the original request error'))).toBe(true)

    expect(await overflowRecovery(f, ownerAgent)).toBe(false)
    expect(f.compact.calls).toBe(2)

    // The latch now holds the exact deterministic key: a third overflow error
    // performs no summarization call while still preserving the provider error.
    expect(await overflowRecovery(f, ownerAgent)).toBe(false)
    expect(f.compact.calls).toBe(2)
    expect(f.warnings.some(warning => warning.includes('held (provider-context-window-exceeded)'))).toBe(true)
    expect(f.session.surface.replaceGeneration).toBe(0)
  })
})

describe('failure classification', () => {
  it('maps provider facts onto the frozen deterministic and transient taxonomy', async () => {
    const f = await fixture({ contextWindow: 4_000, turns: 1 })
    void f
    expect(classifyFailure(new DeterministicCompactionError('no-progress', 'x')))
      .toEqual({ kind: 'deterministic', failureClass: 'no-progress' })
    expect(classifyFailure(Object.assign(new Error('overflow'), { code: CONTEXT_WINDOW_EXCEEDED_CODE })))
      .toEqual({ kind: 'deterministic', failureClass: 'provider-context-window-exceeded' })
    expect(classifyFailure(new Error('prompt is too long for this model context window')))
      .toEqual({ kind: 'deterministic', failureClass: 'provider-context-window-exceeded' })
    expect(classifyFailure(Object.assign(new Error('request body too large'), { code: 'INVALID_REQUEST' })))
      .toEqual({ kind: 'deterministic', failureClass: 'request-size-invalid-request' })
    expect(classifyFailure(Object.assign(new Error('unsupported parameter'), { code: 'INVALID_REQUEST' })))
      .toEqual({ kind: 'transient' })
    expect(classifyFailure(Object.assign(new Error('server overload'), { code: 'SERVER' })))
      .toEqual({ kind: 'transient' })
    expect(classifyFailure(new TypeError('fetch failed')))
      .toEqual({ kind: 'transient' })
  })
})

describe('admission-bounded automatic paths', () => {
  it('fails loud as no-balanced-eligible-span when no balanced prefix fits the slack', async () => {
    const f = await fixture({
      contextWindow: 600,
      turns: 3,
      engine: { thresholdRatio: 0.05, retainTokens: 0 },
    })
    await expect(pressure(f)).rejects.toThrow(/no balanced span fits the 77-token selected-messages budget/)
    // The class is deterministic: the second attempt confirms, then the latch holds.
    await expect(pressure(f)).rejects.toThrow(/no balanced span fits/)
    await expect(pressure(f)).resolves.toBeNull()
  })

  it('rejects forced overflow whose fixed parts alone exceed the budget', async () => {
    const f = await fixture({
      contextWindow: 500,
      turns: 3,
      engine: { thresholdRatio: 1, retainTokens: 0 },
    })
    await expect(f.compact.compactIfNeeded(owner(f.session), 'context-overflow', SIGNAL))
      .rejects.toThrow(/admission 0 \(system\)/)
    expect(f.compact.calls).toBe(0)
  })

  it('rejects forced overflow when no balanced span fits the selected-messages budget', async () => {
    const f = await fixture({
      contextWindow: 600,
      turns: 3,
      engine: { thresholdRatio: 1, retainTokens: 0 },
    })
    await expect(f.compact.compactIfNeeded(owner(f.session), 'context-overflow', SIGNAL))
      .rejects.toThrow(/context-overflow compaction: no balanced span fits the 77-token/)
  })

  it('rejects a span replaced while admission resolves capacity', async () => {
    const f = await fixture({
      contextWindow: 4_000,
      turns: 2,
      openTurn: false,
      engine: { thresholdRatio: 0.05, retainTokens: 0 },
    })
    const nodes = f.session.surface.nodes
    vi.spyOn(f.ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => {
      f.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'concurrent replacement' }],
        source: { kind: 'plugin', plugin: 'test' },
      }), {
        surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[0]! },
        sourceEventSeqs: [nodes[0]!],
      })
      return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 4_000 } })
    })
    await expect(f.compact.compactRegion(nodes[0]!, nodes.at(-1)!, owner(f.session), SIGNAL))
      .rejects.toThrow(/selected surface changed/)
    expect(f.compact.calls).toBe(0)
  })

  it('rejects a direct compactRegion span that cannot be admitted, without opening the bracket', async () => {
    const f = await fixture({
      contextWindow: 1_000,
      turns: 4,
      engine: { thresholdRatio: 0.05, retainTokens: 0 },
    })
    const nodes = f.session.surface.nodes
    await expect(f.compact.compactRegion(nodes[0]!, nodes.at(-1)!, owner(f.session), SIGNAL))
      .rejects.toThrow(/admission \d+ \(system\)/)
    expect(f.compact.calls).toBe(0)
    expect(f.session.events.some(event => event.type === 'compaction/start')).toBe(false)
  })
})

describe('manual compaction without a conversation route', () => {
  function headerlessFixture(turns: number): Session {
    const session = Session.create(SessionId('manual-unrouted'))
    for (let turn = 1; turn <= turns; turn += 1) {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `prompt ${turn} ${'context '.repeat(120)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('step/start', { turn, step: 1 })
      session.append('assistant/message', {
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `answer ${turn} ${'detail '.repeat(120)}` }],
          source: { kind: 'model', provider: MODEL, model: MODEL },
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    return session
  }

  function unroutedAgent(session: Session): Agent {
    const agent = { session, options: {} } as unknown as Agent & {
      runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => Promise<T>
    }
    agent.runMaintenance = task => task(SIGNAL)
    return agent
  }

  it('compacts through the unrouted fallback when no summarization target exists at all', async () => {
    const ctx = fixtureContext(4_000)
    ;(ctx as { sessions?: unknown }).sessions = { flush: async () => {} }
    const session = headerlessFixture(3)
    const compact = new ScriptedCompactionEngine(
      ctx,
      { auto: false, maxTokens: 64 },
      ctx.tokenMeter,
      session,
    )
    const result = await compact.compactNow(unroutedAgent(session), SIGNAL, CommandId('unrouted-command'))
    expect(result).not.toBeNull()
    expect(result?.sourceCommandId).toBe(CommandId('unrouted-command'))
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(true)
    expect(compact.calls).toBe(1)
  })

  it('fails loud when the manual probe cannot admit any span', async () => {
    for (const contextWindow of [500, 600] as const) {
      const ctx = fixtureContext(contextWindow)
      ;(ctx as { sessions?: unknown }).sessions = { flush: async () => {} }
      const session = headerlessFixture(3)
      const compact = new ScriptedCompactionEngine(
        ctx,
        { auto: false, maxTokens: 64, summarizationProvider: MODEL, summarizationModel: MODEL },
        ctx.tokenMeter,
        session,
      )
      await expect(compact.compactNow(unroutedAgent(session), SIGNAL))
        .rejects.toMatchObject({ name: 'ManualCompactionError', code: 'summary' })
      expect(compact.calls).toBe(0)
    }
  })

  it('compacts through the unrouted fallback without a command correlation id', async () => {
    const ctx = fixtureContext(4_000)
    ;(ctx as { sessions?: unknown }).sessions = { flush: async () => {} }
    const session = headerlessFixture(3)
    const compact = new ScriptedCompactionEngine(
      ctx,
      { auto: false, maxTokens: 64 },
      ctx.tokenMeter,
      session,
    )
    const result = await compact.compactNow(unroutedAgent(session), SIGNAL)
    expect(result).not.toBeNull()
    expect(result?.sourceCommandId).toBeUndefined()
  })

  it('admits through an explicit summarization pair and keys the latch basis on it', async () => {
    const ctx = fixtureContext(4_000)
    ;(ctx as { sessions?: unknown }).sessions = { flush: async () => {} }
    const session = headerlessFixture(3)
    const compact = new ScriptedCompactionEngine(
      ctx,
      { auto: false, maxTokens: 64, summarizationProvider: MODEL, summarizationModel: MODEL },
      ctx.tokenMeter,
      session,
    )
    const result = await compact.compactNow(unroutedAgent(session), SIGNAL, CommandId('manual-command'))
    expect(result).not.toBeNull()
    expect(result?.sourceCommandId).toBe(CommandId('manual-command'))
    expect(compact.calls).toBe(1)
  })
})
