/**
 * The `turnOutline` projection unit: mounting the plugin beside the
 * projection registry serves the whole-log turn outline (turn number,
 * `turn/start` seq, bounded first-prompt preview); compositions without the
 * registry are unaffected; unmounting the plugin removes the key (HMR
 * safety). Narrow fold paths with fabricated envelopes (non-human sources,
 * regressive turn numbers) run against the exported definition directly.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as SessionTurnOutlinePlugin from '@deepseek-ai/dsh-session-turn-outline'
import { turnOutlineProjectionDefinition } from '@deepseek-ai/dsh-session-turn-outline/src/projection.ts'
import type { TurnOutlineProjection } from '@deepseek-ai/dsh-session-turn-outline/types'

async function harness(withOutlinePlugin: boolean): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (withOutlinePlugin) await ctx.plugin(SessionTurnOutlinePlugin)
  return { ctx, session: ctx.sessions.create(SessionId('outlined')) }
}

/** Append one human prompt; returns its seq. */
function appendPrompt(session: Session, text: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function outlineOf(ctx: Context, session: Session): TurnOutlineProjection {
  return ctx.sessionProjections.snapshot(session).values.turnOutline as TurnOutlineProjection
}

describe('turn outline projection unit', () => {
  it('serves an empty outline before any turn starts', async () => {
    const { ctx, session } = await harness(true)
    expect(outlineOf(ctx, session)).toEqual({ turns: [] })
    expect(ctx.sessionProjections.checkpoint(session).turnOutline)
      .toEqual({ ver: 1, seq: -1, val: { turns: [] } })
  })

  it('folds each started turn with its boundary seq and first human prompt only', async () => {
    const { ctx, session } = await harness(true)
    const firstBoundary = session.append('turn/start', { turn: 1 }).seq
    appendPrompt(session, 'hello world')
    appendPrompt(session, 'a later steer must not replace the prompt')
    const secondBoundary = session.append('turn/start', { turn: 2 }).seq
    appendPrompt(session, 'second prompt')
    expect(outlineOf(ctx, session)).toEqual({
      turns: [
        { turn: 1, seq: firstBoundary, prompt: 'hello world' },
        { turn: 2, seq: secondBoundary, prompt: 'second prompt' },
      ],
    })
  })

  it('keeps an empty preview for a turn whose prompt never lands', async () => {
    const { ctx, session } = await harness(true)
    const boundary = session.append('turn/start', { turn: 1 }).seq
    session.append('step/start', { turn: 1, step: 1 })
    expect(outlineOf(ctx, session)).toEqual({ turns: [{ turn: 1, seq: boundary, prompt: '' }] })
  })

  it('collapses whitespace, joins text blocks, and caps the preview at 160 characters', async () => {
    const { ctx, session } = await harness(true)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: `  first\n\nline\t${'x'.repeat(200)}` },
        { type: 'text', text: 'never reached past the budget' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const preview = outlineOf(ctx, session).turns[0]?.prompt
    expect(preview).toBeDefined()
    expect(preview).toMatch(/^first line x+$/)
    expect(preview).toHaveLength(160)
  })

  it('ignores non-human user/message sources and pre-turn prompts', async () => {
    const { ctx, session } = await harness(true)
    appendPrompt(session, 'queued before any turn')
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected context' }],
      source: { kind: 'plugin', plugin: 'test-injector', form: 'relay' },
    }), { surfaceOp: 'append' })
    expect(outlineOf(ctx, session)).toEqual({
      turns: [{ turn: 1, seq: 1, prompt: '' }],
    })
  })

  it('notifies the change feed only when the outline actually moves', async () => {
    const { ctx, session } = await harness(true)
    const changes: { key: string; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, _value, seq) => {
      if (key === 'turnOutline') changes.push({ key, seq })
    })
    const boundarySeq = session.append('turn/start', { turn: 1 }).seq
    session.append('step/start', { turn: 1, step: 1 })
    const promptSeq = appendPrompt(session, 'hello')
    appendPrompt(session, 'second human message in the same turn')
    session.append('step/end', { turn: 1, step: 1 })
    expect(changes).toEqual([
      { key: 'turnOutline', seq: boundarySeq },
      { key: 'turnOutline', seq: promptSeq },
    ])
  })

  it('skips a boundary that does not advance the turn number (fabricated envelope)', () => {
    const state: TurnOutlineProjection = { turns: [{ turn: 2, seq: 5, prompt: 'kept' }] }
    const regressive = {
      type: 'turn/start',
      seq: 9,
      time: 0,
      data: { turn: 2 },
    } as unknown as SessionEvent
    expect(turnOutlineProjectionDefinition.apply(state, regressive)).toBe(state)
  })

  it('folds turns already in the log when the plugin mounts late (lazy cell build)', async () => {
    const { ctx, session } = await harness(false)
    session.append('turn/start', { turn: 1 })
    appendPrompt(session, 'pre-mount prompt')
    await ctx.plugin(SessionTurnOutlinePlugin)
    expect(outlineOf(ctx, session).turns).toEqual([{ turn: 1, seq: 0, prompt: 'pre-mount prompt' }])
  })

  it('has no key without the plugin and drops it when the plugin unloads (HMR safety)', async () => {
    const { ctx, session } = await harness(false)
    expect('turnOutline' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(SessionTurnOutlinePlugin)
    session.append('turn/start', { turn: 1 })
    expect('turnOutline' in ctx.sessionProjections.snapshot(session).values).toBe(true)
    await fiber.dispose()
    expect('turnOutline' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })

  it('rejects a persisted checkpoint whose turns are not strictly increasing', async () => {
    const { ctx, session } = await harness(true)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const row = checkpoint.turnOutline
    expect(row).toBeDefined()
    expect(() => ctx.sessionProjections.restore({
      ...checkpoint,
      turnOutline: {
        ...row!,
        val: { turns: [{ turn: 2, seq: 1, prompt: '' }, { turn: 2, seq: 4, prompt: '' }] },
      },
    }, [], 0, session.header)).toThrow(/strictly increasing/)
    expect(() => ctx.sessionProjections.restore({
      ...checkpoint,
      turnOutline: {
        ...row!,
        val: { turns: [{ turn: 1, seq: 1, prompt: 'ok' }, { turn: 2, seq: 4, prompt: '' }] },
      },
    }, [], 0, session.header)).not.toThrow()
  })
})
