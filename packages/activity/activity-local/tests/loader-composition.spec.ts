import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LocalActivityRegistry from '@deepseek-ai/dsh-activity-local'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('process-local through a real Loader composition', () => {
  it('applies the provider-owned retention config from a Cordis row', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-activity-local-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-activity-local'",
      '  config:',
      '    retainBytes: 8',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-activity-local') return LocalActivityRegistry
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.activities).toBeInstanceOf(LocalActivityRegistry)
    const handle = context.activities.open({ kind: 'bash', label: 'loader retention probe' })
    handle.append('aaaa')
    handle.append('bbbb')
    handle.append('cccc')
    const read = context.activities.read(handle.id, 0)
    // retainBytes: 8 from the Cordis row dropped the oldest chunk.
    expect(read.lossy).toBe(true)
    expect(read.chunks.map(chunk => chunk.text)).toEqual(['bbbb', 'cccc'])
    expect(read.next).toBe(12)
  })
})
