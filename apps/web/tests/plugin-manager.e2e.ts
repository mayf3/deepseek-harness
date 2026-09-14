// Web e2e scenario: the plugin manager page behind the sidebar's Plugins entry over a scaffold
// profile runtime: installed packages and bundle enablement. Zero model calls: everything is
// client state plus the profile files and the settings document, so there is
// no fixture and a stray stream would fail loud on the open llm seam.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { join } from 'node:path'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/plugin-manager', import.meta.url))
const MANAGER_EXPECTED = join(SNAPSHOT_DIR, 'manager.expected.md')
const LIVE_EXPECTED = join(SNAPSHOT_DIR, 'live-enabled.expected.md')
const FIXTURE_PLUGINS = fileURLToPath(new URL('./fixtures/plugins', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: plugin manager', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      profileRuntime: {
        packages: [
          { dir: join(FIXTURE_PLUGINS, 'fixture-bundle') },
          { dir: join(FIXTURE_PLUGINS, 'fixture-plain-plugin') },
        ],
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  /** Close any open settings dialog, so the sidebar and the main column are clickable. */
  async function closeSettings() {
    if (await page.getByRole('dialog', { name: '设置' }).count() > 0) {
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    }
  }

  /** Select the sidebar's Plugins entry and wait for the management page in the main column. */
  async function openPluginsPanel() {
    await closeSettings()
    await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('heading', { name: '插件管理' }).waitFor({ timeout: 10_000 })
    return panel
  }

  /** One file under the harness home, or the empty string while it does not exist. */
  async function homeFile(...segments: string[]): Promise<string> {
    return readFile(join(scaffold.harnessHome, ...segments), 'utf8').catch(() => '')
  }

  it('lists the profile packages with their switches', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-list'))
    const panel = await openPluginsPanel()

    await panel.getByText('示例组合包', { exact: true }).waitFor({ timeout: 20_000 })
    expect(await panel.getByText('示例插件', { exact: true }).count()).toBe(1)
    // Non-bundle packages remain installed and expose their uninstall on the detail page.
    const toggle = panel.getByRole('switch', { name: '启用 示例组合包' })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    expect(await panel.getByRole('switch', { name: '启用 示例插件' }).count()).toBe(0)
    expect(await panel.getByRole('button', { name: '加入全局' }).count()).toBe(0)
    expect(await panel.getByRole('button', { name: '卸载 示例插件' }).count()).toBe(0)
    await panel.getByRole('button', { name: '查看 示例插件' }).click()
    await panel.getByRole('button', { name: '卸载 示例插件' }).waitFor({ timeout: 5_000 })
    await panel.getByText('此包未提供组合包 patch，可通过 Cordis 配置手动加载模块。', { exact: true }).waitFor({ timeout: 5_000 })
    await panel.getByRole('button', { name: '返回插件列表' }).click()
    await expect.poll(() => panel.getByRole('button', { name: '卸载 示例插件' }).count(), { timeout: 5_000 }).toBe(0)

    const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MANAGER_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('enables a bundle into the profile manifest and reports the restart it waits for', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-enable'))
    const panel = await openPluginsPanel()
    const toggle = panel.getByRole('switch', { name: '启用 示例组合包' })
    await toggle.waitFor({ timeout: 20_000 })

    await toggle.click()

    await expect.poll(async () => (await homeFile('profiles', 'scaffold', 'package.json')).includes('"@fixture/bundle"'), {
      timeout: 10_000,
    }).toBe(true)
    const manifest = JSON.parse(await homeFile('profiles', 'scaffold', 'package.json')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@fixture/bundle'])
    // A startup-applied profile: the switch is on, and the banner names the package.
    await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('true')
    await panel.getByText('以下更改会在下次启动生效：示例组合包').waitFor({ timeout: 10_000 })
    expect(await panel.getByText('需重启', { exact: true }).count()).toBe(1)
    // The pack's page lists its rows from its static declarations. A profile that applies
    // patches at its next start keeps them read-only: no row switch.
    await panel.getByRole('button', { name: '查看 示例组合包' }).click()
    await panel.locator('[data-plugin-row]', { hasText: 'fixture-row' }).waitFor({ timeout: 10_000 })
    expect(await panel.getByRole('switch', { name: '启用组件 fixture-row' }).count()).toBe(0)
    await panel.getByRole('button', { name: '返回插件列表' }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['manager.expected.md', 'live-enabled.expected.md'])
  })
})


describe('web e2e: live plugin management', () => {
  it('applies bundle enable and disable through the Remote without a restart', async () => {
    const scaffold = await launchWebScaffold({
      profileRuntime: { patchReload: 'live', packages: [{ dir: join(FIXTURE_PLUGINS, 'fixture-bundle') }] },
    })
    let browser: Browser | undefined
    try {
      browser = await chromium.launch()
      const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
      const tripwire = watchConsole(page)
      onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-live'))
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
      const panel = page.locator('[data-plugin-panel]')
      const toggle = panel.getByRole('switch', { name: '启用 示例组合包' })
      await toggle.waitFor({ timeout: 20_000 })
      const mounted = () => [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'fixture-row')
      const bundles = async () => {
        const text = await readFile(join(scaffold.harnessHome, 'profiles', 'scaffold', 'package.json'), 'utf8')
        return (JSON.parse(text) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
      }
      expect(mounted()).toBeUndefined()
      await toggle.click()
      await expect.poll(() => mounted()?.fiber?.state, { timeout: 10_000 }).toBe(2)
      await expect.poll(bundles).toEqual(['@fixture/bundle'])
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      expect(await panel.getByText('需重启', { exact: true }).count()).toBe(0)
      expect(await panel.getByText(/以下更改会在下次启动生效/).count()).toBe(0)
      const snapshot = await captureStableAria(page, '[data-plugin-panel]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(LIVE_EXPECTED, snapshot, MODE)

      await toggle.click()
      await expect.poll(mounted, { timeout: 10_000 }).toBeUndefined()
      await expect.poll(bundles).toEqual([])
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      expect(await panel.getByText('需重启', { exact: true }).count()).toBe(0)
      expect(await panel.getByText(/以下更改会在下次启动生效/).count()).toBe(0)
      expect(tripwire.pageErrors).toEqual([])
    } finally {
      await browser?.close()
      await scaffold.close()
    }
  }, 60_000)
})
