/** Recorded delivery, source deletion, reload, and Session ZIP behavior. */
import { readFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { unzipSync, strFromU8 } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import {
  acknowledgeReloadConnectionLoss, assertFinalWorkspaceSnapshot, captureExpandedTurnProcessAria,
  compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, recordFixture,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const DIR = fileURLToPath(new URL('../../../snapshots/web/present', import.meta.url))
const FIXTURE = join(DIR, 'session.v2.jsonl')
const MODE = webSnapshotMode()
const PROMPT = 'Use one run_code program to do the following in order. Call present for missing.txt and catch its error without creating that file. '
  + 'Use bash to run exactly `printf "DELIVERED_REPORT\\n" > report.txt; printf "DELIVERED_NOTE\\n" > 说明.txt`. '
  + 'Call present for report.txt and 说明.txt. After present succeeds, deliberately throw the string "AFTER_PRESENT" (not an Error object) from that same run_code program. '
  + 'Do not retry the program or create any other files. Finish by mentioning `report.txt` and `说明.txt` in inline code, and put PRESENT_DONE in a separate paragraph.'

describe('web e2e: explicit file delivery', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessionId: SessionId
  let cwd: string
  let disposeApproval: (() => void) | undefined
  const events: SessionEvent[] = []

  beforeAll(async () => {
    await mkdir(DIR, { recursive: true })
    scaffold = await launchWebScaffold({
      agentPresets: { roots: [], default: 'ptc' }, compareReplaySession: true,
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE }),
    })
    disposeApproval = scaffold.ctx.on('approval/request', () => Promise.resolve('allowed-once'), { prepend: true })
    scaffold.ctx.on('session/event', (_session, event) => { events.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    disposeApproval?.()
    await scaffold?.close()
  })

  it('delivers nested snapshots even when the enclosing program subsequently fails', async () => {
    if (MODE !== 'record') expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    sessionId = await settled
    const workspace = scaffold.ctx.agents.get(sessionId)?.session.header.cwd
    if (workspace === undefined) throw new Error('present Session has no workspace')
    cwd = workspace
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
    await page.getByText(/^PRESENT_DONE\.?$/).waitFor({ timeout: 30_000 })
    await assertFinalWorkspaceSnapshot(DIR, cwd)
    expect(events.filter(event => event.type === 'deliverables/presented').flatMap(event => event.data.files.map(file => file.path)))
      .toEqual(['report.txt', '说明.txt'])
    expect(events.some(event => event.type === 'tool/code-dispatch' && event.data.name === 'present' && event.data.isError)).toBe(true)
    expect(events.some(event => event.type === 'tool/result' && event.data.message.content[0].isError)).toBe(true)
  }, 200_000)

  it('downloads after source deletion and reload, while Session ZIP contains only references', async () => {
    await unlink(join(cwd, 'report.txt'))
    await unlink(join(cwd, '说明.txt'))
    for (const reload of [false, true]) {
      if (reload) {
        const warningStart = tripwire.warnings.length
        await page.reload({ waitUntil: 'load' })
        acknowledgeReloadConnectionLoss(tripwire, warningStart)
        await page.getByText(/^PRESENT_DONE\.?$/).waitFor({ timeout: 30_000 })
      }
      const row = page.locator('[data-presented-files-row]')
      await row.waitFor()
      expect(await row.getByRole('link').count()).toBe(2)
      for (const [name, bytes] of [['report.txt', 'DELIVERED_REPORT\n'], ['说明.txt', 'DELIVERED_NOTE\n']]) {
        const pending = page.waitForEvent('download')
        await row.getByRole('link', { name: `Download ${name}`, exact: true }).click()
        const download = await pending
        expect(download.suggestedFilename()).toBe(name)
        expect(await download.failure()).toBeNull()
        expect(await readFile(await download.path(), 'utf8')).toBe(bytes)
      }
    }
    const response = await page.request.get(new URL(`/api/session.export?sessionId=${sessionId}`, scaffold.authenticatedUrl).href)
    expect(response.status()).toBe(200)
    const entries = unzipSync(await response.body())
    expect(Object.keys(entries)).toHaveLength(1)
    expect(strFromU8(Object.values(entries)[0]!)).toContain('deliverables/presented')
    if (MODE !== 'record') {
      const aria = await captureExpandedTurnProcessAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(join(DIR, 'ui.expected.md'), aria, MODE)
      await page.locator('[data-turn-process]').click()
      const failed = page.locator('[data-tool="present"][data-state="error"]')
      const delivered = page.locator('[data-tool="present"][data-state="ok"]')
      expect(await failed.count()).toBe(1)
      expect(await delivered.count()).toBe(1)
      expect(await failed.innerText()).toContain('Delivery failed')
      expect(await delivered.innerText()).toContain('Delivered')
      await page.locator('[data-turn-process]').click()
      await page.setViewportSize({ width: 480, height: 900 })
      const row = page.locator('[data-presented-files-row]')
      await row.scrollIntoViewIfNeeded()
      for (const card of await row.getByRole('link').all()) {
        const bounds = await card.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(480)
      }
    }
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
