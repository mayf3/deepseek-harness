import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
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
const codexEntry = join(packageRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
const codexPackage = JSON.parse(readFileSync(
  join(packageRoot, 'node_modules', '@openai', 'codex', 'package.json'),
  'utf8',
)) as { version: string }

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
  readonly parent: Agent
  readonly env: Record<string, string>
  readonly workspace: string
}

async function realHarness(
  script: readonly ResponsesBehavior[],
  permissionMode?: CodexPermissionMode,
): Promise<{
  readonly harness: RealHarness
  readonly fixture: ResponsesFixture
}> {
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
    PATH: `${codexBinDir}${delimiter}${process.env.PATH ?? ''}`,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
    const handle = spawn(spec)
    handles.push(handle)
    return handle
  })
  await ctx.plugin(codex, {
    env,
    ...permissionMode === undefined ? {} : { permissionMode },
    disposeGraceMs: 2_000,
  })
  const parent = {
    id: 'real-parent',
    session: { header: { cwd: workspace } },
  } as unknown as Agent
  return { harness: { ctx, handles, parent, env, workspace }, fixture }
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

function expectedProcessExitDiagnostic(outcome: SubprocessOutcome): string {
  const fields = [
    'product: Codex',
    'stage: process',
    'category: process-exit',
  ]
  if (outcome.exitCode !== null) fields.push(`exit code: ${outcome.exitCode}`)
  if (outcome.signal !== null) fields.push(`signal: ${outcome.signal}`)
  return `Product subagent failure (${fields.join('; ')})`
}

interface JsonSchemaNode {
  readonly enum?: string[]
  readonly format?: string
  readonly minimum?: number
  readonly properties?: Record<string, JsonSchemaNode>
  readonly required?: string[]
  readonly type?: string | string[]
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
    const schemaRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-schema-'))
    roots.push(schemaRoot)
    await execFileAsync(process.execPath, [
      codexEntry,
      'app-server',
      'generate-json-schema',
      '--out',
      schemaRoot,
    ], { env: { ...process.env, ...harness.env } })
    const schema = JSON.parse(readFileSync(
      join(schemaRoot, 'ServerNotification.json'),
      'utf8',
    )) as {
      definitions: {
        CodexErrorInfo: {
          oneOf: JsonSchemaNode[]
        }
      }
    }
    expect(schema.definitions.CodexErrorInfo.oneOf[0]?.enum).toEqual([
      'contextWindowExceeded',
      'sessionBudgetExceeded',
      'usageLimitExceeded',
      'serverOverloaded',
      'cyberPolicy',
      'internalServerError',
      'unauthorized',
      'badRequest',
      'threadRollbackFailed',
      'sandboxError',
      'other',
    ])
    expect(schema.definitions.CodexErrorInfo.oneOf.slice(1).map(variant =>
      Object.keys(variant.properties ?? {})[0])).toEqual([
      'httpConnectionFailed',
      'responseStreamConnectionFailed',
      'responseStreamDisconnected',
      'responseTooManyFailedAttempts',
      'activeTurnNotSteerable',
    ])
    for (const variant of schema.definitions.CodexErrorInfo.oneOf.slice(1, 5)) {
      const category = Object.keys(variant.properties ?? {})[0]!
      const detail = variant.properties?.[category]
      expect(detail?.required).toBeUndefined()
      expect(detail?.properties?.httpStatusCode).toEqual({
        format: 'uint16',
        minimum: 0,
        type: ['integer', 'null'],
      })
    }

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

    expect(fixture.requests).toHaveLength(1)
    const recorded = fixture.requests[0]!
    expect(recorded.method).toBe('POST')
    expect(recorded.path).toBe('/v1/responses')
    expect(recorded.headers.authorization).toBe('Bearer dsh-fake-openai-key')
    expect(responseInputTexts(recorded.body)).toContain(task)
    await expectQuiescent(harness.handles)
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
    const diagnosticLines = result.diagnostic?.split('\n') ?? []
    expect(diagnosticLines[0]).toBe(
      'Product subagent failure (product: Codex; stage: turn; category: other)',
    )
    expect([
      'Codex unattended decision (mode: never; request: command approval; decision: cancelled): the provider does not grant interactive approval',
      'Codex unattended decision (mode: never; request: sandbox execution; decision: failed): Codex reported a sandbox failure',
      'Codex unattended decision (mode: never; request: command execution; decision: denied): Codex rejected an escalation because the selected policy never asks for approval',
    ]).toContain(diagnosticLines[1])
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

  it('reports a real service failure and an early app-server exit safely', async () => {
    {
      const { harness } = await realHarness([{
        kind: 'error',
        status: 503,
        message: 'SECRET_TOKEN in /private/secret.txt',
      }])
      const run = await harness.ctx.subagents.start('codex', {
        prompt: [{ type: 'text', text: 'Exercise the service failure path.' }],
        parent: harness.parent,
        signal: new AbortController().signal,
      })
      const result = await run.result
      expect(result).toMatchObject({ output: [], stopReason: 'error' })
      expect(result.diagnostic).toBe(
        'Product subagent failure (product: Codex; stage: turn; category: internalServerError)',
      )
      expect(result.diagnostic).not.toContain('SECRET_TOKEN')
      expect(result.diagnostic).not.toContain('/private/secret.txt')
      await run.dispose()
      await expectQuiescent(harness.handles)
    }
    {
      const { harness, fixture } = await realHarness([{ kind: 'hold' }])
      const run = await harness.ctx.subagents.start('codex', {
        prompt: [{ type: 'text', text: 'Exercise the process failure path.' }],
        parent: harness.parent,
        signal: new AbortController().signal,
      })
      await fixture.requestStarted
      expect(harness.handles).toHaveLength(1)
      harness.handles[0]!.terminate()
      const outcome = await harness.handles[0]!.done
      await expect(run.result).resolves.toEqual({
        output: [],
        diagnostic: expectedProcessExitDiagnostic(outcome),
        stopReason: 'error',
      })
      await run.dispose()
      await expectQuiescent(harness.handles)
    }
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
