/** Browser geometry for settings, expanded plugin dialogs, and their menus under Windows caption markers. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { openSettings, ZH_BROWSER_LOCALE } from './support.ts'

it('keeps settings and expanded plugin dialogs clear of the Windows caption across fullscreen transitions', async () => {
  const scaffold = await launchWebScaffold({
    profile: { packages: [] },
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 600 }, locale: ZH_BROWSER_LOCALE })
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await page.waitForSelector('[class*="frame"]')
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-windows-titlebar', '')
        document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')
      })
      await openSettings(page, 'zh')
      const settings = page.getByRole('dialog', { name: '设置', exact: true })
      for (const fullscreen of [false, true, false]) {
        await page.evaluate(value => document.documentElement.toggleAttribute('data-fullscreen', value), fullscreen)
        const margin = fullscreen ? 24 : 60
        await expect.poll(async () => (await settings.boundingBox())?.y).toBe(margin)
        expect((await settings.boundingBox())?.height).toBe(600 - 2 * margin)
      }
      await settings.getByRole('button', { name: '工作区内修改', exact: true }).click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      const menuRect = await menu.boundingBox()
      expect(menuRect?.y).toBeGreaterThanOrEqual(60)
      expect(menuRect!.y + menuRect!.height).toBeLessThanOrEqual(588)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      expect(await settings.isVisible()).toBe(true)
      await settings.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      await page.locator('[data-plugin-panel]').getByRole('button', { name: '添加插件', exact: true }).click()
      const plugin = page.getByRole('dialog', { name: '添加插件', exact: true })
      await plugin.locator('button[aria-expanded="false"]').first().click()
      await expect.poll(() => plugin.locator('button[aria-expanded="true"]').count()).toBe(1)
      for (const fullscreen of [false, true, false]) {
        await page.evaluate(value => document.documentElement.toggleAttribute('data-fullscreen', value), fullscreen)
        const margin = fullscreen ? 24 : 60
        await expect.poll(async () => (await plugin.boundingBox())?.y).toBe(margin)
        expect((await plugin.boundingBox())?.height).toBe(600 - 2 * margin)
        expect(await plugin.getByRole('button', { name: '关闭', exact: true }).isVisible()).toBe(true)
        expect(await plugin.getByRole('button', { name: '安装', exact: true }).isVisible()).toBe(true)
      }
      await page.keyboard.press('Escape')
      await plugin.waitFor({ state: 'hidden' })
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
    } finally { await browser.close() }
  } finally { await scaffold.close() }
})
