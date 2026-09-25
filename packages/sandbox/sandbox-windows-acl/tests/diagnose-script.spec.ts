/**
 * The diagnosis script shipped with the `diagnose-windows-sandbox-acl` skill is a
 * runnable artifact, so its classification and its two repairs are tested directly
 * rather than through a model.
 *
 * Every case builds its own scratch directory under the system temp directory and
 * never touches the user profile. The foreign package SID is synthetic: the access
 * check that blocks a below-Medium caller keys on the SID class, not on a profile
 * that exists, so a made-up `S-1-15-2-*` value exercises the same path. ACEs are
 * written with `icacls` and the `*SID` spelling, which no account name has to
 * resolve.
 *
 * Cleanup restores full control before deleting: the grant case leaves the caller
 * with `WRITE_DAC` but not `WRITE_OWNER`, and a directory that stripped its own
 * `WRITE_OWNER` cannot be removed by the same unelevated caller.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const isWin32 = process.platform === 'win32'

function pwshAvailable(): boolean {
  try {
    execFileSync('where.exe', ['pwsh'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const script = fileURLToPath(new URL('../assets/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1', import.meta.url))
const PACKAGE_SID = 'S-1-15-2-1-2-3-4'
const CAPABILITY_SID = 'S-1-15-3-1-2-3-4'

interface ScriptRun {
  readonly code: number
  readonly output: string
}

function pwsh(command: string): string {
  return execFileSync('pwsh', ['/NoLogo', '/NonInteractive', '/NoProfile', '-Command', command], { encoding: 'utf8' })
}

function runScript(args: readonly string[]): ScriptRun {
  try {
    const stdout = execFileSync('pwsh', ['/NoLogo', '/NonInteractive', '/NoProfile', '-File', script, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output: stdout }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failure.status ?? -1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function icacls(path: string, ...args: readonly string[]): string {
  return pwsh(`(icacls '${path}' ${args.map(argument => `"${argument}"`).join(' ')}) -join "\`n"`)
}

function aclLines(path: string): string[] {
  return icacls(path).split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
}

function ownerOf(path: string): string {
  return pwsh(`(Get-Acl -LiteralPath '${path}').GetOwner([System.Security.Principal.SecurityIdentifier]).Value`).trim()
}

function normalized(path: string, lines: readonly string[]): string[] {
  return lines.map((line) => {
    const trimmed = line.trim()
    return trimmed.startsWith(path) ? trimmed.slice(path.length).trim() : trimmed
  })
}

describe.skipIf(!isWin32 || !pwshAvailable())('diagnose-windows-sandbox-acl script', () => {
  let scratch!: string
  let outDir!: string
  let meSid!: string

  function makeDir(name: string): string {
    const dir = join(scratch, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function stamp(path: string, sid: string, type: 'grant' | 'deny' = 'grant'): void {
    icacls(path, `/${type}`, `*${sid}:(RX)`)
  }

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'dsh-acl-diagnose-'))
    outDir = makeDir('out')
    meSid = pwsh('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value').trim()
  })

  afterAll(() => {
    // Restore what the grant case withheld before deleting the scratch tree.
    pwsh(
      `Get-ChildItem -LiteralPath '${scratch}' -Recurse -Force -Directory -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { icacls $_.FullName /grant:r "*${meSid}:(F)" | Out-Null }; ` +
      `icacls '${scratch}' /grant:r "*${meSid}:(F)" | Out-Null`,
    )
    rmSync(scratch, { recursive: true, force: true })
  })

  it('names a foreign package-SID ACE as the blocker and removes only that ACE', () => {
    const target = makeDir('stamped')
    stamp(target, PACKAGE_SID)
    const before = normalized(target, aclLines(target))
    expect(before.join('\n')).toContain(PACKAGE_SID)

    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=CULPRIT')
    expect(diagnosis.output, diagnosis.output).toContain(`PACKAGE_ACE SID=${PACKAGE_SID}`)

    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(repair.output, repair.output).toContain(`FIXED ${target} SID=${PACKAGE_SID}`)
    expect(repair.output, repair.output).toContain('SUMMARY FIXED=1 GRANTED=0 REFUSED=0')

    // Exactly the foreign ACE disappears; every other line survives unchanged.
    expect(normalized(target, aclLines(target))).toEqual(before.filter(line => !line.includes(PACKAGE_SID)))
  }, 60_000)

  it('reports a healthy directory as not this class and changes nothing', () => {
    const target = makeDir('healthy')
    const before = normalized(target, aclLines(target))

    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=NOT_THIS_CLASS')
    expect(diagnosis.output, diagnosis.output).not.toContain('PACKAGE_ACE')

    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(repair.output, repair.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=0')
    expect(normalized(target, aclLines(target))).toEqual(before)
  }, 60_000)

  it('reports an inert capability SID and an inert DENY ACE without touching either', () => {
    const capability = makeDir('capability')
    stamp(capability, CAPABILITY_SID)
    const deny = makeDir('denied-package')
    stamp(deny, PACKAGE_SID, 'deny')
    const before = new Map([
      [capability, normalized(capability, aclLines(capability))],
      [deny, normalized(deny, aclLines(deny))],
    ])

    const capabilityDiagnosis = runScript(['-Path', capability])
    expect(capabilityDiagnosis.output, capabilityDiagnosis.output).toContain(`OTHER_S1_15 SID=${CAPABILITY_SID}`)
    expect(capabilityDiagnosis.output, capabilityDiagnosis.output).not.toContain('PACKAGE_ACE')
    expect(capabilityDiagnosis.output, capabilityDiagnosis.output).not.toContain('VERDICT=CULPRIT')

    const denyDiagnosis = runScript(['-Path', deny])
    expect(denyDiagnosis.output, denyDiagnosis.output).not.toContain('PACKAGE_ACE')
    expect(denyDiagnosis.output, denyDiagnosis.output).not.toContain('VERDICT=CULPRIT')

    // `pwsh -File` passes `-Path a,b` literally, so each object is diagnosed on its own.
    for (const path of [capability, deny]) {
      const repair = runScript(['-Path', path, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
      expect(repair.output, repair.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=0')
      expect(normalized(path, aclLines(path))).toEqual(before.get(path))
    }
  }, 90_000)

  it('grants full control for a Modify-only DACL without changing the owner', () => {
    const target = makeDir('missing-write-owner')
    pwsh(`icacls '${target}' /inheritance:r /grant:r "*${meSid}:(M)" | Out-Null`)
    const ownerBefore = ownerOf(target)

    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=PRECONDITION')

    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(repair.output, repair.output).toContain('SUMMARY FIXED=0 GRANTED=1 REFUSED=0')
    expect(aclLines(target).join('\n')).toMatch(/\(F\)/u)
    expect(ownerOf(target)).toBe(ownerBefore)
  }, 60_000)

  it('refuses a target outside -AllowRoot and refuses contradictory switches', () => {
    const target = makeDir('outside-root')
    const unrelated = makeDir('unrelated-root')
    stamp(target, PACKAGE_SID)

    const refused = runScript(['-Path', target, '-AllowRoot', unrelated, '-Out', outDir, '-Fix'])
    expect(refused.output, refused.output).toContain('FIX_REFUSED')
    expect(refused.output, refused.output).toContain('is outside -AllowRoot')
    expect(refused.output, refused.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=1')
    expect(aclLines(target).join('\n')).toContain(PACKAGE_SID)

    const contradictory = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix', '-GrantFullControl'])
    expect(contradictory.code).toBe(2)
    expect(contradictory.output, contradictory.output).toContain('run one at a time')
  }, 60_000)
})
