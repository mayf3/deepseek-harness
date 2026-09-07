import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/markdown-mermaid', import.meta.url))
const MODE = webSnapshotMode()
const SEED_ID = 'markdown-mermaid-web-e2e'
const FLOW = 'flowchart LR\n  A[输入] --> B[共享渲染器] --> C[图形预览]'
const SEQUENCE = 'sequenceDiagram\n  participant U as User\n  participant R as Renderer\n  U->>R: Mermaid source\n  R-->>U: Diagram'
const INVALID = 'flowchart LR\n  A[unfinished'
const UNTRUSTED = [
  '%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"body {display:none!important}"}}%%',
  'flowchart LR',
  '  A["<img src=x onerror=alert(1)>"] --> B[Safe]',
  '  click B "javascript:alert(1)"',
].join('\n')

function fixture(): string {
  const session = Session.create(SessionId('markdown-mermaid-source'))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Preview these Mermaid diagrams.' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Mermaid previews', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: [
        '# Mermaid previews',
        ...[FLOW, SEQUENCE, INVALID, UNTRUSTED].map(code => `\`\`\`mermaid\n${code}\n\`\`\``),
      ].join('\n\n') }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const noon = new Date().setHours(12, 0, 0, 0)
  return [
    JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0,
      cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
    }),
    ...session.snapshotEvents().map(event => JSON.stringify({ ...event, time: noon + event.seq * 1000 })),
    '',
  ].join('\n')
}

async function openConversation(page: Page, scaffold: WebScaffold): Promise<void> {
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByRole('treeitem').first().click({ timeout: 30_000 })
  await page.getByRole('treeitem').nth(1).click()
  await page.getByRole('heading', { name: 'Mermaid previews' }).waitFor()
}

describe('web e2e: Mermaid chat previews', () => {
  let scaffold: WebScaffold
  let browser: Browser
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture(), SEED_ID)
    browser = await chromium.launch()
  }, 120_000)
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')('renders diagrams, switches to source, copies source, and contains malformed content', async () => {
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-markdown-mermaid'))
    const tripwire = watchConsole(page)
    const dialogs: string[] = []
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openConversation(page, scaffold)
    const images = page.getByRole('img', { name: 'Mermaid diagram' })
    await expect.poll(() => images.count(), { timeout: 20_000 }).toBe(3)
    await expect.poll(() => images.evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).naturalWidth > 0))).toBe(true)
    expect(await images.evaluateAll(nodes => nodes.every(node =>
      node.getBoundingClientRect().width <= (node as HTMLImageElement).naturalWidth))).toBe(true)
    expect(await page.getByText('Unable to render this diagram. The source is shown below.', { exact: true }).count()).toBe(1)
    expect(await page.locator('pre code').allTextContents()).toContain(INVALID)
    expect(await images.first().evaluate(node => decodeURIComponent((node as HTMLImageElement).src))).toContain('共享渲染器')
    const first = page.locator('.md-code-block').first()
    const controls = first.locator('[class*="bannerWrap"]')
    expect(await first.getByText('mermaid', { exact: true }).count()).toBe(0)
    await page.mouse.move(0, 0)
    expect(await controls.evaluate(node => getComputedStyle(node).opacity)).toBe('0')
    await first.hover()
    expect(await controls.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    await first.getByRole('button', { name: 'Copy', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FLOW)
    await page.mouse.move(0, 0)
    await first.getByRole('button', { name: 'Source', exact: true }).focus()
    expect(await controls.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    await page.keyboard.press('Enter')
    expect(await first.getByRole('button', { name: 'Preview', exact: true })
      .evaluate(node => node === document.activeElement)).toBe(true)
    expect(await first.locator('pre code').textContent()).toBe(FLOW)
    await first.getByRole('button', { name: 'Preview', exact: true }).click()
    await first.getByRole('img').waitFor()
    await first.getByRole('button', { name: 'Copy', exact: true }).waitFor()
    expect(await page.locator('body').evaluate(node => getComputedStyle(node).display)).not.toBe('none')
    expect(await page.locator('[id^="dsh-mermaid-"]').count()).toBe(0)
    expect(dialogs).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await page.getByRole('heading', { name: 'Mermaid previews' }).click()
    await page.mouse.move(0, 0)
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'), snapshot, MODE)
    await page.close()
  }, 60_000)

  it.skipIf(MODE === 'record')('localizes the preview and failure states in Chinese', async () => {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', hasTouch: true })
    await openConversation(page, scaffold)
    await expect.poll(() => page.getByRole('img', { name: 'Mermaid 图表' }).count(), { timeout: 20_000 }).toBe(3)
    expect(await page.getByRole('button', { name: '源码', exact: true }).count()).toBe(4)
    const controls = page.locator('.md-code-block').first().locator('[class*="bannerWrap"]')
    expect(await controls.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    expect(await page.getByRole('button', { name: '源码', exact: true }).first()
      .evaluate(node => node.getBoundingClientRect().width)).toBe(44)
    expect(await page.getByText('无法渲染此图表，源码如下。', { exact: true }).count()).toBe(1)
    const firstImage = page.getByRole('img', { name: 'Mermaid 图表' }).first()
    await expect.poll(() => firstImage.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    expect(await controls.evaluate(node => node.getBoundingClientRect().top))
      .toBeGreaterThanOrEqual(await firstImage.evaluate(node => node.getBoundingClientRect().bottom))
    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'zh.expected.md'), snapshot, MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'zh.expected.md'])
    await page.close()
  }, 60_000)
})
