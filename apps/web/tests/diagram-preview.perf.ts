/** Manual built-Web diagnostic for offscreen diagrams and visible theme refreshes; no timing budgets. */
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, release } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

const SAMPLE_COUNT = 3
const DIAGRAM_COUNT = 20
const TAIL_PARAGRAPHS = 40
const OBSERVATION_MS = 3_000
const SESSION_ID = 'diagram-preview-performance'
const TITLE = 'DIAGRAM_PREVIEW_PERF'
const TAIL = 'DIAGRAM_PREVIEW_TAIL'
const PREVIEW = '[data-code-block-preview]'
const PROBE_KEY = '__dshDiagramPreviewPerf'

interface LongTask {
  readonly startTime: number
  readonly duration: number
}

interface Frame {
  readonly elapsedMs: number
  readonly height: number
  readonly placeholder: boolean
}

interface Probe {
  start?: number
  opportunity?: number
  oldSrc?: string
  trustedClick?: boolean
  frames: Frame[]
  longTasks: LongTask[]
  observer: PerformanceObserver
  raf: number
}

function fixture(): string {
  const session = Session.create(SessionId(SESSION_ID))
  session.append('turn/start', { turn: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Inspect this synthetic diagram history.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: TITLE, messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('step/start', { turn: 1, step: 1 })
  const diagrams = Array.from({ length: DIAGRAM_COUNT }, (_, index) => [
    `Diagram ${index + 1}`,
    '```mermaid',
    'flowchart TD',
    `  A[Request ${index + 1}] --> B[Read history]`,
    '  B --> C{Cached}',
    '  C --> D[Load source]',
    '  C --> E[Reuse source]',
    '  D --> F[Parse]',
    '  E --> F',
    '  F --> G[Layout]',
    '  G --> H[Draw]',
    '  H --> I{Loaded}',
    '  I --> J[Display]',
    '  I --> D',
    '  E --> G',
    '```',
  ].join('\n'))
  const paragraphs = Array.from({ length: TAIL_PARAGRAPHS }, (_, index) =>
    `History note ${index + 1}. This ordinary paragraph keeps the diagrams above the initial reading position. `
    + 'The reader can inspect the completed discussion without opening a chart.')
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: createAssistantMessage({
      content: [{ type: 'text', text: [...diagrams, ...paragraphs, TAIL].join('\n\n') }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
    usage: { inputTokens: 20, outputTokens: 2_000 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({
    type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0,
  }), ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

async function installProbe(phase: 'open' | 'theme', target: Locator): Promise<void> {
  await target.evaluate((node, options) => {
    const longTasks: LongTask[] = []
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push({ startTime: entry.startTime, duration: entry.duration })
    })
    observer.observe({ type: 'longtask' })
    const probe: Probe = { frames: [], longTasks, observer, raf: 0 }
    Reflect.set(globalThis, options.key, probe)
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect()
      const scroll = document.querySelector('[data-conversation-scroll]')?.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && rect.bottom > (scroll?.top ?? 0) && rect.top < (scroll?.bottom ?? innerHeight)
    }
    const frame = (): void => {
      if (probe.start === undefined) return
      let ready = false
      if (options.phase === 'open') {
        const tail = Array.from(document.querySelectorAll('[data-conversation-scroll] p'))
          .find(element => element.textContent === options.tail)
        ready = tail !== undefined && visible(tail)
      } else {
        const preview = document.querySelectorAll(options.preview)[options.diagramCount - 1]
        if (preview === undefined) throw new Error('theme probe has no last diagram')
        probe.frames.push({
          elapsedMs: performance.now() - probe.start,
          height: preview.getBoundingClientRect().height,
          placeholder: Array.from(preview.querySelectorAll('[data-preview-placeholder]')).some(visible),
        })
        ready = Array.from(preview.querySelectorAll('img')).some(image =>
          image.src !== probe.oldSrc && image.complete && image.naturalWidth > 0 && visible(image))
      }
      if (ready && probe.opportunity === undefined) {
        // The second callback is a rendering opportunity, not hardware presentation.
        probe.opportunity = -1
        requestAnimationFrame(() => {
          requestAnimationFrame(() => { probe.opportunity = performance.now() })
        })
      }
      probe.raf = requestAnimationFrame(frame)
    }
    if (options.phase === 'open') {
      node.addEventListener('click', (event) => {
        probe.trustedClick = event.isTrusted
        probe.start = performance.now()
        probe.raf = requestAnimationFrame(frame)
      }, { capture: true, once: true })
    } else {
      const image = node.querySelector('img')
      if (image === null) throw new Error('theme probe has no loaded image')
      probe.oldSrc = image.src
      probe.start = performance.now()
      probe.raf = requestAnimationFrame(frame)
    }
  }, { phase, key: PROBE_KEY, preview: PREVIEW, diagramCount: DIAGRAM_COUNT, tail: TAIL })
}

async function collectProbe(page: Page) {
  try {
    await page.waitForFunction(({ key, windowMs }) => {
      const probe = Reflect.get(globalThis, key) as Probe
      return probe.start !== undefined && (probe.opportunity ?? -1) > 0
        && performance.now() - probe.start >= windowMs
    }, { key: PROBE_KEY, windowMs: OBSERVATION_MS }, { timeout: 30_000 })
  } catch (error) {
    const diagnostic = await page.evaluate(({ key, previewSelector }) => {
      const probe = Reflect.get(globalThis, key) as Probe
      const preview = Array.from(document.querySelectorAll(previewSelector)).at(-1)
      const bounds = (element: Element | null | undefined) => {
        const rect = element?.getBoundingClientRect()
        return rect === undefined ? null : { top: rect.top, bottom: rect.bottom, height: rect.height }
      }
      return {
        opportunity: probe.opportunity,
        frames: probe.frames.slice(-5),
        theme: getComputedStyle(document.documentElement).colorScheme,
        scroll: bounds(document.querySelector('[data-conversation-scroll]')),
        preview: bounds(preview),
        images: Array.from(preview?.querySelectorAll('img') ?? []).map(image => ({
          sameSource: image.src === probe.oldSrc, complete: image.complete, naturalWidth: image.naturalWidth,
          hidden: image.hidden, rect: bounds(image),
        })),
      }
    }, { key: PROBE_KEY, previewSelector: PREVIEW })
    throw new Error(`diagram probe endpoint unavailable: ${JSON.stringify(diagnostic)}`, { cause: error })
  }
  return await page.evaluate(({ key, windowMs, previewSelector }) => {
    const probe = Reflect.get(globalThis, key) as Probe
    probe.observer.disconnect()
    cancelAnimationFrame(probe.raf)
    Reflect.deleteProperty(globalThis, key)
    if (probe.start === undefined || probe.opportunity === undefined) throw new Error('incomplete diagram probe')
    const start = probe.start
    const stop = start + windowMs
    const tasks = probe.longTasks.filter(task => task.startTime < stop && task.startTime + task.duration > start)
    const scripts = performance.getEntriesByType('resource').filter((entry): entry is PerformanceResourceTiming =>
      entry instanceof PerformanceResourceTiming && new URL(entry.name).pathname.endsWith('.js')
      && entry.startTime >= start && entry.startTime < stop)
      .map(entry => ({
        path: new URL(entry.name).pathname,
        transferBytes: entry.transferSize,
        encodedBytes: entry.encodedBodySize,
        decodedBytes: entry.decodedBodySize,
        durationMs: entry.duration,
      }))
    const previews = Array.from(document.querySelectorAll(previewSelector))
    const scrollRect = document.querySelector('[data-conversation-scroll]')?.getBoundingClientRect()
    const intersectingPreviews = previews.filter((preview) => {
      const rect = preview.getBoundingClientRect()
      return rect.bottom > (scrollRect?.top ?? 0) && rect.top < (scrollRect?.bottom ?? innerHeight)
    }).length
    const frames = probe.frames.filter(frame => frame.elapsedMs < windowMs)
    return {
      opportunityMs: probe.opportunity - start,
      observedMs: performance.now() - start,
      trustedClick: probe.trustedClick,
      longTaskMs: tasks.reduce((sum, task) => sum + Math.max(0,
        Math.min(stop, task.startTime + task.duration) - Math.max(start, task.startTime)), 0),
      longTasks: tasks.map(task => ({ startMs: task.startTime - start, durationMs: task.duration })),
      loadedDiagramImages: previews.flatMap(preview => Array.from(preview.querySelectorAll('img')))
        .filter(image => image.complete && image.naturalWidth > 0).length,
      previewCount: previews.length,
      intersectingPreviews,
      scriptTransferBytes: scripts.reduce((sum, script) => sum + script.transferBytes, 0),
      scriptEncodedBytes: scripts.reduce((sum, script) => sum + script.encodedBytes, 0),
      scripts,
      frames,
      heightMin: frames.length === 0 ? null : Math.min(...frames.map(frame => frame.height)),
      heightMax: frames.length === 0 ? null : Math.max(...frames.map(frame => frame.height)),
      placeholderFrames: frames.filter(frame => frame.placeholder).length,
    }
  }, { key: PROBE_KEY, windowMs: OBSERVATION_MS, previewSelector: PREVIEW })
}

async function sample() {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    scaffold = await launchWebScaffold()
    await seedSession(scaffold, fixture(), SESSION_ID)
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.emulateMedia({ colorScheme: 'light' })
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const group = page.getByRole('treeitem').first()
    await group.waitFor({ timeout: 30_000 })
    await group.click()
    const session = page.getByRole('treeitem').nth(1)
    await session.waitFor({ timeout: 30_000 })
    const bootScriptBytes = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming
        && new URL(entry.name).pathname.endsWith('.js'))
      .reduce((sum, entry) => sum + entry.transferSize, 0))
    await installProbe('open', session)
    await session.click()
    const open = await collectProbe(page)
    expect(open.trustedClick).toBe(true)
    expect(open.previewCount).toBe(DIAGRAM_COUNT)
    expect(open.intersectingPreviews).toBe(0)
    const last = page.locator(PREVIEW).last()
    await last.scrollIntoViewIfNeeded()
    await expect.poll(() => last.locator('img').evaluateAll(images => images.some((node) => {
      const image = node as HTMLImageElement
      return image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().height > 0
    }))).toBe(true)
    // Earlier cold previews may grow after the placeholder was scrolled into view.
    await last.scrollIntoViewIfNeeded()
    await expect.poll(() => last.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const scroll = document.querySelector('[data-conversation-scroll]')!.getBoundingClientRect()
      return rect.bottom > scroll.top && rect.top < scroll.bottom
    }), { timeout: 30_000 }).toBe(true)
    await installProbe('theme', last)
    await page.emulateMedia({ colorScheme: 'dark' })
    const theme = await collectProbe(page)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
    expect(tripwire.pageErrors).toEqual([])
    return { browser: browser.version(), bootScriptBytes, open, theme, consoleWarnings: tripwire.warnings }
  } finally {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  }
}

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
}

describe('manual web performance: diagram previews', () => {
  it('reports cold offscreen opening and a visible theme refresh', async () => {
    if (webSnapshotMode() !== 'replay') throw new Error('diagram performance requires keyless replay mode')
    const directory = join(REPO_ROOT, '.playwright-mcp/preview-perf', new Date().toISOString().replaceAll(':', '-'))
    await mkdir(directory, { recursive: true })
    const samples: Awaited<ReturnType<typeof sample>>[] = []
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      const result = await sample()
      samples.push(result)
      await writeFile(join(directory, `sample-${index + 1}.json`), `${JSON.stringify(result, null, 2)}\n`)
      console.log(JSON.stringify({ sample: index + 1, openMs: result.open.opportunityMs, themeMs: result.theme.opportunityMs }))
    }
    const summary = {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
      runtime: { node: process.version, platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model },
      workload: {
        diagrams: DIAGRAM_COUNT, nodesPerDiagram: 10, edgesPerDiagram: 12,
        tailParagraphs: TAIL_PARAGRAPHS, viewport: [1680, 1000], observationMs: OBSERVATION_MS,
      },
      semantics: 'Fresh Chromium and private shipped-composition scaffold per sample; built Client with source-resolved test Host. Opening starts at trusted session click; theme starts immediately before media emulation. Endpoints require visible output and two animation-frame opportunities. Long tasks are clipped to the fixed observation window. Samples include local transport, no model call. No memory or hardware-presentation measurement and no timing verdict.',
      medians: Object.fromEntries((['open', 'theme'] as const).map(phase => [phase, {
        opportunityMs: median(samples.map(sample => sample[phase].opportunityMs)),
        longTaskMs: median(samples.map(sample => sample[phase].longTaskMs)),
        scriptTransferBytes: median(samples.map(sample => sample[phase].scriptTransferBytes)),
        loadedDiagramImages: median(samples.map(sample => sample[phase].loadedDiagramImages)),
        placeholderFrames: median(samples.map(sample => sample[phase].placeholderFrames)),
      }])),
      samples,
    }
    await writeFile(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(JSON.stringify({ directory, medians: summary.medians }))
  })
})
