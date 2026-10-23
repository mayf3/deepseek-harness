/** The out-of-repo `dsh-openai-codex` plugin persists unmarked web-search request events
 * into durable session logs. A fresh worker that resumes such a log without the plugin
 * mounted must still load it once the type is registered in the generated catalog, while
 * every other unknown non-ignorable type keeps refusing the log
 * ([session resume poisoning](https://github.com/mayf3/dsh-agent-core/issues/550)).
 * @module @deepseek-ai/dsh-session-persistence-jsonl/tests/codex-websearch-resume
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import SessionStore, { KNOWN_SESSION_EVENT_TYPES, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

/** The exact event type the Codex search provider appends before dispatch. */
const CODEX_SEARCH_EVENT_TYPE = 'web/openai-codex-search-llm-request'

/** A deliberately unregistered sibling type proving the registration is not a web/* wildcard. */
const UNREGISTERED_EVENT_TYPE = 'web/unregistered-telemetry'

/** The exact secret-free request record the plugin writes (endpoint plus request body). */
function codexSearchRequest(): Record<string, unknown> {
  return {
    endpoint: 'https://chatgpt.com/backend-api/codex/alpha/search',
    body: {
      id: 'resp-1',
      model: 'gpt-5.6-sol',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'tokyo weather' }],
      }],
      commands: { search_query: [{ q: 'tokyo weather' }] },
      settings: {
        search_context_size: 'medium',
        allowed_callers: ['direct'],
        external_web_access: 'indexed',
      },
      max_output_tokens: 10000,
    },
  }
}

/** A one-turn business log with the plugin's unmarked search event between business events. */
function poisonedTurnLog(): SessionEvent[] {
  const turn = oneTurnLog()
  return [
    ...turn.slice(0, 3),
    { type: CODEX_SEARCH_EVENT_TYPE, seq: 3, time: 4, data: codexSearchRequest() } as unknown as SessionEvent,
    ...turn.slice(3).map(event => ({ ...event, seq: event.seq + 1 })),
  ]
}

/** Dirs to remove after each test. */
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Mount one fresh worker (SessionStore plus JSONL persistence) over shared storage. */
async function mountWorker(root: string): Promise<{ ctx: Context; fiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return { ctx, fiber }
}

describe('codex web-search event registration', () => {
  it('registers the exact plugin event type without admitting the rest of the web/* namespace', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has(CODEX_SEARCH_EVENT_TYPE)).toBe(true)
    expect(KNOWN_SESSION_EVENT_TYPES.has(UNREGISTERED_EVENT_TYPE)).toBe(false)
  })

  it('resumes a same-build log carrying the unmarked plugin event after worker restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-codex-'))
    dirs.push(root)
    const writer = await mountWorker(root)
    const id = SessionId('codex-websearch-resume')
    await writer.ctx.sessionPersistence.create(meta(id, '/w'))
    await writer.ctx.sessionPersistence.append(id, poisonedTurnLog())
    await writer.fiber.dispose()

    // A fresh worker process: no plugin mounted, nothing in memory — only the durable log.
    const reader = await mountWorker(root)
    try {
      const loaded = await reader.ctx.sessionPersistence.load(id)
      expect(loaded.events.map(event => event.type)).toEqual([
        'turn/start',
        'user/message',
        'step/start',
        CODEX_SEARCH_EVENT_TYPE,
        'assistant/message',
        'step/end',
        'turn/end',
      ])
    } finally {
      await reader.fiber.dispose()
    }
  })

  it('preserves ordering, sequence, and business messages exactly once across reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-codex-'))
    dirs.push(root)
    const writer = await mountWorker(root)
    const id = SessionId('codex-websearch-ordering')
    await writer.ctx.sessionPersistence.create(meta(id, '/w'))
    await writer.ctx.sessionPersistence.append(id, poisonedTurnLog())
    await writer.fiber.dispose()

    const reader = await mountWorker(root)
    try {
      const loaded = await reader.ctx.sessionPersistence.load(id)
      expect(loaded.events.map(event => event.seq)).toEqual(loaded.events.map((_, index) => index))
      const userMessages = loaded.events.filter(event => event.type === 'user/message')
      const assistantMessages = loaded.events.filter(event => event.type === 'assistant/message')
      expect(userMessages).toHaveLength(1)
      expect(assistantMessages).toHaveLength(1)
      const searchEvents = loaded.events.filter(event => event.type === CODEX_SEARCH_EVENT_TYPE)
      expect(searchEvents).toHaveLength(1)
      expect(searchEvents[0]?.data).toEqual(codexSearchRequest())
      expect(loaded.events.findIndex(event => event.type === CODEX_SEARCH_EVENT_TYPE)).toBe(3)
    } finally {
      await reader.fiber.dispose()
    }
  })

  it('keeps failing closed on an unknown non-ignorable event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-codex-'))
    dirs.push(root)
    const writer = await mountWorker(root)
    const id = SessionId('codex-websearch-fail-closed')
    await writer.ctx.sessionPersistence.create(meta(id, '/w'))
    await writer.ctx.sessionPersistence.append(id, [
      ...poisonedTurnLog(),
      { type: UNREGISTERED_EVENT_TYPE, seq: poisonedTurnLog().length, time: 99, data: { payload: 1 } } as unknown as SessionEvent,
    ])
    await writer.fiber.dispose()

    const reader = await mountWorker(root)
    try {
      const failure = await reader.ctx.sessionPersistence.load(id).then(() => undefined, (error: unknown) => error as Error)
      expect(failure?.name).toBe('SessionFormatUnsupportedError')
      expect(failure?.message).toMatch(/event type "web\/unregistered-telemetry".*not marked ignorable/)
    } finally {
      await reader.fiber.dispose()
    }
  })

  it('reloads identically on repeated restarts (idempotent, no duplication)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-codex-'))
    dirs.push(root)
    const writer = await mountWorker(root)
    const id = SessionId('codex-websearch-idempotent')
    await writer.ctx.sessionPersistence.create(meta(id, '/w'))
    await writer.ctx.sessionPersistence.append(id, poisonedTurnLog())
    await writer.fiber.dispose()

    const first = await mountWorker(root)
    let firstLoad: Awaited<ReturnType<typeof first.ctx.sessionPersistence.load>>
    try {
      firstLoad = await first.ctx.sessionPersistence.load(id)
    } finally {
      await first.fiber.dispose()
    }

    const second = await mountWorker(root)
    try {
      const secondLoad = await second.ctx.sessionPersistence.load(id)
      expect(secondLoad.events).toEqual(firstLoad.events)
      expect(secondLoad.events).toHaveLength(poisonedTurnLog().length)
    } finally {
      await second.fiber.dispose()
    }
  })
})
