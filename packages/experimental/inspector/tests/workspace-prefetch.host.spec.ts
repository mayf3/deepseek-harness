/** DevTools prefetch belongs to contributor setup, not published package installation. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

interface Manifest {
  scripts?: Record<string, string>
  files?: string[]
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as Manifest
}

it('prefetches DevTools from the root workspace after installing its existing Git hooks', () => {
  const root = manifest('../../../../package.json')
  expect(root.scripts?.postinstall).toBe('node scripts/install-lefthook.mjs && pnpm run prefetch:devtools')
  expect(root.scripts?.['prefetch:devtools']).toBe('tsx packages/experimental/inspector/scripts/download-devtools.ts')
})

it.each(['../../../../apps/cli/package.json', '../../inspector-profile/package.json', '../package.json'])(
  'keeps download lifecycle hooks out of the published package %s', (path) => {
    const { scripts = {} } = manifest(path)
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) expect(scripts[hook]).toBeUndefined()
  },
)

it('publishes the built frontend without its download tooling or cache', () => {
  const { files } = manifest('../package.json')
  expect(files).toContain('lib/devtools/**')
  expect(files?.some(path => /^(?:scripts|\.cache)(?:\/|$)/u.test(path))).toBe(false)
})
