/** Installed resource defaults through the same Loader configuration waterfall as profiles. */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Skills from '@deepseek-ai/dsh-skill'
import * as Office from '@deepseek-ai/dsh-skill-office'
import { expect, it } from 'vitest'
import { prepareCliOffice } from '../src/cli.ts'

it('fills physical resource defaults after interpolation and retains explicit Office settings on reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli-office-'))
  const ctx = new Context()
  try {
    const assetRoot = join(root, 'physical skills')
    await cp(fileURLToPath(new URL('../../../packages/skill/skill-office/assets/', import.meta.url)), assetRoot, { recursive: true })
    const cli = join(root, 'office-cli.js')
    await writeFile(cli, '// Physical command target.\n')
    const configPath = join(root, 'cordis.yml')
    const config = '- name: cordis:skills\n- name: cordis:office\n  config:\n    cli: !!js "undefined"\n'
    await writeFile(configPath, config)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.skills = Skills
    ctx.loader.builtins.office = Office
    prepareCliOffice(ctx, { node: process.execPath, cli, assetRoot })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const loaded = await ctx.skills.get('office-docx')
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: join(assetRoot, 'office-docx') })
    expect(loaded?.content).toContain(JSON.stringify(cli))
    expect(await readFile(configPath, 'utf8')).toBe(config)
    const fiber = [...ctx.registry.get(Office)!.fibers][0]
    expect(fiber).toBeDefined()
    fiber!.update({ cli: false }, true)
    await fiber!.await()
    expect((await ctx.skills.get('office-docx'))?.content).toContain('disabled in this deployment')
    fiber!.update({ cli }, true)
    await fiber!.await()
    expect((await ctx.skills.get('office-docx'))?.content).toContain(JSON.stringify(cli))
    await fiber!.dispose()
    expect(await ctx.skills.list()).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
