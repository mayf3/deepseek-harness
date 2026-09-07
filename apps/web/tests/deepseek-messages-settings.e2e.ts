/** Web composition: both DeepSeek protocols keep independent settings, credentials, and model identities. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/deepseek-messages-settings/', import.meta.url))

describe.skipIf(webSnapshotMode() === 'record')('web e2e: DeepSeek protocol coexistence', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    vi.stubEnv('DEEPSEEK_MESSAGES_API_KEY', undefined)
    vi.stubEnv('DEEPSEEK_MESSAGES_BASE_URL', undefined)
    scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, deepSeekMessages: true })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '稍后配置', exact: true }).click()
  }, 120_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try { await scaffold?.close() } finally { vi.unstubAllEnvs() }
    }
  })

  it('saves each protocol independently and exposes both model catalogs', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-messages-settings'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    await dialog.getByText('DeepSeek Messages', { exact: true }).waitFor()
    // Unconfigured composition routes appear as setup cards together.
    const messages = dialog.getByText('DeepSeek Messages', { exact: true }).locator('..').locator('..')
    await messages.getByText('自定义设置', { exact: true }).click()
    expect(await messages.getByLabel('API 地址', { exact: true }).getAttribute('placeholder'))
      .toBe('https://api.deepseek.com/anthropic')
    await compareOrRefreshGolden(join(EXPECTED, 'cards.expected.md'),
      await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
    await messages.getByLabel('API 密钥', { exact: true }).fill('sk-e2e-messages')
    await messages.getByLabel('API 地址', { exact: true }).fill('https://messages.example/anthropic')
    await messages.getByLabel('显示名称 1', { exact: true }).fill('Messages Flash')
    await messages.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 DeepSeek Messages (deepseek-messages)。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '编辑 DeepSeek (deepseek-official)', exact: true }).click()
    const original = dialog.getByText('DeepSeek', { exact: true }).locator('..').locator('..')
    await original.getByLabel('API 密钥', { exact: true }).fill('sk-e2e-completions')
    await original.getByText('自定义设置', { exact: true }).click()
    await original.getByLabel('API 地址', { exact: true }).fill('https://completions.example/v1')
    await original.getByRole('button', { name: '保存', exact: true }).click()
    await dialog.getByText('已保存 DeepSeek (deepseek-official)。', { exact: true }).waitFor()

    const settings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(settings).toContain('https://messages.example/anthropic')
    expect(settings).toContain('https://completions.example/v1')
    expect(settings).not.toContain('sk-e2e-')
    const credentials = await readFile(join(scaffold.harnessHome, '.credentials.yaml'), 'utf8')
    expect(credentials).toContain('DEEPSEEK_MESSAGES_API_KEY: sk-e2e-messages')
    expect(credentials).toContain('DEEPSEEK_API_KEY: sk-e2e-completions')
    expect(await page.locator('body').innerText()).not.toContain('sk-e2e-')
    await page.keyboard.press('Escape')
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'messages-settings-e2e')
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    await page.getByRole('menuitemradio', { name: 'Messages Flash', exact: true }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'picker.expected.md'),
      await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
