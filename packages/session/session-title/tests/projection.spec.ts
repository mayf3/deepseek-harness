import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'

const CONFIG = { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 256 }

async function harness(withTitleService: boolean): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (withTitleService) await ctx.plugin(SessionTitleService, CONFIG)
  return { ctx, session: ctx.sessions.create(SessionId('titled')) }
}

function appendTitle(session: Session, title: string): number {
  return session.append('session/title', { title, messageSeqs: [1], source: { kind: 'fallback' } }).seq
}

describe('title projection unit', () => {
  it('serves null before the first title event', async () => {
    const { ctx, session } = await harness(true)
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values.title).toBeNull()
  })

  it('serves the latest title last-wins and notifies the change feed with the causing seq', async () => {
    const { ctx, session } = await harness(true)
    const changes: { key: string; value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      changes.push({ key, value, seq })
    })
    const firstSeq = appendTitle(session, 'First title')
    const secondSeq = appendTitle(session, 'Second title')
    session.append('turn/start', { turn: 1 })
    expect(changes).toEqual([
      { key: 'title', value: 'First title', seq: firstSeq },
      { key: 'title', value: 'Second title', seq: secondSeq },
    ])
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values.title).toBe('Second title')
    expect(snapshot.asOfSeq).toBe(session.seq - 1)
  })

  it('folds titles already in the log when the service mounts late (lazy cell build)', async () => {
    const { ctx, session } = await harness(false)
    appendTitle(session, 'Pre-mount title')
    await ctx.plugin(SessionTitleService, CONFIG)
    expect(ctx.sessionProjections.snapshot(session).values.title).toBe('Pre-mount title')
  })

  it('has no title key without the title service, and drops it when the service unloads (HMR safety)', async () => {
    const { ctx, session } = await harness(false)
    expect('title' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(SessionTitleService, CONFIG)
    appendTitle(session, 'Ephemeral')
    expect(ctx.sessionProjections.snapshot(session).values.title).toBe('Ephemeral')
    await fiber.dispose()
    expect('title' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })

  it('keeps thousands of title inputs in bounded reverse-linked chunks without persisting them', async () => {
    const { ctx, session } = await harness(false)
    session.append('turn/start', { turn: 1 })
    for (let index = 0; index < 5_000; index++) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `message ${String(index)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    await ctx.plugin(SessionTitleService, CONFIG)

    const state = ctx.sessionProjections.stateOf(session, 'titleInput')
    expect(state?.count).toBe(5_000)
    let chunks = 0
    for (let chunk = state?.tail ?? null; chunk !== null; chunk = chunk.previous) chunks += 1
    expect(chunks).toBe(Math.ceil(5_000 / 64))
    expect(ctx.sessionProjections.checkpoint(session).titleInput).toBeUndefined()
  })
})
