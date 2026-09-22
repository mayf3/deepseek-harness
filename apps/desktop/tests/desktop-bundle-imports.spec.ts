import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Rolldown } from 'tsdown'
import { afterAll, describe, expect, it } from 'vitest'
import {
  importPackageName,
  packagedImportsPlugin,
  unpackagedImports,
} from '../scripts/desktop-bundle-imports.mjs'

const PACKAGED = new Set(['electron', 'electron-updater', '@deepseek-ai/dsh-api-gateway'])

describe('desktop bundle imports', () => {
  it('names the package behind a bare specifier', () => {
    expect(importPackageName('electron-updater/out/electronHttpExecutor.js')).toBe('electron-updater')
    expect(importPackageName('@deepseek-ai/dsh-api-gateway/stream-protocol')).toBe('@deepseek-ai/dsh-api-gateway')
    expect(importPackageName('ws')).toBe('ws')
  })

  it('accepts Node builtins and packaged dependencies, including their subpaths', () => {
    expect(unpackagedImports([
      'node:fs/promises',
      'crypto',
      'electron',
      'electron-updater/out/electronHttpExecutor.js',
      '@deepseek-ai/dsh-api-gateway/stream-protocol',
    ], PACKAGED)).toEqual([])
  })

  it('reports each specifier the packaged application cannot resolve once, in import order', () => {
    expect(unpackagedImports([
      '@deepseek-ai/dsh-home-paths',
      'ws',
      '@deepseek-ai/dsh-home-paths',
      'electron',
    ], PACKAGED)).toEqual(['@deepseek-ai/dsh-home-paths', 'ws'])
  })
})

describe('packaged imports plugin', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-bundle-imports-'))
  const entry = join(root, 'entry.js')
  writeFileSync(entry, [
    'import { app } from "electron";',
    'import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";',
    'export const home = resolveDshHome(app);',
  ].join('\n'))
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function generate(packaged: ReadonlySet<string>): Promise<Rolldown.RolldownOutput> {
    // Every import stays external, which is what an unresolved workspace lib/ output produces.
    const bundle = await Rolldown.rolldown({
      input: entry,
      external: () => true,
      logLevel: 'silent',
      plugins: [packagedImportsPlugin(packaged)],
    })
    try {
      return await bundle.generate({ format: 'esm' })
    } finally {
      await bundle.close()
    }
  }

  it('fails the bundle that leaves an import the packaged application does not ship', async () => {
    await expect(generate(new Set(['electron']))).rejects.toThrow(
      /entry\.js imports @deepseek-ai\/dsh-home-paths, which the packaged application does not ship/u,
    )
  })

  it('passes the bundle whose external imports are all packaged', async () => {
    const output = await generate(new Set(['electron', '@deepseek-ai/dsh-home-paths']))
    expect(output.output.map(chunk => chunk.fileName)).toEqual(['entry.js'])
  })
})
