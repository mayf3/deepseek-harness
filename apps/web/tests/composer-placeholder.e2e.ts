// The built shared Web/Electron composer hides guidance as soon as a draft contains whitespace.
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

it('hides the placeholder for typed and pasted spaces and restores it after deletion', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspace(page, scaffold.workspaceCwd, 'composer-placeholder')
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      const placeholder = page.locator('[data-composer-placeholder]').first()
      const observations: string[] = []
      const observe = async (label: string, visible: boolean) => {
        await expect.poll(() => placeholder.isVisible()).toBe(visible)
        observations.push(`- ${label}: placeholder ${visible ? 'visible' : 'hidden'}`)
      }
      const clear = async () => {
        await input.click()
        await page.keyboard.press('ControlOrMeta+KeyA')
        await page.keyboard.press('Backspace')
      }
      await observe('Empty draft', true)
      await input.click()
      await page.keyboard.press('Space')
      await observe('Single space', false)
      await page.keyboard.press('Space')
      await page.keyboard.press('Space')
      await observe('Consecutive spaces', false)
      await page.keyboard.press('Tab')
      await input.click()
      await observe('Focus restored', false)
      await page.keyboard.press('Enter')
      expect(await input.textContent()).toBe('   ')
      await observe('Whitespace submission rejected', false)
      await clear()
      await observe('All content deleted', true)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.evaluate(() => navigator.clipboard.writeText('   '))
      await page.keyboard.press('ControlOrMeta+KeyV')
      await expect.poll(() => input.textContent()).toBe('   ')
      await observe('Pasted spaces', false)
      await clear()
      await observe('Pasted content deleted', true)
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/composer-placeholder/visibility.expected.md', import.meta.url)),
        observations.join('\n'), webSnapshotMode(),
      )
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
