import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import ApprovalService, { type ApprovalOutcome, type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import * as approvalPolicy from '../src/index.ts'
import { WEB_FETCH_MAX_URL_LENGTH } from '../../web-fetch-http/src/policy.ts'
import { publicHttpNetwork } from '../../web-fetch-http/src/network.ts'

const signal = new AbortController().signal

afterEach(() => {
  vi.restoreAllMocks()
})

function fakeAgent(): Agent {
  return {
    session: {
      header: { cwd: process.cwd() },
      events: [{ type: 'turn/start' }],
      append: () => ({}),
    },
  } as unknown as Agent
}

async function setup(
  mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'workspace-write',
  approval: 'ask' | 'never' = 'ask',
): Promise<{ ctx: Context; calls: { count: number } }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SandboxPolicyService, { mode })
  await ctx.plugin(ApprovalService, { policy: approval })
  await ctx.plugin(approvalPolicy)
  const calls = { count: 0 }
  ctx.tools.register(defineTool({
    name: 'web_fetch',
    description: 'test web fetch',
    parameters: { url: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      calls.count += 1
      return 'fetched'
    },
  }))
  ctx.tools.register(defineTool({
    name: 'echo',
    description: 'unrelated test tool',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() { return 'echoed' },
  }))
  return { ctx, calls }
}

function executeFetch(ctx: Context, agent: Agent | null = fakeAgent(), arguments_: unknown = { url: 'https://example.com/path?q=1' }) {
  return ctx.tools.execute({
    callId: CallId('fetch-call'),
    name: 'web_fetch',
    arguments: arguments_,
    ...agent === null ? {} : { agent },
    signal,
  })
}

describe('web_fetch approval policy', () => {
  it.each(['read-only', 'workspace-write'] as const)('asks once without DNS in %s mode', async (mode) => {
    const { ctx, calls } = await setup(mode)
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    const requests: ApprovalRequest[] = []
    ctx.on('approval/request', (request) => {
      requests.push(request)
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })

    await expect(executeFetch(ctx)).resolves.toMatchObject({ isError: false, value: 'fetched' })

    expect(resolve).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      toolName: 'web_fetch',
      callId: 'fetch-call',
      reason: `Allow web_fetch to access https://example.com/path?q=1 in ${mode} mode? This permission applies only to this tool call.`,
    })
    expect(calls.count).toBe(1)
  })

  it('does not dispatch when the user rejects the one-shot request', async () => {
    const { ctx, calls } = await setup()
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('rejected'))

    await expect(executeFetch(ctx)).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: the user rejected tool "web_fetch"' }],
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(calls.count).toBe(0)
  })

  it('delegates danger-full-access without DNS preflight or approval', async () => {
    const { ctx, calls } = await setup('danger-full-access')
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    const approval = vi.fn(() => Promise.resolve<ApprovalOutcome>('rejected'))
    ctx.on('approval/request', approval)

    await expect(executeFetch(ctx)).resolves.toMatchObject({ isError: false, value: 'fetched' })
    expect(resolve).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect(calls.count).toBe(1)
  })

  it('fails closed under approval never without DNS or a prompt', async () => {
    const { ctx, calls } = await setup('workspace-write', 'never')
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    const approval = vi.fn(() => Promise.resolve<ApprovalOutcome>('allowed-once'))
    ctx.on('approval/request', approval)

    await expect(executeFetch(ctx)).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: web_fetch is not pre-approved in workspace-write mode and approval prompts are disabled' }],
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect(calls.count).toBe(0)
  })

  it('rejects a non-public literal without DNS or approval', async () => {
    const { ctx, calls } = await setup()
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    const approval = vi.fn(() => Promise.resolve<ApprovalOutcome>('allowed-once'))
    ctx.on('approval/request', approval)

    const result = await executeFetch(ctx, fakeAgent(), { url: 'http://127.0.0.1/private' })
    expect(result).toMatchObject({
      isError: true,
      error: { info: { code: 'WEB_BLOCKED_URL' } },
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect(calls.count).toBe(0)
  })

  it('preserves a downstream denial without DNS or approval', async () => {
    const { ctx, calls } = await setup()
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    const approval = vi.fn(() => Promise.resolve<ApprovalOutcome>('allowed-once'))
    ctx.on('approval/request', approval)
    ctx.on('tools/pre-execute', async (_exec, _next): Promise<PreToolDecision> => ({
      kind: 'deny',
      reason: 'denied downstream',
    }))

    await expect(executeFetch(ctx)).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: denied downstream' }],
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect(calls.count).toBe(0)
  })

  it('delegates malformed arguments to the tool schema without DNS or approval', async () => {
    const { ctx, calls } = await setup()
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    const approval = vi.fn(() => Promise.resolve<ApprovalOutcome>('allowed-once'))
    ctx.on('approval/request', approval)

    await expect(executeFetch(ctx, fakeAgent(), { url: 7 })).resolves.toMatchObject({ isError: true })
    await expect(executeFetch(ctx, fakeAgent(), null)).resolves.toMatchObject({ isError: true })
    await expect(executeFetch(ctx, fakeAgent(), {})).resolves.toMatchObject({ isError: true })
    expect(resolve).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect(calls.count).toBe(0)
  })

  it('denies an agentless restricted call without DNS', async () => {
    const { ctx, calls } = await setup()
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')

    await expect(executeFetch(ctx, null)).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Error: web_fetch requires an agent-scoped permission decision' }],
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(calls.count).toBe(0)
  })

  it('rejects a URL over the shared limit before approval', async () => {
    const { ctx, calls } = await setup()
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')
    const approval = vi.fn(() => Promise.resolve<ApprovalOutcome>('allowed-once'))
    ctx.on('approval/request', approval)
    const prefix = 'https://example.com/'
    const exact = `${prefix}${'a'.repeat(WEB_FETCH_MAX_URL_LENGTH - prefix.length)}`
    const over = `${exact}a`

    await expect(executeFetch(ctx, fakeAgent(), { url: exact })).resolves.toMatchObject({ isError: false })
    await expect(executeFetch(ctx, fakeAgent(), { url: over })).resolves.toMatchObject({
      isError: true,
      error: { info: { code: 'WEB_INVALID_URL' } },
    })
    expect(approval).toHaveBeenCalledTimes(1)
    expect(resolve).not.toHaveBeenCalled()
    expect(calls.count).toBe(1)
  })

  it('delegates an agentless danger-full-access call', async () => {
    const { ctx, calls } = await setup('danger-full-access')
    await expect(executeFetch(ctx, null)).resolves.toMatchObject({ isError: false, value: 'fetched' })
    expect(calls.count).toBe(1)
  })

  it('does not ask for an unknown web_fetch tool', async () => {
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRuntime)
    await bare.plugin(SandboxPolicyService, { mode: 'workspace-write' })
    await bare.plugin(ApprovalService, { policy: 'ask' })
    await bare.plugin(approvalPolicy)
    const approval = vi.fn(() => Promise.resolve<ApprovalOutcome>('allowed-once'))
    bare.on('approval/request', approval)
    await expect(executeFetch(bare)).resolves.toMatchObject({
      isError: true,
      error: { info: { code: 'UNKNOWN_TOOL' } },
    })
    expect(approval).not.toHaveBeenCalled()
  })

  it('ignores unrelated tools', async () => {
    const { ctx } = await setup()
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve')

    await expect(ctx.tools.execute({
      callId: CallId('echo-call'), name: 'echo', arguments: {}, agent: fakeAgent(), signal,
    })).resolves.toMatchObject({ isError: false, value: 'echoed' })
    expect(resolve).not.toHaveBeenCalled()
  })
})
