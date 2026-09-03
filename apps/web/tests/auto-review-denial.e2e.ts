// Web e2e scenario: a cold recording renders the structured Auto-review
// denial without replaying a reviewer or model call.
// The real persistence reader, shipped Web composition, permission
// projection, conversation assembler, and generic Tool row all participate.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandOwningTurnProcess, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/auto-review-denial', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/auto-review-denial/session.v2.jsonl', import.meta.url))
const COLLAPSED_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/auto-review-denial/collapsed.expected.md', import.meta.url))
const EXPANDED_EXPECTED = fileURLToPath(new URL('../../../snapshots/web/auto-review-denial/expanded.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'auto-review-denial-web-e2e'

describe.skipIf(MODE === 'record')('web e2e: cold Auto-review denial', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    const rows = fixture.trim().split(/\r?\n/u).slice(1).map(line => JSON.parse(line) as {
      type?: string
      data?: Record<string, unknown>
    })
    const result = rows.find(row => row.type === 'tool/result')
    expect(result?.data).toMatchObject({
      message: {
        source: { kind: 'tool', callId: 'auto-review-denied-call' },
        content: [{
          type: 'tool-result',
          toolCallId: 'auto-review-denied-call',
          isError: true,
        }],
      },
      error: {
        name: 'AutoReviewDeniedError',
        code: 'AUTO_REVIEW_DENIED',
        reason: 'raw\r\nreason',
      },
    })
    expect(result?.data).not.toHaveProperty('callId')

    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID)
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
    const call = page.locator('[data-tool="mystery"]')
    await expandOwningTurnProcess(page, call)
    await call.waitFor({ state: 'visible', timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows only the Auto identity and normalized denial reason', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auto-review-denial'))
    const call = page.locator('[data-tool="mystery"]')
    const row = call.locator('[data-expandable]')
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false')
    expect(await call.getByText('Rejected by Auto review', { exact: true }).count()).toBe(1)
    expect(await call.getByText('Tool execution rejected by user', { exact: true }).count()).toBe(0)
    expect(await call.getByText('hidden-input', { exact: false }).count()).toBe(0)

    const access = page.locator('button[aria-label^="Access mode"]').first()
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('Access mode, current: Auto review EXP')

    const collapsed = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(COLLAPSED_EXPECTED, collapsed, MODE)

    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    expect(await call.getByText('IN', { exact: true }).count()).toBe(0)
    expect(await call.getByText('OUT', { exact: true }).count()).toBe(1)
    expect(await call.getByText('Tool was not executed. Reason: raw reason', { exact: true }).count()).toBe(1)
    expect(await call.getByText('Tool execution rejected by user', { exact: true }).count()).toBe(0)
    expect(await call.getByText('hidden-input', { exact: false }).count()).toBe(0)

    const expanded = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(EXPANDED_EXPECTED, expanded, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'collapsed.expected.md', 'expanded.expected.md', 'session.v2.jsonl',
    ])
  })
})
