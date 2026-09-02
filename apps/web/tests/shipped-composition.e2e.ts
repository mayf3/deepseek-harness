// Boots the shipped Web composition over the built dist this lane already uses
// and asserts its catalog, defaults, Loader lifecycle, and one complete Auto
// producer-to-tool path. Browser scenarios in this lane own visual behavior.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
// Empty type imports carry the tools/sandboxPolicy/approval Context merges.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'

const FILE_REFERENCE_PROMPT = fileURLToPath(new URL(
  './expected/web-runtime-context/file-reference-prompt.expected.md', import.meta.url,
))
const BASE_PATCH_PATH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const HEADLESS_PATCH_PATH = join(REPO_ROOT, 'packages/bundle/headless/cordis.patch.yml')
const AUTO_PROVIDER = 'shipped-auto-review-test'
const AUTO_MODEL = 'same-route'
const AUTO_CALL_ID = ToolCallId('shipped-auto-review-denied-write')
const AUTO_RAW_REASON = '  direct user authorized inspection only\nwrite scope was not authorized  '
const AUTO_FINAL_TEXT = 'SHIPPED_AUTO_REVIEW_DENIAL_OBSERVED'

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** POST one generated Remote unary through the authenticated Web carrier. */
async function remote<T>(
  target: WebScaffold,
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
): Promise<T> {
  const response = await target.hostFetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `shipped-auto-${endpoint}-${randomUUID()}`,
      method: endpoint,
      payload: { args },
    }),
  })
  if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${response.status}: ${await response.text()}`)
  const result = (await response.json() as { result: RpcResult<T> }).result
  if (!result.ok) throw new Error(`${endpoint} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** One text completion in the provider-neutral stream vocabulary. */
function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted same-route main model and reviewer for the shipped Auto pipeline. */
class ShippedAutoAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly targetPath: string) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000 })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const source = options.messages[0]?.source
    if (source?.kind === 'plugin' && source.plugin === 'dsh-auto-review') {
      yield* textChunks(JSON.stringify({ decision: 'deny', reason: AUTO_RAW_REASON }))
      return
    }
    if (options.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
      yield* textChunks(AUTO_FINAL_TEXT)
      return
    }
    const args = JSON.stringify({ file_path: this.targetPath, content: 'MUST_NOT_BE_WRITTEN\n' })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: AUTO_CALL_ID,
      name: 'write',
      argumentsDelta: args,
    }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: AUTO_CALL_ID, name: 'write', arguments: args },
    }
    yield { type: 'usage', usage: { inputTokens: 32, outputTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/**
 * The catalog the shipped Web composition puts in front of the model, minus the
 * ripgrep-dependent pair below. The absences are deliberate, not incidental
 * gaps: the `cordis_*` toolset executes model-written JavaScript that no
 * sandbox row confines, and `mcp_*` servers spawn outside `ctx.shell`.
 * `web_fetch` is present because public-address enforcement and one-shot
 * approval now confine its model-selected request target. The composition
 * Agent Note owns the rationale and its sources.
 */
const EXPECTED_TOOLS = [
  'ask_user_question',
  'bash',
  'create_goal',
  'edit',
  'exit_plan_mode',
  'get_goal',
  'interrupt_agent',
  'job_kill',
  'job_list',
  'job_output',
  'list_agents',
  'ralph',
  'read',
  'read_image',
  'send_message',
  'skill',
  'subagent',
  'subagent_fork',
  'todo_write',
  'update_goal',
  'web_fetch',
  'web_search',
  'workflow',
  'write',
]

/**
 * `glob` and `grep` come from `dsh-tool-fs-search`, which spawns the PACKAGED
 * ripgrep binary (`@vscode/ripgrep`) through the subprocess seam, so the pair
 * is always present on every host — asserted as fixed members, not a host
 * dependency.
 */
const RIPGREP_TOOLS = ['glob', 'grep']

let scaffold: WebScaffold | undefined

afterEach(async () => {
  await scaffold?.close()
  scaffold = undefined
})

it('assembles the shipped Web transport, catalog, guidance, and defaults', async () => {
  scaffold = await launchWebScaffold({ deepSeekMissingCredential: true })
  const ctx = scaffold.ctx
  const index = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}`, {
    headers: { 'accept-encoding': 'gzip' },
  })
  expect(index.headers.get('content-encoding')).toBe('gzip')
  expect(index.headers.get('vary')).toContain('Accept-Encoding')
  await index.body?.cancel()
  expect(ctx.llm.providerRetryPolicy('deepseek-official')).toMatchInlineSnapshot(`
    {
      "initialDelayMs": 500,
      "jitterRatio": 0.1,
      "maxDelayMs": 10000,
      "maxRetries": 5,
      "mode": "normal",
      "retryableCodes": [
        "EMPTY_RESPONSE",
        "RATE_LIMIT",
        "SERVER",
        "TIMEOUT",
        "TRANSPORT",
      ],
    }
  `)
  await ctx.settings.update('llm-deepseek', {
    retryPolicy: { mode: 'always', maxRetries: 5 },
  })
  expect(ctx.llm.providerRetryPolicy('deepseek-official')).toMatchInlineSnapshot(`
    {
      "initialDelayMs": 500,
      "jitterRatio": 0.1,
      "maxDelayMs": 10000,
      "mode": "always",
    }
  `)
  await ctx.settings.update('llm-pi-ai', {
    providers: {
      openai: {},
      anthropic: { retryPolicy: { mode: 'always' } },
    },
  })
  expect(ctx.llm.providerRetryPolicy('openai')).toMatchInlineSnapshot(`
    {
      "initialDelayMs": 500,
      "jitterRatio": 0.1,
      "maxDelayMs": 10000,
      "maxRetries": 5,
      "mode": "normal",
      "retryableCodes": [
        "EMPTY_RESPONSE",
        "RATE_LIMIT",
        "SERVER",
        "TIMEOUT",
        "TRANSPORT",
      ],
    }
  `)
  expect(ctx.llm.providerRetryPolicy('anthropic')).toMatchInlineSnapshot(`
    {
      "initialDelayMs": 500,
      "jitterRatio": 0.1,
      "maxDelayMs": 10000,
      "mode": "always",
    }
  `)
  // The catalog belongs to an AGENT, not to the process: every model-facing row
  // now lives in a preset mounted under one session's scope, so the global
  // layer holds nothing and a caller must name the agent to see anything. This
  // composes from the deployment default — what a session that names no preset
  // gets — which is the shape this test has always been about.
  expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([])
  const handle = await ctx.agents.create({
    sessionId: SessionId('shipped-composition'),
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    const names = ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()
    expect(names.filter(name => !RIPGREP_TOOLS.includes(name))).toEqual(EXPECTED_TOOLS)
    // The packaged ripgrep binary ships with the dependency, so the pair is a
    // fixed roster member on every host.
    expect(names.filter(name => RIPGREP_TOOLS.includes(name))).toEqual(RIPGREP_TOOLS)
    const fileReferenceSection = (await ctx.systemPrompt.assemble({ scope: handle.agent })).sections
      .find(section => section.name === 'ui:deliverable-file-references')
    expect(fileReferenceSection?.text).toBe(readFileSync(FILE_REFERENCE_PROMPT, 'utf8').trimEnd())
  } finally {
    await handle.dispose()
  }
  // `workspace-write` is not "the workspace and nothing else": the shared roots
  // helper always admits the temp directories too. Pinning it against an
  // explicit mode keeps the claim independent of this surface's default, and
  // keeps a future sandbox-confinement test from being run inside /tmp — where an
  // "escape" write succeeds by design and reads as a sandbox failure.
  expect(writableRoots(scaffold.ctx.sandboxPolicy.resolve({ mode: 'workspace-write' }))).toEqual(
    expect.arrayContaining([canonicalPath('/tmp'), canonicalPath(tmpdir())]),
  )
  expect(scaffold.ctx.sandboxPolicy.defaultMode).toBe('workspace-write')
  expect(scaffold.ctx.approval.config.policy).toBe('ask')
  expect(scaffold.ctx.permissionPresets.defaultPreset).toBe('workspace-write')
  expect(scaffold.ctx.permissionPresets.names).toEqual([
    'read-only',
    'workspace-write',
    'danger-full-access',
    'auto',
  ])
  const headlessRows = composeEntries([
    loadOverlayPatches('shipped headless composition', BASE_PATCH_PATH),
    loadOverlayPatches('shipped headless composition', HEADLESS_PATCH_PATH),
  ])
  expect(headlessRows.some(row => row.id === 'auto-review')).toBe(false)

  const commandHandle = await scaffold.ctx.agents.create({
    sessionId: SessionId('shipped-command-catalog'),
    meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  try {
    expect(scaffold.ctx.commands.list(commandHandle.agent)).toContainEqual({
      name: 'feedback',
      description: 'record feedback about this session',
      input: { hint: '<text>' },
    })
  } finally {
    await commandHandle.dispose()
  }
}, 120_000)

it('lets a preset producer reach the background-job registry', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  const handle = await ctx.agents.create({
    sessionId: SessionId('shipped-background-job'),
    meta: { cwd: scaffold.workspaceCwd },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    const signal = new AbortController().signal
    // `tool-bash` is a preset row and `tasks` is a host registry; the producer
    // resolves it with `ctx.get`, so a registry hidden behind a preset realm
    // fails here — with every task control still listed in the catalog above.
    const started = await ctx.tools.execute({
      signal,
      callId: ToolCallId('shipped-bash-background'),
      name: 'bash',
      arguments: {
        command: 'printf SHIPPED_BACKGROUND_OK',
        description: 'shipped background probe',
        run_in_background: true,
      },
      agent: handle.agent,
    })
    expect({ isError: started.isError, content: started.content }).toEqual({
      isError: false,
      content: [{ type: 'text', text: 'started background job bash-1' }],
    })

    // The controller reads what the producer started: same registry, one
    // owner. A per-preset registry would list nothing here even on success.
    const listed = await ctx.tools.execute({
      signal,
      callId: ToolCallId('shipped-task-list'),
      name: 'job_list',
      arguments: {},
      agent: handle.agent,
    })
    expect(listed.isError).toBe(false)
    expect(listed.content).toEqual([
      { type: 'text', text: expect.stringContaining('bash-1 [bash]') as unknown as string },
    ])

    // The full round trip: the output a host-plane producer wrote is collected
    // through a preset-plane control, which is the linkage the realm severed.
    const collected = await ctx.tools.execute({
      signal,
      callId: ToolCallId('shipped-task-output'),
      name: 'job_output',
      arguments: { job_id: 'bash-1', wait: true },
      agent: handle.agent,
    })
    expect(collected.isError).toBe(false)
    expect(collected.content).toEqual([
      { type: 'text', text: expect.stringContaining('SHIPPED_BACKGROUND_OK') as unknown as string },
    ])
  } finally {
    await handle.dispose()
  }
}, 120_000)

it('routes one browser-authored Auto request through the same model before a real tool body', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  const targetPath = join(scaffold.workspaceCwd, 'auto-review-must-not-write.txt')
  const adapter = new ShippedAutoAdapter(targetPath)
  ctx.effect(
    () => ctx.llm.registerAdapter([AUTO_PROVIDER], adapter),
    'shipped Auto review same-route adapter',
  )

  const created = await remote<{ sessionId: string }>(scaffold, 'session/create', {
    request: { cwd: scaffold.workspaceCwd },
  })
  const sessionId = SessionId(created.sessionId)
  await remote(scaffold, 'session/selectModel', {
    request: { sessionId, provider: AUTO_PROVIDER, model: AUTO_MODEL },
  })
  const switched = await remote<{ result: { kind: string; text?: string } }>(
    scaffold,
    'commands/execute',
    { agentId: sessionId, line: '/permission auto', images: [] },
  )
  expect(switched.result).toEqual({ kind: 'success', text: 'preset auto' })

  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('shipped Auto session was not published')
  expect(ctx.permissionPresets.current(agent.session)).toBe('auto')

  const requestId = `shipped-auto-direct-user-${randomUUID()}`
  const settled = scaffold.whenTurnSettled()
  await remote<{ accepted: true }>(scaffold, 'session/prompt', {
    request: {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Inspect this workspace only. Do not modify any file.' }],
    },
  })
  expect(await settled).toBe(sessionId)
  await agent.whenIdle()

  expect(adapter.requests).toHaveLength(3)
  expect(adapter.requests.map(({ provider, model }) => ({ provider, model }))).toEqual([
    { provider: AUTO_PROVIDER, model: AUTO_MODEL },
    { provider: AUTO_PROVIDER, model: AUTO_MODEL },
    { provider: AUTO_PROVIDER, model: AUTO_MODEL },
  ])
  const [firstMain, reviewer, finalMain] = adapter.requests
  expect(firstMain?.tools?.some(schema => schema.name === 'write')).toBe(true)
  expect(reviewer?.system).toContain('You are the final authorization reviewer for exactly one pending tool call.')
  const reviewInput = reviewer?.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
  expect(reviewInput).toContain('PENDING_ACTION')
  expect(reviewInput).toContain(requestId)
  expect(reviewInput).toContain(targetPath)
  const finalModelInput = JSON.stringify(finalMain?.messages)
  expect(finalModelInput).toContain('Auto review rejected tool \\"write\\"; its body was not executed')
  expect(finalModelInput).not.toContain('direct user authorized inspection only')

  const prompt = agent.session.events.find((event): event is Extract<SessionEvent, { type: 'user/message' }> => (
    event.type === 'user/message'
      && event.data.source.kind === 'user'
      && 'rpcId' in event.data.source
      && event.data.source.rpcId === requestId
  ))
  expect(prompt).toBeDefined()
  const result = agent.session.events.find((event): event is Extract<SessionEvent, { type: 'tool/result' }> => (
    event.type === 'tool/result'
      && event.data.message.content.some(block => block.toolCallId === AUTO_CALL_ID)
  ))
  expect(result?.data.error).toEqual({
    name: 'AutoReviewDeniedError',
    code: 'AUTO_REVIEW_DENIED',
    reason: AUTO_RAW_REASON,
  })
  const durableModelResult = JSON.stringify(result?.data.message)
  expect(durableModelResult).toContain('Auto review rejected tool \\"write\\"; its body was not executed')
  expect(durableModelResult).not.toContain('direct user authorized inspection only')
  expect(agent.session.events.some(event => (
    event.type === 'assistant/message'
      && JSON.stringify(event.data.message).includes(AUTO_FINAL_TEXT)
  ))).toBe(true)
  await expect(readFile(targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
}, 120_000)

it('rolls back a failed shipped Auto initialization before publishing or intercepting tools', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  const autoEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'auto-review')
  if (autoEntry === undefined) throw new Error('shipped Auto review Loader entry is missing')

  await autoEntry.update({ disabled: true })
  await ctx.loader.await()
  expect(ctx.permissionPresets.names).not.toContain('auto')

  // This unsupported same-process contribution occupies the reserved preset
  // only to force the shipped integration's registration to roll back. It is
  // not an Auto reviewer or a supported host composition.
  const stopUnsupportedConflict = ctx.permissionPresets.registerAuto(() => {})
  try {
    await expect(
      autoEntry.update({ disabled: false }).then(() => ctx.loader.await()),
    ).rejects.toThrow('preset "auto" is already registered')

    const handle = await ctx.agents.create({
      sessionId: SessionId('shipped-auto-init-rollback'),
      meta: { cwd: scaffold.workspaceCwd },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      ctx.permissionPresets.set(handle.agent.session, 'auto')
      const targetPath = join(scaffold.workspaceCwd, 'auto-init-rollback.txt')
      // The successful write is a rollback sentinel: this unsupported
      // contribution performs no review, so success proves the failed shipped
      // integration left no pre-execute listener behind. It is not supported
      // Auto execution behavior.
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('shipped-auto-init-rollback-write'),
        name: 'write',
        arguments: { file_path: targetPath, content: 'INITIALIZATION_ROLLED_BACK\n' },
        agent: handle.agent,
      })
      expect(result.isError).toBe(false)
      expect(await readFile(targetPath, 'utf8')).toBe('INITIALIZATION_ROLLED_BACK\n')
    } finally {
      await handle.dispose()
    }
  } finally {
    await stopUnsupportedConflict()
    await autoEntry.update({ disabled: true })
    await ctx.loader.await()
  }

  expect(ctx.permissionPresets.names).not.toContain('auto')
  await autoEntry.update({ disabled: false })
  await ctx.loader.await()
  expect(ctx.permissionPresets.names).toContain('auto')
}, 120_000)

it('withdraws Auto on shipped Loader unload and does not restore migrated live sessions', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  const autoEntry = [...ctx.loader.entries()].find(entry => entry.options.id === 'auto-review')
  if (autoEntry === undefined) throw new Error('shipped Auto review Loader entry is missing')
  const handle = await ctx.agents.create({
    sessionId: SessionId('shipped-auto-hot-plug'),
    meta: { cwd: scaffold.workspaceCwd },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
  })
  try {
    ctx.permissionPresets.set(handle.agent.session, 'auto')
    expect(ctx.permissionPresets.current(handle.agent.session)).toBe('auto')

    await autoEntry.update({ disabled: true })
    await ctx.loader.await()
    expect(ctx.permissionPresets.names).not.toContain('auto')
    expect(ctx.permissionPresets.current(handle.agent.session)).toBe('read-only')

    await autoEntry.update({ disabled: false })
    await ctx.loader.await()
    expect(ctx.permissionPresets.names).toContain('auto')
    expect(ctx.permissionPresets.current(handle.agent.session)).toBe('read-only')
  } finally {
    await handle.dispose()
  }
}, 120_000)
