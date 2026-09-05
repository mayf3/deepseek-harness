/**
 * The per-preset user patch layer: a `cordis.patch.yml` beside a locally
 * authored composition, or alone in the user root's slot of a shipped
 * preset's id. Discovery attaches it and judges it, the mount applies it,
 * generations follow its content, the inventory reports its decisions, a
 * copy carries it, and authoring can remove it.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { afterEach, describe, expect, it } from 'vitest'
import AgentPresets, {
  COMPOSITION_FILE, discoverPresets, livePresetMounts, overlayFacts, OVERLAY_FILE, scanRoot,
} from '@deepseek-ai/dsh-agent-presets'
import { fileComposition } from '../src/composition-inventory.ts'
import type { Config } from '@deepseek-ai/dsh-agent-presets'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const HARNESS = new URL('.', import.meta.url).href
const SYSTEM = { path: join(FIXTURES, 'system'), trust: 'system' as const }
const CONTRIBUTE = join(FIXTURES, 'plugins', 'contribute.js')

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A fresh user root, optionally holding one slot with the given files. */
async function userRoot(slots: Record<string, Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-overlay-root-'))
  for (const [id, files] of Object.entries(slots)) {
    await mkdir(join(root, id), { recursive: true })
    for (const [file, content] of Object.entries(files)) await writeFile(join(root, id, file), content)
  }
  return root
}

/** An overlay that switches `alpha` off and inserts one row registering `tool`. */
function overlayInserting(tool: string): string {
  return [
    '- id: alpha',
    '  disabled: true',
    '- insert:',
    `    - id: user-${tool}`,
    `      name: ${CONTRIBUTE}`,
    '      config:',
    `        tool: ${tool}`,
    '',
  ].join('\n')
}

async function harness(roster: Config): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, roster)
  return ctx
}

async function agentOn(ctx: Context, id: string, presetId: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId(id),
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, presetId),
  })
  return handle.agent
}

const toolNames = (ctx: Context, agent: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name).sort()

const rosterOver = (root: string, extra: Partial<Config> = {}): Config => ({
  default: 'standard',
  roots: [SYSTEM, { path: root, trust: 'user' }],
  includeShippedRoot: false,
  includeUserRoot: false,
  ...extra,
})

describe('discovery', () => {
  it('attaches a lone layer in a later root to the preset that won the id', async () => {
    const root = await userRoot({ standard: { [OVERLAY_FILE]: overlayInserting('gamma') } })

    const presets = await discoverPresets([SYSTEM, { path: root, trust: 'user' }], HARNESS)

    const standard = presets.find(preset => preset.id === 'standard')
    expect(standard).toMatchObject({ trust: 'system', overlayPath: join(root, 'standard', OVERLAY_FILE) })
    expect(standard?.broken).toBeUndefined()
    // The lone layer is not a preset of its own root.
    expect(await scanRoot({ path: root, trust: 'user' }, HARNESS)).toEqual([])
  })

  it('reads a layer beside a locally authored composition as that preset\'s own', async () => {
    const root = await userRoot({
      mine: {
        [COMPOSITION_FILE]: `- id: only\n  name: ${CONTRIBUTE}\n  config:\n    tool: only\n`,
        [OVERLAY_FILE]: '- id: only\n  disabled: true\n',
      },
    })
    const other = await userRoot({ mine: { [OVERLAY_FILE]: '- id: only\n  config: {}\n' } })

    const presets = await discoverPresets([{ path: root, trust: 'user' }, { path: other, trust: 'user' }], HARNESS)

    // The preset's own layer wins; a later root's lone layer for the same id is ignored.
    expect(presets).toEqual([expect.objectContaining({ id: 'mine', overlayPath: join(root, 'mine', OVERLAY_FILE) })])
  })

  it('reports a lone layer whose id no root supplies as a broken slot', async () => {
    const root = await userRoot({ ghost: { [OVERLAY_FILE]: '[]\n' } })

    const presets = await discoverPresets([SYSTEM, { path: root, trust: 'user' }], HARNESS)

    expect(presets.find(preset => preset.id === 'ghost')).toMatchObject({
      trust: 'user',
      path: join(root, 'ghost', COMPOSITION_FILE),
      overlayPath: join(root, 'ghost', OVERLAY_FILE),
      broken: expect.stringContaining('no root supplies a preset "ghost"') as string,
    })
    // A slot with neither file is still the missing-composition case.
    const empty = await userRoot({ hollow: { 'notes.txt': '' } })
    const hollow = (await discoverPresets([{ path: empty, trust: 'user' }], HARNESS)).find(preset => preset.id === 'hollow')
    expect(hollow?.broken).toContain(`${COMPOSITION_FILE} is missing`)
  })

  it('judges the layer with the composition: unparsable, malformed, or unresolvable inserts break the preset', async () => {
    const unparsable = await userRoot({ standard: { [OVERLAY_FILE]: 'a: [\n' } })
    const malformed = await userRoot({ standard: { [OVERLAY_FILE]: '- insert:\n    - config: {}\n' } })
    const unresolvable = await userRoot({ standard: { [OVERLAY_FILE]: '- insert:\n    - id: x\n      name: ./nowhere.js\n' } })
    const own = await userRoot({
      mine: { [COMPOSITION_FILE]: '[]\n', [OVERLAY_FILE]: 'a: 1\n' },
    })

    const [a, b, c, d] = await Promise.all([unparsable, malformed, unresolvable].map(
      async root => (await discoverPresets([SYSTEM, { path: root, trust: 'user' }], HARNESS)).find(preset => preset.id === 'standard'),
    ).concat([
      (async () => (await discoverPresets([{ path: own, trust: 'user' }], HARNESS)).find(preset => preset.id === 'mine'))(),
    ]))

    expect(a?.broken).toContain(`the user patch layer ${OVERLAY_FILE} cannot be applied`)
    expect(b?.broken).toContain('user patch layer entry 1 row 1 names no plugin')
    expect(c?.broken).toContain('inserts row "x", which names a plugin that cannot be resolved')
    expect(d?.broken).toContain('must be a top-level YAML array')
  })

  it('leaves a broken composition\'s verdict in place rather than judging its layer', async () => {
    const shipped = await userRoot({ bad: { [COMPOSITION_FILE]: '- id: x\n  name: ./nowhere.js\n' } })
    const root = await userRoot({ bad: { [OVERLAY_FILE]: 'a: [\n' } })

    const presets = await discoverPresets([{ path: shipped, trust: 'system' }, { path: root, trust: 'user' }], HARNESS)

    const broken = presets.find(preset => preset.id === 'bad')
    expect(broken?.overlayPath).toBe(join(root, 'bad', OVERLAY_FILE))
    expect(broken?.broken).toContain('cannot be resolved')
    expect(broken?.broken).not.toContain('user patch layer')
  })
})

describe('mounting', () => {
  it('applies the layer over the composition: a row switched off, a row added', async () => {
    const root = await userRoot({ standard: { [OVERLAY_FILE]: overlayInserting('gamma') } })
    const ctx = await harness(rosterOver(root))

    const agent = await agentOn(ctx, 'sess-overlaid', 'standard')

    expect(toolNames(ctx, agent)).toEqual(['gamma'])
  })

  it('starts a new generation when the layer changes and returns to one whose content comes back', async () => {
    const root = await userRoot({ standard: { [OVERLAY_FILE]: overlayInserting('gamma') } })
    const ctx = await harness(rosterOver(root))
    const first = await agentOn(ctx, 'sess-gen-1', 'standard')
    const firstMount = livePresetMounts().findLast(mount => mount.presetId === 'standard')

    await writeFile(join(root, 'standard', OVERLAY_FILE), overlayInserting('delta'))
    const second = await agentOn(ctx, 'sess-gen-2', 'standard')
    const secondMount = livePresetMounts().findLast(mount => mount.presetId === 'standard')

    expect(toolNames(ctx, first)).toEqual(['gamma'])
    expect(toolNames(ctx, second)).toEqual(['delta'])
    expect(secondMount).not.toBe(firstMount)
    expect(livePresetMounts().filter(mount => mount.presetId === 'standard')).toHaveLength(2)

    // The same content again: the retired generation serves, no third mount.
    await writeFile(join(root, 'standard', OVERLAY_FILE), overlayInserting('gamma'))
    const third = await agentOn(ctx, 'sess-gen-3', 'standard')
    expect(toolNames(ctx, third)).toEqual(['gamma'])
    expect(livePresetMounts().filter(mount => mount.presetId === 'standard')).toHaveLength(2)
    expect(await ctx.agentPresets.standingKeyFor('standard')).toBe(firstMount?.key)
  })

  it('composes the bare preset when the layer disappears between discovery and mount', async () => {
    const root = await userRoot({ standard: { [OVERLAY_FILE]: overlayInserting('gamma') } })
    const ctx = await harness(rosterOver(root))
    const preset = await ctx.agentPresets.resolve('standard')
    await writeFile(join(root, 'standard', OVERLAY_FILE), '[]\n')

    const racer = ctx.agentPresets as unknown as { ensureStanding(current: typeof preset): Promise<unknown> }
    await racer.ensureStanding(preset)
    const agent = await agentOn(ctx, 'sess-bare', 'standard')

    expect(toolNames(ctx, agent)).toEqual(['alpha'])
  })
})

describe('inventory', () => {
  it('reports the layer\'s decisions from the file and from a standing mount', async () => {
    const root = await userRoot({ standard: { [OVERLAY_FILE]: overlayInserting('gamma') } })
    const ctx = await harness(rosterOver(root))

    const fromFile = (await ctx.agentPresets.compositionInventory()).find(composition => composition.id === 'standard')
    expect(fromFile?.rows).toEqual([
      { entryId: 'alpha', moduleName: '../../plugins/contribute.js', enabled: false, source: 'preset', disabledBy: 'user' },
      { entryId: 'alpha-extra', moduleName: '../../plugins/contribute.js', enabled: false, source: 'preset', disabledBy: 'composition' },
      { entryId: 'user-gamma', moduleName: CONTRIBUTE, enabled: true, source: 'user' },
    ])

    await agentOn(ctx, 'sess-inventory', 'standard')
    const mounted = (await ctx.agentPresets.compositionInventory()).find(composition => composition.id === 'standard')
    expect(mounted?.rows).toEqual([
      { entryId: 'alpha', moduleName: '../../plugins/contribute.js', enabled: false, source: 'preset', disabledBy: 'user' },
      { entryId: 'alpha-extra', moduleName: '../../plugins/contribute.js', enabled: false, source: 'preset', disabledBy: 'composition' },
      { entryId: 'user-gamma', moduleName: CONTRIBUTE, enabled: true, source: 'user', fiberState: FiberState.ACTIVE },
    ])
  })

  it('answers from the composition alone when the layer disappears before the inventory reads it', async () => {
    const root = await userRoot({ standard: { [OVERLAY_FILE]: overlayInserting('gamma') } })
    const ctx = await harness(rosterOver(root))
    await rm(join(root, 'standard', OVERLAY_FILE))

    const fromFile = (await ctx.agentPresets.compositionInventory()).find(composition => composition.id === 'standard')

    expect(fromFile?.rows.map(row => [row.entryId, row.source])).toEqual([
      ['alpha', 'preset'],
      ['alpha-extra', 'preset'],
    ])
  })

  it('answers from the composition alone when the layer stopped reading', async () => {
    const root = await userRoot({ standard: { [OVERLAY_FILE]: overlayInserting('gamma') } })
    const ctx = await harness(rosterOver(root))
    await agentOn(ctx, 'sess-inventory-broken-layer', 'standard')
    await writeFile(join(root, 'standard', OVERLAY_FILE), 'a: [\n')

    const mounted = (await ctx.agentPresets.compositionInventory()).find(composition => composition.id === 'standard')

    expect(mounted?.rows.map(row => [row.entryId, row.source, row.disabledBy])).toEqual([
      ['alpha', 'preset', 'composition'],
      ['alpha-extra', 'preset', 'composition'],
      ['user-gamma', 'preset', undefined],
    ])
  })

  it('reads a layer\'s inserted and disabled ids, ignoring !!js gates', () => {
    expect(overlayFacts([
      { id: 'a', disabled: true },
      { id: 'b', disabled: { __jsExpr: 'true' } as unknown as boolean },
      { id: 'c', config: {} },
      { insert: [{ id: 'd', name: 'x' }, { id: 'g', name: 'cordis:group', group: true, config: [{ id: 'e', name: 'y' }] }] },
      // A group inserted without members contributes its own id alone; an anonymous row contributes nothing.
      { insert: [{ id: 'h', name: 'cordis:group', group: true }, { name: 'anonymous' } as never] },
    ])).toEqual({ inserted: new Set(['d', 'g', 'e', 'h']), disabled: new Set(['a']) })
  })

  it('reads a composition file under a layer that targets a row it does not have', async () => {
    // A patch matching no row is the Loader's warning at mount time; the
    // inventory applies the rest and stays silent about it.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-preset-inventory-'))
    const path = join(dir, COMPOSITION_FILE)
    await writeFile(path, '- id: alpha\n  name: ../../plugins/contribute.js\n')
    expect(await fileComposition(path, () => false, [{ id: 'missing', disabled: true }])).toEqual({
      rows: [{ entryId: 'alpha', moduleName: '../../plugins/contribute.js', enabled: true, source: 'preset' }],
    })
  })
})

describe('authoring', () => {
  it('names the layer path for shipped and locally authored presets', async () => {
    const root = await userRoot({
      mine: { [COMPOSITION_FILE]: `- id: only\n  name: ${CONTRIBUTE}\n  config:\n    tool: only\n` },
    })
    const ctx = await harness(rosterOver(root))

    expect(await ctx.agentPresets.overlayPathFor('standard')).toBe(join(root, 'standard', OVERLAY_FILE))
    expect(await ctx.agentPresets.overlayPathFor('mine')).toBe(join(root, 'mine', OVERLAY_FILE))
    await writeFile(join(root, 'mine', OVERLAY_FILE), '[]\n')
    expect(await ctx.agentPresets.overlayPathFor('mine')).toBe(join(root, 'mine', OVERLAY_FILE))
  })

  it('refuses a layer path when the deployment configures no writable root', async () => {
    const ctx = await harness({ default: 'standard', roots: [SYSTEM], includeShippedRoot: false, includeUserRoot: false })

    await expect(ctx.agentPresets.overlayPathFor('standard')).rejects.toMatchObject({ code: 'agent-preset/read-only' })
  })

  it('copies a shipped preset\'s layer in beside the new composition', async () => {
    // A shipped preset whose rows resolve from anywhere, so its copy mounts.
    const shipped = await userRoot({
      base: { [COMPOSITION_FILE]: `- id: alpha\n  name: ${CONTRIBUTE}\n  config:\n    tool: alpha\n` },
    })
    const root = await userRoot({ base: { [OVERLAY_FILE]: overlayInserting('gamma') } })
    const ctx = await harness({
      default: 'base',
      roots: [{ path: shipped, trust: 'system' }, { path: root, trust: 'user' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    await ctx.agentPresets.copy('base', 'research', 'Research')

    expect(await readFile(join(root, 'research', OVERLAY_FILE), 'utf8')).toBe(overlayInserting('gamma'))
    const research = await ctx.agentPresets.resolve('research')
    expect(research.overlayPath).toBe(join(root, 'research', OVERLAY_FILE))
    const agent = await agentOn(ctx, 'sess-copied', 'research')
    expect(toolNames(ctx, agent)).toEqual(['gamma'])
  })

  it('removes a layer and the slot it alone occupied', async () => {
    const root = await userRoot({
      standard: { [OVERLAY_FILE]: overlayInserting('gamma') },
      mine: { [COMPOSITION_FILE]: '[]\n', [OVERLAY_FILE]: '[]\n' },
    })
    const ctx = await harness(rosterOver(root))

    expect(await ctx.agentPresets.removeOverlay('standard')).toBe(true)
    expect(existsSync(join(root, 'standard'))).toBe(false)
    expect(await ctx.agentPresets.removeOverlay('standard')).toBe(false)
    expect(await ctx.agentPresets.removeOverlay('mine')).toBe(true)
    expect(existsSync(join(root, 'mine', COMPOSITION_FILE))).toBe(true)
    expect((await ctx.agentPresets.resolve('standard')).overlayPath).toBeUndefined()
  })

  it('refuses to remove a layer outside the writable root', async () => {
    const shipped = await userRoot({ standard: { [OVERLAY_FILE]: '[]\n' } })
    const writable = await userRoot()
    const ctx = await harness({
      default: 'standard',
      roots: [SYSTEM, { path: shipped, trust: 'system' }, { path: writable, trust: 'user' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    await expect(ctx.agentPresets.removeOverlay('standard')).rejects.toMatchObject({ code: 'agent-preset/read-only' })
  })
})

describe('the standing scope', () => {
  it('is named after the preset, so plugins it mounts register settings under preset/<id>', async () => {
    const { scopeIdOf } = await import('@deepseek-ai/dsh-scope')
    const { presetScopeId } = await import('@deepseek-ai/dsh-agent-presets')
    const root = await userRoot()
    const ctx = await harness(rosterOver(root))

    const agent = await agentOn(ctx, 'sess-named-scope', 'standard')

    expect(presetScopeId('standard')).toBe('preset/standard')
    expect(scopeIdOf(agent.ctx)).toBe('preset/standard')
  })
})
