/** Real-composition coverage of nested process disclosure geometry and accessible summaries. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it('keeps completed step work collapsed inside an expanded turn and bounds its scroll area', async () => {
  const fixture = createChatScrollFixture({ markerPrefix: 'STEP_PROCESS', title: 'Step process disclosure', turns: 88 })
  const scaffold = await launchWebScaffold({})
  try {
    const log = fixture.log.trimEnd().split('\n').map((line, index) => {
      if (index === 0) return line
      const event = JSON.parse(line) as Record<string, unknown>
      return JSON.stringify({ ...event, time: 1_800_000_000_000 })
    }).join('\n') + '\n'
    await seedSession(scaffold, log, 'step-process-e2e')
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser, 900)
      await page.goto(scaffold.authenticatedUrl)
      await page.getByText('Ungrouped', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Search sessions' }).click()
      await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(fixture.markers.user(1))
      const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
      await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
      await results.click()
      const outer = page.locator('[data-turn-process="88"]')
      await outer.waitFor()
      expect(await page.getByRole('button', { name: 'Load earlier', exact: true }).count()).toBe(1)
      expect(await outer.textContent()).toMatch(/^Took /)
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/step-process/turn-collapsed.md', import.meta.url)),
        await outer.ariaSnapshot(), webSnapshotMode())
      await outer.click()
      const group = page.locator('[data-step-process][data-chat-turn="88"]').first()
      const toggle = group.getByRole('button', { name: 'Ran commands', exact: true })
      await toggle.waitFor()
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
      expect(await group.locator('[data-step-process-body]').getAttribute('hidden')).toBe('until-found')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/step-process/collapsed.md', import.meta.url)),
        await group.ariaSnapshot(), webSnapshotMode())
      await toggle.click()
      const body = group.locator('[data-step-process-body]')
      expect(await body.getAttribute('hidden')).toBeNull()
      const leafSpacing = await body.evaluate((element) => {
        const rows = [...element.children].filter(row => !row.hasAttribute('hidden'))
        return rows.slice(1).map((row, index) => ({
          gap: row.getBoundingClientRect().top - rows[index]!.getBoundingClientRect().bottom,
          shrink: getComputedStyle(row).flexShrink,
        }))
      })
      expect(leafSpacing).toEqual([{ gap: 16, shrink: '0' }, { gap: 16, shrink: '0' }])
      // Expand the individual tool cards so their output exceeds the process viewport.
      for (const row of await body.locator('[data-sample="bash"]').all()) await row.click()
      await page.screenshot({ path: '/tmp/dsh-step-process-expanded.png' })
      const geometry = await body.evaluate((element) => {
        const style = getComputedStyle(element)
        element.scrollTop = 100
        return { height: element.clientHeight, max: style.maxHeight, overflow: style.overflowY,
          scrollable: element.scrollHeight > element.clientHeight, top: element.scrollTop }
      })
      expect(geometry.height).toBeLessThanOrEqual(400)
      expect(geometry.overflow).toBe('auto')
      expect(geometry.scrollable).toBe(true)
      expect(geometry.top).toBeGreaterThan(0)
      await page.screenshot({ path: '/tmp/dsh-step-process-expanded.png' })
      await outer.click()
      await outer.click()
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
      await toggle.click()
      const resetGeometry = await body.evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight }))
      expect(resetGeometry.scroll).toBeLessThanOrEqual(resetGeometry.height)
      await toggle.click()
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})

it('keeps a waking notice above and independent of the turn disclosure', async () => {
  const fixture = createChatScrollFixture({ markerPrefix: 'TURN_TRIGGER', title: 'Background task notice', turns: 1,
    wakingInput: { source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'PR merge check completed' },
      content: 'background job bash-39 (bash: PR merge check) finished [status: completed, exit code 0]. Read its output with job_output.' } })
  const scaffold = await launchWebScaffold({})
  try {
    const log = fixture.log.trimEnd().split('\n').map((line, index) => index === 0 ? line
      : JSON.stringify({ ...JSON.parse(line) as Record<string, unknown>, time: 1_800_000_000_000 })).join('\n') + '\n'
    await seedSession(scaffold, log, 'turn-trigger-e2e')
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser, 900)
      await page.goto(scaffold.authenticatedUrl)
      await page.getByText('Ungrouped', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Search sessions' }).click()
      await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill('PR merge check')
      const results = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
      await expect.poll(() => results.count(), { timeout: 60_000 }).toBe(1)
      await results.click()
      const notice = page.locator('[data-turn-trigger]')
      const button = notice.getByRole('button')
      const outer = page.locator('[data-turn-process="1"]')
      await notice.waitFor()
      expect(await button.getAttribute('aria-expanded')).toBe('false')
      expect(await button.textContent()).toContain('Background task completed')
      const noticeBox = await notice.boundingBox()
      const outerBox = await outer.boundingBox()
      expect(noticeBox!.y + noticeBox!.height).toBeLessThan(outerBox!.y)
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/step-process/trigger-collapsed.md', import.meta.url)),
        (await notice.ariaSnapshot()).replace(/\d\d:\d\d/g, 'HH:mm'), webSnapshotMode())
      await button.click()
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/step-process/trigger-expanded.md', import.meta.url)),
        (await notice.ariaSnapshot()).replace(/\d\d:\d\d/g, 'HH:mm'), webSnapshotMode())
      await outer.click()
      await outer.click()
      expect(await button.getAttribute('aria-expanded')).toBe('true')
      expect(await notice.isVisible()).toBe(true)
      await page.screenshot({ path: '/tmp/dsh-turn-trigger-expanded.png' })
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
