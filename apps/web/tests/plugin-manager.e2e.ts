// Web e2e scenario: the plugin manager page behind the sidebar's Plugins entry over a scaffold
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
const DETAIL_EXPECTED = join(SNAPSHOT_DIR, 'preset-detail.expected.md')
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

  /** Open the settings dialog on the Plugins section: the configuration page. */
  async function openPluginsSettings() {
    await closeSettings()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '插件', exact: true }).click()
    await dialog.getByRole('heading', { name: '插件', exact: true }).waitFor({ timeout: 10_000 })
    return dialog
  }

  /** Open the settings dialog on one preset's detail page. */
  async function openPresetDetail(name: string) {
    await closeSettings()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Agent 预设', exact: true }).click()
    await dialog.getByRole('button', { name: `配置: ${name}` }).click()
    await dialog.getByRole('heading', { name }).waitFor({ timeout: 10_000 })
    return dialog
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
    // The bundle is installed but not enabled; the plain plugin carries no
    // switch, only its **Add to…** menu; uninstall waits on the plugin's page,
    // which names the module and where it is composed, and the crumb leads back.
    const toggle = panel.getByRole('switch', { name: '启用 示例组合包' })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    expect(await panel.getByRole('switch', { name: '启用 示例插件' }).count()).toBe(0)
    expect(await panel.getByRole('button', { name: '加入到…' }).count()).toBe(1)
    expect(await panel.getByRole('button', { name: '卸载 示例插件' }).count()).toBe(0)
    await panel.getByRole('button', { name: '查看 示例插件' }).click()
    await panel.getByRole('button', { name: '卸载 示例插件' }).waitFor({ timeout: 5_000 })
    await panel.getByText('尚未加入', { exact: true }).waitFor({ timeout: 5_000 })
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

  it('adds a plain plugin to a preset, then switches it off and deletes it on the preset\'s detail page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-preset-row'))
    const panel = await openPluginsPanel()
    await panel.getByRole('button', { name: '加入到…' }).click()
    await page.getByRole('menuitem', { name: '预设：标准模式' }).click()

    const overlay = (): Promise<string> => readFile(join(presetRoot, 'standard', 'cordis.patch.yml'), 'utf8').catch(() => '')
    await expect.poll(async () => (await overlay()).includes('@fixture/plain-plugin'), { timeout: 10_000 }).toBe(true)
    expect(await overlay()).toContain('id: fixture/plain-plugin')
    // The **Add to…** menu now marks that preset as joined; the menu closes
    // through its anchor.
    await panel.getByRole('button', { name: '加入到…' }).click()
    await page.getByRole('menuitem', { name: '预设：标准模式（已加入）' }).waitFor({ timeout: 5_000 })
    await panel.getByRole('button', { name: '加入到…' }).click()
    await expect.poll(() => page.getByRole('menuitem').count(), { timeout: 5_000 }).toBe(0)

    // The preset's detail page, behind the gear on its card, lists the new
    // row under the package's title as the user's, switched on, with the
    // local mark.
    const dialog = await openPresetDetail('标准模式')
    const presetRow = dialog.locator('[data-preset-row="fixture/plain-plugin"]')
    const rowToggle = presetRow.getByRole('switch', { name: '启用 示例插件' })
    await rowToggle.waitFor({ timeout: 10_000 })
    expect(await rowToggle.getAttribute('aria-checked')).toBe('true')
    expect(await presetRow.getAttribute('data-plugin-source')).toBe('user')
    expect(await presetRow.getByText('本地', { exact: true }).count()).toBe(1)
    const settingsSection = dialog.locator('[data-settings-scope="preset/standard"]')
    await expect.poll(() => settingsSection.getByRole('button', { name: /^展开设置:/ }).count(), { timeout: 10_000 }).toBe(4)
    const detailSnapshot = await captureStableAria(page, '[data-preset-detail="standard"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DETAIL_EXPECTED, detailSnapshot, MODE)

    await rowToggle.click()
    await expect.poll(async () => (await overlay()).includes('disabled: true'), { timeout: 10_000 }).toBe(true)
    await expect.poll(() => rowToggle.getAttribute('aria-checked'), { timeout: 10_000 }).toBe('false')

    await presetRow.getByRole('button', { name: '从这个预设删除 示例插件' }).click()
    await expect.poll(async () => (await overlay()).includes('@fixture/plain-plugin'), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => rowToggle.count(), { timeout: 10_000 }).toBe(0)
    // The breadcrumb leads back to the roster.
    await dialog.getByRole('button', { name: '返回 Agent 预设' }).click()
    await dialog.getByRole('button', { name: '配置: 标准模式' }).waitFor({ timeout: 10_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('writes a configuration field under one preset scope and leaves the shared value alone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-plugin-manager-scope'))
    const dialog = await openPresetDetail('标准模式')
    // The detail page's settings section edits the preset's own scope.
    const settingsSection = dialog.locator('[data-settings-scope="preset/standard"]')
    await settingsSection.getByRole('button', { name: '展开设置: 终端' }).click()
    const timeout = settingsSection.getByLabel('命令超时（毫秒）')
    await timeout.waitFor({ timeout: 10_000 })
    expect(await timeout.inputValue()).toBe('60000')
    await timeout.fill('12000')
    await settingsSection.getByRole('button', { name: '保存', exact: true }).click()

    const settings = (): Promise<string> => homeFile('settings.yaml')
    await expect.poll(async () => (await settings()).includes('timeoutMs: 12000'), { timeout: 10_000 }).toBe(true)
    const document = await settings()
    expect(document).toContain('scopes:')
    expect(document).toContain('preset/standard:')
    expect(document.indexOf('scopes:')).toBeLessThan(document.indexOf('timeoutMs: 12000'))
    // On the configuration tab the shared instance still shows the composed default.
    const plugins = await openPluginsSettings()
    await plugins.getByRole('button', { name: '展开设置: 终端' }).click()
    await expect.poll(() => plugins.getByLabel('命令超时（毫秒）').inputValue(), { timeout: 5_000 }).toBe('60000')
    expect(await plugins.getByText('已覆盖').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['manager.expected.md', 'preset-detail.expected.md'])
  })
})
