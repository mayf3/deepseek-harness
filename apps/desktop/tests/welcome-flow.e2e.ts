/** Built Desktop Host acceptance; run after the repository build, without provider credentials. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { connectDesktopWelcome, type DesktopWelcomeBackend } from '../src/welcome-backend.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const builtHost = join(repository, 'apps/desktop-host/lib/index.js')
afterEach(() => { vi.unstubAllEnvs() })

function version(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

describe.skipIf(!existsSync(builtHost))('built Desktop welcome flow', () => {
  it('keeps an unconfigured launch unconfigured and persists an explicitly saved key across restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-welcome-'))
    let host: DesktopHostProcess | undefined
    try {
      for (const name of Object.keys(process.env)) {
        if (/KEY|TOKEN|SECRET|PASSWORD/u.test(name)) vi.stubEnv(name, undefined)
      }
      const home = join(root, 'home')
      mkdirSync(home)
      vi.stubEnv('DSH_HOME', home)
      vi.stubEnv('DSH_TELEMETRY_MODE', 'DISABLED')
      const project = prepareDevelopmentProject({
        projectDir: join(root, 'project'),
        cliDir: join(repository, 'apps/cli'),
        hostDir: join(repository, 'apps/desktop-host'),
        dependencyDir: join(repository, 'node_modules/.pnpm/node_modules'),
        release: {
          schemaVersion: 1,
          version: version(join(repository, 'apps/desktop/package.json')),
          pnpmVersion: version(join(repository, 'apps/desktop/node_modules/pnpm/package.json')),
          nodeVersion: process.versions.node,
          hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        },
      })
      const paths = resolveDesktopPaths(home)
      const manager = new DesktopProjectManager(paths, {
        node: process.execPath, pnpm: join(repository, 'apps/desktop/node_modules/pnpm/bin/pnpm.mjs'), dsh: project,
      })
      await manager.applyRelease()
      writeFileSync(join(paths.profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
      let backend: DesktopWelcomeBackend
      const restart = async (): Promise<void> => {
        await host?.stop()
        host = new DesktopHostProcess(process.execPath, project, paths.profile)
        const { url } = await host.start()
        let cookie = ''
        const send: typeof fetch = async (input, init) => {
          const headers = new Headers(init?.headers)
          if (cookie !== '') headers.set('cookie', cookie)
          const response = await fetch(input, { ...init, headers, redirect: 'manual' })
          if (response.status !== 303) return response
          cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
          await response.body?.cancel()
          return fetch(new URL(response.headers.get('location')!, url), { headers: { cookie } })
        }
        backend = await connectDesktopWelcome(url, send)
      }
      const status = async () => backend.read()
      const fingerprint = (): string => createHash('sha256')
        .update(readFileSync(join(home, '.credentials.yaml'))).digest('hex')
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: false, localePreference: null })
      const before = fingerprint()
      await host!.stop()
      writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: zh\n')
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: false, localePreference: 'zh' })
      expect(fingerprint()).toBe(before)
      expect(await backend!.save('sk-local-onboarding-test')).toEqual({ ok: true })
      expect(await status()).toMatchObject({ hasApiKey: true, localePreference: 'zh' })
      await restart()
      expect(await status()).toMatchObject({ hasApiKey: true })
    } finally {
      await host?.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
