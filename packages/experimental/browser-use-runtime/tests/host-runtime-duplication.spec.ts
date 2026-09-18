/**
 * Issue #4573: a profile install of this package sits beside the dsh
 * installation and installs its own copy of `@deepseek-ai/dsh-scope`, so two
 * scope module instances coexist in one host process. `dsh-scope` mints its
 * scope-tag symbol per module instance, so the copy's `createScope` writes a
 * tag every host registry ignores: each Agent's MCP tools register in the
 * global tool layer, the first Agent succeeds, and every later Agent's tool
 * synchronization collides.
 *
 * The first case reproduces that install layout and pins the failure. The
 * second pins the shipped layout the peer declaration produces: one instance,
 * two Agents, each with its own browser client.
 *
 * The first case is a characterization of the duplicated package, not a
 * behavior to preserve. Delete it once `dsh-scope` stops depending on module
 * identity (for example a `Symbol.for` tag shared across copies).
 *
 * Run: `pnpm vitest run packages/experimental/browser-use-runtime/tests/host-runtime-duplication.spec.ts`
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountSessionMcp } from '../src/mcp.ts'

const FIXTURE = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))
const TOOL = 'mcp__browser-fixture__visit'
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Composition with the registries a browser provider contributes to. */
async function load(): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-duplication-'))
  roots.push(root)
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({
    id: name, name, config: name === 'loop' ? { agents: [] } : {},
  }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, root }
}

/** One MCP client per Agent under a caller-supplied scope context factory. */
function mountPerAgent(
  ctx: Context,
  root: string,
  scopeFor: (agent: Agent) => Context,
  client: typeof import('@deepseek-ai/dsh-mcp-client'),
): void {
  ctx.on('agent/created', async ({ agent }) => {
    await scopeFor(agent).plugin(client, client.Config({
      transport: 'stdio', serverName: 'browser-fixture', command: process.execPath, args: [FIXTURE, root],
      failOnStartupError: true, reconnect: { enabled: false },
    }))
  }, { prepend: true })
}

const toolNames = (ctx: Context, agent?: Agent): string[] =>
  ctx.tools.schemas(agent).map(schema => schema.name)

it('reproduces the second-Agent failure a profile install causes', async () => {
  const { ctx, root } = await load()
  // What npm installs beside the installation: one second copy of both packages
  // in the profile, so the copy's client resolves the copy's scope module.
  vi.resetModules()
  const profileScope = await import('@deepseek-ai/dsh-scope')
  const profileMcpClient = await import('@deepseek-ai/dsh-mcp-client')
  mountPerAgent(ctx, root, agent => profileScope.createScope(ctx, agent).ctx, profileMcpClient)

  await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: root } })
  expect(toolNames(ctx)).toContain(TOOL)
  await expect(ctx.agents.create({ sessionId: SessionId('second'), meta: { cwd: root } }))
    .rejects.toThrow('mcp-client(browser-fixture): initial connection or tool synchronization failed')
})

it('keeps every Agent browser tool in that Agent scope under the shipped layout', async () => {
  const { ctx, root } = await load()
  await ctx.plugin({
    inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
    apply(provider: Context) {
      mountSessionMcp(provider, {
        name: 'browser-fixture', exclusive: false, command: process.execPath, args: [FIXTURE, root],
      })
    },
  })

  const first = await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: root } })
  const second = await ctx.agents.create({ sessionId: SessionId('second'), meta: { cwd: root } })
  expect(toolNames(ctx)).toEqual([])
  for (const agent of [first.agent, second.agent]) {
    expect(toolNames(ctx, agent)).toContain(TOOL)
  }
})
