// Web e2e scenario: the agent-preset settings section as copy-only authoring.
// The browser never edits composition text — a shipped preset opens in a
// read-only viewer, the copy dialog collects an id and an optional display
// name, and the host copies the whole directory. The section's other job is
// getting the user TO the files: this lane pins `nativeOpen: false` (see the
// overlay), so the location affordance answers the preset directory as text —
// the deterministic branch a golden can hold on every platform.
//
// Zero model calls: no replay fixture mounts, so a stray stream fails loud.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Locator } from 'playwright'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/agent-preset-authoring', import.meta.url))
const SECTION_EXPECTED = join(SNAPSHOT_DIR, 'section.expected.md')
const COPY_DIALOG_EXPECTED = join(SNAPSHOT_DIR, 'copy-dialog.expected.md')
const CREATED_EXPECTED = join(SNAPSHOT_DIR, 'created.expected.md')
const DAMAGED_EXPECTED = join(SNAPSHOT_DIR, 'damaged.expected.md')
/** The shipped roster, bundled inside the `dsh-agent-presets` package. */
const SHIPPED_PRESETS = fileURLToPath(new URL('../../../packages/preset/agent-presets/presets', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./agent-preset-authoring.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: agent-preset authoring is a host-side copy', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let userRoot: string

  /** The settings dialog, opened on the Agent-presets section. */
  function settingsDialog(): Locator {
    return page.getByRole('dialog', { name: '设置' })
  }

  beforeAll(async () => {
    userRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-web-e2e-presets-')))
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      profile: { packages: [] },
      agentPresets: {
        // The shipped root is the plugin's own, prepended before this.
        roots: [{ path: userRoot, trust: 'user' }],
        default: 'standard',
      },
    })
    browser = await chromium.launch()
    // The scenario asserts the shipped Chinese copy, so the browser asks for it.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(userRoot, { recursive: true, force: true })
  })

  it('offers the roster with copy as the only way to create', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-section'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = settingsDialog()
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Agent 预设' }).click()
    await dialog.getByRole('heading', { name: 'Agent 预设' }).waitFor({ timeout: 10_000 })
    // The intro copy also names 标准模式. Wait for the roster's own action so
    // the snapshot cannot land between the section shell and its cards.
    await dialog.getByRole('button', { name: '查看配置: 标准模式', exact: true }).waitFor({ timeout: 10_000 })

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)

    await compareOrRefreshGolden(SECTION_EXPECTED, snapshot, MODE)
    const toggle = dialog.getByRole('switch', { name: '新任务可选择模式' })
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    // The authoring entry is visible, and the shipped rows offer
    // view/copy but never delete or a location — their
    // install is overwritten by upgrades and is not the user's to manage.
    expect(snapshot).toContain('让 Agent 帮我创建预设模式')
    expect(snapshot).not.toContain('新建预设')
    expect(snapshot).toContain('查看配置: 标准模式')
    expect(snapshot).not.toContain('删除: 标准模式')
    expect(snapshot).not.toContain('打开目录')
    // The rest of this scenario exercises the existing default and Creator
    // actions with the beta picker enabled by default.
  }, 60_000)

  it('reads technical details and examples without changing the new-task default', async () => {
    const settings = settingsDialog()
    const trigger = settings.getByRole('button', { name: '模式说明: PTC 模式', exact: true })
    await trigger.click()
    const guide = page.getByRole('dialog', { name: 'PTC 模式', exact: true })
    await guide.getByRole('heading', { name: '怎样调用工具', exact: true }).waitFor()
    const beforeSwitch = await guide.boundingBox()
    expect(await guide.textContent()).toContain('run_code')
    await guide.getByRole('tab', { name: '如何使用', exact: true }).click()
    await guide.getByRole('heading', { name: '批量检查配置文件', exact: true }).waitFor()
    expect(await guide.boundingBox()).toEqual(beforeSwitch)
    await guide.getByRole('tab', { name: '如何使用', exact: true }).press('ArrowLeft')
    expect(await guide.getByRole('tab', { name: '模式说明', exact: true }).getAttribute('aria-selected')).toBe('true')
    await guide.getByRole('tab', { name: '模式说明', exact: true }).press('Escape')
    await guide.waitFor({ state: 'detached' })
    expect(await trigger.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await settings.isVisible()).toBe(true)
    expect(await settings.getByRole('button', { name: '新任务默认: 标准模式', exact: true }).getAttribute('aria-pressed')).toBe('true')

    await settings.getByRole('button', { name: '如何使用: 创造模式', exact: true }).click()
    const creator = page.getByRole('dialog', { name: '创造模式', exact: true })
    await creator.getByRole('heading', { name: '添加一个界面', exact: true }).waitFor()
    expect(await creator.getByRole('heading', { name: '添加一个工具', exact: true }).isVisible()).toBe(true)
    const closePosition = await creator.getByRole('button', { name: '关闭', exact: true }).boundingBox()
    const examples = creator.getByRole('tabpanel', { name: '如何使用', exact: true })
    const scrolledTo = await examples.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      return element.scrollTop
    })
    expect(scrolledTo).toBeGreaterThan(0)
    expect(await creator.getByRole('button', { name: '关闭', exact: true }).boundingBox()).toEqual(closePosition)
    await creator.getByRole('tab', { name: '模式说明', exact: true }).click()
    await creator.getByRole('tab', { name: '如何使用', exact: true }).click()
    expect(await examples.evaluate(element => element.scrollTop)).toBe(scrolledTo)
    await creator.getByRole('button', { name: '关闭', exact: true }).click()
    await creator.waitFor({ state: 'detached' })
  }, 60_000)

  it('views a shipped composition read-only instead of editing it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-view'))
    const dialog = settingsDialog()
    await dialog.getByRole('button', { name: '查看配置: 标准模式' }).click()
    const viewer = page.getByRole('dialog', { name: '查看配置 · 标准模式' })
    await viewer.waitFor({ timeout: 10_000 })

    // The real shipped composition, not a golden: the viewer shows whatever
    // the deployment ships, and this lane only asserts it is shown read-only.
    const shipped = await readFile(join(SHIPPED_PRESETS, 'standard', 'agent.cordis.yml'), 'utf8')
    expect(await viewer.locator('pre').textContent()).toBe(shipped)
    expect(await viewer.getByRole('textbox').count()).toBe(0)
    // The header X and the footer button share the 关闭 name; the footer one
    // is last in the dialog.
    await viewer.getByRole('button', { name: '关闭' }).last().click()
    await viewer.waitFor({ state: 'detached', timeout: 10_000 })
  }, 60_000)

  it('copies 极简模式 whole under a new id and lands in its files', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-copy'))
    const dialog = settingsDialog()
    await dialog.getByRole('button', { name: '复制预设: 极简模式' }).click()
    const copyDialog = page.getByRole('dialog', { name: '复制预设 · 复制自 极简模式' })
    await copyDialog.waitFor({ timeout: 10_000 })

    const dialogSnapshot = await captureStableAria(
      page, '[role="dialog"][aria-label^="复制预设"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(COPY_DIALOG_EXPECTED, dialogSnapshot, MODE)
    // Two fields and nothing else: the id is the directory name the host
    // needs up front; description and composition live in the files.
    expect(dialogSnapshot).toContain('标识符')
    expect(dialogSnapshot).not.toContain('描述')

    await copyDialog.getByPlaceholder('my-agent').fill('my-agent')
    await copyDialog.getByPlaceholder('在模式列表中显示的名称，不填则使用标识符').fill('我的模式')
    await copyDialog.getByRole('button', { name: '创建' }).click()
    await copyDialog.waitFor({ state: 'detached', timeout: 10_000 })

    // The new row lands in the custom group, and — with no desktop opener —
    // its directory is revealed as text right away: landing in the files is
    // the completion of a copy, not a follow-up.
    await dialog.getByText('我的模式').first().waitFor({ timeout: 10_000 })
    await dialog.getByText('预设文件：').waitFor({ timeout: 10_000 })
    // The copy dialog is detached, so the settings dialog is the only one
    // left (it names itself via aria-labelledby, which a CSS attribute
    // selector cannot address).
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, {
      replacements: [[userRoot, '{{presetRoot}}']],
    })
    await compareOrRefreshGolden(CREATED_EXPECTED, snapshot, MODE)
    expect(snapshot).toContain('{{presetRoot}}/my-agent')

    // The host copied the whole directory and rewrote only the display
    // metadata: the composition is byte-identical to the shipped source, the
    // description rides along for the user to edit in place, and neither the
    // source's name nor its roster order survives into the copy.
    const composition = await readFile(join(userRoot, 'my-agent', 'agent.cordis.yml'), 'utf8')
    expect(composition).toBe(await readFile(join(SHIPPED_PRESETS, 'minimal', 'agent.cordis.yml'), 'utf8'))
    const metadata = await readFile(join(userRoot, 'my-agent', 'preset.yml'), 'utf8')
    expect(metadata).toContain('name: 我的模式')
    expect(metadata).toContain('description: 仅提供持久 shell 的单工具编码 Agent。')
    expect(metadata).not.toContain('order:')
  }, 60_000)

  it('deletes the copy after confirmation and reclaims the roster', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-delete'))
    const dialog = settingsDialog()
    await dialog.getByRole('button', { name: '删除: 我的模式' }).click()
    const confirm = page.getByRole('dialog', { name: '删除该预设？' })
    await confirm.waitFor({ timeout: 10_000 })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.waitFor({ state: 'detached', timeout: 10_000 })

    await expect.poll(async () => dialog.getByText('我的模式').count(), { timeout: 10_000 }).toBe(0)
    expect(existsSync(join(userRoot, 'my-agent'))).toBe(false)
    // The custom group outlives its only member: the heading stays with the
    // creator entry so the place to author a preset never disappears.
    expect(await dialog.getByRole('heading', { name: '自定义' }).count()).toBe(1)
    expect(await dialog.getByRole('button', { name: '让 Agent 帮我创建预设模式' }).count()).toBe(1)
    expect(await dialog.getByText('标准模式').count()).toBeGreaterThan(0)
  }, 60_000)

  it('marks damaged presets broken and clears a ghost through delete', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-damaged'))
    // The two hand-edit damage shapes: a composition that no longer parses,
    // and a directory whose composition file was deleted outright.
    await mkdir(join(userRoot, 'broken-yaml'), { recursive: true })
    await writeFile(join(userRoot, 'broken-yaml', 'agent.cordis.yml'), '- id: x\n  name: [unclosed\n')
    await mkdir(join(userRoot, 'ghost'), { recursive: true })
    await writeFile(join(userRoot, 'ghost', 'preset.yml'), 'name: 幽灵预设\ndescription: composition 已被手动删除。\n')

    // The section reads the roster when it mounts; hop away and back.
    const dialog = settingsDialog()
    await dialog.getByRole('button', { name: '通用设置' }).click()
    await dialog.getByRole('button', { name: 'Agent 预设' }).click()
    await dialog.getByText('加载失败').first().waitFor({ timeout: 10_000 })

    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd, {
      replacements: [[userRoot, '{{presetRoot}}']],
    })
    await compareOrRefreshGolden(DAMAGED_EXPECTED, snapshot, MODE)
    // Both damage shapes surface as marked, unselectable, uncopyable cards
    // that still carry their metadata and the discovery-reported reason.
    expect(snapshot).toContain('加载失败: broken-yaml')
    expect(snapshot).toContain('加载失败: 幽灵预设')
    expect(snapshot).toContain('not valid YAML')
    expect(snapshot).toContain('agent.cordis.yml is missing')
    expect(await dialog.getByRole('button', { name: '加载失败: broken-yaml' }).isDisabled()).toBe(true)
    expect(await dialog.getByRole('button', { name: '复制预设: 幽灵预设' }).isDisabled()).toBe(true)
    // A broken card offers no "set default" affordance at all — the aria name
    // IS the broken marking, so the picking name must not exist.
    expect(await dialog.getByRole('button', { name: '设为新任务默认: broken-yaml' }).count()).toBe(0)

    // The ghost's way out is the card's own delete — and the id it blocked
    // is claimable again immediately afterwards.
    await dialog.getByRole('button', { name: '删除: 幽灵预设' }).click()
    const confirm = page.getByRole('dialog', { name: '删除该预设？' })
    await confirm.waitFor({ timeout: 10_000 })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await confirm.waitFor({ state: 'detached', timeout: 10_000 })
    await expect.poll(async () => dialog.getByText('幽灵预设').count(), { timeout: 10_000 }).toBe(0)
    expect(existsSync(join(userRoot, 'ghost'))).toBe(false)

    await dialog.getByRole('button', { name: '复制预设: 极简模式' }).click()
    const copyDialog = page.getByRole('dialog', { name: '复制预设 · 复制自 极简模式' })
    await copyDialog.waitFor({ timeout: 10_000 })
    await copyDialog.getByPlaceholder('my-agent').fill('ghost')
    await copyDialog.getByRole('button', { name: '创建' }).click()
    await copyDialog.waitFor({ state: 'detached', timeout: 10_000 })
    await dialog.getByRole('button', { name: '设为新任务默认: ghost' }).waitFor({ timeout: 10_000 })

    // Leave the roster as the earlier tests shaped it.
    await dialog.getByRole('button', { name: '删除: ghost' }).click()
    const cleanup = page.getByRole('dialog', { name: '删除该预设？' })
    await cleanup.waitFor({ timeout: 10_000 })
    await cleanup.getByRole('button', { name: '删除', exact: true }).click()
    await cleanup.waitFor({ state: 'detached', timeout: 10_000 })
    await rm(join(userRoot, 'broken-yaml'), { recursive: true, force: true })
  }, 60_000)

  it('starts a creator-mode session from the section', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-preset-authoring-creator'))
    // Without a workspace the flow only stages (there is no session to land
    // in until one is connected); connect first so the gesture carries all
    // the way to a composed host session.
    await settingsDialog().getByRole('button', { name: '关闭' }).last().click()
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = settingsDialog()
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Agent 预设' }).click()
    await dialog.getByRole('button', { name: '让 Agent 帮我创建预设模式' }).click()

    // Leaving settings is part of the gesture: the flow lands on the
    // new-session screen with the self-referential preset staged, and the
    // blank session the flow produces composes from it on the host.
    await dialog.waitFor({ state: 'detached', timeout: 10_000 })
    await expect.poll(async () => {
      const response = await scaffold.hostFetch('/api/session/list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'creator-draft-stage', method: 'session/list',
          payload: { args: { _request: {} } },
        }),
      })
      const body = await response.json() as {
        result: { value?: { items: unknown[] } }
      }
      return JSON.stringify(body.result.value?.items ?? body.result)
    }, { timeout: 15_000 }).toContain('"agentPreset":"cordis"')
  }, 60_000)

  it('drove every surface without a page error or a stream warning', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
