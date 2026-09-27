/** Build the installed terminal launcher and its private update-lock controller. */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Target architecture for the installed Desktop command. */
export interface DesktopCliTarget {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly macosMinimumVersion?: string
}

/**
 * Compile the small native launchers before signing Desktop resources.
 * @param destination - Physical runtime/cli directory prepared for the application.
 * @param target - Desktop platform and architecture, independent of the build host architecture.
 */
export function prepareDesktopCli(destination: string, target: DesktopCliTarget): void {
  mkdirSync(destination, { recursive: true })
  mkdirSync(join(destination, 'bin'), { recursive: true })
  if (target.platform === 'win32') {
    if (process.platform !== 'win32' || target.arch !== 'x64') throw new Error('desktop CLI: Windows preparation requires an x64 Windows target')
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(import.meta.dirname, 'prepare-windows-cli.ps1'), '-OutputDirectory', destination], { stdio: 'inherit' })
  } else {
    if (target.platform !== process.platform) throw new Error('desktop CLI: native launcher requires a matching build platform')
    if (target.platform === 'darwin' && !/^\d+\.\d+(?:\.\d+)?$/u.test(target.macosMinimumVersion ?? '')) {
      throw new Error('desktop CLI: the Electron macOS minimum version is required')
    }
    const compiler = target.platform === 'darwin' ? 'clang++' : 'c++'
    const source = join(import.meta.dirname, '..', 'cli', 'launcher.cpp')
    for (const [name, definitions] of [['dsh', []], ['cli-control', ['-DDSH_CLI_CONTROL=1']]] as const) {
      execFileSync(compiler, ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror',
        ...target.platform === 'darwin' ? ['-arch', target.arch === 'arm64' ? 'arm64' : 'x86_64'] : [],
        ...target.platform === 'darwin' ? ['-mmacosx-version-min=' + target.macosMinimumVersion] : [],
        ...definitions, source, '-o', join(destination, ...name === 'dsh' ? ['bin', name] : [name])], { stdio: 'inherit' })
    }
  }
  // The release replaces this inode and identifier together with the complete
  // application. An old handoff cannot block a newly installed generation.
  writeFileSync(join(destination, 'generation'), randomUUID() + '\n')
  writeFileSync(join(destination, 'lease'), '')
}
