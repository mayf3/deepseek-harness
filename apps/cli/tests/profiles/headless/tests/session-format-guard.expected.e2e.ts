/**
 * Assembled-app regressions for Session-format lifecycle behavior: a physical
 * v0 log migrates through the real Loader composition, remains byte-for-byte
 * intact beside v1, and accepts the next append through v1; a future format or unknown
 * required current event refuses with the direction and raw log path.
 * @module session-format-guard-snapshot
 */

import { join, dirname } from 'node:path'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogFilename } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { describe, expect, it } from 'vitest'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'expected/workspace-context-resume/offline-edit')
const replayFixture = join(fixtureDir, 'replay.jsonl')
const configPath = fileURLToPath(new URL('../workspace-context-resume-snapshot.patch.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
// The resumed-agent fixture in the shared config resumes exactly this id.
const sessionId = SessionId('workspace-context-resume')

/** Stage one physical raw JSONL session without passing through the current writer. */
async function seedSession(root: string, cwd: string, version: number, events: SessionEvent[]): Promise<string> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    cwd,
    isSeeded: false,
  }
  try {
    const location = ctx.sessionPersistence.locate(meta)
    if (location === undefined) throw new Error('JSONL backend did not locate the seeded session')
    const content = [
      { type: 'session', version, id: sessionId, createdAt: 1, cwd, delegationDepth: 0 },
      ...events,
    ].map(record => JSON.stringify(record)).join('\n') + '\n'
    const path = join(dirname(location.path), generationLogFilename(version, 'none'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    return path
  } finally {
    await ctx.fiber.dispose()
  }
}

function closedTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

describe('session format guard through the assembled app', () => {
  it('migrates a raw v0 log before resume, preserves exact source bytes, and appends only to v1', async () => {
    let v0Path = ''
    let v0 = ''
    let v0Identity: { readonly dev: bigint; readonly ino: bigint } | undefined
    await runLoaderSmoke({
      label: 'v0 identity migration before resume',
      tempDirPrefix: 'dsh-format-migrate-v0-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Continue the migrated session.'],
      tsconfigPath,
      env: { DSH_SNAPSHOT_FILE: replayFixture },
      prepare: async (runCwd) => {
        v0Path = await seedSession(join(runCwd, '.sessions'), runCwd, 0, closedTurn())
        v0 = await readFile(v0Path, 'utf8')
        const identity = await stat(v0Path, { bigint: true })
        v0Identity = { dev: identity.dev, ino: identity.ino }
      },
      inspect: async () => {
        const v1Path = join(dirname(v0Path), generationLogFilename(SESSION_FORMAT_VERSION, 'none'))
        const current = await readFile(v1Path, 'utf8')
        const sourceIdentity = await stat(v0Path, { bigint: true })
        const currentIdentity = await stat(v1Path, { bigint: true })
        expect(await readFile(v0Path, 'utf8')).toBe(v0)
        expect({ dev: sourceIdentity.dev, ino: sourceIdentity.ino }).toEqual(v0Identity)
        expect({ dev: currentIdentity.dev, ino: currentIdentity.ino }).not.toEqual(v0Identity)
        expect((JSON.parse(current.split('\n')[0] as string) as { version: number }).version)
          .toBe(SESSION_FORMAT_VERSION)
        expect(current).not.toBe(v0)
        expect(current.trimEnd().split('\n').length).toBeGreaterThan(closedTurn().length + 1)
        expect((await readdir(dirname(v0Path))).sort()).toEqual(['session.jsonl', 'session.v1.jsonl'])
      },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('refuses to resume a newer-format log, naming the upgrade direction and the raw log path', async () => {
    let sessionPath = ''
    const result = await runLoaderSmoke({
      label: 'newer-format resume refusal',
      tempDirPrefix: 'dsh-format-guard-version-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Try to resume.'],
      tsconfigPath,
      env: { DSH_SNAPSHOT_FILE: replayFixture },
      expectedExitCode: 1,
      prepare: async (runCwd) => {
        sessionPath = await seedSession(join(runCwd, '.sessions'), runCwd, SESSION_FORMAT_VERSION + 99, closedTurn())
      },
    })
    expect(result.stderr).toContain(
      `session "${sessionId}" uses log format v${SESSION_FORMAT_VERSION + 99}, but this harness reads only v${SESSION_FORMAT_VERSION}: the log was written by a newer harness — upgrade the harness to open it`,
    )
    // macOS reports the temp dir via the /private symlink parent; assert the
    // stable path suffix instead of the realpath-dependent prefix.
    expect(result.stderr).toContain('(raw log: ')
    expect(result.stderr).toContain(sessionPath.slice(sessionPath.indexOf('/.sessions/')))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('refuses to resume a log with an unknown required event type', async () => {
    let sessionPath = ''
    const result = await runLoaderSmoke({
      label: 'unknown-event resume refusal',
      tempDirPrefix: 'dsh-format-guard-event-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Try to resume.'],
      tsconfigPath,
      env: { DSH_SNAPSHOT_FILE: replayFixture },
      expectedExitCode: 1,
      prepare: async (runCwd) => {
        sessionPath = await seedSession(join(runCwd, '.sessions'), runCwd, SESSION_FORMAT_VERSION, [
          ...closedTurn(),
          { type: 'future/event', seq: SessionSeq(2), time: 3, data: { payload: 1 } } as unknown as SessionEvent,
        ])
      },
    })
    expect(result.stderr).toContain(
      `session "${sessionId}" contains event type "future/event" (seq 2) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`,
    )
    // macOS reports the temp dir via the /private symlink parent; assert the
    // stable path suffix instead of the realpath-dependent prefix.
    expect(result.stderr).toContain('(raw log: ')
    expect(result.stderr).toContain(sessionPath.slice(sessionPath.indexOf('/.sessions/')))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
