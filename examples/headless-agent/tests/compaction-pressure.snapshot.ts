/** Headless Loader regression for pressure on the first routed request. */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { normalizeSessionLog, scrubRequestHeaders } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it } from 'vitest'

const expected = join(dirname(fileURLToPath(import.meta.url)), 'snapshots/compaction-pressure/session.expected.jsonl')
const configPath = fileURLToPath(new URL('../compaction-pressure.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const sessionId = SessionId('compaction-pressure')

async function seedHistory(root: string, cwd: string): Promise<string> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const session = Session.create(sessionId)
  for (let turn = 1; turn <= 2; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `HISTORY SENTINEL ${'historical evidence '.repeat(1600)}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', { turn, step: 1, message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'Recorded the historical evidence.' }],
      source: { kind: 'model', provider: 'pressure-provider', model: 'pressure-model' },
    }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd, delegationDepth: 0 }
  try {
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(sessionId, session.events)
    const location = ctx.sessionPersistence.locate(meta)
    if (location === undefined) throw new Error('JSONL backend did not locate the pressure session')
    return location.path
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('headless compaction pressure snapshot', () => {
  it('compacts headerless resumed history before the first routed request', async () => {
    let sessionPath = ''
    const result = await runLoaderSmoke({
      label: 'headless first-request compaction pressure',
      tempDirPrefix: 'headless-compaction-pressure-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Continue from the established historical evidence.'],
      tsconfigPath,
      env: { DSH_SNAPSHOT: 'replay' },
      prepare: async (cwd) => { sessionPath = await seedHistory(join(cwd, '.sessions'), cwd) },
      inspect: async (cwd) => {
        const raw = await readFile(sessionPath, 'utf8')
        const session = scrubRequestHeaders(normalizeSessionLog(raw, { sessionIds: [sessionId], cwd }))
        const records = session.trimEnd().split('\n').map(line => JSON.parse(line) as { type: string; seq: number; data?: { shadowedSeqs?: number[] }; sourceEventSeqs?: number[] })
        expect(records.filter(record => record.type === 'compaction/start')).toHaveLength(1)
        expect(records.filter(record => record.type === 'compaction/end')).toHaveLength(1)
        const summary = records.find(record => record.type === 'compaction/summary')
        expect(summary?.data?.shadowedSeqs).toEqual([1, 3, 7, 9])
        const header = records.find(record => record.type === 'request/header')
        const start = records.find(record => record.type === 'compaction/start')
        const lastAssistant = records.findLast(record => record.type === 'assistant/message')
        expect(header!.seq).toBeLessThan(start!.seq)
        expect(start!.seq).toBeLessThan(lastAssistant!.seq)
        for (const record of records.filter(record => record.type !== 'session')) {
          expect(record.sourceEventSeqs?.every(seq => seq < record.seq) ?? true).toBe(true)
        }
        if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, session)
        expect(session).toBe(await readFile(expected, 'utf8'))
      },
    })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout.trimEnd().split('\n').at(-1)!)).toMatchObject({
      type: 'result', output: 'COMPACTION PRESSURE PASSED',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
