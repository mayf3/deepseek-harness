// Web e2e scenario: the changed-files card a finished turn ends with.
// Cold-seeds one recorded change summary (zero model calls), then verifies the
// real assembled card folds after three rows, expands to the complete list,
// and offers native file and folder actions when the Host desktop is pinned on.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./changed-files.overlay.yml', import.meta.url))
const SEED_ID = 'changed-files-web-e2e'
const DONE = 'CHANGED_FILES_DONE'

/** Eleven files in display order, as the Host records them. */
const CHANGED = [
  ['config/design-token', 42, 11],
  ['config/feature-flags.json', 143, 32],
  ['config/launch-plan.yaml', 654, 9],
  ['src/app.ts', 120, 80],
  ['src/index.html', 30, 4],
  ['src/manifest.yaml', 12, 0],
  ['src/notes.txt', 8, 8],
  ['src/preview.svg', 0, 0],
  ['src/schema.json', 90, 60],
  ['src/styles.css', 100, 100],
  ['关于我.md', 33, 22],
] as const

/** Build one settled turn whose recorded summary lists eleven changed files. */
function changedFixture(): string {
  const session = Session.create(SessionId('changed-files-source'))
  const eventTimeOrigin = new Date().setHours(12, 0, 0, 0)
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Update the site files.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', {
    title: 'Changed files fold', messageSeqs: [user.seq], source: { kind: 'fallback' },
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: `Updated the site.\n\n${DONE}` }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('workspace/changes', {
    turn: 1,
    total: CHANGED.length,
    snapshot: { before: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', after: 'c1a2b3d4e5f60718293a4b5c6d7e8f9012345678' },
    files: CHANGED.map(([path, added, deleted]) => ({
      path, display: path, added, deleted, ...(path.endsWith('.svg') ? { binary: true as const } : {}),
    })),
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
      createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({
      ...event, time: eventTimeOrigin + event.seq * 1_000,
    })),
    '',
  ].join('\n')
}

describe('web e2e: a finished turn ends with the files it changed', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await seedSession(scaffold, changedFixture(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.setViewportSize({ width: 1400, height: 900 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('folds an eleven-file summary after three rows and expands it in place', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-changed-files'))
    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    if (await groupRow.getAttribute('aria-expanded') !== 'true') await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()

    await expect.poll(() => page.getByText(DONE, { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    const card = page.locator('[data-changed-files]')
    await card.waitFor({ timeout: 15_000 })
    await expect.poll(() => card.getByText('Edited 11 files', { exact: true }).count()).toBe(1)
    expect(await card.getByText('+1,232', { exact: true }).count()).toBe(1)
    expect(await card.getByText('-326', { exact: true }).count()).toBe(1)
    const rows = card.getByRole('listitem')
    await expect.poll(() => rows.count()).toBe(3)
    expect(await rows.nth(0).innerText()).toContain('config/design-token')
    expect(await rows.nth(0).innerText()).toContain('+42')
    expect(await rows.nth(2).innerText()).toContain('config/launch-plan.yaml')
    // The pinned desktop turns the header into the folder action and rows into default-app opens.
    await expect.poll(() => card.getByRole('button', { name: 'Open the folder containing the changed files' }).count()).toBe(1)
    expect(await card.getByRole('button', { name: 'Open config/design-token in default app' }).count()).toBe(1)

    const expand = card.getByRole('button', { name: 'Show all 11 changed files' })
    expect(await expand.innerText()).toContain('All 11 files')
    await expand.click()
    await expect.poll(() => rows.count()).toBe(11)
    expect(await rows.nth(7).innerText()).toContain('binary')
    expect(await rows.nth(10).innerText()).toContain('关于我.md')
    const collapse = card.getByRole('button', { name: 'Collapse changed files' })
    expect(await collapse.getAttribute('aria-expanded')).toBe('true')
    // The collapse control is the card's last element after expansion.
    expect(await card.evaluate(element => element.lastElementChild?.getAttribute('aria-expanded'))).toBe('true')
    await collapse.click()
    await expect.poll(() => rows.count()).toBe(3)
    expect(await page.getByText('Files changed', { exact: true }).count()).toBe(0)

    const geometry = await card.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
