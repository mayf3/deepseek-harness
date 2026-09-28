/** Verify application qualification commands without invoking Apple tools. */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyMacOSNotarizedApplication, verifyMacOSSignatureAfterSign } from '../scripts/verify-macos-signature.mjs'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(),
}))

const expected = { signingIdentity: 'Example Company (TEAMID1234)', teamId: 'TEAMID1234' }
const roots: string[] = []
const xml = '<plist version="1.0"><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>'
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-microphone-'))
  roots.push(root)
  const appPath = join(root, 'DeepSeek Harness.app')
  const helper = join(appPath, 'Contents', 'Frameworks', 'DeepSeek Harness Helper.app')
  mkdirSync(helper, { recursive: true })
  mkdirSync(join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework'))
  return { appPath, helper,
    context: { electronPlatformName: 'darwin', appOutDir: root, packager: { appInfo: { productFilename: 'DeepSeek Harness' } } },
    commands: [
      ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]],
      ['/usr/bin/codesign', ['--display', '--verbose=4', appPath]],
      ['/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', appPath]],
      ['/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-']],
      ['/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', helper]],
      ['/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-']],
      ['/usr/bin/xcrun', ['stapler', 'validate', appPath]],
      ['/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]],
    ] as const,
  }
}

function mockCommands(failedCommand?: number, invalidEntitlements?: { command: number; value: unknown }) {
  let index = 0
  vi.mocked(spawnSync).mockImplementation(() => {
    const command = index++
    return {
      pid: 1, output: [],
      stdout: command === 2 || command === 4 ? xml : command === 3 || command === 5
        ? JSON.stringify({ 'com.apple.security.device.audio-input': command === invalidEntitlements?.command ? invalidEntitlements.value : true }) : '',
      stderr: `Authority=Developer ID Application: ${expected.signingIdentity}\nTeamIdentifier=${expected.teamId}\n`,
      status: command === failedCommand ? 1 : 0, signal: null,
    }
  })
}

afterEach(() => {
  vi.resetAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('notarized application qualification', () => {
  it.each([undefined, 0, 1, 2, 3, 4, 5, 6, 7])('stops at failed command %s or verifies every qualification', (failedCommand) => {
    const { appPath, commands } = fixture()
    mockCommands(failedCommand)
    if (failedCommand === undefined) {
      expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).not.toThrow()
    } else {
      expect(() => { verifyMacOSNotarizedApplication(appPath, expected) }).toThrow('exited with 1')
    }
    const calledCommands = commands.slice(0, failedCommand === undefined ? commands.length : failedCommand + 1)
    expect(spawnSync).toHaveBeenCalledTimes(calledCommands.length)
    for (const [index, [command, args]] of calledCommands.entries()) {
      expect(spawnSync).toHaveBeenNthCalledWith(index + 1, command, args,
        { encoding: 'utf8', ...(command === '/usr/bin/plutil' ? { input: xml } : {}) })
    }
  })

  it.each([undefined, false, 'true', 1])('rejects missing or non-boolean microphone grants: %s', (value) => {
    const { context, appPath, helper } = fixture()
    for (const [command, path] of [[3, appPath], [5, helper]] as const) {
      vi.mocked(spawnSync).mockClear()
      mockCommands(undefined, { command, value })
      expect(() => { verifyMacOSSignatureAfterSign(context, expected) })
        .toThrow(`${path} requires com.apple.security.device.audio-input=true`)
      expect(spawnSync).toHaveBeenCalledTimes(command + 1)
    }
  })
})
