import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CodeRuntime } from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import ToolRuntime, { defineTool, RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

const signal = new AbortController().signal

function digest(policy: Record<string, unknown>): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
    }
    return JSON.stringify(value)
  }
  return createHash('sha256').update(canonical(policy)).digest('hex')
}

function tool(name: string, calls: string[]) {
  return defineTool({
    name,
    description: name,
    parameters: { value: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text' as const, text: value }],
    },
    async execute() {
      calls.push(name)
      return name
    },
  })
}

function makeAgent(rawId: string, cwd?: string): Agent {
  const id = SessionId(rawId)
  const session = Session.create(id, undefined, {
    version: 0,
    id,
    createdAt: Date.now(),
    ...(cwd === undefined ? {} : { cwd }),
  })
  return {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'idle',
    ctx: new Context(),
    send() {},
    followup() {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function setup(mode: 'native' | 'code' = 'native', processAgentId = 'agt_example') {
  vi.stubEnv('DSH_AGENT_ID', processAgentId)
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode })
  const runtimeAgent = makeAgent(`runtime-${processAgentId}`)
  ctx.agents.register(runtimeAgent)
  return { ctx, agent: runtimeAgent }
}

async function mintScope(ctx: Context, agent: Agent): Promise<{ scope: Scope; agent: Agent }> {
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] }))
  return { scope, agent }
}

class NestedRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fake'

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    const tools = request.bindings[0]!.functions
    await tools.workflow!({ operation: 'read', value: 'nested' })
    await tools.workflow!({ operation: 'write', value: 'nested' }).catch(() => undefined)
    return { logs: [], value: 'done' }
  }
}

describe('trusted native tool policy', () => {
  it('hides unlisted tools and rejects direct global, scoped, and run_code dispatch before handlers', async () => {
    const { ctx, agent } = await setup('code', 'agt_dev')
    const calls: string[] = []
    ctx.tools.register(tool('read', calls))
    ctx.tools.register(tool('write', calls))
    ctx.tools.register(defineTool({
      name: 'workflow',
      description: 'workflow',
      parameters: { operation: { type: 'string' }, value: { type: 'string' } },
      nativePolicyDiscriminators: ['operation'],
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
      async execute(args) { const operation = args.operation ?? 'missing'; calls.push(operation); return operation },
    }))
    const allowedCalls = [{ toolName: 'read' }]
    const unsigned = { version: 1, agentId: 'agt_dev', mode: 'native-allowlist', allowedCalls }
    const policy = { ...unsigned, policyDigest: digest(unsigned) }
    ctx.tools.configureTrustedNativeToolPolicy(policy)

    const { scope } = await mintScope(ctx, agent)
    scope.ctx.tools.register(tool('scope_write', calls))
    scope.ctx.tools.register(defineTool({
      name: 'read',
      description: 'scoped shadow',
      parameters: { value: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
      async execute() { calls.push('scoped-read'); return 'scoped-read' },
    }))

    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(['read'])
    expect(ctx.tools.schemas(agent)).toEqual([])
    const denied = await Promise.all([
      ctx.tools.execute({ signal, callId: CallId('write-1'), name: 'write', arguments: { value: 'x' }, agent }),
      ctx.tools.execute({ signal, callId: CallId('scope-1'), name: 'scope_write', arguments: { value: 'x' }, agent }),
      ctx.tools.execute({ signal, callId: CallId('shadow-1'), name: 'read', arguments: { value: 'x' }, agent }),
      ctx.tools.execute({ signal, callId: CallId('code-1'), name: 'run_code', arguments: { code: '1', description: 'test' }, agent }),
      ctx.tools.execute({ signal, callId: CallId('unknown-agent'), name: 'read', arguments: { value: 'x' }, agent: makeAgent('unregistered') }),
    ])

    expect(denied.every(result => result.isError)).toBe(true)
    expect(calls).toEqual([])
    await ctx.fiber.dispose()
  })

  it('keeps the authorized operation immutable across pre-execute listeners', async () => {
    const { ctx, agent } = await setup('native', 'agt_dev')
    const calls: string[] = []
    ctx.tools.register(tool('read', calls))
    ctx.tools.register(tool('write', calls))
    ctx.tools.register(defineTool({
      name: 'workflow',
      description: 'workflow',
      parameters: { operation: { type: 'string' }, value: { type: 'string' } },
      nativePolicyDiscriminators: ['operation'],
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
      async execute(args) { const operation = args.operation ?? 'missing'; calls.push(operation); return operation },
    }))
    const unsigned = { version: 1, agentId: 'agt_dev', mode: 'native-allowlist', allowedCalls: [{ toolName: 'read' }] }
    ctx.tools.configureTrustedNativeToolPolicy({ ...unsigned, policyDigest: digest(unsigned) })
    ctx.on('tools/pre-execute', async (execution, next) => {
      Object.assign(execution, { name: 'read', arguments: { value: 'rewritten' } })
      return next()
    })

    const result = await ctx.tools.execute({ signal, callId: CallId('rewrite'), name: 'write', arguments: { value: 'x' }, agent })
    expect(result.isError).toBe(true)
    expect(calls).toEqual([])
    await ctx.fiber.dispose()
  })

  it('permits only the explicitly named Owner repair action and preserves legacy behavior without policy', async () => {
    const calls: string[] = []
    const { ctx: owner, agent: ownerAgent } = await setup('native', 'agt_owner')
    owner.tools.register(tool('write', calls))
    const ownerUnsigned = { version: 1, agentId: 'agt_owner', mode: 'native-allowlist', allowedCalls: [{ toolName: 'write' }] }
    owner.tools.configureTrustedNativeToolPolicy({ ...ownerUnsigned, policyDigest: digest(ownerUnsigned) })
    const ownerResult = await owner.tools.execute({ signal, callId: CallId('owner-write'), name: 'write', arguments: { value: 'x' }, agent: ownerAgent })
    expect(ownerResult.isError).toBe(false)
    const ownerChild = makeAgent('agt-owner-child-runtime')
    const disposeOwnerChild = owner.agents.register(ownerChild)
    const childResult = await owner.tools.execute({ signal, callId: CallId('owner-child-write'), name: 'write', arguments: { value: 'x' }, agent: ownerChild })
    expect(childResult.isError).toBe(false)
    disposeOwnerChild()
    const disposedResult = await owner.tools.execute({ signal, callId: CallId('owner-disposed-write'), name: 'write', arguments: { value: 'x' }, agent: ownerChild })
    expect(disposedResult.isError).toBe(true)

    const { ctx: legacy, agent: legacyAgent } = await setup()
    legacy.tools.register(tool('write', calls))
    const legacyResult = await legacy.tools.execute({ signal, callId: CallId('legacy-write'), name: 'write', arguments: { value: 'x' }, agent: legacyAgent })
    expect(legacyResult.isError).toBe(false)
    expect(calls).toEqual(['write', 'write', 'write'])
    await Promise.all([owner.fiber.dispose(), legacy.fiber.dispose()])
  })

  it('matches exact operation selectors and honors declared discriminators', async () => {
    const calls: string[] = []
    const { ctx, agent } = await setup()
    ctx.tools.register(defineTool({
      name: 'workflow',
      description: 'workflow',
      parameters: { operation: { type: 'string' }, payload: { type: 'string' }, filter: { type: 'json' } },
      nativePolicyDiscriminators: ['operation', 'filter'],
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
      async execute(args) { const operation = args.operation ?? 'missing'; calls.push(operation); return operation },
    }))
    const argumentEquals = { operation: 'read', filter: { state: 'open' } }
    const unsigned = {
      version: 1,
      agentId: 'agt_example',
      mode: 'native-allowlist',
      allowedCalls: [{ toolName: 'workflow', argumentEquals }],
    }
    ctx.tools.configureTrustedNativeToolPolicy({ ...unsigned, policyDigest: digest(unsigned) })
    argumentEquals.filter.state = 'closed'

    const read = await ctx.tools.execute({ signal, callId: CallId('workflow-read'), name: 'workflow', arguments: { operation: 'read', payload: 'x', filter: { state: 'open' } }, agent })
    const write = await ctx.tools.execute({ signal, callId: CallId('workflow-write'), name: 'workflow', arguments: { operation: 'write', payload: 'x', filter: { state: 'open' } }, agent })
    expect(read.isError).toBe(false)
    expect(write.isError).toBe(true)
    expect(calls).toEqual(['read'])
    await ctx.fiber.dispose()
  })

  it('applies the same allowlist to Code Mode nested dispatch', async () => {
    vi.stubEnv('DSH_AGENT_ID', 'agt_example')
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'code' })
    await ctx.plugin(NestedRuntime)
    const agent = makeAgent('nested-runtime-agent')
    ctx.agents.register(agent)
    const calls: string[] = []
    ctx.tools.register(tool('read', calls))
    ctx.tools.register(tool('write', calls))
    ctx.tools.register(defineTool({
      name: 'workflow',
      description: 'workflow',
      parameters: { operation: { type: 'string' }, value: { type: 'string' } },
      nativePolicyDiscriminators: ['operation'],
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text' as const, text: value }] },
      async execute(args) { const operation = args.operation ?? 'missing'; calls.push(operation); return operation },
    }))
    const unsigned = {
      version: 1,
      agentId: 'agt_example',
      mode: 'native-allowlist',
      allowedCalls: [{ toolName: RUN_CODE_NAME }, { toolName: 'workflow', argumentEquals: { operation: 'read' } }],
    }
    ctx.tools.configureTrustedNativeToolPolicy({ ...unsigned, policyDigest: digest(unsigned) })
    const codeAgent = makeAgent('native-policy-code-session', '/workspace')
    ctx.agents.register(codeAgent)

    const result = await ctx.tools.execute({
      signal,
      callId: CallId('code-outer'),
      name: RUN_CODE_NAME,
      arguments: { code: 'program', description: 'test nested policy' },
      agent: codeAgent,
    })
    if (result.isError) throw new Error(result.error.message)
    expect(result.isError).toBe(false)
    expect(calls).toEqual(['read'])
    await ctx.fiber.dispose()
  })

  it('rejects a wrong digest before a policy is bound', async () => {
    const { ctx } = await setup()
    ctx.tools.register(tool('read', []))
    expect(() => ctx.tools.configureTrustedNativeToolPolicy({
      version: 1,
      agentId: 'agt_dev',
      mode: 'native-allowlist',
      allowedCalls: [{ toolName: 'read' }],
      policyDigest: '0'.repeat(64),
    })).toThrow(/digest/i)
    await ctx.fiber.dispose()
  })

  it('rejects missing or mismatched independent process identity before acknowledging policy', async () => {
    const missing = await setup('native', '')
    const missingUnsigned = { version: 1, agentId: 'agt_example', mode: 'native-allowlist', allowedCalls: [] }
    expect(() => missing.ctx.tools.configureTrustedNativeToolPolicy({
      ...missingUnsigned,
      policyDigest: digest(missingUnsigned),
    })).toThrow(/requires authenticated DSH_AGENT_ID/)
    await missing.ctx.fiber.dispose()

    const mismatch = await setup('native', 'agt_other')
    const mismatchUnsigned = { version: 1, agentId: 'agt_example', mode: 'native-allowlist', allowedCalls: [] }
    expect(() => mismatch.ctx.tools.configureTrustedNativeToolPolicy({
      ...mismatchUnsigned,
      policyDigest: digest(mismatchUnsigned),
    })).toThrow(/does not match authenticated DSH_AGENT_ID/)
    await mismatch.ctx.fiber.dispose()
  })
})
