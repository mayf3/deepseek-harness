// Web e2e scenario: the plugin manager tab in Plugins settings over a scaffold
// profile runtime — one installed bundle switched on, one plain plugin added to
// an agent preset and switched off there, and the configuration tab writing one
// field under that preset's settings scope. Zero model calls: everything is
// client state plus the profile files and the settings document, so there is
// no fixture and a stray stream would fail loud on the open llm seam.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
const FIXTURE_PLUGINS = fileURLToPath(new URL('./fixtures/plugins', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: plugin manager', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  /** The writable preset root the scenario's preset overlays land in. */
  let presetRoot: string

  beforeAll(async () => {
    presetRoot = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-presets-'))
    scaffold = await launchWebScaffold({
      // The scaffold pins a roster without a user root, so a preset's user
      // patch layer needs one: an empty root beside the shipped presets.
      agentPresets: { roots: [{ path: presetRoot, trust: 'user' }], default: 'standard' },
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
    await rm(presetRoot, { recursive: true, force: true })
  })

  /** Open the settings dialog on the Plugins section and select one of its tabs. */
  async function openPluginsTab(tab: string) {
    if (await page.getByRole('dialog', { name: '设置' }).count() > 0) {
      await page.keyboard.press('Escape')
      await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    }
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '插件', exact: true }).click()
    await dialog.getByRole('tab', { name: tab, exact: true }).click()
    await expect
      .poll(() => dialog.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'), { timeout: 5_000 })
      .toBe('true')
    return dialog
  }

  /** One file under the harness home, or the empty string while it does not exist. */
  async function homeFile(...segments: string[]): Promise<string> {
    return readFile(join(scaffold.harnessHome, ...segments), 'utf8').catch(() => '')
  }

  it('lists the profile packages with their switches and the preset composition', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-list'))
    const dialog = await openPluginsTab('插件管理')

    await dialog.getByText('示例组合包', { exact: true }).waitFor({ timeout: 20_000 })
    expect(await dialog.getByText('示例插件', { exact: true }).count()).toBe(1)
    // The bundle is installed but not enabled; the plain plugin carries no switch.
    const toggle = dialog.getByRole('switch', { name: '启用 示例组合包' })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    expect(await dialog.getByRole('switch', { name: '启用 示例插件' }).count()).toBe(0)
    // The default preset's composition renders beside the packages.
    expect(await dialog.getByRole('button', { name: '选择要管理的 Agent 预设' }).textContent()).toContain('默认')
    expect(await dialog.getByRole('switch', { name: 'Enable row bash' }).count()).toBe(0)

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(MANAGER_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('enables a bundle into the profile manifest and reports the restart it waits for', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-enable'))
    const dialog = await openPluginsTab('插件管理')
    const toggle = dialog.getByRole('switch', { name: '启用 示例组合包' })
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
    await dialog.getByText('以下更改会在下次启动生效：示例组合包').waitFor({ timeout: 10_000 })
    expect(await dialog.getByText('待重启', { exact: true }).count()).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('adds a plain plugin to a preset, switches its row off there, and removes it again', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-preset-row'))
    const dialog = await openPluginsTab('插件管理')
    await dialog.getByRole('button', { name: '展开 示例插件' }).click()
    await dialog.getByRole('button', { name: '添加到…' }).click()
    await page.getByRole('menuitem', { name: '预设：标准模式' }).click()

    const overlay = (): Promise<string> => readFile(join(presetRoot, 'standard', 'cordis.patch.yml'), 'utf8').catch(() => '')
    await expect.poll(async () => (await overlay()).includes('@fixture/plain-plugin'), { timeout: 10_000 }).toBe(true)
    expect(await overlay()).toContain('id: fixture/plain-plugin')
    // The preset composition lists the new row as the user's, switched on.
    const rowToggle = dialog.getByRole('switch', { name: '启用行 fixture/plain-plugin' })
    await rowToggle.waitFor({ timeout: 10_000 })
    expect(await rowToggle.getAttribute('aria-checked')).toBe('true')
    expect(await dialog.locator('[data-preset-row="fixture/plain-plugin"]').getAttribute('data-plugin-source')).toBe('user')

    await rowToggle.click()
    await expect.poll(async () => (await overlay()).includes('disabled: true'), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => rowToggle.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('false')
    expect(await dialog.getByText('用户停用', { exact: true }).count()).toBe(1)

    await dialog.getByRole('button', { name: '移除行 fixture/plain-plugin' }).click()
    await expect.poll(async () => (await overlay()).includes('@fixture/plain-plugin'), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => rowToggle.count(), { timeout: 10_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('writes a configuration field under one preset scope and leaves the shared value alone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-scope'))
    const dialog = await openPluginsTab('插件配置')
    const scope = dialog.getByRole('button', { name: '选择这些设置生效的 Agent 预设' })
    await scope.waitFor({ timeout: 10_000 })
    expect(await scope.textContent()).toBe('所有预设')

    await scope.click()
    await page.getByRole('menuitem', { name: '标准模式（默认）' }).click()
    await expect.poll(() => scope.getAttribute('data-settings-scope'), { timeout: 5_000 }).toBe('preset/standard')
    await dialog.getByText('这里的值只对本预设生效；未覆盖的字段继承"所有预设"的值。').waitFor({ timeout: 5_000 })

    await dialog.getByText('终端', { exact: true }).click()
    const timeout = dialog.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })
    expect(await timeout.inputValue()).toBe('60000')
    await timeout.fill('12000')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()

    const settings = (): Promise<string> => homeFile('settings.yaml')
    await expect.poll(async () => (await settings()).includes('timeoutMs: 12000'), { timeout: 10_000 }).toBe(true)
    const document = await settings()
    expect(document).toContain('scopes:')
    expect(document).toContain('preset/standard:')
    expect(document.indexOf('scopes:')).toBeLessThan(document.indexOf('timeoutMs: 12000'))
    // Back under the shared instance the field still shows the composed default.
    await scope.click()
    await page.getByRole('menuitem', { name: '所有预设' }).click()
    await expect.poll(() => scope.getAttribute('data-settings-scope'), { timeout: 5_000 }).toBe('global')
    const expandTerminal = dialog.getByRole('button', { name: '展开设置: 终端' })
    if (await expandTerminal.count() > 0) await expandTerminal.click()
    await expect.poll(() => dialog.getByLabel('命令超时（毫秒）').inputValue(), { timeout: 5_000 }).toBe('60000')
    expect(await dialog.getByText('已覆盖').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['manager.expected.md'])
  })
})
