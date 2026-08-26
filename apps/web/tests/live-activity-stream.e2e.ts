// Session-header live activities driven by a real background bash run: the
// roster row arrives over the activity control stream, expanding it opens the
// observation stream, and the panel shows the process's real output while it
// is still running. No model call is involved.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JobId } from '@deepseek-ai/dsh-jobs'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/live-activity-stream', import.meta.url))
const STREAMING_EXPECTED = join(SNAPSHOT_DIR, 'streaming.expected.md')
const SETTLED_EXPECTED = join(SNAPSHOT_DIR, 'settled.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'live-activity-stream-web-e2e'
// One fixed line of early output, then silence long enough that the streaming
// assertions never race the process exiting; the test kills it explicitly.
const COMMAND = "printf 'streamed-%s\\n' marker-line; sleep 45"

/**
 * Wait for opening a session to publish its live Agent.
 * @param scaffold - the booted web scaffold.
 * @param sessionId - the opened session's identity.
 * @returns the registered Agent instance.
 */
async function liveAgent(scaffold: WebScaffold, sessionId: SessionId): Promise<Agent> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const found = scaffold.ctx.agents.get(sessionId)
    if (found !== undefined) return found
    if (Date.now() > deadline) throw new Error(`opening session "${sessionId}" published no live Agent`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

describe.skipIf(MODE === 'record')('web e2e: live activity stream', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let agent: Agent
  let jobId: JobId

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    // Opening the session drives the Host's ordinary Agent resolution; the
    // activity owner must be that exact live instance, never a second one.
    agent = await liveAgent(scaffold, SessionId(SEED_ID))
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('streams a running background command\'s real output into the expanded panel', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-live-activity-streaming'))
    const trigger = page.getByRole('button', { name: '1 task running' })
    expect(await trigger.count()).toBe(0)

    const started = await scaffold.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('live-activity-stream-e2e'),
      name: 'bash',
      arguments: { command: COMMAND, description: 'Emit one live line then hold', run_in_background: true },
      agent,
    })
    const reported = started.content.map(block => block.type === 'text' ? block.text : '').join('')
    const matched = /\bbash-\d+\b/.exec(reported)
    if (matched === null) throw new Error(`background bash reported no job id: ${reported}`)
    jobId = JobId(matched[0])

    // The roster row reaches the header over the activity control stream.
    await trigger.waitFor({ timeout: 15_000 })
    await trigger.click()

    // Expanding the row opens the observation stream; the panel then renders
    // the command's real stdout while the process is still running.
    const expand = page.getByRole('button', { name: /Show live output/ })
    await expand.waitFor({ timeout: 10_000 })
    await expand.click()
    await page.getByText('streamed-marker-line').waitFor({ timeout: 15_000 })

    const snapshot = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(STREAMING_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('settles the open panel when the job is killed, keeping the streamed tail', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-live-activity-settled'))
    expect(scaffold.ctx.jobs.kill(jobId, agent, { reason: 'web e2e cancellation' })).toBe('requested')

    // Settlement arrives on the observation stream itself, so the open panel
    // flips without any further interaction; the roster trigger follows.
    const idle = page.getByRole('button', { name: '1 task' })
    await idle.waitFor({ timeout: 20_000 })
    await page.getByText('streamed-marker-line').waitFor({ timeout: 10_000 })

    const snapshot = await captureStableAria(page, '[class*="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(SETTLED_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['settled.expected.md', 'streaming.expected.md'])
  })
})
