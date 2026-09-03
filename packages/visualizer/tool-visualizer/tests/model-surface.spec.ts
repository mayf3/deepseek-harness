import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, scopeOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import * as VisualizerClient from '../src/client.ts'
import VisualizerService from '../src/index.ts'
import * as VisualizerModel from '../src/model.ts'
import { visualizerSystemPrompt } from '../src/prompt.ts'
import type { Config } from '../src/types.ts'

const SIGNAL = new AbortController().signal
const SCOPED_BASES = new WeakMap<Context, Context>()

async function captureScopedBase(ctx: Context): Promise<void> {
  await ctx.plugin(Object.assign((inner: Context) => {
    SCOPED_BASES.set(ctx, inner)
  }, { inject: ['systemPrompt', 'tools'] }))
}

async function mount(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const authorityFiber = await ctx.plugin(VisualizerService, config)
  await captureScopedBase(ctx)
  const base = SCOPED_BASES.get(ctx)
  if (base === undefined) throw new Error('missing scoped test base')
  const presetKey: ScopeKey = { agentPreset: 'surface' }
  const presetScope = createScope(base, presetKey)
  const modelFiber = await presetScope.ctx.plugin(VisualizerModel)
  const agent = recordedAgent(ctx, 'surface-agent', undefined, undefined, presetKey)
  ctx.agents.register(agent)
  return { ctx, authorityFiber, modelFiber, presetScope, agent }
}

async function construct(config: Config) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await captureScopedBase(ctx)
  return {
    ctx,
    service: new VisualizerService(ctx, config),
  }
}

async function modelFace(ctx: Context, agent: Agent) {
  const prompt = await ctx.systemPrompt.assemble({ agent, scope: agent })
  const names = ['widget_guidelines', 'show_widget']
    .filter(name => ctx.tools.get(name, agent) !== undefined)
  const guidance = await ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId('snapshot-guidance'),
    name: 'widget_guidelines',
    arguments: { modules: ['diagram', 'mockup', 'interactive', 'chart', 'illustration'] },
    agent,
  })
  const receipt = await ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId('snapshot-widget'),
    name: 'show_widget',
    arguments: {
      title: 'Snapshot',
      widget_code: '<button>Choose</button>',
    },
    agent,
  })
  return {
    prompt: prompt.sections.find(section => section.name === 'tool:visualizer')?.text,
    tools: Object.fromEntries(names.map((name) => {
      const tool = ctx.tools.get(name, agent)
      if (tool === undefined) throw new Error(`missing Visualizer tool ${name}`)
      return [name, { description: tool.description, parameters: tool.parameters, output: tool.output.schema }]
    })),
    results: { guidance: guidance.content, show_widget: receipt.content },
  }
}

function recordedAgent(
  ctx: Context,
  id: string,
  followup: Agent['followup'] = vi.fn<Agent['followup']>(),
  source = '<button>Choose</button><script></script>',
  presetParent?: ScopeKey,
): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const call = session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId('widget'),
    name: 'show_widget',
    arguments: JSON.stringify({ title: 'Choice', widget_code: source }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId('widget'), content: [], isError: false }),
    meta: { kind: /^<svg(?=[\s/>])/i.test(source.trimStart()) ? 'svg' : 'html' },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const agent = { id: session.id, session, ctx, followup } as unknown as Agent
  const scope = createScope(
    SCOPED_BASES.get(ctx) ?? ctx,
    agent,
    presetParent === undefined ? undefined : { parent: presetParent },
  )
  Object.assign(agent, { ctx: scope.ctx.extend({ agent }) })
  return agent
}

describe('Visualizer model surface', () => {
  it('ships one neutral SVG and HTML model surface when mounted', async () => {
    const { ctx, agent } = await mount()
    expect(await modelFace(ctx, agent)).toMatchSnapshot()
    const prompt = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(prompt.sections.find(section => section.name === 'tool:visualizer')?.text)
      .toBe(visualizerSystemPrompt())

    const guidance = ctx.tools.get('widget_guidelines', agent)!
    const show = ctx.tools.get('show_widget', agent)!
    expect(ctx.tools.schemas()).toEqual([])
    const mockupGuidelines = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('mockup'),
      name: 'widget_guidelines',
      arguments: { modules: ['mockup'] },
      agent,
    })
    const mockupGuidelineText = mockupGuidelines.content
      .flatMap(item => item.type === 'text' ? [item.text] : [])
      .join('\n')
    expect(mockupGuidelineText).toContain('native controls')
    const interactiveGuidelines = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('interactive'),
      name: 'widget_guidelines',
      arguments: { modules: ['interactive'] },
      agent,
    })
    const interactiveGuidelineText = interactiveGuidelines.content
      .flatMap(item => item.type === 'text' ? [item.text] : [])
      .join('\n')
    expect(interactiveGuidelineText).toContain('window.dshWidget.sendPrompt')
    expect(interactiveGuidelineText).toContain('Call show_widget next')
    expect(visualizerSystemPrompt()).toContain('choose presentation details yourself')
    expect(visualizerSystemPrompt()).toContain('use no file, shell, editing, or preview step')
    expect(interactiveGuidelineText).toContain('one primary control per value')
    expect(interactiveGuidelineText).toContain('Give every control a clear label')
    expect(interactiveGuidelineText).not.toContain('window.dshWidget.onInit')
    expect(interactiveGuidelineText).not.toContain('window.dshWidget.reportState')
    expect(guidance.parameters).toEqual({
      type: 'object',
      properties: {
        modules: {
          type: 'array',
          items: { type: 'string', enum: ['diagram', 'mockup', 'interactive', 'chart', 'illustration'] },
          description: 'Choose every module that fits the requested result. diagram: a fixed view of nodes and relationships. chart: quantitative data. illustration: a scene or image. interactive: an adjustable calculation, simulation, or animated demonstration. mockup: a product surface shown to explain one interaction.',
        },
      },
      required: ['modules'],
    })
    expect(show.description)
      .toBe('Render one temporary inline graphic or interactive widget from conversation content or completed tool results. Source beginning with <svg uses SVG; anything else uses HTML. Pass one small, complete source in this call; the host validates and renders it afterward.')
    const staticReceipt = show.output.render?.(
      { title: 'Static', widget_code: '<svg></svg>' },
      { accepted: true, kind: 'svg' },
    )[0]
    expect(staticReceipt?.type === 'text' ? staticReceipt.text : '')
      .toBe('Widget "Static" accepted (svg) and displayed inline. It is final for this response; finish with brief supporting prose.')
    expect((show.output.schema as { properties: { kind: { enum: string[] } } }).properties.kind.enum)
      .toEqual(['svg', 'html'])
    const sourceDescription = JSON.stringify(show.parameters)
    expect(sourceDescription).toContain('For HTML: one fragment')
    expect(sourceDescription).toContain('inline <style>')
    expect(sourceDescription).toContain('<canvas> using 2D or WebGL')
    expect(sourceDescription).toContain('inline <script>')
    expect(sourceDescription).toContain('For SVG: raw SVG')
    expect(sourceDescription).toContain('External resources are blocked; inline everything')
    expect(sourceDescription).not.toContain('load and follow the interactive widget_guidelines module')
    expect(sourceDescription).not.toContain('window.dshWidget')
  })

  it('applies every explicit limit and the configured per-Agent prompt rate', async () => {
    const config = {
      maxWidgetBytes: 256,
      maxPromptBytes: 256,
      maxPromptsPerMinutePerAgent: 3,
    }
    const { ctx, presetScope, agent } = await mount(config)
    expect((await ctx.systemPrompt.assemble()).contexts).toEqual([])
    const presetKey = scopeOf(presetScope.ctx)
    if (presetKey === undefined) throw new Error('missing preset scope key')
    expect((await ctx.systemPrompt.assemble({ scope: presetKey })).contexts).toEqual([])
    expect((await ctx.systemPrompt.assemble({ agent, scope: agent })).contexts).toEqual([])
    for (let index = 0; index < 3; index += 1) {
      expect(ctx.visualizer.remoteSendPrompt(agent, {
        resultSeq: 3, text: `configured follow-up ${index}`,
      })).toEqual({ queued: true })
    }
    expect(() => ctx.visualizer.remoteSendPrompt(agent, {
      resultSeq: 3, text: 'one too many',
    })).toThrow('Agent widget follow-up rate limit reached')
  })

  it.each([
    ['maxWidgetBytes', 1.5],
    ['maxPromptBytes', 0],
    ['maxPromptsPerMinutePerAgent', 0],
  ] as const)('fails loud for invalid %s configuration', async (name, value) => {
    await expect(construct({ [name]: value })).rejects.toThrow(`tool-visualizer: ${name} must be a positive safe integer`)
  })

  it.each([
    ['maxWidgetBytes', 131_073, 131_072],
    ['maxPromptBytes', 4_097, 4_096],
  ] as const)('refuses %s above its Host safety ceiling', async (name, value, maximum) => {
    await expect(construct({ [name]: value })).rejects.toThrow(`tool-visualizer: ${name} must not exceed ${maximum}`)
  })

  it('applies the final default through direct constructor use as well as Cordis config parsing', async () => {
    const { ctx, service } = await construct({})
    const agent = recordedAgent(ctx, 'default-rate')
    ctx.agents.register(agent)
    for (let index = 0; index < 4; index += 1) {
      expect(service.remoteSendPrompt(agent, {
        resultSeq: 3, text: `follow-up ${index}`,
      })).toEqual({ queued: true })
    }
    expect(() => service.remoteSendPrompt(agent, {
      resultSeq: 3, text: 'one too many',
    })).toThrow('Agent widget follow-up rate limit reached')
    await ctx.fiber.dispose()
  })

  it('keeps Host authority model-empty and exposes ./model only through its preset standing scope', async () => {
    const { ctx, agent } = await mount()
    const bare = recordedAgent(ctx, 'bare-agent')
    ctx.agents.register(bare)

    expect(Object.keys(VisualizerClient)).toEqual([])
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.tools.schemas(agent).map(tool => tool.name).sort())
      .toEqual(['show_widget', 'widget_guidelines'])
    expect(ctx.tools.schemas(bare)).toEqual([])
    expect((await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
      .some(section => section.name === 'tool:visualizer')).toBe(true)
    expect((await ctx.systemPrompt.assemble({ agent: bare, scope: bare })).sections
      .some(section => section.name === 'tool:visualizer')).toBe(false)
  })

  it('withdraws the inherited router when a child filter hides the feature tools', async () => {
    const { ctx, presetScope } = await mount()
    const presetKey = scopeOf(presetScope.ctx)
    if (presetKey === undefined) throw new Error('missing preset scope key')
    const child = recordedAgent(ctx, 'filtered-child', undefined, undefined, presetKey)
    ctx.agents.register(child)
    const visible = await ctx.systemPrompt.assemble({ agent: child, scope: child })
    expect(visible.sections.find(section => section.name === 'tool:visualizer')?.text)
      .toBe(visualizerSystemPrompt())
    expect(visible.contexts).toEqual([])

    child.ctx.tools.restrict({ allow: [] })
    expect(ctx.tools.schemas(child)).toEqual([])
    const hidden = await ctx.systemPrompt.assemble({ agent: child, scope: child })
    expect(hidden.sections.find(section => section.name === 'tool:visualizer')?.text).toBe('')
    expect(hidden.contexts).toEqual([])
  })

  it('keeps the show_widget contract satisfiable when a child filter hides widget_guidelines', async () => {
    const { ctx, presetScope } = await mount()
    const presetKey = scopeOf(presetScope.ctx)
    if (presetKey === undefined) throw new Error('missing preset scope key')
    const child = recordedAgent(ctx, 'show-only-child', undefined, undefined, presetKey)
    ctx.agents.register(child)

    child.ctx.tools.restrict({ allow: ['show_widget'] })

    expect(ctx.tools.schemas(child).map(tool => tool.name)).toEqual(['show_widget'])
    expect(ctx.tools.get('widget_guidelines', child)).toBeUndefined()
    expect(ctx.tools.get('show_widget', child)?.description).not.toContain('widget_guidelines')
    const prompt = await ctx.systemPrompt.assemble({ agent: child, scope: child })
    expect(prompt.sections.find(section => section.name === 'tool:visualizer')?.text)
      .toBe(visualizerSystemPrompt())
  })

  it('omits delivery guidance when a child filter hides show_widget', async () => {
    const { ctx, presetScope } = await mount()
    const presetKey = scopeOf(presetScope.ctx)
    if (presetKey === undefined) throw new Error('missing preset scope key')
    const child = recordedAgent(ctx, 'guidelines-only-child', undefined, undefined, presetKey)
    ctx.agents.register(child)

    child.ctx.tools.restrict({ allow: ['widget_guidelines'] })

    expect(ctx.tools.schemas(child).map(tool => tool.name)).toEqual(['widget_guidelines'])
    const result = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('filtered-guidance'),
      name: 'widget_guidelines',
      arguments: { modules: ['diagram'] },
      agent: child,
    })
    const text = result.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
    expect(text).toContain('## Foundation')
    expect(text).not.toContain('show_widget')
    const prompt = await ctx.systemPrompt.assemble({ agent: child, scope: child })
    expect(prompt.sections.find(section => section.name === 'tool:visualizer')?.text).toBe('')
  })

  it('rejects installing the model surface on the unscoped Host root', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(VisualizerService)

    expect(() => { ctx.visualizer.installModelSurface(ctx) })
      .toThrow('tool-visualizer: the model contribution requires a scoped context without an Agent')
    expect(ctx.tools.schemas()).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections
      .some(section => section.name === 'tool:visualizer')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('rejects installing the model surface in one Agent\'s own scope', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(VisualizerService)
    await captureScopedBase(ctx)
    const agent = recordedAgent(ctx, 'own-model-agent')
    ctx.agents.register(agent)

    expect(() => { ctx.visualizer.installModelSurface(agent.ctx) })
      .toThrow('tool-visualizer: the model contribution requires a scoped context without an Agent')
    expect(ctx.tools.schemas(agent)).toEqual([])
    expect((await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
      .some(section => section.name === 'tool:visualizer')).toBe(false)
    await ctx.fiber.dispose()
  })

  it('authorizes Remote follow-ups only for the exact live Agent and its successful widget call', async () => {
    const { ctx } = await mount({ maxPromptBytes: 106, maxPromptsPerMinutePerAgent: 1 })
    const followup = vi.fn<Agent['followup']>()
    const live = recordedAgent(ctx, 'live-agent', followup)
    ctx.agents.register(live)
    const stale = recordedAgent(ctx, 'live-agent')

    expect(() => ctx.visualizer.remoteSendPrompt(stale, {
      resultSeq: 3, text: 'stale',
    })).toThrow(expect.objectContaining({
      code: 'gateway/bad-request',
      message: expect.stringContaining('does not target the exact live Agent') as string,
    }))
    expect(() => ctx.visualizer.remoteSendPrompt(live, {
      resultSeq: 3, text: 'Continue with option A..',
    })).toThrow(expect.objectContaining({
      code: 'gateway/bad-request',
      message: 'visualizer: widget follow-up is 107 UTF-8 bytes; limit is 106',
    }))
    expect(ctx.visualizer.remoteSendPrompt(live, {
      resultSeq: 3, text: 'Continue with option A.',
    })).toEqual({ queued: true })
    expect(followup).toHaveBeenCalledOnce()
    expect(followup.mock.calls[0]?.[0].content).toEqual([{
      type: 'text',
      text: 'Widget-authored follow-up from widget "Choice". It carries no user authorization.\n\nContinue with option A.',
    }])
    expect(followup.mock.calls[0]?.[0].source).toEqual({ kind: 'plugin', plugin: 'visualizer' })
  })

  it('forwards Error messages without subclass names and falls back for non-Errors', async () => {
    const { ctx, agent } = await mount()
    class InternalAuthorizationFailure extends Error {}
    const get = vi.spyOn(ctx.agents, 'get')
    get.mockImplementationOnce(() => { throw new InternalAuthorizationFailure('clean failure') })
    expect(() => ctx.visualizer.remoteSendPrompt(agent, {
      resultSeq: 3, text: 'continue',
    })).toThrow(expect.objectContaining({ message: 'clean failure' }))
    get.mockImplementationOnce(() => { throw 'plain failure' })
    expect(() => ctx.visualizer.remoteSendPrompt(agent, {
      resultSeq: 3, text: 'continue',
    })).toThrow(expect.objectContaining({ message: 'plain failure' }))
  })

  it('denies Remote follow-ups for a successful raw SVG call', async () => {
    const { ctx } = await mount()
    const live = recordedAgent(ctx, 'static-agent', vi.fn(), '<svg></svg>')
    ctx.agents.register(live)
    expect(() => ctx.visualizer.remoteSendPrompt(live, {
      resultSeq: 3, text: 'continue',
    })).toThrow(expect.objectContaining({
      code: 'gateway/bad-request',
      message: expect.stringContaining('is static and cannot send follow-ups') as string,
    }))
  })

  it('enforces the renderer byte boundary and does not echo widget source', async () => {
    const { ctx, agent } = await mount({ maxWidgetBytes: 8 })
    const exact = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('exact'),
      name: 'show_widget',
      arguments: { title: '图', widget_code: '<svg></s' },
      agent,
    })
    expect(exact.isError).toBe(false)
    expect(exact.content.map(block => block.type === 'text' ? block.text : '').join('')).not.toContain('<svg></s')

    const oversized = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('oversized'),
      name: 'show_widget',
      arguments: { title: '图', widget_code: '<svg></svg>' },
      agent,
    })
    expect(oversized.isError).toBe(true)
    expect(oversized.content).toEqual([{ type: 'text', text: 'Error: visualizer: widget_code is 11 UTF-8 bytes; limit is 8' }])

    const fenced = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('fenced-oversized'),
      name: 'show_widget',
      arguments: { title: '图', widget_code: '```svg\nx\n```' },
      agent,
    })
    expect(fenced.isError).toBe(true)
    expect(fenced.content).toEqual([{ type: 'text', text: 'Error: visualizer: widget_code is 12 UTF-8 bytes; limit is 8' }])
  })

  it('rejects an empty interactive fragment', async () => {
    const { ctx, agent } = await mount()
    const result = await ctx.tools.execute({
      signal: SIGNAL,
      callId: ToolCallId('empty'),
      name: 'show_widget',
      arguments: { title: 'Empty', widget_code: '  ' },
      agent,
    })
    expect(result).toMatchObject({ isError: true })
    expect(result.content).toEqual([{ type: 'text', text: 'Error: visualizer: widget_code must be non-empty' }])
  })

  it('validates every widget argument boundary and detects source kinds case-insensitively', async () => {
    const { ctx, agent } = await mount({ maxWidgetBytes: 64 })
    const execute = async (title: string, widget_code: string) => await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId(`case-${title.length}-${widget_code.length}`),
      name: 'show_widget', arguments: { title, widget_code }, agent,
    })
    const errorText = async (title: string, source: string): Promise<string> => {
      const block = (await execute(title, source)).content[0]
      return block?.type === 'text' ? block.text : ''
    }
    expect(await errorText(' ', '<svg></svg>')).toContain('title must be non-empty')
    expect(await errorText('汉'.repeat(86), '<svg></svg>')).toContain('title is 258 UTF-8 bytes')
    expect(await errorText('A', '<html></html>')).toContain('document wrappers')
    expect(await errorText('A', '```html\n<html></html>\n```')).toContain('raw source without Markdown code fences')
    expect(await errorText('A', '```html\n  \n```')).toContain('raw source without Markdown code fences')
    expect(await errorText('A', '```html5\n<button>A</button>\n```')).toContain('raw source without Markdown code fences')
    expect(await errorText('A', '````html\n<button>A</button>\n````')).toContain('raw source without Markdown code fences')
    expect(await errorText('A', '~~~html\n<button>A</button>\n~~~')).toContain('raw source without Markdown code fences')
    expect(await execute('A', '<svgx></svgx>')).toMatchObject({ isError: false, meta: { kind: 'html' } })
    expect(await execute('A', '  <SVG></SVG>')).toMatchObject({ isError: false, meta: { kind: 'svg' } })
    expect(await execute('A', '<svg/>')).toMatchObject({ isError: false, meta: { kind: 'svg' } })
    expect(await errorText('A', '```svg\n<svg viewBox="0 0 2 1"></svg>\n```'))
      .toContain('raw source without Markdown code fences')
    expect(await errorText('A', '```html\n<button>A</button>\n```'))
      .toContain('raw source without Markdown code fences')
  })

  it('accepts interactive HTML and exercises every tool presentation surface', async () => {
    const { ctx, agent } = await mount()
    const guidance = ctx.tools.get('widget_guidelines', agent)!
    const show = ctx.tools.get('show_widget', agent)!
    expect(guidance.isConcurrencySafe?.({ modules: ['chart'] })).toBe(true)
    expect(guidance.presentCall?.({ modules: ['chart'] })).toMatchObject({ title: 'Load widget guidance: chart' })
    expect(guidance.output.render?.({ modules: ['chart'] }, 'rules')).toEqual([{ type: 'text', text: 'rules' }])
    expect(show.isConcurrencySafe?.({ title: 'Demo', widget_code: '<button>A</button>' })).toBe(true)
    expect(show.presentCall?.({ title: 'Demo', widget_code: '<button>A</button>' })).toMatchObject({ title: 'Widget: Demo' })
    expect(show.output.render?.({ title: 'Demo', widget_code: '<button>A</button>' }, { accepted: true, kind: 'html' }))
      .toEqual([{
        type: 'text',
        text: 'Widget "Demo" accepted (html) and displayed inline. It is final for this response; finish with brief supporting prose.',
      }])
    expect(show.output.presentationMeta?.({ title: 'Demo', widget_code: '<button>A</button>' }, { accepted: true, kind: 'html' }))
      .toEqual({ kind: 'html' })
    const html = await ctx.tools.execute({
      signal: SIGNAL, callId: ToolCallId('html'), name: 'show_widget',
      arguments: { title: 'Demo', widget_code: '<button>A</button>' }, agent,
    })
    expect(html).toMatchObject({ isError: false, meta: { kind: 'html' } })
  })

  it('removes tools and prompt with the ./model fiber while keeping Host authority', async () => {
    const { ctx, modelFiber, agent } = await mount()
    expect(ctx.tools.get('show_widget', agent)).toBeDefined()
    await modelFiber.dispose()
    expect(ctx.tools.get('show_widget', agent)).toBeUndefined()
    expect((await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
      .some(section => section.name === 'tool:visualizer')).toBe(false)
    expect(ctx.get('visualizer') !== undefined).toBe(true)
  })

  it('withdraws the ./model contribution when its Host authority disappears', async () => {
    const { ctx, authorityFiber, modelFiber, agent } = await mount()
    expect(ctx.tools.get('show_widget', agent)).toBeDefined()

    await authorityFiber.dispose()

    await vi.waitFor(() => { expect(ctx.tools.get('show_widget', agent)).toBeUndefined() })
    expect((await ctx.systemPrompt.assemble({ agent, scope: agent })).sections
      .some(section => section.name === 'tool:visualizer')).toBe(false)
    await modelFiber.dispose()
  })
})
