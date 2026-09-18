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
      await page.mouse.move(0, 0)
      const outerColor = await outer.evaluate(element => getComputedStyle(element).color)
      expect(await outer.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      await outer.hover()
      await expect.poll(() => outer.evaluate(
        (element, initialColor) => getComputedStyle(element).color === initialColor,
        outerColor,
      )).toBe(false)
      expect(await outer.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/step-process/turn-collapsed.md', import.meta.url)),
        await outer.ariaSnapshot(), webSnapshotMode())
      await outer.click()
      const group = page.locator('[data-step-process][data-chat-turn="88"]').first()
      const toggle = group.getByRole('button', { name: 'Ran commands', exact: true })
      await toggle.waitFor()
      expect(await toggle.getAttribute('aria-expanded')).toBe('false')
      const activityIcon = toggle.locator('[data-step-process-icon]')
      const chevron = toggle.locator('[data-step-process-chevron]')
      await page.mouse.move(0, 0)
      const toggleColor = await toggle.evaluate(element => getComputedStyle(element).color)
      expect(await toggle.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      expect(await activityIcon.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      expect(await chevron.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
      await toggle.hover()
      await expect.poll(() => toggle.evaluate(
        (element, initialColor) => getComputedStyle(element).color === initialColor,
        toggleColor,
      )).toBe(false)
      expect(await toggle.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      await expect.poll(() => activityIcon.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
      await expect.poll(() => chevron.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      expect(await toggle.evaluate(element => getComputedStyle(element).paddingBottom)).toBe('0px')
      expect(await group.locator('[data-step-process-body]').getAttribute('hidden')).toBe('until-found')
      const nextMessage = group.locator('xpath=following-sibling::*[1]')
      expect(await nextMessage.getAttribute('data-chat-flow-kind')).toBe('assistant-step')
      expect(await group.evaluate((element) => {
        const next = element.nextElementSibling
        return next === null ? null : next.getBoundingClientRect().top - element.getBoundingClientRect().bottom
      })).toBe(16)
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/step-process/collapsed.md', import.meta.url)),
        await group.ariaSnapshot(), webSnapshotMode())
      await toggle.click()
      const body = group.locator('[data-step-process-body]')
      expect(await body.getAttribute('hidden')).toBeNull()
      await expect.poll(() => activityIcon.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
      await expect.poll(() => chevron.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      expect(await toggle.getAttribute('aria-expanded')).toBe('true')
      expect(await toggle.evaluate(element => getComputedStyle(element).paddingBottom)).toBe('16px')
      const leafSpacing = await body.evaluate((element) => {
        const rows = [...element.children].filter(row => !row.hasAttribute('hidden'))
        return rows.slice(1).map((row, index) => ({
          gap: row.getBoundingClientRect().top - rows[index]!.getBoundingClientRect().bottom,
          shrink: getComputedStyle(row).flexShrink,
        }))
      })
      expect(leafSpacing).toEqual([{ gap: 8, shrink: '0' }, { gap: 8, shrink: '0' }])
      // Expand the individual tool cards so their output exceeds the process viewport.
      for (const row of await body.locator('[data-sample="bash"]').all()) await row.click()
      await body.evaluate((element) => {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
      })
      await expect.poll(() => body.getAttribute('data-scroll-up')).toBeNull()
      await expect.poll(() => body.getAttribute('data-scroll-down')).toBe('true')
      const geometry = await body.evaluate((element) => {
        const style = getComputedStyle(element)
        element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
        element.dispatchEvent(new Event('scroll'))
        return { height: element.clientHeight, max: style.maxHeight, overflow: style.overflowY,
          scrollable: element.scrollHeight > element.clientHeight, top: element.scrollTop }
      })
      expect(geometry.height).toBeLessThanOrEqual(400)
      expect(geometry.overflow).toBe('auto')
      expect(geometry.scrollable).toBe(true)
      expect(geometry.top).toBeGreaterThan(0)
      await expect.poll(() => body.getAttribute('data-scroll-up')).toBe('true')
      await expect.poll(() => body.getAttribute('data-scroll-down')).toBe('true')
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event('scroll'))
      })
      await expect.poll(() => body.getAttribute('data-scroll-down')).toBeNull()
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

it('chains wheel scrolling from a secondary process range to the conversation', async () => {
  const fixture = createChatScrollFixture({
    markerPrefix: 'STEP_PROCESS_SCROLL', title: 'Step process scrolling', turns: 96,
  })
  const scaffold = await launchWebScaffold({})
  try {
    await seedSession(scaffold, fixture.log, 'step-process-scroll-e2e')
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
      await outer.click()
      const group = page.locator('[data-step-process][data-chat-turn="88"]').first()
      const toggle = group.getByRole('button', { name: 'Ran commands', exact: true })
      await toggle.click()
      const body = group.locator('[data-step-process-body]')
      const host = page.locator('[data-conversation-scroll]')
      const wheelBody = async (deltaY: number): Promise<void> => {
        const box = await body.boundingBox()
        if (box === null) throw new Error('step process body has no layout box')
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, deltaY)
      }

      const shortGeometry = await body.evaluate((element) => {
        const scrollHost = element.closest<HTMLElement>('[data-conversation-scroll]')
        if (scrollHost === null) throw new Error('step process body has no conversation scrollport')
        return {
          hostMax: scrollHost.scrollHeight - scrollHost.clientHeight,
          hostTop: scrollHost.scrollTop,
          scrollable: element.scrollHeight > element.clientHeight,
        }
      })
      expect(shortGeometry.scrollable).toBe(false)
      expect(shortGeometry.hostTop).toBeGreaterThan(120)
      expect(shortGeometry.hostMax - shortGeometry.hostTop).toBeGreaterThan(120)
      await wheelBody(-120)
      await expect.poll(() => host.evaluate(element => element.scrollTop)).toBeLessThan(shortGeometry.hostTop)
      const shortHostAfterUp = await host.evaluate(element => element.scrollTop)
      await wheelBody(120)
      await expect.poll(() => host.evaluate(element => element.scrollTop)).toBeGreaterThan(shortHostAfterUp)

      for (const row of await body.locator('[data-sample="bash"]').all()) await row.click()
      await body.hover()
      const middle = await body.evaluate((element) => {
        const scrollHost = element.closest<HTMLElement>('[data-conversation-scroll]')
        if (scrollHost === null) throw new Error('step process body has no conversation scrollport')
        element.scrollTop = (element.scrollHeight - element.clientHeight) / 2
        element.dispatchEvent(new Event('scroll'))
        return {
          bodyTop: element.scrollTop,
          hostTop: scrollHost.scrollTop,
          scrollable: element.scrollHeight > element.clientHeight,
        }
      })
      expect(middle.scrollable).toBe(true)
      await wheelBody(80)
      await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(middle.bodyTop)
      expect(await host.evaluate(element => element.scrollTop)).toBe(middle.hostTop)

      await body.evaluate((element) => {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
      })
      await body.hover()
      const hostBeforeTopChain = await host.evaluate(element => element.scrollTop)
      await wheelBody(-120)
      await expect.poll(() => host.evaluate(element => element.scrollTop)).toBeLessThan(hostBeforeTopChain)
      expect(await body.evaluate(element => element.scrollTop)).toBe(0)

      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        element.dispatchEvent(new Event('scroll'))
      })
      await body.hover()
      const bottomEdge = await body.evaluate((element) => {
        const scrollHost = element.closest<HTMLElement>('[data-conversation-scroll]')
        if (scrollHost === null) throw new Error('step process body has no conversation scrollport')
        return {
          hostTop: scrollHost.scrollTop,
          maxBodyTop: element.scrollHeight - element.clientHeight,
        }
      })
      await wheelBody(120)
      await expect.poll(() => host.evaluate(element => element.scrollTop)).toBeGreaterThan(bottomEdge.hostTop)
      expect(await body.evaluate(element => element.scrollTop)).toBe(bottomEdge.maxBodyTop)
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
      expect(await outer.isEnabled()).toBe(false)
      expect(await outer.getAttribute('aria-expanded')).toBeNull()
      expect(await outer.locator('svg').count()).toBe(0)
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/step-process/empty-turn.md', import.meta.url)),
        await outer.ariaSnapshot(), webSnapshotMode())
      expect(await button.getAttribute('aria-expanded')).toBe('true')
      expect(await notice.isVisible()).toBe(true)
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})


it('places hover-only actions below trailing reasoning in a stopped turn', async () => {
  const fixture = createChatScrollFixture({ markerPrefix: 'STOPPED_FOOTER', title: 'Stopped turn footer', turns: 1,
    stopAfterReasoning: true })
  const scaffold = await launchWebScaffold({})
  try {
    await seedSession(scaffold, fixture.log, 'stopped-footer-e2e')
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
      const tail = page.locator('[data-turn-tail="1"]')
      await tail.waitFor()
      expect(await tail.getAttribute('data-actions-reveal')).toBe('hover')
      const lastGroup = page.locator('[data-step-process]').last()
      await lastGroup.getByRole('button', { name: 'Analysis completed', exact: true }).click()
      const think = lastGroup.getByRole('button', { name: 'Think', exact: true })
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/step-process/think-collapsed.md', import.meta.url)),
        await think.ariaSnapshot(), webSnapshotMode())
      expect(await lastGroup.getByText('Inspect the remaining work before continuing.', { exact: true }).isVisible()).toBe(false)
      await think.click()
      expect(await lastGroup.getByText('Inspect the remaining work before continuing.', { exact: true }).isVisible()).toBe(true)
      await think.click()
      const groupBox = await lastGroup.boundingBox()
      const tailBox = await tail.boundingBox()
      expect(tailBox!.y).toBeGreaterThanOrEqual(groupBox!.y + groupBox!.height)
      const copy = tail.getByRole('button', { name: 'Copy', exact: true })
      const actions = copy.locator('..')
      await page.mouse.move(0, 0)
      await expect.poll(() => actions.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
      await tail.hover()
      await expect.poll(() => actions.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      await compareOrRefreshGolden(fileURLToPath(new URL('./expected/step-process/stopped-footer.md', import.meta.url)),
        (await tail.ariaSnapshot()).replace(/\d\d:\d\d/g, 'HH:mm'), webSnapshotMode())
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
