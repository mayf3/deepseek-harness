import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { SystemPromptProjection } from '../src/runtime-context.ts'

const SOURCE = '@deepseek-ai/dsh-system-prompt'

async function sessionStore(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

function appendUser(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('SystemPromptProjection', () => {
  it('appends the first rendered prompt, skips an unchanged one, and replaces the retained node on change', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-fresh'))
    const projection = new SystemPromptProjection(ctx, session)

    expect(projection.project('')).toBeUndefined()
    const first = projection.project('v1')
    expect(first?.intent).toEqual({ surfaceOp: 'append' })
    expect(first?.message.role).toBe('system')
    expect(first?.message.source).toEqual({ kind: 'plugin', plugin: SOURCE })
    const head = session.append('system/message', { turn: 1, step: 1, message: first!.message }, first!.intent)
    appendUser(session, 'hello')

    expect(projection.project('v1')).toBeUndefined()
    const second = projection.project('v2')
    expect(second?.intent).toEqual({
      surfaceOp: { op: 'replace', start: head.seq, end: head.seq },
      sourceEventSeqs: [head.seq],
    })
    const replaced = session.append('system/message', { turn: 2, step: 1, message: second!.message }, second!.intent)
    expect(session.surface.nodes[0]).toBe(replaced.seq)
    expect(projection.project('v2')).toBeUndefined()

    // An emptied prompt keeps the head node with empty content, which projects to no wire message.
    const emptied = projection.project('')
    expect(emptied?.message.content).toEqual([])
    session.append('system/message', { turn: 3, step: 1, message: emptied!.message }, emptied!.intent)
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user'])
    expect(projection.project('')).toBeUndefined()
    expect(projection.project('v3')?.intent).toMatchObject({ surfaceOp: { op: 'replace' } })
  })

  it('restores the surviving system node from the log and ignores other sessions', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-replay'))
    const stale = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('stale', SOURCE) }, { surfaceOp: 'append' })
    appendUser(session, 'hello')
    const current = session.append('system/message', { turn: 2, step: 1, message: createSystemMessage('current', SOURCE) }, {
      surfaceOp: { op: 'replace', start: stale.seq, end: stale.seq },
      sourceEventSeqs: [stale.seq],
    })

    const projection = new SystemPromptProjection(ctx, session)
    expect(projection.project('current')).toBeUndefined()
    expect(projection.project('next')?.intent).toEqual({
      surfaceOp: { op: 'replace', start: current.seq, end: current.seq },
      sourceEventSeqs: [current.seq],
    })

    const other = ctx.sessions.create(SessionId('system-prompt-other'))
    other.append('system/message', { turn: 1, step: 1, message: createSystemMessage('other', SOURCE) }, { surfaceOp: 'append' })
    expect(projection.project('current')).toBeUndefined()
  })

  it('restores an empty-content system node as "no prompt" and replaces it in place when a prompt appears', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-empty-replay'))
    const empty = session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('', SOURCE) }, { surfaceOp: 'append' })
    appendUser(session, 'hello')

    const projection = new SystemPromptProjection(ctx, session)
    expect(projection.project('')).toBeUndefined()
    expect(projection.project('now present')?.intent).toEqual({
      surfaceOp: { op: 'replace', start: empty.seq, end: empty.seq },
      sourceEventSeqs: [empty.seq],
    })
  })

  it('appends again after a replacement shadowed a system node that was not the head', async () => {
    const ctx = await sessionStore()
    const session = ctx.sessions.create(SessionId('system-prompt-shadowed'))
    const projection = new SystemPromptProjection(ctx, session)
    appendUser(session, 'before any prompt')
    const late = projection.project('late prompt')
    expect(late?.intent).toEqual({ surfaceOp: 'append' })
    const node = session.append('system/message', { turn: 1, step: 1, message: late!.message }, late!.intent)
    expect(session.surface.nodes.indexOf(node.seq)).toBe(1)
    expect(projection.project('late prompt')).toBeUndefined()

    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: node.seq, end: node.seq },
      sourceEventSeqs: [node.seq],
    })
    expect(projection.project('late prompt')?.intent).toEqual({ surfaceOp: 'append' })
  })
})
