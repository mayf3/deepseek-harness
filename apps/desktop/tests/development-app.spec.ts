/** Cold-start launcher preserves workspace paths without evaluating shell syntax. */
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { developmentLauncher } from '../scripts/development-app.ts'

it.each(['abc', '1.5', '0', '65536'])('rejects Web port %s before starting a build', async (port) => {
  const launch = promisify(execFile)(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../scripts/dev.ts', import.meta.url))],
    { env: { ...process.env, DSH_DESKTOP_WEB_PORT: port, npm_execpath: '' } },
  )
  await expect(launch).rejects.toMatchObject({
    code: 1,
    signal: null,
    killed: false,
  })
  await expect(launch).rejects.toThrow('DSH_DESKTOP_WEB_PORT must be an integer from 1 through 65535')
})

it.skipIf(process.platform === 'win32')('passes literal workspace paths and cold-start settings to Electron', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-development-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const bundle = join(root, "Harness ' $(false).app")
  const binary = join(bundle, 'Contents', 'MacOS', 'Electron')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$DSH_HOME" "$DSH_DESKTOP_DEV_APP" "$DSH_DESKTOP_OPEN_DEVTOOLS" "$DSH_DESKTOP_WEB_PORT" "$@"\n', { mode: 0o755 })
  const launcher = join(root, 'launcher')
  const home = join(root, "home ' $(false)")
  writeFileSync(launcher, developmentLauncher({ electron: binary, appRoot: root, directory: root,
    home, userData: join(root, 'browser data'), mainPort: 9229, rendererPort: 9222, hostPort: 9230, webPort: 19401, openDevtools: '0' }, bundle))
  const result = execFileSync('/bin/sh', [launcher, '--test-launch-argument'], { encoding: 'utf8' })
  expect(result.trimEnd().split('\n')).toEqual([home, '1', '0', '19401', '--inspect=127.0.0.1:9229',
    '--remote-debugging-port=9222', `--user-data-dir=${join(root, 'browser data')}`, root, '--test-launch-argument'])
})
