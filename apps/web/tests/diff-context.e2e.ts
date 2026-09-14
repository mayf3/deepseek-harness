/** Cold rendering of the shared filesystem edit Session preserves neutral context. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { expandTurnProcesses, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/diff-context', import.meta.url))
const SOURCE = fileURLToPath(new URL('../../../snapshots/session/fs-edit/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: contextual edit diff', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, await readFile(SOURCE, 'utf8'), 'diff-context')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  it('shows true totals before expansion and neutral shared context after expansion', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-diff-context'))
    const group = page.locator('[role="treeitem"]').first()
    await group.waitFor({ timeout: 15_000 })
    await group.click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('DONE', { exact: true }).waitFor({ timeout: 15_000 })
    await expandTurnProcesses(page)
    const edit = page.locator('[data-variant="edit"]')
    expect(await edit.textContent()).toContain('+1 -1')
    expect(await edit.locator('[data-diff]').count()).toBe(0)
    await edit.locator('[data-expandable]').click()
    const card = edit.locator('[data-diff]')
    await card.waitFor()
    expect(await card.getByText('level=info', { exact: true }).count()).toBe(1)
    expect(await card.textContent()).toContain('+1 -1 · 1 file')
    await compareOrRefreshGolden(`${SNAPSHOT_DIR}/ui.expected.md`,
      await captureStableAria(page, '[data-variant="edit"]', scaffold.workspaceCwd), MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
