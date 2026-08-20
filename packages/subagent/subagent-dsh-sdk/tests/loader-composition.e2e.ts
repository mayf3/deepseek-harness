/**
 * Keyless REAL-composition coverage across the SDK wire: a test-only
 * cordis.yml boots the headless app through the Loader, delegates to a
 * complete second harness runtime, and verifies cwd inheritance plus
 * model-visible child-failure diagnostics.
 */

import { realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveExampleLaunch, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = new URL('../../../../examples/jsonrpc-agent/tests/fixtures/subagent/subagent-dsh-sdk/', import.meta.url)
const driver = fileURLToPath(new URL('driver.ts', fixtureDir))
const configPath = fileURLToPath(new URL('cordis.yml', fixtureDir))
const childConfigPath = fileURLToPath(new URL('child.cordis.yml', fixtureDir))
const runtimeBin = fileURLToPath(new URL('../../../../packages/examples/jsonrpc-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

async function sessionEvents(log: string): Promise<SessionEvent[]> {
  const lines = (await readFile(log, 'utf8')).trimEnd().split('\n')
  return lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
}

function toolResultText(events: SessionEvent[]): string {
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(1)
  return results[0]!.data.message.content[0].content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function childLaunchEnv(failure = false): Record<string, string> {
  const launch = resolveExampleLaunch({
    srcBin: runtimeBin,
    configArgs: [childConfigPath],
    tsconfigPath: repoTsconfig,
  })
  return {
    DSH_TEST_CHILD_COMMAND: launch.command,
    DSH_TEST_CHILD_ARGS: JSON.stringify(launch.args),
    DSH_TEST_CHILD_ENV: JSON.stringify({
      ...Object.fromEntries(Object.entries(launch.env).filter(([, value]) => value !== undefined)),
      ...(failure ? { DSH_TEST_CHILD_FAILURE: '1' } : {}),
    }),
  }
}

describe('SDK subagent cwd inheritance through a real cordis.yml', () => {
  it('runs the child runtime in the parent session workspace', async () => {
    // The child launch honors the same src/lib mode as the driving harness,
    // per the shared example-launch resolver (testing policy forbids
    // hand-written `--import tsx` argv for example subprocesses).
    let events: SessionEvent[] = []
    let childEvents: SessionEvent[] = []
    let workspace = ''
    const { stderr } = await runLoaderSmoke({
      label: 'dsh-sdk-subagent cwd composition smoke',
      tempDirPrefix: 'dsh-sdk-subagent-cwd-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      // Two complete harness runtimes boot in sequence (driver, then the SDK
      // child); from-source tsx boots under load need more than the default
      // 30s window.
      processTimeoutMs: 120_000,
      env: childLaunchEnv(),
      inspect: async (cwd) => {
        // The child reports realpaths; canonicalize the temp workspace to match.
        workspace = realpathSync(cwd)
        const parentLogs = await jsonlFiles(join(cwd, '.sessions'))
        expect(parentLogs).toHaveLength(1)
        events = await sessionEvents(parentLogs[0] as string)
        // The child runtime persisted its own transcript in ITS cwd — which
        // must be the parent session's workspace for the inheritance to hold.
        const childLogs = await jsonlFiles(join(cwd, '.child-sessions'))
        expect(childLogs).toHaveLength(1)
        childEvents = await sessionEvents(childLogs[0] as string)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')

    // The parent's tool result carries the child model's echo of its real
    // process.cwd() — the parent session's workspace, never the harness
    // process's launch directory.
    expect(toolResultText(events)).toBe(`child cwd: ${workspace}`)

    // The child ran a real turn of its own: user message in, assistant out.
    expect(childEvents.some(event => event.type === 'user/message')).toBe(true)
    const childAnswers = childEvents.filter(event => event.type === 'assistant/message')
    expect(childAnswers.length).toBeGreaterThan(0)
    // 15s of vitest headroom past the subprocess deadline, mirroring
    // LOADER_SMOKE_TEST_TIMEOUT_MS's margin over the default window.
  }, 135_000)

  it('presents the child error diagnostic separately from partial output', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'dsh-sdk-subagent diagnostic composition smoke',
      tempDirPrefix: 'dsh-sdk-subagent-diagnostic-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs: 120_000,
      env: childLaunchEnv(true),
      inspect: async (cwd) => {
        const parentLogs = await jsonlFiles(join(cwd, '.sessions'))
        expect(parentLogs).toHaveLength(1)
        events = await sessionEvents(parentLogs[0] as string)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(toolResultText(events)).toBe(
      'Error: subagent run failed\n'
      + 'Diagnostic: Subagent failure (provider: DSH SDK; stage: session-run; category: child-error)\n'
      + 'Partial output before the run ended:\npartial child loader answer',
    )
  }, 135_000)
})
