import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createAssistantMessage, createUserMessage, ToolCallId as ToolCallIdOf } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as ClaudeCodeMods from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop bridge tests: a scripted mock MODEL drives the REAL agent loop,
 * tool registry, command registry, filesystem, subprocess, user-questions and
 * storage services, and the REAL bridge loads REAL mod directories — only the
 * model is mocked. Each test asserts the mod's effect on the loop or the
 * services, not on the bridge's internals.
 */

const FIXTURES = resolve(import.meta.dirname, 'fixtures')
const dirs: string[] = []
const fibers: Fiber[] = []
afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix = 'dsh-cc-mods-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Write an inline mod directory: a manifest, hooks.json, and the given register.js body. */
function writeMod(name: string, body: string): string {
  const root = join(scratch(), name)
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  mkdirSync(join(root, 'hooks'))
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '0.0.1' }))
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.js'] }))
  writeFileSync(join(root, 'hooks', 'register.js'), body)
  return root
}

interface HarnessOptions {
  readonly config?: Partial<ClaudeCodeMods.Config>
  readonly services?: (ctx: Context, workspace: string) => Promise<void>
  readonly tools?: { mode?: 'native' | 'ptc' | 'both' }
}

interface Harness {
  readonly ctx: Context
  readonly adapter: MockAdapter
  readonly workspace: string
  readonly mods: Fiber
  readonly info: ReturnType<typeof vi.fn>
  readonly warn: ReturnType<typeof vi.fn>
  agent(id?: string): Promise<Agent>
  turn(agent: Agent, text: string): Promise<void>
}

async function harness(pluginDirs: string[], adapter: MockAdapter, options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  fibers.push(ctx.fiber)
  const info = vi.fn()
  const warn = vi.fn()
  ctx.logger.info = info as never
  ctx.logger.warn = warn as never
  await mountAgentLoopTestDependencies(ctx, { tools: options.tools ?? {} })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  const workspace = scratch('dsh-cc-mods-ws-')
  await options.services?.(ctx, workspace)
  const mods = await ctx.plugin(ClaudeCodeMods, { pluginDirs, ...options.config })
  await mods.await()
  ctx.llm.registerAdapter(['mock'], adapter)
  return {
    ctx, adapter, workspace, mods, info, warn,
    agent: id => ctx.agentLoop.create(SessionId(id ?? 'a1'), { provider: 'mock', model: 'mock' }, { cwd: workspace }),
    async turn(agent, text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
  }
}

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

function toolResult(agent: Agent): { isError: boolean; text: string } | undefined {
  const event = events(agent).find(e => e.type === 'tool/result')
  if (event?.type !== 'tool/result') return undefined
  const { message } = event.data
  return { isError: message.isError === true, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') }
}

function echoTool(name: string, ran: string[] = []) {
  return defineContentToolFixture({
    name, description: 'echoes its command', parameters: { command: { type: 'string' } },
    async execute(args) {
      ran.push(String(args.command))
      return [{ type: 'text', text: `ran ${String(args.command)}` }]
    },
  })
}

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('first-mod: the tutorial mod on the real loop', () => {
  it('registers /tally at session start, counts the turn\'s tool calls, prints the count without a model turn, and unregisters on dispose', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { command: 'ls' }), textResponse('done')])
    const h = await harness([join(FIXTURES, 'first-mod')], adapter)
    h.ctx.tools.register(echoTool('echo'))
    const agent = await h.agent()
    expect(h.ctx.commands.list(agent).map(command => command.name)).toEqual(['tally'])
    expect(h.info).toHaveBeenCalledWith(
      'claude-code-mods: hooks module first-mod@inline loaded (tier user); '
      + 'events: session.start, tool.call, command.run{command=tally}, ui.render{component=Spinner}',
    )

    await h.turn(agent, 'list the files here')
    expect(adapter.requests).toHaveLength(2)
    const run = await h.ctx.commands.execute(agent, '/tally', [], new AbortController().signal)
    expect(run?.result).toEqual({ kind: 'success', text: 'first-mod: Claude has made 1 tool calls since this mod loaded' })
    expect(events(agent).filter(e => e.type === 'command/run' || e.type === 'command/done').map(e => e.type)).toEqual(['command/run', 'command/done'])

    // The command is scoped to the agent that started the session, not global.
    const other = await h.agent('a2')
    expect(h.ctx.commands.list(other).map(command => command.name)).toEqual(['tally'])

    await h.mods.dispose()
    expect(h.ctx.commands.list(agent)).toEqual([])
    expect(h.ctx.commands.list(other)).toEqual([])
  })
})

describe('guard-mod: tool.call deny, observe-after, and fail-closed .catch', () => {
  it('refuses a risky Bash command before the tool body runs, with the reason as the model-visible error', async () => {
    const ran: string[] = []
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'git push --force' }), textResponse('ok')])
    const h = await harness([join(FIXTURES, 'guard-mod')], adapter)
    h.ctx.tools.register(echoTool('bash', ran))
    expect(h.warn).toHaveBeenCalledWith(expect.stringMatching(/settings hooks in hooks.json are not run by this bridge/))
    const agent = await h.agent()
    await h.turn(agent, 'force push')
    expect(ran).toEqual([])
    expect(toolResult(agent)).toEqual({ isError: true, text: 'Error: guard-mod refused this command: git push --force' })
  })

  it('lets a safe command through, observes the result, and reaches the host log through $.ui.log', async () => {
    const ran: string[] = []
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'ls' }), textResponse('ok')])
    const h = await harness([join(FIXTURES, 'guard-mod')], adapter)
    h.ctx.tools.register(echoTool('bash', ran))
    const agent = await h.agent()
    await h.turn(agent, 'list')
    expect(ran).toEqual(['ls'])
    expect(toolResult(agent)).toEqual({ isError: false, text: 'ran ls' })
    await waitFor(() => h.info.mock.calls.some(call => call[0] === 'guard-mod: ran Bash: ls'))
  })

  it('fails closed through .catch when the guard throws', async () => {
    const ran: string[] = []
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'explode' }), textResponse('ok')])
    const h = await harness([join(FIXTURES, 'guard-mod')], adapter)
    h.ctx.tools.register(echoTool('bash', ran))
    const agent = await h.agent()
    await h.turn(agent, 'boom')
    expect(ran).toEqual([])
    expect(toolResult(agent)).toEqual({ isError: true, text: 'Error: The command guard failed, so this command was not run: throw' })
    expect(h.warn).toHaveBeenCalledWith('claude-code-mods: guard-mod: tool.call hook skipped: threw Error: guard exploded')
  })
})

describe('ticket-mod: a mod-registered tool, prompt context, and a turn.complete line', () => {
  it('offers mcp__ticket-mod__ticket to the model and answers its calls with a successful result', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'mcp__ticket-mod__ticket', { id: 'T-1' }), textResponse('ok')])
    const h = await harness([join(FIXTURES, 'ticket-mod')], adapter)
    const agent = await h.agent()
    const schema = h.ctx.tools.schemas(scopeOf(agent.ctx)).find(tool => tool.name === 'mcp__ticket-mod__ticket')
    expect(schema).toMatchObject({ description: 'Look up a ticket by its id and return its title and status', parameters: { type: 'object', required: ['id'] } })
    await h.turn(agent, 'what is T-1 about?')
    expect(toolResult(agent)).toEqual({ isError: false, text: 'Login button does nothing (open)' })
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('mcp__ticket-mod__ticket')
    await waitFor(() => h.info.mock.calls.some(call => call[0] === 'claude-code-mods: Done in some ms'))
  })

  it('appends prompt.submit context as a mod-sourced message the model reads after the prompt', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const h = await harness([join(FIXTURES, 'ticket-mod')], adapter)
    const agent = await h.agent()
    await h.turn(agent, 'open a PR for this change')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Current branch: feature/mods')
    const context = events(agent).find(e => e.type === 'user/message' && e.data.source.kind !== 'user')
    expect(context?.type === 'user/message' && context.data.source).toEqual({ kind: 'claude-code-mods' })
    expect(toolResult(agent)).toBeUndefined()
  })
})

describe('prompt.submit: rewrite and drop', () => {
  it('rewrites the prompt text the model sees and drops a prompt with a reason', async () => {
    const mod = writeMod('prompt-mod', `
      export function register(on) {
        on('prompt.submit', async ($, e, next) => {
          if (e.text.includes('secret')) return { drop: 'secrets stay out' }
          return next({ ...e, text: e.text.trim().toUpperCase() })
        })
      }
    `)
    const adapter = new MockAdapter([textResponse('ok')])
    const h = await harness([mod], adapter)
    const agent = await h.agent()
    await h.turn(agent, '  hello there  ')
    const entered = events(agent).find(e => e.type === 'user/message')
    expect(entered?.type === 'user/message' && entered.data.content).toEqual([{ type: 'text', text: 'HELLO THERE' }])
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('HELLO THERE')

    await h.turn(agent, 'tell me the secret')
    expect(adapter.requests).toHaveLength(1)
    const turns = events(agent).filter(e => e.type === 'turn/end').map(e => e.type === 'turn/end' && e.data.reason.kind)
    expect(turns).toEqual(['completed', 'blocked'])
    expect(h.info).toHaveBeenCalledWith('claude-code-mods: prompt dropped: secrets stay out')
  })
})

describe('tool.call: answers and rewrites', () => {
  it('answers a built-in tool in its place as an error-shaped result, keeps a rewritten result through post-execute, and warns once about rewritten arguments', async () => {
    const mod = writeMod('answer-mod', `
      export function register(on) {
        on('tool.call', { tool: 'echo' }, async ($, e, next) => {
          if (e.command === 'skip') return { result: 'Skipped by answer-mod' }
          if (e.command === 'redact') {
            const r = await next({ ...e, command: 'rewritten' })
            return { ...r, result: String(r.result).replace('ran', 'RAN') }
          }
          return next(e)
        })
      }
    `)
    const ran: string[] = []
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { command: 'skip' }), textResponse('one'),
      toolCallResponse('c2', 'echo', { command: 'redact' }), textResponse('two'),
      toolCallResponse('c3', 'echo', { command: 'redact' }), textResponse('three'),
    ])
    const h = await harness([mod], adapter)
    h.ctx.tools.register(echoTool('echo', ran))
    const agent = await h.agent()
    await h.turn(agent, 'skip it')
    expect(ran).toEqual([])
    expect(toolResult(agent)).toEqual({ isError: true, text: 'Skipped by answer-mod' })
    const first = events(agent).find(e => e.type === 'tool/result')
    expect(first?.type === 'tool/result' && JSON.stringify(first.data)).toContain('MOD_ANSWERED')

    await h.turn(agent, 'redact it')
    await h.turn(agent, 'redact again')
    expect(ran).toEqual(['redact', 'redact'])
    const results = events(agent).filter(e => e.type === 'tool/result').map(e => e.type === 'tool/result' && e.data.message.content[0])
    expect(results.slice(1)).toEqual([{ type: 'text', text: 'RAN redact' }, { type: 'text', text: 'RAN redact' }])
    expect(h.warn.mock.calls.filter(call => String(call[0]).includes('rewrote the arguments of echo'))).toHaveLength(1)
  })

  it('leaves tools alone when no mod hooks tool.call', async () => {
    const mod = writeMod('quiet-mod', 'export function register(on) { on("turn.start", ($, e, next) => next(e)) }')
    const ran: string[] = []
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { command: 'ls' }), textResponse('ok')])
    const h = await harness([mod], adapter)
    h.ctx.tools.register(echoTool('echo', ran))
    const agent = await h.agent()
    await h.turn(agent, 'go')
    expect(ran).toEqual(['ls'])
    expect(toolResult(agent)).toEqual({ isError: false, text: 'ran ls' })
  })
})

describe('the mods API over harness services', () => {
  it('serves files, processes, session facts, the store, env, http, commands, and tools', async () => {
    const mod = writeMod('api-mod', `
      export function register(on) {
        on('command.run', { command: 'probe' }, async ($, e) => {
          const out = {}
          await $.fs.write('notes.md', '# Notes')
          out.read = await $.fs.read('notes.md')
          out.exists = [await $.fs.exists('notes.md'), await $.fs.exists('missing.md')]
          out.list = (await $.fs.list()).map(entry => entry.name + ':' + entry.kind)
          out.stat = (await $.fs.stat('notes.md')).kind
          await $.fs.stat('missing.md').catch(error => { out.statError = error.message })
          out.run = await $.process.run(['node', '-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'])
          await $.process.run(['node', '-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 }).catch(error => { out.timeout = error.message })
          out.session = {
            id: await $.session.id(), cwd: await $.session.cwd(), root: await $.session.root(), model: await $.session.model(),
            turns: await $.session.turns(), version: await $.session.version(), usage: await $.session.usage(),
            messages: await $.session.messages(),
          }
          await $.store.set('count', 7)
          await $.store.set('name', 'x')
          await $.store.delete('name')
          await $.store.delete('never')
          out.store = { count: await $.store.get('count'), keys: await $.store.keys() }
          await $.env.set('CC_MODS_PROBE', 'yes')
          out.env = await $.env.get('CC_MODS_PROBE')
          await $.env.set('CC_MODS_PROBE', undefined)
          out.envGone = await $.env.get('CC_MODS_PROBE')
          const response = await $.http.fetch(e.args, { method: 'POST', headers: { 'x-mod': 'api-mod' }, body: 'ping', timeoutMs: 2000 })
          out.http = { status: response.status, ok: response.ok, text: response.text, echoed: response.headers['x-echo'] }
          out.get = (await $.http.fetch(e.args)).headers['x-echo']
          out.commands = (await $.command.list()).map(command => command.name + '/' + command.source)
          out.tools = (await $.tool.list()).map(tool => tool.name)
          out.call = await $.tool.call({ tool: 'echo', command: 'from mod' })
          out.toasts = [$.ui.toast('hi'), $.ui.status('busy'), $.ui.status(undefined), $.ui.log('debug line', { to: 'debug' })]
          out.open = await $.ui.open({ id: 'pane' })
          out.close = await $.ui.close({ id: 'pane' })
          out.panes = await $.ui.panes()
          out.state = await $.state.get({ plugin: 'api-mod', key: 'missing' })
          return { text: JSON.stringify(out) }
        })
        on('session.start', async ($, e, next) => {
          await $.command.register({ name: 'probe', description: 'Probe the mods API', argumentHint: '<url>' })
          await $.command.register({ name: 'Bad Name!', description: 'x' }).catch(() => {})
          return next(e)
        })
      }
    `)
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        response.setHeader('x-echo', `${request.method} ${request.headers['x-mod']} ${body}`)
        response.end('pong')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const adapter = new MockAdapter([textResponse('ok')])
      const h = await harness([mod], adapter, {
        services: async (ctx, workspace) => {
          await ctx.plugin(LocalFileSystem, { cwd: workspace })
          await ctx.plugin(LocalSubprocessRuntime)
          await ctx.plugin(Storage)
          await ctx.plugin(StorageJson, { root: join(workspace, '.storage') })
          await ctx.plugin(StorageDomain, { backend: 'json' })
        },
      })
      h.ctx.tools.register(echoTool('echo'))
      const agent = await h.agent()
      await h.turn(agent, 'hello')
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
      const run = await h.ctx.commands.execute(agent, `/probe ${url}`, [], new AbortController().signal)
      expect(run?.result.kind).toBe('success')
      const out = JSON.parse(String(run?.result.text).replace(/^api-mod: /, '')) as Record<string, unknown>
      expect(out.read).toBe('# Notes')
      expect(readFileSync(join(h.workspace, 'notes.md'), 'utf8')).toBe('# Notes')
      expect(out.exists).toEqual([true, false])
      expect(out.list).toContain('notes.md:file')
      expect(out.stat).toBe('file')
      expect(out.statError).toMatch(/missing\.md does not exist/)
      expect(out.run).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' })
      expect(out.timeout).toMatch(/did not exit within 200 ms/)
      expect(out.session).toEqual({
        id: 'a1', cwd: h.workspace, root: h.workspace, model: 'mock', turns: 1,
        version: ClaudeCodeMods.MODS_API_VERSION,
        usage: { startedAt: agent.session.header.createdAt, context: { window: 0 }, rateLimits: [] },
        messages: [{ role: 'user', text: 'hello', toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [] }],
      })
      expect(out.store).toEqual({ count: 7, keys: ['count'] })
      expect(out.env).toBe('yes')
      expect(out.envGone).toBeUndefined()
      expect(out.http).toEqual({ status: 200, ok: true, text: 'pong', echoed: 'POST api-mod ping' })
      expect(out.get).toBe('GET undefined ')
      expect(out.commands).toEqual(['probe/plugin'])
      expect(out.tools).toContain('echo')
      expect(out.call).toEqual({ result: 'ran from mod' })
      expect(out.toasts).toEqual([null, null, null, null])
      expect(out.open).toMatchObject({ isPlaced: false })
      expect((out.open as { reason: string }).reason).toMatch(/places no panes/)
      expect(out.close).toBeUndefined()
      expect(out.panes).toEqual([])
      expect(out.state).toEqual({})
      expect(h.info).toHaveBeenCalledWith('api-mod (toast): hi')
      expect(h.info).toHaveBeenCalledWith('api-mod (status): busy')
      expect(h.info).toHaveBeenCalledWith('api-mod (status): (cleared)')
    } finally {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
})

describe('$.ui.ask through the user-questions answerer', () => {
  function askMod(): string {
    return writeMod('ask-mod', `
      export function register(on) {
        on('tool.call', { tool: 'echo' }, async ($, e, next) => {
          let answer
          if (e.command === 'plain') answer = await $.ui.ask('Run it?')
          else if (e.command === 'multi') answer = await $.ui.ask('Pick', { options: ['a', 'b', 'c'], header: 'Choices', multiSelect: true })
          else answer = await $.ui.ask('Run ' + e.command + '?', ['Run it', 'Refuse'])
          if (answer === 'Run it' || answer === 'typed yes' || answer === 'a, c') return next(e)
          return { deny: 'The user declined: ' + answer }
        })
      }
    `)
  }

  it('holds the call until the answerer settles and maps selections, typed answers, and dismissals', async () => {
    const ran: string[] = []
    const answers: string[][] = []
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { command: 'first' }), textResponse('one'),
      toolCallResponse('c2', 'echo', { command: 'second' }), textResponse('two'),
      toolCallResponse('c3', 'echo', { command: 'plain' }), textResponse('three'),
      toolCallResponse('c4', 'echo', { command: 'multi' }), textResponse('four'),
      toolCallResponse('c5', 'echo', { command: 'dismissed' }), textResponse('five'),
    ])
    const seen: unknown[] = []
    const h = await harness([askMod()], adapter, {
      services: async (ctx) => {
        await ctx.plugin(UserQuestionService)
        ctx.on('user-questions/request', (request) => {
          seen.push(request.questions[0])
          const next = answers.shift() ?? []
          return Promise.resolve({ answers: next.length === 0 && request.questions[0]?.question === 'Run dismissed?' ? [] : [{ id: 'answer', selected: next, ...next.length === 0 ? { custom: 'typed yes' } : {} }] })
        })
      },
    })
    h.ctx.tools.register(echoTool('echo', ran))
    const agent = await h.agent()
    answers.push(['Refuse'], ['Run it'], [], ['a', 'c'], [])
    await h.turn(agent, 'first')
    await h.turn(agent, 'second')
    await h.turn(agent, 'plain')
    await h.turn(agent, 'multi')
    await h.turn(agent, 'dismissed')
    expect(ran).toEqual(['second', 'plain', 'multi', 'dismissed'])
    const results = events(agent).filter(e => e.type === 'tool/result').map(e => e.type === 'tool/result' && e.data.message.content[0])
    expect(results[0]).toEqual({ type: 'text', text: 'Error: The user declined: Refuse' })
    expect(seen[0]).toEqual({ id: 'answer', question: 'Run first?', options: [{ label: 'Run it' }, { label: 'Refuse' }] })
    expect(seen[2]).toEqual({ id: 'answer', question: 'Run it?' })
    expect(seen[3]).toEqual({ id: 'answer', question: 'Pick', header: 'Choices', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multiSelect: true })
    expect(h.warn).toHaveBeenCalledWith('claude-code-mods: ask-mod: tool.call hook skipped: threw Error: $.ui.ask: the user dismissed the question')
  })
})

describe('commands and prompts raised by a mod', () => {
  it('runs commands, submits prompts framed or as the user, and reports a command the mod forgot to answer', async () => {
    const mod = writeMod('driver-mod', `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.command.register({ name: 'nudge', description: 'Submit a prompt from the mod' })
          await $.command.register({ name: 'silent', description: 'Registered without a command.run hook' })
          await $.command.register({ name: 'relay', description: 'Run another command' })
          await $.command.register({ name: 'quiet', description: 'Prints nothing' })
          return next(e)
        })
        on('command.run', { command: 'quiet' }, async ($) => {
          $.ui.log((await $.command.list()).map(c => c.name + '/' + c.source).join(','))
          return {}
        })
        on('command.run', { command: 'nudge' }, async ($, e) => {
          const sent = await $.prompt.submit(e.args === 'user' ? { text: 'as the user', asUser: true } : { text: 'from the mod' })
          return { text: 'sent ' + sent.text.length }
        })
        on('command.run', { command: 'relay' }, async ($, e) => {
          if (e.args === 'missing') return { text: await $.command.run({ command: 'nope' }).catch(error => error.message) }
          if (e.args === 'silent') return { text: await $.command.run({ command: 'silent' }).then(r => r.text) }
          if (e.args === 'fail') return { text: await $.command.run({ command: 'fail' }).catch(error => 'failed: ' + error.message) }
          if (e.args === 'mute') return { text: JSON.stringify(await $.command.run({ command: 'mute' })) }
          return { text: JSON.stringify(await $.command.run({ command: 'nudge', args: 'user' })) }
        })
      }
    `)
    const adapter = new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three')])
    const h = await harness([mod], adapter)
    h.ctx.commands.register({ name: 'fail', description: 'always fails', handler: () => ({ kind: 'error', text: 'nope' }) })
    h.ctx.commands.register({ name: 'mute', description: 'succeeds silently', handler: () => ({ kind: 'success' }) })
    const agent = await h.agent()
    const signal = new AbortController().signal
    const nudged = await h.ctx.commands.execute(agent, '/nudge', [], signal)
    expect(nudged?.result).toEqual({ kind: 'success', text: 'driver-mod: sent 47' })
    await agent.whenIdle()
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Message from the \\"driver-mod\\" mod:\\nfrom the mod')
    const submitted = events(agent).find(e => e.type === 'user/message')
    expect(submitted?.type === 'user/message' && submitted.data.source).toEqual({ kind: 'claude-code-mods' })

    const relayed = await h.ctx.commands.execute(agent, '/relay', [], signal)
    expect(relayed?.result).toEqual({ kind: 'success', text: 'driver-mod: {"text":"driver-mod: sent 11"}' })
    await agent.whenIdle()
    const last = adapter.requests[1]?.messages.at(-1)
    expect(last?.role === 'user' && last.content).toEqual([{ type: 'text', text: 'as the user' }])

    const silent = await h.ctx.commands.execute(agent, '/relay silent', [], signal)
    expect(silent?.result.text).toBe("driver-mod: driver-mod: driver-mod registered /silent but no command.run hook answered it; add on('command.run', { command: 'silent' }, hook)")
    const missing = await h.ctx.commands.execute(agent, '/relay missing', [], signal)
    expect(missing?.result.text).toBe('driver-mod: /nope is not a command')
    expect((await h.ctx.commands.execute(agent, '/relay fail', [], signal))?.result.text).toBe('driver-mod: failed: nope')
    expect((await h.ctx.commands.execute(agent, '/relay mute', [], signal))?.result.text).toBe('driver-mod: {}')
    expect((await h.ctx.commands.execute(agent, '/quiet', [], signal))?.result).toEqual({ kind: 'success' })
    expect(h.info).toHaveBeenCalledWith('driver-mod: fail/builtin,mute/builtin,nudge/plugin,quiet/plugin,relay/plugin,silent/plugin')
  })
})

describe('mod tools: registration errors and unanswered calls', () => {
  it('fails an invalid registration inside $.tool.register and reports a call no hook answered as a tool error', async () => {
    const mod = writeMod('tools-mod', `
      export function register(on) {
        on('session.start', async ($, e, next) => {
          await $.tool.register({ name: 'orphan', description: 'No hook answers this tool' })
          const errors = []
          await $.tool.register({ name: 'bad name', description: 'x' }).catch(error => errors.push(error.message))
          await $.tool.register({ name: 'badschema', description: 'x', inputSchema: { type: 'string' } }).catch(error => errors.push(error.message))
          $.ui.log(errors.join(' | '))
          return next(e)
        })
        on('tool.call', { tool: 'mcp__tools-mod__orphan' }, async ($, e, next) => {
          if (e.mode === 'object') return { result: { structured: true } }
          if (e.mode === 'empty') return { result: undefined }
          return next(e)
        })
      }
    `)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'mcp__tools-mod__orphan', { mode: 'pass' }), textResponse('one'),
      toolCallResponse('c2', 'mcp__tools-mod__orphan', { mode: 'object' }), textResponse('two'),
      toolCallResponse('c3', 'mcp__tools-mod__orphan', { mode: 'empty' }), textResponse('three'),
    ])
    const h = await harness([mod], adapter)
    const agent = await h.agent()
    await waitFor(() => h.info.mock.calls.some(call => String(call[0]).startsWith('tools-mod: tool "bad name" refused')))
    expect(h.info).toHaveBeenCalledWith(expect.stringMatching(/tool "bad name" refused.*\| .*object/))
    await h.turn(agent, 'one')
    await h.turn(agent, 'two')
    await h.turn(agent, 'three')
    const results = events(agent).filter(e => e.type === 'tool/result').map(e => e.type === 'tool/result' && [e.data.message.isError, e.data.message.content[0]])
    expect(results[0]).toEqual([true, { type: 'text', text: "Error: tools-mod registered mcp__tools-mod__orphan but no tool.call hook answered it; add on('tool.call', { tool: 'mcp__tools-mod__orphan' }, hook)" }])
    expect(results[1]).toEqual([false, { type: 'text', text: '{"structured":true}' }])
    expect(results[2]).toEqual([false, { type: 'text', text: '' }])
  })
})

describe('subagents, programmatic calls, and malformed tool arguments', () => {
  it('marks a child agent\'s events with agentId, skips session.start for it, and reads an unparsable tool input as empty', async () => {
    const mod = writeMod('watch-mod', `
      export function register(on) {
        on('session.start', async ($, e, next) => { $.ui.log('session.start ' + await $.session.id()); return next(e) })
        on('session.end', async ($, e, next) => { $.ui.log('session.end ' + e.sessionId); return next(e) })
        on('tool.call', async ($, e, next) => {
          const { value = 0 } = await $.state.get({ plugin: 'watch-mod', key: 'calls' })
          await $.state.set({ plugin: 'watch-mod', key: 'calls' }, value + 1)
          $.ui.log('tool.call ' + e.tool + ' agent=' + (e.agentId ?? 'root') + ' n=' + (value + 1))
          if (e.command === 'direct') {
            const names = (await $.tool.list()).map(tool => tool.name)
            const nested = await $.tool.call({ tool: 'echo', command: 'nested' })
            $.ui.log('direct saw ' + names.join(',') + ' and ' + JSON.stringify(nested))
          }
          return next(e)
        })
        on('turn.start', async ($, e, next) => { $.ui.log('turn.start agent=' + (e.agentId ?? 'root')); return next(e) })
        on('turn.complete', async ($, e, next) => {
          const messages = await $.session.messages()
          $.ui.log('turn.complete agent=' + (e.agentId ?? 'root') + ' inputs=' + JSON.stringify(messages.flatMap(m => m.toolUses.map(t => t.input))))
          return next(e)
        })
      }
    `)
    const malformedCall = [
      { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
      { type: 'tool-call-delta' as const, index: 0, id: ToolCallIdOf('m1'), name: 'echo', argumentsDelta: '{bad json' },
      { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: ToolCallIdOf('m1'), name: 'echo', arguments: '{bad json' } },
      { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
    ]
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { command: 'child' }), textResponse('child done'),
      malformedCall, textResponse('root done'),
    ])
    const h = await harness([mod], adapter)
    h.ctx.tools.register(echoTool('echo'))
    const root = await h.agent()
    const child = await h.ctx.agentLoop.createAgent(h.ctx, {
      sessionId: SessionId('child-1'), parentAgent: root, agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: h.workspace, origin: 'subagent' },
    })
    await h.turn(child.agent, 'child task')
    await child.dispose()
    await h.turn(root, 'root task')
    const lines = () => h.info.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('watch-mod: '))
    await waitFor(() => lines().length === 7)
    expect(lines()).toEqual([
      'watch-mod: session.start a1',
      'watch-mod: turn.start agent=child-1',
      'watch-mod: tool.call echo agent=child-1 n=1',
      'watch-mod: turn.complete agent=child-1 inputs=[{"command":"child"}]',
      'watch-mod: turn.start agent=root',
      'watch-mod: tool.call echo agent=root n=1',
      'watch-mod: turn.complete agent=root inputs=[{}]',
    ])
    const direct = await h.ctx.tools.execute({ callId: ToolCallIdOf('direct'), name: 'echo', arguments: { command: 'direct' }, signal: new AbortController().signal })
    expect(direct.isError).toBe(false)
    expect(h.info).toHaveBeenCalledWith('watch-mod: direct saw echo and {"result":"ran nested"}')
    expect(h.info.mock.calls.filter(call => String(call[0]).includes('agent=root n='))).toHaveLength(3)
  })
})

describe('turn.complete reasons and sessions the bridge did not follow from the start', () => {
  it('reports aborted and error turns, folds only the open turn, and ignores a session without a live agent', async () => {
    const mod = writeMod('ends-mod', `
      export function register(on) {
        on('turn.complete', async ($, e, next) => {
          $.ui.log('turn.complete ' + e.turnId + ' ' + e.reason + ' aborted=' + e.isAborted + ' answer=' + JSON.stringify(e.answer) + ' usage=' + (e.usage ? e.usage.model : 'none'))
          return next(e)
        })
      }
    `)
    const adapter = new MockAdapter([textResponse('fine'), 'hang'])
    const h = await harness([mod], adapter)
    const agent = await h.agent()
    await h.turn(agent, 'one')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length === 2)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    await h.turn(agent, 'three')
    const lines = () => h.info.mock.calls.map(call => String(call[0])).filter(line => line.startsWith('ends-mod: '))
    await waitFor(() => lines().length === 3)
    expect(lines()[0]).toBe('ends-mod: turn.complete 1 answer aborted=false answer="fine" usage=mock')
    expect(lines()[1]).toMatch(/^ends-mod: turn.complete 2 aborted aborted=true answer="(partial)?" usage=/)
    expect(lines()[2]).toMatch(/^ends-mod: turn.complete 3 error aborted=false/)

    // A fold for a turn the bridge never saw open, and an event for a session no agent owns.
    agent.session.append('turn/end', { turn: 9, reason: { kind: 'completed' } })
    await waitFor(() => lines().length === 4)
    expect(lines()[3]).toBe('ends-mod: turn.complete 9 answer aborted=false answer="" usage=none')
    const orphan = h.ctx.sessions.create(SessionId('orphan'))
    orphan.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lines()).toHaveLength(4)
  })

  it('forgets a session\'s state and raises session.end when its agent is disposed', async () => {
    const mod = writeMod('end-mod', `
      export function register(on) {
        on('session.end', async ($, e, next) => { $.ui.log('ended ' + e.sessionId + ' ' + e.reason); return next(e) })
      }
    `)
    const h = await harness([mod], new MockAdapter([]))
    const handle = await h.ctx.agentLoop.createAgent(h.ctx, { sessionId: SessionId('ends'), agentOptions: { provider: 'mock', model: 'mock' } })
    // An assistant message outside any turn the bridge follows is left alone.
    handle.agent.session.append('assistant/message', {
      turn: 0, step: 0, stream: [],
      message: createAssistantMessage({ content: [{ type: 'text', text: 'stray' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    await handle.dispose()
    await waitFor(() => h.info.mock.calls.some(call => call[0] === 'end-mod: ended ends other'))
  })
})

describe('$.session.usage with the token meter', () => {
  it('reports the provider-measured prompt size against the route\'s context window', async () => {
    class WindowedAdapter extends MockAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return { ...await super.resolveModel(provider, model), context: { contextWindow: 1000 } }
      }
    }
    const mod = writeMod('usage-mod', `
      export function register(on) {
        on('turn.complete', async ($, e, next) => {
          const usage = await $.session.usage()
          $.ui.log('usage ' + JSON.stringify(usage.context))
          return next(e)
        })
      }
    `)
    const adapter = new WindowedAdapter([textResponse('ok')])
    const h = await harness([mod], adapter, { services: async (ctx) => { await ctx.plugin(TokenMeter) } })
    const agent = await h.agent()
    await h.turn(agent, 'measure me')
    await waitFor(() => h.info.mock.calls.some(call => String(call[0]).startsWith('usage-mod: usage ')))
    const line = h.info.mock.calls.map(call => String(call[0])).find(text => text.startsWith('usage-mod: usage ')) ?? ''
    const context = JSON.parse(line.slice('usage-mod: usage '.length)) as { tokens: number; window: number; percent: number }
    expect(context.window).toBe(1000)
    expect(context.tokens).toBeGreaterThan(0)
    expect(context.percent).toBe(Math.round((context.tokens / 1000) * 100))
  })
})

describe('loading diagnostics and configuration', () => {
  it('skips a mod whose module fails and one that exports no register, loads the rest, and fails loud on a missing directory', async () => {
    const quiet = writeMod('quiet-mod', 'export function register() {}')
    const adapter = new MockAdapter([])
    const h = await harness([join(FIXTURES, 'broken-mod'), join(FIXTURES, 'no-register'), quiet], adapter, {
      config: { hookTimeoutMs: 50, catchTimeoutMs: 20, processTimeoutMs: 100 },
    })
    const warnings = h.warn.mock.calls.map(call => String(call[0]))
    expect(warnings).toContainEqual(
      expect.stringMatching(/broken-mod: hooks module did not load: register threw .*"tool.calls" is not an event/),
    )
    expect(warnings).toContainEqual(expect.stringMatching(/no-register: hooks module did not load: .*does not export a register function/))
    expect(h.info).toHaveBeenCalledWith('claude-code-mods: hooks module quiet-mod@inline loaded (tier user); events: (none)')

    const ctx = new Context()
    fibers.push(ctx.fiber)
    await expect(ClaudeCodeMods.apply(ctx, { pluginDirs: [join(FIXTURES, 'missing')] })).rejects.toThrow(/plugin\.json: cannot read/)
    await expect(ClaudeCodeMods.apply(ctx, { pluginDirs: [], hookTimeoutMs: 0 })).rejects.toThrow(/hookTimeoutMs must be a positive number/)
    await expect(ClaudeCodeMods.apply(ctx, { pluginDirs: [], catchTimeoutMs: -1 }))
      .rejects.toThrow(/catchTimeoutMs must be a positive number/)
    await expect(ClaudeCodeMods.apply(ctx, { pluginDirs: [], processTimeoutMs: Number.NaN }))
      .rejects.toThrow(/processTimeoutMs must be a positive number/)
    await expect(ClaudeCodeMods.apply(ctx, { pluginDirs: [] })).resolves.toBeUndefined()
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in ClaudeCodeMods).toBe(false)
    expect(ClaudeCodeMods.name).toBe('claude-code-mods')
    expect(ClaudeCodeMods.inject).toEqual([])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped: unknown = loader.unwrapExports(ClaudeCodeMods)
    expect(unwrapped).toBe(ClaudeCodeMods)
  })
})

describe('post-execute interplay and prompt rewrites with images', () => {
  it('keeps a downstream block, carries downstream contexts onto a replaced result, and rewrites only text blocks', async () => {
    const mod = writeMod('rewrite-mod', `
      export function register(on) {
        on('tool.call', { tool: 'echo' }, async ($, e, next) => {
          const r = await next(e)
          return { ...r, result: 'REPLACED' }
        })
        on('prompt.submit', ($, e, next) => next({ ...e, text: 'rewritten: ' + e.text }))
      }
    `)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { command: 'a' }), textResponse('one'),
      toolCallResponse('c2', 'echo', { command: 'b' }), textResponse('two'),
    ])
    const h = await harness([mod], adapter)
    h.ctx.tools.register(echoTool('echo'))
    let block = true
    h.ctx.on('tools/post-execute', async (_exec, _result, next) => {
      if (block) return { kind: 'block', feedback: [{ type: 'text', text: 'blocked downstream' }] }
      const downstream = await next()
      return { ...downstream, additionalContexts: [createUserMessage({ content: [{ type: 'text', text: 'downstream context' }], source: { kind: 'user' } })] }
    })
    const agent = await h.agent()
    const image = { type: 'image' as const, attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } as ImageAttachmentRef }
    // Injected context is claimed with the waking prompt, so one pre-step sees both messages.
    agent.inject(createUserMessage({ content: [image], source: { kind: 'user' } }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }, image, { type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const entered = events(agent).filter(e => e.type === 'user/message').map(e => e.type === 'user/message' && e.data.content)
    expect(entered).toContainEqual([image])
    expect(entered).toContainEqual([{ type: 'text', text: 'rewritten: firstsecond' }, image])
    expect(toolResult(agent)).toEqual({ isError: true, text: 'blocked downstream' })

    block = false
    await h.turn(agent, 'again')
    const results = events(agent).filter(e => e.type === 'tool/result').map(e => e.type === 'tool/result' && e.data.message.content[0])
    expect(results[1]).toEqual({ type: 'text', text: 'REPLACED' })
    expect(JSON.stringify(adapter.requests[3]?.messages)).toContain('downstream context')
  })
})
