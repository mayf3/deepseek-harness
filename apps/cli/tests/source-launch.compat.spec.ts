import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearedProxyEnv } from '@deepseek-ai/dsh-http-proxy'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import type { SourceToolEvidence } from './fixtures/source-tool-driver.ts'
import { testProfileResolution } from './profiles/headless/tests/profile-resolution.ts'

/**
 * Keyless smoke for SOURCE `dsh` execution: run `apps/cli/src/bin.ts`
 * with the exact production runtime vector (`node --import tsx/esm`, the
 * vector the root `dsh` script invokes directly) and assert the
 * required-config diagnostic, profile dependency resolution, and headless tool dispatch. The Node compatibility
 * matrix runs this WHOLE file, so a Node release changing module hooks or TypeScript handling
 * breaks this gate instead of every developer's `pnpm dsh`; the built-bin
 * suite covers the published `lib/` entry, not this source chain.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'
const sourceToolTimeoutMs = 90_000

describe('dsh SOURCE launcher (node --import tsx/esm)', () => {
  testProfileResolution('src')

  it('launches the source CLI without building', async () => {
    const rootPackage = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      readonly scripts?: Record<string, string>
    }
    expect(rootPackage.scripts?.dsh).toBe('node --import tsx/esm apps/cli/src/bin.ts')
  })

  it('boots the source entry and requires a profile', async () => {
    const result = await execa(process.execPath, ['--import', 'tsx/esm', dshSourceBin], {
      cwd: repoRoot,
      input: '',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      reject: false,
    })
    if (result.timedOut) {
      throw new Error(`dsh source launch did not exit within 25s. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    }
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('--profile <name> is required')
    expect(result.stdout).toBe('')
  }, 30_000)

  it('dispatches a source-profile shell call to a result, including sandbox-unavailable hosts, without mixing tools src/lib', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-source-tool-'))
    try {
      const cwd = join(root, 'workspace')
      await mkdir(cwd)
      const patch = join(root, 'source-tool.patch.yml')
      await writeFile(patch, JSON.stringify([
        { id: 'headless-startup', disabled: true },
        { id: 'headless-runner', disabled: true },
        { id: 'llm-deepseek', disabled: true },
        { id: 'agent-default-model', config: { provider: 'cli-mock', model: 'cli-mock' } },
        { insert: [
          {
            id: 'cli-mock-llm',
            name: join(repoRoot, 'packages/test-support/loader-smoke/tests/fixtures/cli-mock-llm.ts'),
          },
          {
            id: 'source-tool-driver',
            name: fileURLToPath(new URL('./fixtures/source-tool-driver.ts', import.meta.url)),
            config: { cwd },
          },
        ] },
      ]))
      // Source resolution is the subject; this profile and observer need no Web dist or built driver.
      const result = await execa(process.execPath, [
        '--import', 'tsx/esm', dshSourceBin, '--profile', 'headless', '--patch', patch,
      ], {
        cwd: repoRoot,
        env: {
          ...clearedProxyEnv(),
          DSH_HOME: join(root, 'home'),
          DSH_AGENTS_HOME: join(root, 'agents'),
          DSH_TELEMETRY_DISABLED: '1',
          DSH_TOOLS_MODE: 'native',
          DSH_CLI_MOCK_FAILURE: '0',
        },
        input: '',
        timeout: sourceToolTimeoutMs - 15_000,
        killSignal: 'SIGKILL',
        reject: false,
      })
      const diagnostic = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      expect(result.timedOut, diagnostic).toBe(false)
      expect(result.signal, diagnostic).toBeUndefined()
      expect(result.exitCode, diagnostic).toBe(0)
      const records = result.stdout.split('\n').filter(line => line.startsWith('DSH_SOURCE_TOOL_RESULT '))
      expect(records, diagnostic).toHaveLength(1)
      const evidence = JSON.parse(records[0]!.slice('DSH_SOURCE_TOOL_RESULT '.length)) as SourceToolEvidence
      expect(evidence.execArgv).toEqual(['--import', 'tsx/esm'])
      expect(evidence.errors).toEqual([])
      for (const pkg of ['tools', 'agent-loop']) {
        expect(evidence.modules.filter(url => url.endsWith(`/packages/core/${pkg}/src/index.ts`))).toHaveLength(1)
        expect(evidence.modules.filter(url => url.includes(`/packages/core/${pkg}/lib/`))).toEqual([])
      }
      const calls = evidence.events.filter(event => event.type === 'tool/call')
      expect(calls).toHaveLength(1)
      expect(calls[0]!.data).toMatchObject({
        callId: 'cli-smoke-call', name: process.platform === 'win32' ? 'pwsh' : 'bash',
      })
      const results = evidence.events.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(1)
      const toolResult = results[0]!.data
      expect(toolResult.message.content).toHaveLength(1)
      const block = toolResult.message.content[0]
      expect(block).toMatchObject({ type: 'tool-result', toolCallId: 'cli-smoke-call' })
      if (toolResult.error !== undefined) {
        expect(toolResult.error).toMatchObject({ name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' })
        expect(block.isError).toBe(true)
      } else {
        expect(block.isError).not.toBe(true)
        expect(block.content.filter(part => part.type === 'text').map(part => part.text).join(''))
          .toContain('CLI_TOOL_ROUND_TRIP')
      }
      expect(evidence.events.filter(event => event.type === 'turn/end').map(event => event.data.reason))
        .toEqual([{ kind: 'completed' }])
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, sourceToolTimeoutMs)
})
