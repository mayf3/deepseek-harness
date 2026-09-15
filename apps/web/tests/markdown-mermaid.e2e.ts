import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
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
const HTML = '<h2>Static HTML</h2>'

const CPU = `flowchart LR
    subgraph CPU["CPU 中央处理器"]
        direction TB
        CU["控制器 Control Unit"]
        ALU["运算器 ALU"]
        REG["寄存器 Registers"]
    end

    MEM["存储器 Memory（指令 + 数据）"]
    IN["输入设备 Input"]
    OUT["输出设备 Output"]

    IN -->|"数据 / 指令"| MEM
    MEM -->|"指令"| CU
    MEM -->|"数据"| REG
    REG -->|"数据"| MEM
    CU -->|"控制信号"| ALU
    CU -->|"控制信号"| MEM
    CU -->|"地址总线"| MEM
    ALU -->|"结果"| REG
    MEM -->|"数据"| OUT
    CU -->|"控制信号"| OUT`

function fixture(diagramSources?: string[]): string {
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
      content: [{ type: 'text', text: diagramSources === undefined ? [
        '# Mermaid previews',
        ...[FLOW, SEQUENCE, INVALID, UNTRUSTED].map(code => `\`\`\`mermaid\n${code}\n\`\`\``),
        ...[['dot', DOT], ['svg', SVG], ['html', HTML]].map(([lang, code]) => `\`\`\`${lang}\n${code}\n\`\`\``),
      ].join('\n\n') : ['# Mermaid previews', ...diagramSources.map(code => `\`\`\`mermaid\n${code}\n\`\`\``)].join('\n\n') }],
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

async function settleBox(locator: Locator): Promise<{ width: number; height: number }> {
  return await locator.evaluate(async (node) => {
    let previous = { width: -1, height: -1 }
    let stableFrames = 0
    for (let frame = 0; frame < 180; frame += 1) {
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      const { width, height } = node.getBoundingClientRect()
      const current = { width, height }
      stableFrames = Math.abs(width - previous.width) < 0.25 && Math.abs(height - previous.height) < 0.25
        ? stableFrames + 1
        : 0
      if (stableFrames === 5) return current
      previous = current
    }
    throw new Error('layout did not settle within 180 animation frames')
  })
}

async function showAllPreviews(page: Page, label = 'Preview'): Promise<void> {
  const blocks = page.locator('.md-code-block')
  for (let index = 0; index < await blocks.count(); index += 1) {
    const button = blocks.nth(index).getByRole('button', { name: label, exact: true })
    if (await button.count() === 1) await button.click()
  }
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

  it.skipIf(MODE === 'record')('keeps preview and source at the same height across viewport widths', async () => {
    const page = await newEnglishPage(browser)
    let cpuScaffold: WebScaffold | undefined
    try {
      cpuScaffold = await launchWebScaffold({})
      await seedSession(cpuScaffold, fixture([CPU]), SEED_ID)
      await openConversation(page, cpuScaffold)
      const block = page.locator('.md-code-block')
      await block.scrollIntoViewIfNeeded()
      const image = block.getByRole('img', { name: 'Mermaid diagram', exact: true })
      await image.evaluate(async (node: HTMLImageElement) => { await node.decode() })
      expect(await block.locator('pre').count()).toBe(0)
      const heights: number[] = []
      for (const width of [1680, 360]) {
        await page.setViewportSize({ width, height: 1000 })
        await settleBox(page.locator('[data-chat-flow]'))
        await image.waitFor({ state: 'visible' })
        const previewBlock = await settleBox(block)
        const previewGeometry = await block.evaluate((node) => {
          const body = node.querySelector<HTMLElement>('[data-code-block-content]')!
          const source = node.querySelector<HTMLElement>('[data-code-block-source-view]')!
          const preview = node.querySelector<HTMLElement>('[data-code-block-preview]')!
          return {
            block: node.getBoundingClientRect().height,
            body: body.getBoundingClientRect().height,
            source: source.closest('.md-code-block')!.querySelector('[data-code-block-content]')!.getBoundingClientRect().height,
            preview: preview.getBoundingClientRect().height,
            sourceVisibility: getComputedStyle(source).visibility,
            sourceAriaHidden: source.getAttribute('aria-hidden'),
          }
        })
        expect(previewGeometry.sourceVisibility).toBe('hidden')
        expect(previewGeometry.sourceAriaHidden).toBe('true')
        expect(previewGeometry.preview).toBeCloseTo(previewGeometry.source, 0)
        expect(previewGeometry.body).toBeCloseTo(previewGeometry.source, 0)
        expect(await block.locator('pre:visible').count()).toBe(0)
        await block.getByRole('button', { name: 'Source', exact: true }).click()
        await block.locator('pre:visible').waitFor()
        const sourceBlock = await settleBox(block)
        expect(sourceBlock.height).toBeCloseTo(previewBlock.height, 0)
        expect(sourceBlock.width).toBeCloseTo(previewBlock.width, 0)
        await block.getByRole('button', { name: 'Preview', exact: true }).click()
        await image.waitFor({ state: 'visible' })
        const restoredBlock = await settleBox(block)
        expect(restoredBlock.height).toBeCloseTo(previewBlock.height, 0)
        expect(restoredBlock.width).toBeCloseTo(previewBlock.width, 0)
        heights.push(previewGeometry.source)
      }
      expect(heights.every(height => height > 0 && height <= 632)).toBe(true)
      expect(await block.locator('[data-code-block-resize]').count()).toBe(0)
      expect(await block.getByRole('button', { name: 'Reset size', exact: true }).count()).toBe(0)
      await block.getByRole('button', { name: 'Source', exact: true }).click()
      expect(await block.locator('pre code').textContent()).toBe(CPU)
    } catch (error) {
      await saveFailureShot(page, 'web-e2e-cpu-preview')
      throw error
    } finally {
      await page.close()
      await cpuScaffold?.close()
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('retains both equal-height views and keeps toolbar geometry stable', async () => {
    const page = await newEnglishPage(browser)
    try {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      await openConversation(page, scaffold)
      const block = page.locator('.md-code-block').nth(5)
      await block.scrollIntoViewIfNeeded()
      const image = block.getByRole('img', { name: 'SVG preview', exact: true })
      await image.evaluate(async (node: HTMLImageElement) => { await node.decode() })
      const imgNode = await image.elementHandle()
      const sourceView = block.locator('[data-code-block-source-view]')
      const previewLayer = block.locator('[data-code-block-preview]')
      expect(await sourceView.getAttribute('aria-hidden')).toBe('true')
      expect(await block.locator('pre').count()).toBe(0)
      const previewHeight = (await previewLayer.boundingBox())!.height
      expect(await imgNode!.evaluate(node => node.isConnected)).toBe(true)
      const sourceButton = block.getByRole('button', { name: 'Source', exact: true })
      await sourceButton.click()
      await block.locator('pre.shiki:visible').waitFor()
      const source = await block.locator('pre.shiki').elementHandle()
      expect(await block.locator('pre code').textContent()).toBe(SVG)
      expect(await block.getByRole('button', { name: 'Enlarge preview', exact: true }).count()).toBe(0)
      expect(await sourceView.getAttribute('aria-hidden')).toBeNull()
      const numbers = block.getByRole('button', { name: 'Line numbers', exact: true })
      await numbers.click()
      expect(await numbers.getAttribute('aria-pressed')).toBe('true')
      expect(await block.getAttribute('data-line-numbers')).toBe('true')
      expect(await source!.evaluate(node => node.isConnected)).toBe(true)
      const copy = block.getByRole('button', { name: 'Copy', exact: true })
      const selectionGeometry = () => sourceButton.evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return { width: rect.width, height: rect.height, right: node.closest('.md-code-block')!.getBoundingClientRect().right - rect.right }
      })
      const toolbarBefore = await selectionGeometry()
      await copy.click()
      await block.getByRole('button', { name: 'Copied', exact: true }).waitFor()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SVG)
      expect(await selectionGeometry()).toEqual(toolbarBefore)
      const sourceHeight = (await block.locator('[data-code-block-content]').boundingBox())!.height
      expect(sourceHeight).toBeCloseTo(previewHeight, 0)
      await block.getByRole('button', { name: 'Preview', exact: true }).click()
      expect(await source!.evaluate(node => node.isConnected)).toBe(true)
      expect(await sourceView.getAttribute('aria-hidden')).toBe('true')
      expect((await previewLayer.boundingBox())!.height).toBeCloseTo(sourceHeight, 0)
      expect(await imgNode!.evaluate(node => node.isConnected)).toBe(true)
      expect(await block.locator('[data-code-block-resize]').count()).toBe(0)
      await page.setViewportSize({ width: 360, height: 800 })
      await image.waitFor({ state: 'visible' })
      expect((await block.boundingBox())!.width).toBeLessThanOrEqual(360)
    } finally {
      await page.close()
    }
  })

  it.skipIf(MODE === 'record')('fades only preview toolbar opacity and reveals it for hover or keyboard focus', async () => {
    const page = await newEnglishPage(browser)
    try {
      await openConversation(page, scaffold)
      const block = page.locator('.md-code-block').first()
      await block.getByRole('img', { name: 'Mermaid diagram', exact: true }).evaluate(async (node: HTMLImageElement) => { await node.decode() })
      const toolbar = block.locator('[data-code-block-banner]').locator('..')
      await block.hover()
      await expect.poll(() => toolbar.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
      const shown = await block.boundingBox()
      const toolbarBox = await toolbar.boundingBox()
      await page.mouse.move(0, 0)
      await expect.poll(() => toolbar.evaluate(node => getComputedStyle(node).opacity)).toBe('0')
      expect(await block.boundingBox()).toEqual(shown)
      expect(await toolbar.boundingBox()).toEqual(toolbarBox)
      expect(await toolbar.evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0.16s')
      await block.getByRole('button', { name: 'Source', exact: true }).focus()
      await page.keyboard.press('Shift+Tab')
      await expect.poll(() => toolbar.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
      await block.getByRole('button', { name: 'Source', exact: true }).click()
      await page.getByRole('heading', { name: 'Mermaid previews' }).click()
      await page.mouse.move(0, 0)
      expect(await toolbar.evaluate(node => getComputedStyle(node).opacity)).toBe('1')
      expect(await block.locator('[data-code-block-resize]').count()).toBe(0)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      expect(await toolbar.evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s')
    } finally {
      await page.close()
    }
  })

  it.skipIf(MODE === 'record')('highlights diagram source with theme tokens', async () => {
    const page = await newEnglishPage(browser)
    try {
      await openConversation(page, scaffold)
      const trees = []
      for (const [index, language, source] of [[0, 'mermaid', FLOW], [4, 'dot', DOT], [5, 'svg', SVG]] as const) {
        const block = page.locator('.md-code-block').nth(index)
        await block.scrollIntoViewIfNeeded()
        await block.getByRole('button', { name: 'Source', exact: true }).click()
        await block.locator('pre.shiki').waitFor()
        expect(await block.locator('pre code').textContent()).toBe(source)
        const lines = await block.locator('pre.shiki .line').evaluateAll(nodes => nodes.map(line =>
          [...line.querySelectorAll('span')].map(span => ({ text: span.textContent, style: span.style.cssText })),
        ))
        expect(new Set(lines.flat().map(span => span.style)).size).toBeGreaterThan(1)
        trees.push({ language, lines })
      }
      await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'source-highlight.expected.md'), JSON.stringify(trees, null, 2), MODE)
    } finally {
      await page.close()
    }
  })

  it.skipIf(MODE === 'record').each(['light', 'dark'] as const)(
    'fits diagram previews to image dimensions within viewport limits in %s mode', async (scheme) => {
      const page = await newEnglishPage(browser)
      try {
        await page.emulateMedia({ colorScheme: scheme })
        await openConversation(page, scaffold)
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(scheme)
        await showAllPreviews(page)


        for (const title of ['Mermaid diagram', 'Graphviz diagram', 'SVG preview']) {
          const image = page.getByRole('img', { name: title, exact: true }).first()
          await image.evaluate(async (node: HTMLImageElement) => { await node.decode() })
          const geometry = await image.evaluate((node) => {
            const block = node.closest('.md-code-block')!
            const source = block.querySelector<HTMLElement>('[data-code-block-source-view]')!
            const preview = block.querySelector<HTMLElement>('[data-code-block-preview]')!
            return {
              image: node.getBoundingClientRect().height,
              source: source.closest('.md-code-block')!.querySelector('[data-code-block-content]')!.getBoundingClientRect().height,
              preview: preview.getBoundingClientRect().height,
              client: preview.clientHeight,
              scroll: preview.scrollHeight,
            }
          })
          expect(geometry.image).toBeGreaterThan(0)
          expect(geometry.preview).toBeCloseTo(geometry.source, 0)
          expect(geometry.scroll).toBeGreaterThanOrEqual(geometry.client)
          expect(geometry.image).toBeLessThanOrEqual(600)
          expect(geometry.preview).toBeCloseTo(Math.max(120, geometry.image + 32), 0)
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
          sourceHeight: node.closest('.md-code-block')!.querySelector<HTMLElement>('[data-code-block-content]')!.getBoundingClientRect().height,
          previewHeight: node.closest('.md-code-block')!.querySelector<HTMLElement>('[data-code-block-preview]')!.getBoundingClientRect().height,
          ratio: node.naturalWidth / node.naturalHeight,
        }))
        expect(compact.width / compact.height).toBeCloseTo(compact.ratio, 1)
        expect(compact.previewHeight).toBeCloseTo(compact.sourceHeight, 0)
      } finally {
        await page.close()
      }
    },
  )

  it.skipIf(MODE === 'record')('updates existing diagrams when the document switches between light and dark', async () => {
    const page = await newEnglishPage(browser)
    try {
      await openConversation(page, scaffold)
      await page.locator('.md-code-block').first().getByRole('button', { name: 'Preview', exact: true }).click()
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
    const first = page.locator('.md-code-block').first()
    const invalid = page.locator('.md-code-block').nth(2)
    await invalid.getByRole('status').filter({ hasText: 'Unable to render this diagram' }).waitFor()
    await invalid.getByRole('button', { name: 'Source', exact: true }).click()
    expect((await invalid.locator('[data-code-block-content]').boundingBox())!.height).toBeCloseTo(120, 0)
    await invalid.getByRole('button', { name: 'Preview', exact: true }).click()
    expect(await first.locator('pre').count()).toBe(0)
    expect(await first.locator('[data-code-block-source-view]').getAttribute('aria-hidden')).toBe('true')
    expect(await first.getByText('mermaid', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Preview', exact: true }).count()).toBe(6)
    const html = page.locator('.md-code-block').nth(6)
    expect(await html.locator('pre code').textContent()).toBe(HTML)
    expect(await html.getByRole('button', { name: 'Preview', exact: true }).count()).toBe(0)
    const image = first.getByRole('img', { name: 'Mermaid diagram', exact: true })
    await image.evaluate(async (node: HTMLImageElement) => { await node.decode() })
    const diagram = await image.elementHandle()
    const layout = await first.evaluate((block) => {
      const source = block.querySelector<HTMLElement>('[data-code-block-source-view]')!
      const preview = block.querySelector<HTMLElement>('[data-code-block-preview]')!
      return {
        block: block.getBoundingClientRect().height,
        source: source.closest('.md-code-block')!.querySelector('[data-code-block-content]')!.getBoundingClientRect().height,
        preview: preview.getBoundingClientRect().height,
        width: block.getBoundingClientRect().width,
      }
    })
    expect(layout.preview).toBeCloseTo(layout.source, 0)
    await first.getByRole('button', { name: 'Enlarge preview', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Mermaid diagram', exact: true })
    const enlarged = dialog.getByRole('img', { name: 'Mermaid diagram', exact: true })
    const enlargedGeometry = await enlarged.evaluate((node: HTMLImageElement) => ({
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
      ratio: node.naturalWidth / node.naturalHeight,
    }))
    const viewport = page.viewportSize()!
    expect(enlargedGeometry.width).toBeGreaterThan(layout.width)
    expect(enlargedGeometry.width / enlargedGeometry.height).toBeCloseTo(enlargedGeometry.ratio, 1)
    expect(Math.max(enlargedGeometry.width / (viewport.width * 0.88), enlargedGeometry.height / (viewport.height * 0.84))).toBeCloseTo(1, 2)
    const fitted = (await enlarged.boundingBox())!
    expect(fitted.x).toBeGreaterThanOrEqual(viewport.width * 0.06 - 1)
    expect(fitted.y).toBeGreaterThanOrEqual(viewport.height * 0.08 - 1)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'lightbox.expected.md'), await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    const anchor = { x: fitted.x + fitted.width * 0.6, y: fitted.y + fitted.height * 0.6 }
    await page.mouse.move(anchor.x, anchor.y)
    await page.mouse.wheel(0, -360)
    await expect.poll(async () => (await enlarged.boundingBox())!.width).toBeGreaterThan(fitted.width * 1.5)
    const zoomed = (await enlarged.boundingBox())!
    expect((anchor.x - zoomed.x) / zoomed.width).toBeCloseTo(0.6, 2)
    expect((anchor.y - zoomed.y) / zoomed.height).toBeCloseTo(0.6, 2)
    await page.mouse.down()
    await page.mouse.move(anchor.x + 100, anchor.y + 60, { steps: 15 })
    await page.mouse.up()
    const panned = (await enlarged.boundingBox())!
    expect(panned.x - zoomed.x).toBeCloseTo(100, 0)
    expect(panned.y - zoomed.y).toBeCloseTo(60, 0)
    expect(panned.width).toBeCloseTo(zoomed.width, 2)
    await page.mouse.dblclick(viewport.width / 2, viewport.height / 2)
    await expect.poll(async () => (await enlarged.boundingBox())!.width).toBe(fitted.width)
    expect((await enlarged.boundingBox())!.x).toBe(fitted.x)
    expect(await image.getAttribute('src')).toBe(await enlarged.getAttribute('src'))
    await dialog.getByRole('button', { name: 'Close preview', exact: true }).click()
    await showAllPreviews(page)
    const images = page.getByRole('img', { name: 'Mermaid diagram' })
    await expect.poll(() => images.count(), { timeout: 20_000 }).toBe(3)
    await expect.poll(() => images.evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).naturalWidth > 0))).toBe(true)
    expect(await images.evaluateAll(nodes => nodes.every(node =>
      node.getBoundingClientRect().width <= (node as HTMLImageElement).naturalWidth))).toBe(true)
    expect(await page.getByRole('status').filter({ hasText: 'Unable to render this diagram. Select Source to inspect the code.' }).count()).toBe(1)
    const failed = page.locator('.md-code-block').filter({ has: page.locator('[role="status"]') })
    await failed.getByRole('button', { name: 'Source', exact: true }).click()
    expect(await failed.locator('pre code').textContent()).toBe(INVALID)
    await failed.getByRole('button', { name: 'Preview', exact: true }).click()
    expect(await images.first().evaluate(node => decodeURIComponent((node as HTMLImageElement).src))).toContain('共享渲染器')
    await first.getByRole('button', { name: 'Copy', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FLOW)
    await first.getByRole('button', { name: 'Source', exact: true }).focus()
    await page.keyboard.press('Enter')
    expect(await first.getByRole('button', { name: 'Source', exact: true })
      .evaluate(node => node === document.activeElement)).toBe(true)
    expect(await first.locator('pre code').textContent()).toBe(FLOW)
    expect(await diagram!.evaluate(node => node.isConnected && getComputedStyle(node).visibility === 'hidden')).toBe(true)
    await first.getByRole('button', { name: 'Preview', exact: true }).click()
    await first.getByRole('img', { name: 'Mermaid diagram' }).waitFor()
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
    expect(await page.getByRole('button', { name: '预览', exact: true }).count()).toBe(6)
    const first = page.locator('.md-code-block').first()
    expect(await first.locator('pre').count()).toBe(0)
    expect(await first.locator('[data-code-block-source-view]').getAttribute('aria-hidden')).toBe('true')
    await first.getByRole('button', { name: '预览', exact: true }).click()
    const firstImage = page.getByRole('img', { name: 'Mermaid 图表' }).first()
    await expect.poll(() => firstImage.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await first.getByRole('button', { name: '放大预览', exact: true }).click()
    await page.getByRole('dialog', { name: 'Mermaid 图表' }).waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'zh-lightbox.expected.md'), await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), MODE)
    await page.keyboard.press('Escape')
    expect(await first.getByRole('button', { name: '源码', exact: true }).textContent()).toBe('源码')
    expect(await first.getByRole('button', { name: '复制', exact: true }).getAttribute('aria-label')).toBe('复制')
    await showAllPreviews(page, '预览')
    await page.getByRole('status').filter({ hasText: '无法渲染此图表，可切换到源码查看。' }).waitFor()
    const snapshot = await captureStableAria(page, DIAGRAM_MESSAGE, scaffold.workspaceCwd)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'zh.expected.md'), snapshot, MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'zh.expected.md', 'source-highlight.expected.md', 'lightbox.expected.md', 'zh-lightbox.expected.md'])
    await page.close()
  }, 60_000)

  it.skipIf(MODE === 'record')('rejects native Mermaid image nodes before requests and renders the next diagram', async () => {
    const page = await newEnglishPage(browser)
    let imageScaffold: WebScaffold | undefined
    const requests: string[] = []
    try {
      await page.route('https://preview.invalid/**', async (route) => {
        requests.push(route.request().url())
        await route.abort()
      })
      imageScaffold = await launchWebScaffold({})
      await seedSession(imageScaffold, fixture([
        'flowchart LR\n  A@{ img: "https://preview.invalid/mermaid-image", h: 80 }', FLOW,
      ]), SEED_ID)
      await openConversation(page, imageScaffold)
      await page.locator('.md-code-block').first().getByRole('status')
        .filter({ hasText: 'Unable to render this diagram' }).waitFor()
      const image = page.getByRole('img', { name: 'Mermaid diagram', exact: true })
      await image.evaluate(async (node: HTMLImageElement) => { await node.decode() })
      expect(requests).toEqual([])
    } finally {
      await page.close()
      await imageScaffold?.close()
    }
  }, 60_000)

  it.skipIf(MODE === 'record')('previews inert DOT and SVG images', async () => {
    const page = await newEnglishPage(browser)
    const requests: string[] = []
    const dialogs: string[] = []
    // A data-URL SVG image must not fetch source-authored external resources.
    await page.route('https://preview.invalid/**', async (route) => {
      requests.push(route.request().url())
      await route.abort()
    })
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss() })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await openConversation(page, scaffold)
    for (const [index, title, code] of [[4, 'Graphviz diagram', DOT], [5, 'SVG preview', SVG]] as const) {
      const block = page.locator('.md-code-block').nth(index)
      await block.getByRole('button', { name: 'Preview', exact: true }).click()
      const preview = block.getByRole('img', { name: title, exact: true })
      await preview.waitFor()
      await expect.poll(() => preview.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await block.getByRole('button', { name: 'Copy', exact: true }).click()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code)
      await block.getByRole('button', { name: 'Source', exact: true }).click()
      expect(await block.locator('pre code').textContent()).toBe(code)
      await block.getByRole('button', { name: 'Preview', exact: true }).click()
      await preview.waitFor()
    }
    expect(await page.locator('body').getAttribute('data-preview-escaped')).toBeNull()
    expect(dialogs).toEqual([])
    expect(requests).toEqual([])
    const notices = await page.request.get(new URL('/preview-third-party-notices.txt', scaffold.authenticatedUrl).href)
    expect(notices.ok()).toBe(true)
    expect(await notices.text()).toContain('Eclipse Public License - v 2.0')
    await page.close()
  })
})
