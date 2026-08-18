import { execFile } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as codex from '../src/index.ts'
import type { CodexPermissionMode } from '../src/run.ts'
import {
  startResponsesFixture,
  type ResponsesBehavior,
  type ResponsesFixture,
} from './responses-fixture.ts'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const codexBinDir = join(packageRoot, 'node_modules', '.bin')
const codexPackageJson = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackage = JSON.parse(readFileSync(
  codexPackageJson,
  'utf8',
)) as { version: string; bin: { codex: string } }
const codexEntry = resolve(dirname(codexPackageJson), codexPackage.bin.codex)
const codexPackageRoot = dirname(dirname(codexEntry))

const roots: string[] = []
const fixtures: ResponsesFixture[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

interface RealHarness {
  readonly ctx: Context
  readonly handles: SubprocessHandle[]
  readonly spawnSpecs: SubprocessSpawnSpec[]
  readonly parent: Agent
  readonly env: Record<string, string>
  readonly workspace: string
}

interface RealInstanceFixture {
  readonly fixture: ResponsesFixture
  readonly env: Record<string, string>
  readonly workspace: string
}

async function realInstanceFixture(
  script: readonly ResponsesBehavior[],
): Promise<RealInstanceFixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-codex-real-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const codexHome = join(root, 'codex-home')
  const fixture = await startResponsesFixture(script)
  fixtures.push(fixture)
  mkdirSync(workspace)
  mkdirSync(codexHome)
  writeFileSync(join(codexHome, 'config.toml'), [
    'model = "fixture-model"',
    'model_provider = "fixture"',
    'approval_policy = "on-request"',
    'sandbox_mode = "read-only"',
    'disable_response_storage = true',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.fixture]',
    'name = "Fixture Responses"',
    `base_url = "${fixture.baseUrl}"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n'))
  const env = {
    OPENAI_API_KEY: 'dsh-fake-openai-key',
    CODEX_HOME: codexHome,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    PATH: root,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }
  return { fixture, env, workspace }
}

interface RealRuntime {
  readonly ctx: Context
  readonly handles: SubprocessHandle[]
  readonly spawnSpecs: SubprocessSpawnSpec[]
}

async function realRuntime(): Promise<RealRuntime> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  const spawnSpecs: SubprocessSpawnSpec[] = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    spawnSpecs.push(spec)
    const handle = spawn(spec)
    handles.push(handle)
    return handle
  })
  return { ctx, handles, spawnSpecs }
}

async function realHarness(
  script: readonly ResponsesBehavior[],
  permissionMode?: CodexPermissionMode,
): Promise<{
  readonly harness: RealHarness
  readonly fixture: ResponsesFixture
}> {
  const instance = await realInstanceFixture(script)
  const { ctx, handles, spawnSpecs } = await realRuntime()
  await ctx.plugin(codex, {
    env: instance.env,
    ...permissionMode === undefined ? {} : { permissionMode },
    disposeGraceMs: 2_000,
  })
  const parent = {
    id: 'real-parent',
    session: { header: { cwd: instance.workspace } },
  } as unknown as Agent
  return {
    harness: {
      ctx,
      handles,
      spawnSpecs,
      parent,
      env: instance.env,
      workspace: instance.workspace,
    },
    fixture: instance.fixture,
  }
}

async function expectQuiescent(handles: readonly SubprocessHandle[]): Promise<void> {
  expect(handles.length).toBeGreaterThan(0)
  for (const handle of handles) {
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome).toHaveProperty('exitCode')
    expect(outcome).toHaveProperty('signal')
  }
}

function responseInputTexts(body: Record<string, unknown>): string[] {
  if (!Array.isArray(body.input)) return []
  return body.input.flatMap((item): string[] => {
    if (item === null || typeof item !== 'object') return []
    const content = (item as Record<string, unknown>).content
    if (!Array.isArray(content)) return []
    return content.flatMap((part): string[] => (
      part !== null
      && typeof part === 'object'
      && typeof (part as Record<string, unknown>).text === 'string'
        ? [(part as Record<string, unknown>).text as string]
        : []
    ))
  })
}

describe('real @openai/codex 0.147.0 product', () => {
  it('starts approve-for-me through the real app-server and returns exact text', async () => {
    const sentinel = 'REAL_CODEX_SENTINEL_0_147_0'
    const task = 'Return the fixture sentinel exactly.'
    const { harness, fixture } = await realHarness([
      { kind: 'complete', text: sentinel },
    ], 'approve-for-me')
    expect(codexPackage.version).toBe('0.147.0')
    const version = await execFileAsync(process.execPath, [codexEntry, '--version'], {
      env: { ...process.env, ...harness.env },
    })
    expect(version.stdout.trim()).toBe('codex-cli 0.147.0')

    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: task }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: sentinel }],
      stopReason: 'completed',
    })
    await run.dispose()

    expect(harness.spawnSpecs[0]?.argv).toEqual([
      process.execPath,
      codexEntry,
      'app-server',
      '--stdio',
    ])

    expect(fixture.requests).toHaveLength(1)
    const recorded = fixture.requests[0]!
    expect(recorded.method).toBe('POST')
    expect(recorded.path).toBe('/v1/responses')
    expect(recorded.headers.authorization).toBe('Bearer dsh-fake-openai-key')
    expect(responseInputTexts(recorded.body)).toContain(task)
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('fails a missing platform payload without falling back to a host codex', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-missing-payload-'))
    roots.push(root)
    const isolatedPackage = join(root, 'node_modules', '@openai', 'codex')
    mkdirSync(dirname(isolatedPackage), { recursive: true })
    cpSync(codexPackageRoot, isolatedPackage, { recursive: true, dereference: true })
    const isolatedEntry = join(isolatedPackage, 'bin', 'codex.js')

    await expect(execFileAsync(process.execPath, [isolatedEntry, '--version'], {
      env: {
        PATH: codexBinDir,
        ...process.platform === 'win32' && process.env.SystemRoot !== undefined
          ? { SystemRoot: process.env.SystemRoot }
          : {},
      },
    })).rejects.toThrow(/Missing optional dependency @openai\/codex-[a-z0-9-]+/)
  }, 30_000)

  it('runs two named instances concurrently and unloads one without revoking its run', async () => {
    const safeInstance = await realInstanceFixture([{ kind: 'hold' }])
    const bypassInstance = await realInstanceFixture([{
      kind: 'complete',
      text: 'NAMED_CODEX_BYPASS_RESULT',
    }])
    const { ctx, handles, spawnSpecs } = await realRuntime()
    const safeFiber = await ctx.plugin(codex, {
      providerName: 'codex-safe',
      env: safeInstance.env,
      permissionMode: 'never',
      disposeGraceMs: 2_000,
    })
    const bypassFiber = await ctx.plugin(codex, {
      providerName: 'codex-bypass',
      env: bypassInstance.env,
      permissionMode: 'dangerously-bypass-approvals-and-sandbox',
      disposeGraceMs: 2_000,
    })
    const safeParent = {
      id: 'safe-parent',
      session: { header: { cwd: safeInstance.workspace } },
    } as unknown as Agent
    const bypassParent = {
      id: 'bypass-parent',
      session: { header: { cwd: bypassInstance.workspace } },
    } as unknown as Agent
    const safeController = new AbortController()

    const [safeRun, bypassRun] = await Promise.all([
      ctx.subagents.start('codex-safe', {
        prompt: [{ type: 'text', text: 'Hold the safe instance.' }],
        parent: safeParent,
        signal: safeController.signal,
      }),
      ctx.subagents.start('codex-bypass', {
        prompt: [{ type: 'text', text: 'Complete the bypass instance.' }],
        parent: bypassParent,
        signal: new AbortController().signal,
      }),
    ])
    await safeInstance.fixture.requestStarted
    await safeFiber.dispose()
    expect(ctx.subagents.list()).toEqual(['codex-bypass'])
    await expect(ctx.subagents.start('codex-safe', {
      prompt: [{ type: 'text', text: 'This start must fail.' }],
      parent: safeParent,
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NO_PROVIDER' })

    await expect(bypassRun.result).resolves.toEqual({
      output: [{ type: 'text', text: 'NAMED_CODEX_BYPASS_RESULT' }],
      stopReason: 'completed',
    })
    safeController.abort(new Error('cancel only the published safe run'))
    await expect(safeRun.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    await Promise.all([safeRun.dispose(), bypassRun.dispose()])
    expect(safeInstance.fixture.requests).toHaveLength(1)
    expect(bypassInstance.fixture.requests).toHaveLength(1)
    expect(safeInstance.fixture.requests[0]?.body.input)
      .not.toEqual(bypassInstance.fixture.requests[0]?.body.input)
    expect(spawnSpecs.map(spec => spec.env?.CODEX_HOME).sort()).toEqual([
      safeInstance.env.CODEX_HOME,
      bypassInstance.env.CODEX_HOME,
    ].sort())
    await expectQuiescent(handles)
    await bypassFiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  }, 60_000)

  it('overrides on-request with never and reports a denied command safely', async () => {
    const command = process.platform === 'win32'
      ? 'cmd /c type nul > approval-side-effect'
      : 'touch approval-side-effect'
    const commandCalls = [
      {
        name: 'exec_command',
        arguments: {
          cmd: command,
          sandbox_permissions: 'require_escalated',
          justification: 'exercise the unattended approval boundary',
        },
      },
      {
        name: 'shell_command',
        arguments: {
          command,
          sandbox_permissions: 'require_escalated',
          justification: 'exercise the unattended approval boundary',
        },
      },
    ] as const
    const { harness, fixture } = await realHarness([
      {
        kind: 'advertisedFunctionCall',
        choices: commandCalls,
      },
      {
        kind: 'error',
        status: 400,
        message: 'fixture terminal failure after permission denial',
      },
    ])
    const sideEffect = join(harness.workspace, 'approval-side-effect')
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Attempt the fixture command.' }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    const result = await run.result
    expect(result.output).toEqual([])
    expect(result.stopReason).toBe('error')
    expect([
      'Codex unattended decision (mode: never; request: command approval; decision: cancelled): the provider does not grant interactive approval',
      'Codex unattended decision (mode: never; request: sandbox execution; decision: failed): Codex reported a sandbox failure',
      'Codex unattended decision (mode: never; request: command execution; decision: denied): Codex rejected an escalation because the selected policy never asks for approval',
    ]).toContain(result.diagnostic)
    expect(result.diagnostic).not.toContain(command)
    expect(result.diagnostic).not.toContain(harness.workspace)
    await run.dispose()

    expect(existsSync(sideEffect)).toBe(false)
    expect(fixture.requests).toHaveLength(2)
    const tools = fixture.requests[0]!.body.tools as Array<Record<string, unknown>>
    expect(commandCalls.some(call => tools.some(tool => (
      tool.type === 'function' && tool.name === call.name
    )))).toBe(true)
    expect(fixture.requests.every(requestEntry =>
      requestEntry.headers.authorization === 'Bearer dsh-fake-openai-key',
    )).toBe(true)
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('executes an explicitly selected dangerous bypass write in the isolated workspace', async () => {
    const sideEffect = 'bypass-side-effect'
    const command = process.platform === 'win32'
      ? `cmd /c echo bypass>${sideEffect}`
      : `printf bypass > ${sideEffect}`
    const commandCalls = [
      {
        name: 'exec_command',
        arguments: {
          cmd: command,
        },
      },
      {
        name: 'shell_command',
        arguments: {
          command,
        },
      },
    ] as const
    const { harness } = await realHarness([
      { kind: 'advertisedFunctionCall', choices: commandCalls },
      { kind: 'complete', text: 'bypass complete' },
    ], 'dangerously-bypass-approvals-and-sandbox')
    const target = join(harness.workspace, sideEffect)
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Create the fixture side effect.' }],
      parent: harness.parent,
      signal: new AbortController().signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'bypass complete' }],
      stopReason: 'completed',
    })
    expect(readFileSync(target, 'utf8').trim()).toBe('bypass')
    await run.dispose()
    await expectQuiescent(harness.handles)
  }, 60_000)

  it('settles cancellation locally and leaves the real app-server tree quiescent', async () => {
    const { harness, fixture } = await realHarness([{ kind: 'hold' }])
    const controller = new AbortController()
    const run = await harness.ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'Wait for cancellation.' }],
      parent: harness.parent,
      signal: controller.signal,
    })
    await fixture.requestStarted
    controller.abort(new Error('real product cancellation'))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
    await run.dispose()
    await expectQuiescent(harness.handles)
  }, 60_000)
})
