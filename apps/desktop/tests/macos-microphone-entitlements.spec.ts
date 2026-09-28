/** Inspect actual signed entitlements without launching an app or changing microphone authorization. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyMacOSMicrophoneEntitlements } from '../scripts/verify-macos-signature.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function sign(appPath: string, entitlements: string): void {
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, appPath], { stdio: 'pipe' })
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-signed-microphone-'))
  roots.push(root)
  const appPath = join(root, 'Microphone.app')
  const helper = join(appPath, 'Contents', 'Frameworks', 'Microphone Helper.app')
  const entitlements = fileURLToPath(new URL('../scripts/macos-entitlements.plist', import.meta.url))
  for (const [index, path] of [helper, appPath].entries()) {
    mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true })
    copyFileSync('/usr/bin/true', join(path, 'Contents', 'MacOS', 'probe'))
    writeFileSync(join(path, 'Contents', 'Info.plist'), `<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundleIdentifier</key><string>com.example.microphone-${index}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>\n`)
    sign(path, entitlements)
  }
  return { root, appPath, helper }
}

// The signature format and inspection tools belong to macOS.
describe.skipIf(process.platform !== 'darwin')('signed microphone entitlements', () => {
  it('accepts the main and helper applications signed with the release entitlements', () => {
    const { appPath } = fixture()
    expect(() => { verifyMacOSMicrophoneEntitlements(appPath) }).not.toThrow()
  })

  it.each(['app', 'helper'] as const)('rejects a signed %s without microphone access', (target) => {
    const { root, appPath, helper } = fixture()
    const path = target === 'app' ? appPath : helper
    const entitlements = join(root, 'missing-audio.plist')
    writeFileSync(entitlements, '<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n')
    sign(path, entitlements)
    expect(() => { verifyMacOSMicrophoneEntitlements(appPath) })
      .toThrow(`${path} requires com.apple.security.device.audio-input=true`)
  })
})
