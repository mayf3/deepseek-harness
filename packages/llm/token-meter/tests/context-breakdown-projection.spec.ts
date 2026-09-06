// contextBreakdown projection: heuristic system/tools/message composition,
// plus the shared estimator's pricing branches.

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ToolSchema } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ContextBreakdownProjection } from '@deepseek-ai/dsh-token-meter/client'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { contextBreakdownProjectionDefinition } from '../src/breakdown-projection.ts'
import {
  estimateContent,
  estimateMessage,
  estimateSystemMessage,
  estimateToolsTokens,
} from '../src/estimate.ts'

const CONFIG = { provider: 'test', model: 'test-model' }

const TOOLS: ToolSchema[] = [{
  name: 'bash',
  description: 'run a command',
  parameters: { type: 'object', properties: {} },
}]

async function harness(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return { ctx, session: ctx.sessions.create() }
}

const projected = (ctx: Context, session: Session): ContextBreakdownProjection => {
  const value = ctx.sessionProjections.snapshot(session).values.contextBreakdown
  if (value === undefined) throw new Error('contextBreakdown projection is not registered')
  return value
}

function appendUser(session: Session, text: string): SessionSeqType {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

const SYSTEM_PLUGIN = '@deepseek-ai/dsh-system-prompt'

/** Append the rendered system prompt as surface node 0, the way the loop does before the first user message. */
function appendSystem(session: Session, text: string): SessionSeqType {
  return session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage(text, SYSTEM_PLUGIN),
  }, { surfaceOp: 'append' }).seq
}

/** Replace the system node in place, the way the loop does when the rendered prompt changes. */
function replaceSystem(session: Session, node: SessionSeqType, text: string): SessionSeqType {
  return session.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage(text, SYSTEM_PLUGIN),
  }, { surfaceOp: { op: 'replace', start: node, end: node }, sourceEventSeqs: [node] }).seq
}

/**
 * Meter one upcoming replacement the way compaction-basic does: price the
 * replaced span from the measurement service's own nodes and log the
 * shadow-price event directly before the replace.
 */
function appendSummaryMeter(ctx: Context, session: Session, start: SessionSeqType, end: SessionSeqType): void {
  const nodes = ctx.tokenMeter.measure(session).nodes
  const startIdx = nodes.findIndex(node => node.seq === start)
  const endIdx = nodes.findIndex(node => node.seq === end)
  const shadowed = nodes.slice(startIdx, endIdx + 1)
  session.append('compaction/summary', {
    compactionId: CompactionId('context-breakdown-summary'),
    summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start, end },
    shadowedSeqs: shadowed.map(node => node.seq),
    shadowedTokenCount: shadowed.reduce((total, node) => total + node.tokens, 0),
    provider: 'mock',
    model: 'mock',
  })
}

describe('contextBreakdown session projection', () => {
  it('serves zeros for an empty log', async () => {
    const { ctx, session } = await harness()
    expect(projected(ctx, session)).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
  })

  it('prices the system node and the newest envelope last-wins and pushes no change for a restated envelope', async () => {
    const { ctx, session } = await harness()
    const systemNode = appendSystem(session, 'You are terse.')
    session.append('request/header', {
      header: { config: CONFIG, tools: TOOLS },
      reason: 'initial',
    })
    // 'You are terse.' prices to 8 (4 text + 4 role): the same figure the
    // request envelope's former system field priced to.
    expect(projected(ctx, session)).toEqual({
      systemTokens: 8,
      toolsTokens: estimateToolsTokens({ config: CONFIG, tools: TOOLS }),
      messageTokens: 0,
    })

    const changed: string[] = []
    ctx.sessionProjections.onChanged((_session, key) => { changed.push(key) })
    session.append('request/header', {
      header: { config: CONFIG, tools: TOOLS },
      reason: 'change',
    })
    session.append('session/end-seed', {})
    expect(changed).not.toContain('contextBreakdown')

    // A tool-less envelope prices the tools figure back to zero and leaves
    // the system node's figure alone.
    session.append('request/header', { header: { config: CONFIG }, reason: 'change' })
    expect(projected(ctx, session)).toEqual({ systemTokens: 8, toolsTokens: 0, messageTokens: 0 })

    // Replacing node 0 follows the new prompt; an empty prompt records none.
    const longer = replaceSystem(session, systemNode, 'You are terse and answer in one line.')
    expect(projected(ctx, session).systemTokens).toBe(Math.ceil('You are terse and answer in one line.'.length / 4) + 4)
    replaceSystem(session, longer, '')
    expect(projected(ctx, session)).toEqual({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 })
  })

  it('keeps the system node out of the message figure across appends and a system replacement', async () => {
    const { ctx, session } = await harness()
    const systemNode = appendSystem(session, 'You are terse.')
    appendUser(session, 'abcd')
    expect(projected(ctx, session)).toMatchObject({ systemTokens: 8, messageTokens: 9 })
    replaceSystem(session, systemNode, 'You are verbose and thorough.')
    expect(projected(ctx, session)).toMatchObject({
      systemTokens: Math.ceil('You are verbose and thorough.'.length / 4) + 4,
      messageTokens: 9,
    })
    // The service prices the same system node identically, so the two
    // figures partition its surface total.
    const { systemTokens, messageTokens } = projected(ctx, session)
    expect(systemTokens + messageTokens).toBe(ctx.tokenMeter.measure(session).surfaceTokens)
  })

  it('sums surface appends and skips an empty-content assistant message', async () => {
    const { ctx, session } = await harness()
    appendUser(session, 'abcd')
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 9, outputTokens: 0 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    // 'abcd' prices to 9 (1 text + 4 block + 4 role); the usage-only assistant
    // message derives to no transcript entry and adds nothing.
    expect(projected(ctx, session).messageTokens).toBe(9)
  })

  it('shrinks the message figure when a metered replacement compacts the surface', async () => {
    const { ctx, session } = await harness()
    const first = appendUser(session, 'before compaction, a longer message')
    const second = appendUser(session, 'and a second entry')
    const summary = createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    appendSummaryMeter(ctx, session, first, second)
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', start: first, end: second },
      sourceEventSeqs: [first, second],
    })
    expect(projected(ctx, session).messageTokens).toBe(estimateMessage(summary))
  })

  it('keeps the message figure equal to the service result across appends and a compaction', async () => {
    const { ctx, session } = await harness()
    // The panel's composition rows and `measure()` answer the same question in
    // the same vocabulary; one shared fold is what makes that true.
    const agree = (): number => {
      const { systemTokens, messageTokens } = projected(ctx, session)
      expect(systemTokens + messageTokens).toBe(ctx.tokenMeter.measure(session).surfaceTokens)
      return messageTokens
    }
    appendSystem(session, 'You are terse.')
    session.append('request/header', {
      header: { config: CONFIG, tools: TOOLS },
      reason: 'initial',
    })
    expect(agree()).toBe(0)

    const question = appendUser(session, 'a first question, long enough to price above zero')
    session.append('step/start', { turn: 1, step: 1 })
    const answer = session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'a considered answer' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 40, outputTokens: 7 },
    }, { surfaceOp: 'append' }).seq
    session.append('step/end', { turn: 1, step: 1 })
    const grown = agree()
    expect(grown).toBeGreaterThan(0)

    appendSummaryMeter(ctx, session, question, answer)
    // The armed shadow price must not move the published figure by itself.
    expect(agree()).toBe(grown)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: question, end: answer },
      sourceEventSeqs: [question, answer],
    })
    expect(agree()).toBeLessThan(grown)
  })

  it('folds a replacement without a claim at zero and fails on a mismatched claim', () => {
    const definition = contextBreakdownProjectionDefinition
    const replace = (start: SessionSeq, end: SessionSeq): SessionEvent => ({
      type: 'user/message',
      seq: SessionSeq(9),
      time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      surfaceOp: { op: 'replace', start, end },
      sourceEventSeqs: [start, end],
    } as unknown as SessionEvent)
    const append = (seq: SessionSeq): SessionEvent => ({
      type: 'user/message',
      seq,
      time: 0,
      data: createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    } as unknown as SessionEvent)
    const meter = (start: SessionSeq, end: SessionSeq, seq: SessionSeq): SessionEvent => ({
      type: 'compaction/prune',
      seq,
      time: 0,
      data: {
        shadowedRange: { start, end },
        shadowedSeqs: [start, end],
        shadowedTokenCount: 5,
      },
    } as unknown as SessionEvent)
    let state = definition.init()
    state = definition.apply(state, append(SessionSeq(1)))
    state = definition.apply(state, append(SessionSeq(3)))
    // No metering event: the replacement contributes zero instead of throwing.
    expect(definition.wire.view(definition.apply(state, replace(SessionSeq(1), SessionSeq(3)))).messageTokens)
      .toBe(definition.wire.view(state).messageTokens)
    // An adjacent claim for another range contradicts the replacement.
    const mismatched = definition.apply(state, meter(SessionSeq(1), SessionSeq(1), SessionSeq(8)))
    expect(() => definition.apply(mismatched, replace(SessionSeq(1), SessionSeq(3))))
      .toThrow('no adjacent shadow price')
    // A claim expires after one intervening event, so replacement delta is zero.
    let expired = definition.apply(state, meter(SessionSeq(1), SessionSeq(3), SessionSeq(8)))
    expired = definition.apply(expired, {
      type: 'session/end-seed', seq: SessionSeq(9), time: 0, data: {},
    })
    expect(definition.wire.view(definition.apply(expired, replace(SessionSeq(1), SessionSeq(3)))).messageTokens)
      .toBe(definition.wire.view(state).messageTokens)
    // The armed claim prices exactly the next event's matching replacement.
    const armed = definition.apply(state, meter(SessionSeq(1), SessionSeq(3), SessionSeq(8)))
    expect(definition.wire.view(definition.apply(armed, replace(SessionSeq(1), SessionSeq(3)))).messageTokens)
      .toBe(definition.wire.view(state).messageTokens - 5 + estimateMessage(
        createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      ))
  })

  it('keeps the persisted checkpoint O(1) as the surface grows and compacts', async () => {
    const { ctx, session } = await harness()
    const first = appendUser(session, 'the first of many messages')
    for (let index = 0; index < 24; index += 1) appendUser(session, `message number ${index} with some text`)
    const last = appendUser(session, 'the last message before compaction')
    const stateKeys = (): string[] => {
      const row = ctx.sessionProjections.checkpoint(session)['contextBreakdown']
      if (row === undefined) throw new Error('contextBreakdown checkpoint row is missing')
      return Object.keys(row.val as Record<string, unknown>).sort()
    }
    // Growth adds no per-node bookkeeping to the durable state.
    expect(stateKeys()).toEqual(['messageTokens', 'systemTokens', 'toolsTokens'])
    const shadowed = session.surface.nodes.slice(
      session.surface.nodes.indexOf(first),
      session.surface.nodes.indexOf(last) + 1,
    )
    appendSummaryMeter(ctx, session, first, last)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', start: first, end: last },
      sourceEventSeqs: [...shadowed],
    })
    expect(stateKeys()).toEqual(['messageTokens', 'systemTokens', 'toolsTokens'])
    expect(projected(ctx, session).messageTokens)
      .toBe(ctx.tokenMeter.measure(session).surfaceTokens)
  })

  it('discards version-2 cache values and refolds system messages from the full log', async () => {
    const { ctx, session } = await harness()
    try {
      appendSystem(session, 'You are terse.')
      session.append('request/header', { header: { config: CONFIG, tools: TOOLS }, reason: 'initial' })
      appendUser(session, 'abcd')
      const current = ctx.sessionProjections.checkpoint(session)
      // The old fold's fields still validate, but its header-based system price is not reusable.
      const staleValue = { systemTokens: 0, toolsTokens: estimateToolsTokens({ config: CONFIG, tools: TOOLS }), messageTokens: 17 }
      expect(contextBreakdownProjectionDefinition.stateSchema.parse(staleValue)).toEqual(staleValue)
      const checkpoint = {
        ...current,
        contextBreakdown: { ver: 2, seq: SessionSeq(session.seq - 1), val: staleValue },
      }
      expect.soft(ctx.sessionProjections.viewCheckpoint(checkpoint)).not.toHaveProperty('contextBreakdown')
      expect.soft(ctx.sessionProjections.restoreFloor(checkpoint)).toBe(0)
      const restored = ctx.sessionProjections.restore(
        checkpoint, session.snapshotEvents(), SessionLogOffset(0), session.header, session.inheritedEventCount,
      )
      expect(restored.snapshot.values.contextBreakdown).toEqual({
        systemTokens: 8, toolsTokens: staleValue.toolsTokens, messageTokens: 9,
      })
      expect(restored.checkpoint).toEqual(current)
      expect(restored.checkpoint['contextBreakdown']?.ver).toBe(3)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores from a JSON checkpoint and unregisters with the token-meter fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const meterFiber = await ctx.plugin(TokenMeter)
    const session = ctx.sessions.create()
    appendSystem(session, 'You are terse.')
    appendUser(session, 'abcd')
    const checkpoint = JSON.parse(JSON.stringify(
      ctx.sessionProjections.checkpoint(session),
    )) as ReturnType<typeof ctx.sessionProjections.checkpoint>

    await meterFiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values).not.toHaveProperty('contextBreakdown')

    await ctx.plugin(TokenMeter)
    expect(ctx.sessionProjections.viewCheckpoint(checkpoint).contextBreakdown).toEqual({
      systemTokens: 8,
      toolsTokens: 0,
      messageTokens: 9,
    })
  })
})

describe('shared estimator', () => {
  it('prices every content-block shape under the fixed heuristic', () => {
    expect(estimateContent([{ type: 'text', text: 'abcd' }])).toBe(5)
    expect(estimateContent([{ type: 'reasoning', text: 'abcdefgh' }] as ContentBlock[])).toBe(6)
    expect(estimateContent([{ type: 'tool-call', id: 'c' as never, name: 'bash', arguments: '{"a":1}' }])).toBe(7)
    expect(estimateContent([{
      type: 'tool-result', toolCallId: 'c' as never,
      content: [{ type: 'text', text: 'abcd' }],
    }])).toBe(9)
    const unknown = { type: 'mystery', payload: 'abc' } as unknown as ContentBlock
    expect(estimateContent([unknown])).toBe(4 + Math.ceil(JSON.stringify(unknown).length / 4))
  })

  it('prices the system node without block overhead and an empty prompt to zero', () => {
    expect(estimateSystemMessage(createSystemMessage('', SYSTEM_PLUGIN))).toBe(0)
    expect(estimateSystemMessage(createSystemMessage('abcdefgh', SYSTEM_PLUGIN))).toBe(6)
    // estimateMessage routes the system role to the same figure.
    expect(estimateMessage(createSystemMessage('abcdefgh', SYSTEM_PLUGIN))).toBe(6)
    // A non-text block in a system message keeps a conservative JSON price.
    const image = { type: 'image', attachment: { attachmentId: 'a' } } as unknown as ContentBlock
    expect(estimateSystemMessage(createMessage({
      role: 'system',
      content: [{ type: 'text', text: 'abcd' }, image],
      source: { kind: 'plugin', plugin: SYSTEM_PLUGIN },
    }))).toBe(Math.ceil((4 + JSON.stringify(image).length) / 4) + 4)
  })

  it('prices the envelope tool schemas and absent tools to zero', () => {
    expect(estimateToolsTokens(undefined)).toBe(0)
    expect(estimateToolsTokens({ config: CONFIG, tools: [] })).toBe(0)
    expect(estimateToolsTokens({ config: CONFIG, tools: TOOLS }))
      .toBe(Math.ceil(JSON.stringify(TOOLS).length / 4) + 4)
  })
})
