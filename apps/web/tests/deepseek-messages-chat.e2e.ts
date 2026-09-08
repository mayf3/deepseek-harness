/** Recorded Web conversation through the shipped Messages route and DeepSeek model group. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/deepseek-messages-chat', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const MODE = webSnapshotMode()
const RECORD_PROMPT = '只回复 MESSAGES_WEB_READY，不调用工具。'

describe('web e2e: DeepSeek Messages conversation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let replayFixture: string

  beforeAll(async () => {
    replayFixture = await selectedSessionFixture(FIXTURE, MODE === 'record')
    scaffold = await launchWebScaffold({
      deepSeekMessages: true,
      ...(MODE === 'record' ? {} : {
        replayFixture,
        paceMs: 5,
        replayProviders: [{
          id: 'deepseek-messages', name: 'DeepSeek',
          models: [{
            id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
            contextWindow: 1_000_000, defaultMaxTokens: 256_000,
            reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high',
          }],
        }],
      }),
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('records the Messages provider while displaying DeepSeek in the model selector', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-deepseek-messages-chat'))
    const prompts = MODE === 'record' ? [RECORD_PROMPT] : fixtureUserPrompts(await readFile(replayFixture, 'utf8'))
    expect(prompts).toHaveLength(1)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'deepseek-messages', model: 'deepseek-v4-flash' })
    await page.getByRole('button', { name: /^选择模型/ }).click()
    await page.getByRole('menuitem', { name: /模型/ }).click()
    await page.getByText('DeepSeek', { exact: true }).waitFor()
    await page.getByRole('button', { name: /^选择模型/ }).click()
    const input = page.locator('[data-composer-input]').first()
    const settled = scaffold.whenTurnSettled()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await settled
    const session = scaffold.ctx.sessions.get(sessionId)!
    expect(session.requestHeader()?.config.provider).toBe('deepseek-messages')
    await page.getByText('MESSAGES_WEB_READY', { exact: true }).waitFor()
    if (MODE === 'record') {
      await recordFixture(scaffold, sessionId, FIXTURE)
    } else {
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'),
        await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    }
    expect(tripwire.pageErrors).toEqual([])
  })

  it.skipIf(MODE === 'record')('keeps the recorded-session inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v3.jsonl', 'ui.expected.md'])
  })
})
