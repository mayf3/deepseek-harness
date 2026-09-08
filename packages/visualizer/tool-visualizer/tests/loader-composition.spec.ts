/** REAL-composition proof for Host authority and the preset model contribution. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import VisualizerService from '../src/index.ts'
import * as VisualizerModel from '../src/model.ts'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const bundlePatch = (name: 'base' | 'headless') => loadOverlayPatches(
  'visualizer composition test',
  join(REPOSITORY_ROOT, 'packages', 'bundle', name, 'cordis.patch.yml'),
)

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (ctx) => { await ctx.fiber.dispose() }))
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

async function boot(rows: string[]): Promise<{ ctx: Context; imports: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-visualizer-composition-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, `${rows.join('\n')}\n`)
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const imports: string[] = []
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-visualizer', VisualizerService],
    ['@deepseek-ai/dsh-tool-visualizer/model', VisualizerModel],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      imports.push(specifier)
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, imports }
}

async function scopedBase(ctx: Context): Promise<Context> {
  let base: Context | undefined
  await ctx.plugin(Object.assign((inner: Context) => { base = inner }, { inject: ['systemPrompt', 'tools'] }))
  if (base === undefined) throw new Error('missing scoped test base')
  return base
}

async function mountPresetModel(ctx: Context) {
  const base = await scopedBase(ctx)
  const presetKey = { agentPreset: 'standard' }
  const presetScope = createScope(base, presetKey)
  const presetRoot = await mkdtemp(join(tmpdir(), 'dsh-visualizer-preset-row-'))
  roots.push(presetRoot)
  const composition = join(presetRoot, 'agent.cordis.yml')
  await writeFile(composition, [
    '- id: tool-visualizer',
    "  name: '@deepseek-ai/dsh-tool-visualizer/model'",
    '',
  ].join('\n'))
  const modelTree = presetScope.ctx.plugin(Include, { path: pathToFileURL(composition).href })
  await modelTree.await()

  return { base, presetKey }
}

function registerPresetAgent(
  ctx: Context,
  preset: Awaited<ReturnType<typeof mountPresetModel>>,
  id: string,
) {
  const session = Session.create(SessionId(id))
  const agent = { id: session.id, session, ctx } as unknown as Agent
  const agentScope = createScope(preset.base, agent, { parent: preset.presetKey })
  Object.assign(agent, { ctx: agentScope.ctx.extend({ agent }) })
  ctx.agents.register(agent)
  return agent
}

async function expectVisualizerSurface(ctx: Context, agent: Agent, visible: boolean): Promise<void> {
  await vi.waitFor(async () => {
    expect(ctx.tools.schemas(agent).map(schema => schema.name).sort())
      .toEqual(visible ? ['show_widget', 'widget_guidelines'] : [])
    const prompt = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(prompt.sections.some(section => section.name === 'tool:visualizer')).toBe(visible)
  })
}

describe('Visualizer Host composition', () => {
  it('keeps headless dormant and mounts the model wrapper only in full presets', () => {
    const headlessEntries = composeEntries([bundlePatch('base'), bundlePatch('headless')])
    expect(headlessEntries.some(entry => entry.name === '@deepseek-ai/dsh-tool-visualizer')).toBe(false)

    const presetModelRows = (id: 'standard' | 'minimal' | 'ptc' | 'cordis') => loadOverlayPatches(
      'visualizer preset composition test',
      join(REPOSITORY_ROOT, 'packages/preset/agent-presets/presets', id, 'agent.cordis.yml'),
    ).filter(entry => entry.name === '@deepseek-ai/dsh-tool-visualizer/model')
    for (const id of ['standard', 'cordis'] as const) {
      const rows = presetModelRows(id)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.disabled).toBeUndefined()
    }
    expect(presetModelRows('ptc')).toEqual([])
    expect(presetModelRows('minimal')).toEqual([])
  })

  it('boots the test-only Host and model through Loader without global model state', async () => {
    const { ctx, imports } = await boot([
      "- id: agents\n  name: '@deepseek-ai/dsh-agent'",
      "- id: system-prompt\n  name: '@deepseek-ai/dsh-system-prompt'",
      "- id: tools\n  name: '@deepseek-ai/dsh-tools'",
      "- id: tool-visualizer\n  name: '@deepseek-ai/dsh-tool-visualizer'",
    ])
    expect(ctx.tools.schemas()).toEqual([])
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:visualizer'))
      .toBe(false)

    const preset = await mountPresetModel(ctx)
    const agent = registerPresetAgent(ctx, preset, 'test-standard')
    expect(imports).toContain('@deepseek-ai/dsh-tool-visualizer')
    expect(imports).toContain('@deepseek-ai/dsh-tool-visualizer/model')
    expect(ctx.tools.schemas(agent).map(schema => schema.name).sort())
      .toEqual(['show_widget', 'widget_guidelines'])
    const prompt = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(prompt.sections.find(section => section.name === 'tool:visualizer')?.text)
      .toContain('Use show_widget for a temporary inline visual')
  })

  it('loads a dormant model wrapper without Host authority', async () => {
    const { ctx, imports } = await boot([
      "- id: agents\n  name: '@deepseek-ai/dsh-agent'",
      "- id: system-prompt\n  name: '@deepseek-ai/dsh-system-prompt'",
      "- id: tools\n  name: '@deepseek-ai/dsh-tools'",
    ])
    const preset = await mountPresetModel(ctx)
    const agent = registerPresetAgent(ctx, preset, 'dormant-standard')

    expect(imports).toContain('@deepseek-ai/dsh-tool-visualizer/model')
    expect(ctx.get('visualizer')).toBeUndefined()
    expect(ctx.tools.schemas()).toEqual([])
    await expectVisualizerSurface(ctx, agent, false)
  })

  it('activates, withdraws, and reactivates the wrapper for existing and new Agents', async () => {
    const { ctx } = await boot([
      "- id: agents\n  name: '@deepseek-ai/dsh-agent'",
      "- id: system-prompt\n  name: '@deepseek-ai/dsh-system-prompt'",
      "- id: tools\n  name: '@deepseek-ai/dsh-tools'",
    ])
    const preset = await mountPresetModel(ctx)
    const beforeAuthority = registerPresetAgent(ctx, preset, 'before-authority')
    await expectVisualizerSurface(ctx, beforeAuthority, false)

    const firstAuthorityId = await ctx.loader.create({ name: '@deepseek-ai/dsh-tool-visualizer' })
    await ctx.loader.await()
    await expectVisualizerSurface(ctx, beforeAuthority, true)

    const duringAuthority = registerPresetAgent(ctx, preset, 'during-authority')
    await expectVisualizerSurface(ctx, duringAuthority, true)

    await ctx.loader.remove(firstAuthorityId)
    await ctx.loader.await()
    await expectVisualizerSurface(ctx, beforeAuthority, false)
    await expectVisualizerSurface(ctx, duringAuthority, false)

    const betweenAuthorities = registerPresetAgent(ctx, preset, 'between-authorities')
    await expectVisualizerSurface(ctx, betweenAuthorities, false)

    await ctx.loader.create({ name: '@deepseek-ai/dsh-tool-visualizer' })
    await ctx.loader.await()
    await expectVisualizerSurface(ctx, beforeAuthority, true)
    await expectVisualizerSurface(ctx, duringAuthority, true)
    await expectVisualizerSurface(ctx, betweenAuthorities, true)

    const afterReactivation = registerPresetAgent(ctx, preset, 'after-reactivation')
    await expectVisualizerSurface(ctx, afterReactivation, true)
  })
})
