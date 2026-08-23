/** Recorded-session replay through the shipped headless `dsh` profile. */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeSessionSnapshot, parseSnapshotManifest, type NormalizeContext } from '@deepseek-ai/dsh-session-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const snapshotsRoot = fileURLToPath(new URL('./', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/src/bin.ts')
const tsconfigPath = join(repoRoot, 'tsconfig.json')
const defaultCompositionDir = join(snapshotsRoot, 'text-turn')
const basePatch = join(defaultCompositionDir, 'cordis.yml')
const replayPatch = join(defaultCompositionDir, 'cordis.snapshot.yml')

interface JsonObject {
  [key: string]: unknown
}

function contextOf(log: string): NormalizeContext {
  const header = JSON.parse(log.split('\n').find(line => line.trim() !== '') ?? '{}') as JsonObject
  return {
    sessionIds: typeof header.id === 'string' ? [header.id] : [],
    cwd: typeof header.cwd === 'string' ? header.cwd : '\0missing-cwd\0',
  }
}

async function persistedSession(cwd: string): Promise<string> {
  const root = join(cwd, '.dsh', 'sessions')
  const files = (await readdir(root, { recursive: true }))
    .filter(file => file.endsWith('session.jsonl'))
  expect(files).toHaveLength(1)
  return readFile(join(root, files[0] as string), 'utf8')
}

function records(log: string): JsonObject[] {
  return log.split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as JsonObject)
}

function taskFromSession(log: string): string {
  for (const record of records(log)) {
    if (record.type !== 'user/message') continue
    const data = record.data as JsonObject | undefined
    const source = data?.source as JsonObject | undefined
    if (source?.kind !== 'user' || !Array.isArray(data?.content)) continue
    const blocks = data.content as JsonObject[]
    if (blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string') {
      return blocks[0].text
    }
  }
  throw new Error('headless snapshot session has no single-text user task')
}

function finalTextFromSession(log: string): string {
  const messages = records(log).flatMap((record) => {
    if (record.type !== 'assistant/message') return []
    const data = record.data as JsonObject | undefined
    const message = data?.message as JsonObject | undefined
    return message === undefined ? [] : [message]
  })
  const content = messages.at(-1)?.content
  if (!Array.isArray(content)) throw new Error('headless snapshot session has no final assistant message')
  return (content as JsonObject[])
    .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('')
}

describe('headless recorded-session snapshots', () => {
  it.each(['text-turn', 'tool-call-turn'])('replays %s through dsh --profile headless', async (name) => {
    const scenarioDir = join(snapshotsRoot, name)
    const manifestPath = join(scenarioDir, 'snapshot.yml')
    expect(parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)).toMatchObject({
      version: 1,
      profile: 'headless',
      composition: 'default',
      recording: 'live',
    })
    const fixture = await readFile(join(scenarioDir, 'session.jsonl'), 'utf8')
    const task = taskFromSession(fixture)

    let actual = ''
    const result = await runLoaderSmoke({
      label: 'tool-call-turn headless snapshot',
      tempDirPrefix: 'dsh-headless-session-snapshot-',
      binScript: dshBin,
      configPath: basePatch,
      binArgs: [
        '--profile', 'headless',
        '--patch', basePatch,
        '--patch', replayPatch,
        task,
      ],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: join(scenarioDir, 'session.jsonl'),
        DSH_TELEMETRY_DISABLED: '1',
      },
      inspect: async (cwd) => { actual = await persistedSession(cwd) },
    })

    expect(result.stdout).toBe(`${finalTextFromSession(fixture)}\n`)
    expect(result.stderr).toBe('')
    expect(normalizeSessionSnapshot(actual, contextOf(actual)))
      .toBe(normalizeSessionSnapshot(fixture, contextOf(fixture)))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
