/** Plain-Node smoke for the generated Agent Teams Client Remote assembly. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(packageDir, '../../..')
const artifact = (path: string): string => join(root, path)
const artifactUrl = (path: string): string => pathToFileURL(artifact(path)).href

const requiredArtifacts = [
  'packages/experimental/agent-team-remotes/lib/client.js',
  'packages/experimental/agent-team-remotes/lib/index.js',
  'packages/experimental/team/lib/typert.remote-client.js',
].every(path => existsSync(artifact(path)))

describe.skipIf(!requiredArtifacts)('Agent Teams Remote built LIB assembly', () => {
  it('mounts exactly the generated Team contribution and keeps the Host half inert', async () => {
    const urls = {
      client: artifactUrl('packages/experimental/agent-team-remotes/lib/client.js'),
      host: artifactUrl('packages/experimental/agent-team-remotes/lib/index.js'),
    }
    const script = `
      const handoffs = new Map()
      globalThis.window = {
        __ModuleLoader__: {
          load(handoff) { handoffs.set(handoff.id, handoff) },
        },
      }
      const host = await import(${JSON.stringify(urls.host)})
      host.apply()
      await import(${JSON.stringify(urls.client)})
      const handoff = handoffs.get('@deepseek-ai/dsh-agent-team-remotes')
      if (handoff === undefined) throw new Error('missing Agent Teams Remote Client handoff')
      const plugin = handoff.factory(specifier => {
        throw new Error('unexpected Client external ' + specifier)
      })
      let mounted
      const dispose = () => {}
      const result = await plugin.apply({
        remote: {
          $mount(contribution) {
            mounted = contribution
            return Promise.resolve(dispose)
          },
        },
      })
      console.log(JSON.stringify({
        inject: plugin.inject,
        sameDisposer: result === dispose,
        methods: mounted?.descriptors.map(descriptor => descriptor.id),
      }))
    `

    const result = await runPlainNode(script)
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      inject: string[]
      sameDisposer: boolean
      methods: string[]
    }
    expect(output).toEqual({
      inject: ['remote'],
      sameDisposer: true,
      methods: [
        '@deepseek-ai/dsh-team#teams/createTask',
        '@deepseek-ai/dsh-team#teams/updateTask',
        '@deepseek-ai/dsh-team#teams/view',
      ],
    })
  })
})

function runPlainNode(script: string): Promise<{
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolveRun({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        stdout,
        stderr,
      })
    })
  })
}
