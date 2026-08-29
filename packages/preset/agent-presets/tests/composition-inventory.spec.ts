/**
 * Structured composition reads: the flattened plugin rows a preset names,
 * answered from the composition file while no session has mounted the preset
 * and from the standing mount once one has, with a composition that cannot be
 * read reported broken by reason instead of dropped.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentPresets, { COMPOSITION_FILE, METADATA_FILE } from '@deepseek-ai/dsh-agent-presets'
import type { Config } from '@deepseek-ai/dsh-agent-presets'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { fileComposition, mountedCompositionRows } from '../src/composition-inventory.ts'
import { livePresetMounts } from '../src/mount.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const SYSTEM_ROOT = { path: join(FIXTURES, 'system'), trust: 'system' as const }
// A row naming a package installed beside the harness, the way authored rows do.
const VALID = '- id: prompt\n  name: \'@deepseek-ai/dsh-system-prompt\'\n'

const contexts: Context[] = []

/** A Loader-context evaluator over an empty scope, enough for literal gates. */
const evaluateExpression = (expression: string): unknown => evaluate({}, expression)
/** An evaluator that refuses every expression, leaving rows conditional. */
const refuseExpression = (): never => { throw new Error('no loader context') }

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(roster: Config): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, roster)
  return ctx
}

describe('fileComposition', () => {
  it('flattens groups and keeps refused expressions conditional', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-composition-'))
    const path = join(dir, COMPOSITION_FILE)
    await writeFile(path, [
      '- id: alpha',
      '  name: pkg-alpha',
      '- name: pkg-anonymous',
      '- id: off',
      '  name: pkg-off',
      '  disabled: true',
      '- id: cond',
      '  name: pkg-cond',
      '  disabled: !!js process.platform === \'win32\'',
      '- id: grp',
      '  name: cordis:group',
      '  group: true',
      '  config:',
      '    - id: child',
      '      name: pkg-child',
      '    - id: child-off',
      '      name: pkg-child-off',
      '      disabled: true',
      '- id: grp-off',
      '  name: cordis:group',
      '  group: true',
      '  disabled: true',
      '  config:',
      '    - id: buried',
      '      name: pkg-buried',
      '- id: grp-cond',
      '  name: cordis:group',
      '  group: true',
      '  disabled: !!js 1',
      '  config:',
      '    - id: maybe',
      '      name: pkg-maybe',
      '    - id: certainly-off',
      '      name: pkg-certainly-off',
      '      disabled: true',
    ].join('\n'))

    expect(await fileComposition(path, refuseExpression)).toEqual({
      rows: [
        { entryId: 'alpha', moduleName: 'pkg-alpha', enabled: true },
        { entryId: null, moduleName: 'pkg-anonymous', enabled: true },
        { entryId: 'off', moduleName: 'pkg-off', enabled: false },
        {
          entryId: 'cond',
          moduleName: 'pkg-cond',
          enabled: 'conditional',
          condition: 'process.platform === \'win32\'',
        },
        { entryId: 'child', moduleName: 'pkg-child', enabled: true },
        { entryId: 'child-off', moduleName: 'pkg-child-off', enabled: false },
        { entryId: 'buried', moduleName: 'pkg-buried', enabled: false },
        { entryId: 'maybe', moduleName: 'pkg-maybe', enabled: 'conditional' },
        { entryId: 'certainly-off', moduleName: 'pkg-certainly-off', enabled: false },
      ],
    })
  })

  it('evaluates decidable gates the way a mount would', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-composition-'))
    const path = join(dir, COMPOSITION_FILE)
    await writeFile(path, [
      '- id: off',
      '  name: pkg-off',
      '  disabled: !!js 1 === 1',
      '- id: on',
      '  name: pkg-on',
      '  disabled: !!js 1 === 2',
    ].join('\n'))

    expect(await fileComposition(path, evaluateExpression)).toEqual({
      rows: [
        { entryId: 'off', moduleName: 'pkg-off', enabled: false, condition: '1 === 1' },
        { entryId: 'on', moduleName: 'pkg-on', enabled: true, condition: '1 === 2' },
      ],
    })
  })

  it('answers broken for a file that stopped reading as a composition', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-composition-'))

    const missing = await fileComposition(join(dir, COMPOSITION_FILE), refuseExpression)
    expect(missing).toHaveProperty('broken')

    const unparsable = join(dir, 'unparsable.yml')
    await writeFile(unparsable, 'foo: [')
    const yaml = await fileComposition(unparsable, refuseExpression)
    expect('broken' in yaml && yaml.broken.length > 0).toBe(true)

    const rowless = join(dir, 'rowless.yml')
    await writeFile(rowless, 'foo: bar\n')
    expect(await fileComposition(rowless, refuseExpression)).toEqual({
      broken: 'the composition must be a top-level list of plugin rows',
    })
  })
})

describe('mountedCompositionRows', () => {
  it('reads evaluated enablement and root-fiber states, skipping group rows', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.active = () => {}
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const disabledId = await ctx.loader.create({ name: 'cordis:active', disabled: true })
    const evaluatedId = await ctx.loader.create({
      name: 'cordis:active',
      // The YAML `!!js` tag deserializes to exactly this object; EntryOptions
      // types the field by its literal form only.
      disabled: { __jsExpr: 'false' } as unknown as boolean,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    expect(mountedCompositionRows(ctx.loader)).toEqual([
      { entryId: activeId, moduleName: 'cordis:active', enabled: true, fiberState: FiberState.ACTIVE },
      { entryId: disabledId, moduleName: 'cordis:active', enabled: false },
      {
        entryId: evaluatedId,
        moduleName: 'cordis:active',
        enabled: true,
        condition: 'false',
        fiberState: FiberState.ACTIVE,
      },
    ])
  })
})

describe('AgentPresets.compositionInventory', () => {
  it('reads unmounted presets from their files, marking the default and metadata', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'dsh-composition-roster-'))
    await mkdir(join(userRoot, 'documented'))
    await writeFile(join(userRoot, 'documented', COMPOSITION_FILE), [
      VALID.trimEnd(),
      '- id: gated',
      '  name: \'@deepseek-ai/dsh-system-prompt\'',
      '  disabled: !!js 1 === 1',
      '- id: undecidable',
      '  name: \'@deepseek-ai/dsh-system-prompt\'',
      '  disabled: !!js nothing.here',
    ].join('\n'))
    await writeFile(join(userRoot, 'documented', METADATA_FILE), 'name: 我的模式\n')
    const ctx = await harness({
      default: 'minimal',
      roots: [SYSTEM_ROOT, { path: userRoot, trust: 'user' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    expect(await ctx.agentPresets.compositionInventory()).toEqual([
      {
        id: 'minimal',
        isDefault: true,
        rows: [{ entryId: 'beta', moduleName: '../../plugins/contribute.js', enabled: true }],
      },
      {
        id: 'standard',
        isDefault: false,
        rows: [
          { entryId: 'alpha', moduleName: '../../plugins/contribute.js', enabled: true },
          { entryId: 'alpha-extra', moduleName: '../../plugins/contribute.js', enabled: false },
        ],
      },
      {
        id: 'documented',
        name: '我的模式',
        isDefault: false,
        rows: [
          { entryId: 'prompt', moduleName: '@deepseek-ai/dsh-system-prompt', enabled: true },
          // The platform-gate shape: the service evaluates it with the
          // Loader's own scope, so the file answer matches a mount's.
          { entryId: 'gated', moduleName: '@deepseek-ai/dsh-system-prompt', enabled: false, condition: '1 === 1' },
          // An expression the evaluator refuses stays a mount's decision.
          {
            entryId: 'undecidable',
            moduleName: '@deepseek-ai/dsh-system-prompt',
            enabled: 'conditional',
            condition: 'nothing.here',
          },
        ],
      },
    ])
    // Reading is never mounting: every unmounted preset above was answered
    // from its file, so listing plugins cannot activate a preset early.
    expect(livePresetMounts()).toEqual([])
  })

  it('reads a mounted preset from its standing composition', async () => {
    const ctx = await harness({
      default: 'standard',
      roots: [SYSTEM_ROOT],
      includeShippedRoot: false,
      includeUserRoot: false,
    })
    await ctx.agents.create({
      sessionId: SessionId('composition-inventory'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })

    const standard = (await ctx.agentPresets.compositionInventory())
      .find(composition => composition.id === 'standard')
    expect(standard?.rows).toEqual([
      {
        entryId: 'alpha',
        moduleName: '../../plugins/contribute.js',
        enabled: true,
        fiberState: FiberState.ACTIVE,
      },
      { entryId: 'alpha-extra', moduleName: '../../plugins/contribute.js', enabled: false },
    ])
  })

  it('keeps a broken preset on the inventory with its discovery reason', async () => {
    const userRoot = await mkdtemp(join(tmpdir(), 'dsh-composition-roster-'))
    await mkdir(join(userRoot, 'damaged'))
    const ctx = await harness({
      default: 'minimal',
      roots: [SYSTEM_ROOT, { path: userRoot, trust: 'user' }],
      includeShippedRoot: false,
      includeUserRoot: false,
    })

    const damaged = (await ctx.agentPresets.compositionInventory())
      .find(composition => composition.id === 'damaged')
    expect(damaged?.rows).toEqual([])
    expect(damaged?.broken).toContain('is missing')
  })

  it('reports a composition that raced discovery as broken instead of dropping it', async () => {
    const ctx = await harness({
      default: 'minimal',
      roots: [SYSTEM_ROOT],
      includeShippedRoot: false,
      includeUserRoot: false,
    })
    // Discovery judged the preset healthy, then the file vanished before the
    // row read: the inventory keeps the preset and carries the raced reason.
    vi.spyOn(ctx.agentPresets, 'list').mockResolvedValue([
      { id: 'ghost', trust: 'user', path: join(FIXTURES, 'ghost', COMPOSITION_FILE) },
    ])

    const [ghost] = await ctx.agentPresets.compositionInventory()
    expect(ghost?.rows).toEqual([])
    expect(ghost?.broken).toBeDefined()
  })
})
