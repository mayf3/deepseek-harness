/** The preset settings page only views and selects; authoring is guided to Creator mode. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/agent-preset-authoring', import.meta.url))
const mode = webSnapshotMode()

describe('web e2e: preset roster guidance', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ profile: { packages: [] } })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: 'Agent 预设' }).click()
    await page.getByRole('heading', { name: 'Agent 预设' }).waitFor()
  }, 120_000)
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  it('shows the shipped roster with mode help and no editing actions', async () => {
    onTestFailed(() => saveFailureShot(page, 'preset-roster-section'))
    await expect.poll(() => page.locator('[data-agent-preset-id]').count()).toBe(4)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(EXPECTED, 'section.expected.md'), snapshot, mode)
    expect(snapshot).toContain('如何创建或修改预设')
    expect(snapshot).not.toContain('新建预设')
    expect(snapshot).not.toContain('编辑插件')
    expect(snapshot).not.toContain('打开目录')
    expect(snapshot).not.toContain('删除')
  })

  it('reads mode details and examples without changing the new-task default', async () => {
    onTestFailed(() => saveFailureShot(page, 'preset-roster-guide'))
    const settings = page.getByRole('dialog', { name: '设置' })
    const trigger = settings.getByRole('button', { name: '模式说明: PTC 模式', exact: true })
    await trigger.click()
    const guide = page.getByRole('dialog', { name: 'PTC 模式', exact: true })
    await guide.getByRole('heading', { name: '怎样调用工具', exact: true }).waitFor()
    await guide.getByRole('tab', { name: '如何使用', exact: true }).click()
    await guide.getByRole('heading', { name: '批量检查配置文件', exact: true }).waitFor()
    await guide.getByRole('tab', { name: '如何使用', exact: true }).press('Escape')
    await guide.waitFor({ state: 'detached' })
    expect(await trigger.evaluate(element => document.activeElement === element)).toBe(true)
    expect(await settings.getByRole('button', { name: '新任务默认: 标准模式', exact: true }).getAttribute('aria-pressed')).toBe('true')
  })

  it('guides authoring to Creator mode instead of editing here', async () => {
    onTestFailed(() => saveFailureShot(page, 'preset-roster-authoring-help'))
    await page.getByRole('button', { name: '如何创建或修改预设', exact: true }).click()
    const help = page.getByRole('dialog', { name: '创建和修改预设', exact: true })
    await help.waitFor()
    const snapshot = await captureStableAria(page, '[role="dialog"][aria-label="创建和修改预设"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(EXPECTED, 'authoring-help.expected.md'), snapshot, mode)
    expect(snapshot).toContain('让 Agent 帮我创建预设模式')
    await help.getByRole('button', { name: '关闭', exact: true }).last().click()
    await help.waitFor({ state: 'detached' })
  })

  it('runs without page errors or model calls', () => { expect(tripwire.pageErrors).toEqual([]) })
})
