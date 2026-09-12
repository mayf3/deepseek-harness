/** External browser/Stagehand fixture; DSH registries, tools, logging, and model calls remain real. */

import type { ClientLLM } from '@browserbasehq/stagehand'
import { z } from 'zod'

/** Valid PNG for the real attachment admission path. */
export const screenshotBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'

/** Controllable external operations and acquired browser handles. */
export const fixture: {
  browsers: FixtureBrowser[]
  createError?: Error
  create?: (model: ClientLLM) => Promise<void>
  navigate?: (page: FixturePage) => Promise<void>
  browserClose?: () => Promise<void>
  actResult?: { success: boolean; message: string }
  interrupt?: Promise<void>
  stagehandClose?: () => void
} = { browsers: [] }

/** Reset fixture state after the previous test has closed its contexts. */
export function resetFixture(): void {
  fixture.browsers = []
  delete fixture.createError
  delete fixture.create
  delete fixture.navigate
  delete fixture.browserClose
  delete fixture.actResult
  delete fixture.interrupt
  delete fixture.stagehandClose
}

/** A browser tab with only the operations exercised by the provider. */
export class FixturePage {
  currentURL = 'about:blank'
  constructor(readonly owner: FixtureBrowser, readonly pageId: string) {}
  async goto(url: string): Promise<void> { this.currentURL = url; await fixture.navigate?.(this) }
  async url(): Promise<string> { return this.currentURL }
  async title(): Promise<string> { return 'Fixture heading' }
  async screenshot(): Promise<Buffer> { return Buffer.from(screenshotBase64, 'base64') }
  async close(): Promise<void> { this.owner.pages = this.owner.pages.filter(page => page !== this) }
}

/** Acquired browser with independently owned tabs and close state. */
export class FixtureBrowser {
  pages: FixturePage[] = []
  active: FixturePage
  closed = false
  stagehandClosed = false
  readonly context = {
    pages: async (): Promise<FixturePage[]> => this.pages,
    activePage: async (): Promise<FixturePage | undefined> => this.pages.includes(this.active) ? this.active : this.pages[0],
    newPage: async (url?: string): Promise<FixturePage> => {
      const page = new FixturePage(this, `tab-${this.pages.length + 1}`)
      if (url) page.currentURL = url
      this.pages.push(page)
      this.active = page
      return page
    },
    setActivePage: async (page: FixturePage): Promise<void> => { this.active = page },
  }
  constructor(readonly origin: 'launched' | 'connected', readonly options: unknown) {
    this.active = new FixturePage(this, 'tab-1')
    this.pages.push(this.active)
  }
  async close(): Promise<void> { await fixture.browserClose?.(); this.closed = true }
}

/** Only the external SDK acquisition operations are mocked. */
export const localBrowser = {
  async launch(options: unknown): Promise<FixtureBrowser> {
    const browser = new FixtureBrowser('launched', options)
    fixture.browsers.push(browser)
    return browser
  },
  async connect(options: unknown): Promise<FixtureBrowser> {
    const browser = new FixtureBrowser('connected', options)
    fixture.browsers.push(browser)
    return browser
  },
}

/** Native wrapper that exercises the public custom-generation callback. */
export class Stagehand {
  private readonly closed: PromiseWithResolvers<void> = Promise.withResolvers()
  constructor(readonly browser: FixtureBrowser, readonly model: ClientLLM) {}
  static async create(options: { browser: FixtureBrowser; model: ClientLLM }): Promise<Stagehand> {
    await fixture.create?.(options.model)
    if (fixture.createError) throw fixture.createError
    return new Stagehand(options.browser, options.model)
  }
  async close(): Promise<void> { this.browser.stagehandClosed = true; fixture.stagehandClose?.(); this.closed.resolve() }
  async extract(instruction: string, schemaOrOptions: unknown, _options?: unknown): Promise<unknown> {
    const schema = schemaOrOptions instanceof z.ZodType
      ? z.toJSONSchema(schemaOrOptions)
      : { type: 'object', properties: { extraction: { type: 'string' } }, required: ['extraction'], additionalProperties: false }
    const inference = this.model.generate({
      messages: [{ role: 'user', content: { type: 'text', text: 'Page heading: Fixture heading' } }],
      systemPrompt: instruction,
      responseFormat: { type: 'json_schema', name: 'extract', schema: z.json().parse(schema) },
    })
    const result = await Promise.race([
      inference,
      (fixture.interrupt ?? this.closed.promise).then(() => { throw new Error('Fixture browser disconnected') }),
    ])
    if (result.outputFormat !== 'json_schema') throw new Error('Fixture expected structured output')
    return { data: result.structuredContent }
  }
  async observe(instruction: string, options: unknown): Promise<unknown> { return this.extract(instruction, options) }
  async act(instruction: string, options: unknown): Promise<{ data: { success: boolean; message: string } }> {
    await this.extract(instruction, options)
    return { data: fixture.actResult ?? { success: true, message: 'Fixture action completed' } }
  }
}
