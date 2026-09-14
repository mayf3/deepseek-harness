/** Real profile, Remote, bundle scripts and Cordis slots: page-local client lifecycle without navigation. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-live-client', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/client-plugin-live', import.meta.url))

async function openInventory(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'load' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('button', { name: '插件', exact: true }).click()
  await dialog.getByRole('tab', { name: '插件列表', exact: true }).click()
  await dialog.getByRole('searchbox', { name: '搜索插件' }).waitFor()
  return dialog
}

it('synchronizes two pages, disposes effects and restores an offline page from the latest graph without navigation', async () => {
  const scaffold = await launchWebScaffold({
    extraInstallAnchors: [join(FIXTURE, 'package.json')],
  })
  const host = scaffold.ctx.loader.ctx.fiber.uid
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const otherContext = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const page = await context.newPage()
    const other = await otherContext.newPage()
    const consoles = [watchConsole(page), watchConsole(other)]
    onTestFailed(() => saveFailureShot(page, 'web-e2e-client-live'))
    await openInventory(page, scaffold.authenticatedUrl)
    const otherInventory = await openInventory(other, scaffold.authenticatedUrl)
    let entryId: string | undefined
    const toggle = async () => {
      if (entryId === undefined) entryId = await scaffold.ctx.loader.create({ name: '@fixture/live-client' })
      else { scaffold.ctx.loader.remove(entryId); entryId = undefined }
    }
    let navigations = 0
    for (const target of [page, other]) target.on('framenavigated', () => { navigations++ })
    const live = (target: Page) => target.locator('[data-live-client]')
    const dataset = (target: Page) => target.evaluate(() => ({
      liveMounts: document.documentElement.dataset.liveMounts,
      liveDisposals: document.documentElement.dataset.liveDisposals,
      liveHits: document.documentElement.dataset.liveHits,
    }))
    const ping = (target: Page) => target.evaluate(() => { window.dispatchEvent(new Event('dsh-fixture-ping')) })
    expect(await live(page).count()).toBe(0)
    expect(scaffold.ctx.clientModules.graph().entries.some(row => row.id === '@fixture/live-client')).toBe(false)

    await toggle()
    for (const target of [page, other]) {
      await live(target).waitFor()
      expect(await live(target).evaluate(el => getComputedStyle(el).color)).toBe('rgb(12, 34, 56)')
      await ping(target)
      expect((await dataset(target)).liveHits).toBe('1')
    }
    await compareOrRefreshGolden(join(EXPECTED, 'enabled.expected.md'), await captureStableAria(page, '[data-live-client]', scaffold.workspaceCwd), webSnapshotMode())

    // The inventory filter is page-owned state that live composition must preserve.
    const draft = otherInventory.getByRole('searchbox', { name: '搜索插件' })
    await draft.fill('unfinished-filter')
    await toggle()
    for (const target of [page, other]) {
      await expect.poll(() => live(target).count()).toBe(0)
      await expect.poll(async () => (await dataset(target)).liveDisposals).toBe('1')
      await ping(target)
      expect((await dataset(target)).liveHits).toBe('1')
      expect(await target.locator('style[data-plugin="@fixture/live-client"]').count()).toBe(0)
    }
    expect(await draft.inputValue()).toBe('unfinished-filter')
    await toggle()
    for (const target of [page, other]) {
      await live(target).waitFor()
      expect(await live(target).count()).toBe(1)
      expect((await dataset(target)).liveMounts).toBe('2')
      expect(await target.locator('style[data-plugin="@fixture/live-client"]').count()).toBe(1)
    }

    const disconnected = other.waitForEvent('requestfailed', request => request.url().includes('/plugins/events'))
    await otherContext.setOffline(true)
    // Chromium offline emulation leaves established SSE sockets open. Cycling this
    // fixture's transport plugin closes them without replacing the Host or profile.
    const transport = [...scaffold.ctx.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-hmr')!.fiber!
    const reconnected = page.waitForResponse(response => response.url().includes('/plugins/events') && response.status() === 200)
    await transport.restart()
    await disconnected
    await reconnected
    await toggle()
    await expect.poll(() => live(page).count()).toBe(0)
    expect(await live(other).count()).toBe(1)
    await otherContext.setOffline(false)
    await expect.poll(() => live(other).count(), { timeout: 20_000 }).toBe(0)
    expect(await draft.inputValue()).toBe('unfinished-filter')
    expect(navigations).toBe(0)
    expect(scaffold.ctx.loader.ctx.fiber.uid).toBe(host)
    for (const console of consoles) expect(console.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 90_000)

it('keeps a failed client download local and retries without changing Host enablement', async () => {
  const scaffold = await launchWebScaffold({ extraInstallAnchors: [join(FIXTURE, 'package.json')] })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: ZH_BROWSER_LOCALE })
    onTestFailed(() => saveFailureShot(page, 'web-e2e-client-live-retry'))
    await openInventory(page, scaffold.authenticatedUrl)
    const bundle = (url: URL) => url.pathname.startsWith('/plugins/') && url.search.includes('@fixture/live-client/client.js')
    await page.route(bundle, route => route.abort())
    const entryId = await scaffold.ctx.loader.create({ name: '@fixture/live-client' })
    const failure = page.locator('[data-client-sync-failure]')
    await failure.waitFor()
    expect(scaffold.ctx.loader.resolve(entryId).fiber?.state).toBe(2)
    expect(await page.locator('[data-live-client]').count()).toBe(0)
    expect(scaffold.ctx.clientModules.graph().entries.some(row => row.id === '@fixture/live-client')).toBe(true)
    await page.unroute(bundle)
    await failure.getByRole('button', { name: '重试本页面同步' }).click()
    await page.locator('[data-live-client]').waitFor()
    await expect.poll(() => failure.count()).toBe(0)
    expect(scaffold.ctx.loader.resolve(entryId).fiber?.state).toBe(2)
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 90_000)
