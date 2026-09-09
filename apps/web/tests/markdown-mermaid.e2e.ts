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
const DIAGRAM_MESSAGE = '[class*="markdown"]:has(.md-code-block)'
const FLOW = 'flowchart LR\n  A[输入] --> B[共享渲染器] --> C[图形预览]'
const SEQUENCE = 'sequenceDiagram\n  participant U as User\n  participant R as Renderer\n  U->>R: Mermaid source\n  R-->>U: Diagram'
const INVALID = 'flowchart LR\n  A[unfinished'
const UNTRUSTED = [
  '%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"body {display:none!important}"}}%%',
  'flowchart LR',
  '  A["<img src=x onerror=alert(1)>"] --> B[Safe]',
  '  click B "javascript:alert(1)"',
].join('\n')

const DOT = 'digraph { rankdir=LR; Input -> Preview }'
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="100" onload="parent.document.body.dataset.previewEscaped='yes'">
<rect width="460" height="100" fill="lightblue"/><text x="20" y="55">SVG preview</text>
<script>parent.document.body.dataset.previewEscaped='yes';alert('unsafe SVG')</script>
<image href="https://preview.invalid/svg-image" width="1" height="1"/>
<foreignObject width="1" height="1"><div xmlns="http://www.w3.org/1999/xhtml"><script>alert('unsafe HTML')</script></div></foreignObject>
</svg>`
const HTML = `<style>h2 { color: green }</style><h2>Static HTML</h2>
<script>parent.document.body.dataset.previewEscaped = 'yes'; alert('unsafe')</script>
<meta http-equiv="refresh" content="0;url=https://preview.invalid/refresh">
<a href="https://preview.invalid/navigate">Disabled navigation</a>
<img src="https://preview.invalid/image" onerror="alert('unsafe')">
<iframe src="https://preview.invalid/frame"></iframe>`

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
        ...[['dot', DOT], ['svg', SVG], ['html', HTML]].map(([lang, code]) => `\`\`\`${lang}\n${code}\n\`\`\``),
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

  it.skipIf(MODE === 'record').each(['light', 'dark'] as const)(
    'tightly wraps short diagram previews in %s mode', async (scheme) => {
      const page = await newEnglishPage(browser)
      try {
        await page.emulateMedia({ colorScheme: scheme })
        await openConversation(page, scaffold)
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(scheme)

        const mermaid = page.getByRole('img', { name: 'Mermaid diagram' }).first()
        await mermaid.evaluate(async (node: HTMLImageElement) => { await node.decode() })
        const mermaidHeight = await mermaid.evaluate(node => node.getBoundingClientRect().height)
        const canvasHeight = await mermaid.evaluate(node => node.parentElement!.getBoundingClientRect().height)
        // Compact diagrams need at most the Mermaid canvas's 16px padding on each side.
        expect(canvasHeight - mermaidHeight).toBeLessThanOrEqual(32)

        for (const title of ['Graphviz diagram', 'SVG preview']) {
          const image = page.getByRole('img', { name: title, exact: true })
          await image.evaluate(async (node: HTMLImageElement) => { await node.decode() })
          const imageHeight = await image.evaluate(node => node.getBoundingClientRect().height)
          const containerHeight = await image.evaluate(node => node.parentElement!.getBoundingClientRect().height)
          expect(imageHeight).toBeGreaterThan(0)
          expect(containerHeight).toBeGreaterThanOrEqual(imageHeight)
          expect.soft(containerHeight - imageHeight,
            `${scheme} ${title}: ${containerHeight}px container around ${imageHeight}px content`,
          ).toBeLessThanOrEqual(32)
        }
        await page.setViewportSize({ width: 360, height: 800 })
        const svg = page.getByRole('img', { name: 'SVG preview', exact: true })
        await expect.poll(() => svg.evaluate((node) => {
          const { width, height } = node.getBoundingClientRect()
          return width > 0 && height > 0 && width < 460
        })).toBe(true)
        const compact = await svg.evaluate((node: HTMLImageElement) => ({
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
          canvasHeight: node.parentElement!.getBoundingClientRect().height,
          ratio: node.naturalWidth / node.naturalHeight,
        }))
        expect(compact.width / compact.height).toBeCloseTo(compact.ratio, 1)
        expect(compact.canvasHeight - compact.height).toBeLessThanOrEqual(32)
      } finally {
        await page.close()
      }
    },
  )

  it.skipIf(MODE === 'record')('updates existing diagrams when the document switches between light and dark', async () => {
    const page = await newEnglishPage(browser)
    try {
      await openConversation(page, scaffold)
      const image = page.getByRole('img', { name: 'Mermaid diagram' }).first()
      await image.waitFor()
      let previous = await image.getAttribute('src')
      for (const scheme of ['dark', 'light'] as const) {
        await page.evaluate((value) => {
          document.documentElement.style.colorScheme = value
          document.body.toggleAttribute('data-ds-dark-theme', value === 'dark')
        }, scheme)
        await expect.poll(() => image.getAttribute('src')).not.toBe(previous)
        await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
        const colors = await image.evaluate((node) => {
          const reference = document.createElement('span')
          reference.style.backgroundColor = 'var(--dsw-alias-markdown-code-block)'
          document.body.append(reference)
          try {
            return {
              canvas: getComputedStyle(node.parentElement!).backgroundColor,
              expected: getComputedStyle(reference).backgroundColor,
            }
          } finally {
            reference.remove()
          }
        })
        expect(colors.canvas).toBe(colors.expected)
        await expect.poll(() => page.getByTitle('HTML preview', { exact: true }).getAttribute('srcdoc'))
          .toContain(`color-scheme:${scheme}`)
        previous = await image.getAttribute('src')
      }
    } finally {
      await page.close()
    }
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
    const diagram = await first.getByRole('img').elementHandle()
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
    expect(await diagram!.evaluate(node => node.isConnected)).toBe(true)
    expect(await diagram!.isVisible()).toBe(false)
    await first.getByRole('button', { name: 'Preview', exact: true }).click()
    expect(await diagram!.isVisible()).toBe(true)
    await first.getByRole('button', { name: 'Copy', exact: true }).waitFor()
    expect(await page.locator('body').evaluate(node => getComputedStyle(node).display)).not.toBe('none')
    expect(await page.locator('[id^="dsh-mermaid-"]').count()).toBe(0)
    expect(dialogs).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await page.getByRole('heading', { name: 'Mermaid previews' }).click()
    await page.mouse.move(0, 0)
    const snapshot = await captureStableAria(page, DIAGRAM_MESSAGE, scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'), snapshot, MODE)
    await page.close()
  }, 60_000)

  it.skipIf(MODE === 'record')('localizes the preview and failure states in Chinese', async () => {
    const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', hasTouch: true })
    await openConversation(page, scaffold)
    await expect.poll(() => page.getByRole('img', { name: 'Mermaid 图表' }).count(), { timeout: 20_000 }).toBe(3)
    expect(await page.getByRole('button', { name: '源码', exact: true }).count()).toBe(7)
    const controls = page.locator('.md-code-block').first().locator('[class*="bannerWrap"]')
    expect(await controls.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
    expect(await page.getByRole('button', { name: '源码', exact: true }).first()
      .evaluate(node => node.getBoundingClientRect().width)).toBe(44)
    expect(await page.getByText('无法渲染此图表，源码如下。', { exact: true }).count()).toBe(1)
    const firstImage = page.getByRole('img', { name: 'Mermaid 图表' }).first()
    await expect.poll(() => firstImage.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    expect(await controls.evaluate(node => node.getBoundingClientRect().top))
      .toBeGreaterThanOrEqual(await firstImage.evaluate(node => node.getBoundingClientRect().bottom))
    const snapshot = await captureStableAria(page, DIAGRAM_MESSAGE, scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'zh.expected.md'), snapshot, MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'zh.expected.md'])
    await page.close()
  }, 60_000)

  it.skipIf(MODE === 'record')('previews inert DOT and SVG images and isolates static HTML', async () => {
    const page = await newEnglishPage(browser)
    const requests: string[] = []
    const dialogs: string[] = []
    // Routing observes requests eligible for transport; Chromium also emits 'request' for CSP-blocked URLs.
    await page.route('https://preview.invalid/**', async (route) => {
      requests.push(route.request().url())
      await route.abort()
    })
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openConversation(page, scaffold)
    for (const [title, code] of [['Graphviz diagram', DOT], ['SVG preview', SVG], ['HTML preview', HTML]] as const) {
      const preview = title === 'HTML preview'
        ? page.getByTitle(title, { exact: true })
        : page.getByRole('img', { name: title, exact: true, includeHidden: true })
      await preview.waitFor()
      if (title === 'HTML preview') {
        expect(await preview.getAttribute('sandbox')).toBe('')
        const body = preview.contentFrame()
        await body.getByRole('heading', { name: 'Static HTML' }).waitFor()
        expect(await body.getByRole('heading').evaluate(node => getComputedStyle(node).color)).toBe('rgb(0, 128, 0)')
        await body.getByText('Disabled navigation').click()
        expect(await preview.evaluate(node => (node as HTMLIFrameElement).contentDocument)).toBeNull()
      } else {
        await expect.poll(() => preview.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      }
      const block = page.locator('.md-code-block').filter({ has: preview })
      await block.hover()
      await block.getByRole('button', { name: 'Copy', exact: true }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
      await block.getByRole('button', { name: 'Source', exact: true }).click()
      expect(await block.locator('pre code').textContent()).toBe(code)
      await block.getByRole('button', { name: 'Preview', exact: true }).click()
      expect(await preview.isVisible()).toBe(true)
    }
    expect(await page.locator('body').getAttribute('data-preview-escaped')).toBeNull()
    expect(dialogs).toEqual([])
    expect(requests).toEqual([])
    const notices = await page.request.get(new URL('/preview-third-party-notices.txt', scaffold.authenticatedUrl).href)
    expect(notices.ok()).toBe(true)
    expect(await notices.text()).toContain('Eclipse Public License - v 2.0')
    await page.close()
  })

  it.skipIf(MODE === 'record')('keeps actions visible when a mouse and touchscreen are both available', async () => {
    const hybridBrowser = await chromium.launch({
      args: ['--blink-settings=availablePointerTypes=6,primaryPointerType=4,availableHoverTypes=2,primaryHoverType=2'],
    })
    try {
      const page = await newEnglishPage(hybridBrowser)
      expect(await page.evaluate(() =>
        matchMedia('(hover: hover) and (pointer: fine) and (any-pointer: coarse)').matches)).toBe(true)
      await openConversation(page, scaffold)
      const first = page.locator('.md-code-block').first()
      const diagram = first.getByRole('img', { name: 'Mermaid diagram' })
      await expect.poll(() => diagram.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await page.mouse.move(0, 0)
      const controls = first.locator('[class*="bannerWrap"]')
      expect(await controls.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
      expect(await controls.evaluate(node => getComputedStyle(node).pointerEvents)).toBe('auto')
      expect(await first.getByRole('button', { name: 'Source', exact: true })
        .evaluate(node => node.getBoundingClientRect().width)).toBe(44)
      expect(await controls.evaluate(node => node.getBoundingClientRect().top))
        .toBeGreaterThanOrEqual(await diagram.evaluate(node => node.getBoundingClientRect().bottom))
      await first.getByRole('button', { name: 'Source', exact: true }).click()
      expect(await first.locator('pre code').textContent()).toBe(FLOW)
    } finally {
      await hybridBrowser.close()
    }
  }, 60_000)
})
