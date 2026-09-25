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
 * Cleanup restores full control on the fixture directories before removing them.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

interface ScriptReport {
  readonly kind: string
  readonly operation: string
  readonly path: string
  readonly status: string
  readonly reason: string
  readonly details: Record<string, unknown>
}

function reports(run: ScriptRun): ScriptReport[] {
  const result = run.output.split(/\r?\n/u).filter(line => line.startsWith('REPORT '))
    .map(line => JSON.parse(line.slice('REPORT '.length)) as ScriptReport)
  expect(result.length).toBeGreaterThan(0)
  for (const entry of result) expect(entry.reason.length).toBeGreaterThan(0)
  expect(result.at(-1)).toMatchObject({ kind: 'summary', details: { exitCode: run.code } })
  return result
}

function pwsh(command: string): string {
  return execFileSync('pwsh', ['/NoLogo', '/NonInteractive', '/NoProfile', '-Command', command], { encoding: 'utf8' })
}

function runScript(args: readonly string[]): ScriptRun {
  return runPowerShell(['-File', script, ...args])
}

function runPowerShell(args: readonly string[]): ScriptRun {
  try {
    const stdout = execFileSync('pwsh', ['/NoLogo', '/NonInteractive', '/NoProfile', ...args], {
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
  return execFileSync('icacls', [path, ...args], { encoding: 'utf8', windowsHide: true })
}

function sddlOf(path: string): string {
  return pwsh(`(Get-Acl -LiteralPath '${path.replaceAll("'", "''")}').Sddl`).trim()
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
    expect(reports(repair)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'action', operation: 'remove_package_allow', path: target, status: 'started' }),
      expect.objectContaining({ kind: 'action', operation: 'remove_package_allow', path: target, status: 'completed' }),
      expect.objectContaining({ kind: 'verification', operation: 'fix', path: target, status: 'verified' }),
    ]))

    // Exactly the foreign ACE disappears; every other line survives unchanged.
    expect(normalized(target, aclLines(target))).toEqual(before.filter(line => !line.includes(PACKAGE_SID)))
  }, 60_000)

  it('reports a healthy directory as not this class and changes nothing', () => {
    const target = makeDir('healthy')
    const before = normalized(target, aclLines(target))

    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=NOT_THIS_CLASS')
    expect(diagnosis.output, diagnosis.output).not.toContain('PACKAGE_ACE')
    expect(reports(diagnosis)).toContainEqual(expect.objectContaining({ kind: 'decision', operation: 'diagnose', path: target, status: 'skipped' }))

    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(repair.output, repair.output).toContain('SUMMARY FIXED=0 GRANTED=0 REFUSED=0')
    expect(reports(repair)).toContainEqual(expect.objectContaining({ kind: 'decision', operation: 'fix', path: target, status: 'skipped' }))
    expect(normalized(target, aclLines(target))).toEqual(before)
  }, 60_000)

  it('reports every inspected ancestor and locates a package ACE present only on the parent', async () => {
    const parent = makeDir('parent-package-report')
    const target = join(parent, 'child')
    mkdirSync(target)
    stamp(parent, PACKAGE_SID)
    const before = [sddlOf(parent), sddlOf(target)]

    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.code, diagnosis.output).toBe(0)
    const entries = reports(diagnosis)
    const inspected = entries.filter(entry => entry.kind === 'observation' && entry.operation === 'inspect_acl')
    const expectedPaths = [target]
    for (let ancestor = dirname(target); ; ancestor = dirname(ancestor)) {
      expectedPaths.push(ancestor)
      if (dirname(ancestor) === ancestor) break
    }
    expect(inspected.map(entry => entry.path)).toEqual(expectedPaths)
    expect(inspected[0]).toMatchObject({
      path: target, status: 'read',
      details: { aces: expect.not.arrayContaining([expect.objectContaining({ sid: PACKAGE_SID })]) },
    })
    expect(inspected[1]).toMatchObject({
      path: parent, status: 'read',
      details: { aces: expect.arrayContaining([expect.objectContaining({ sid: PACKAGE_SID, type: 'Allow', inherited: false })]) },
    })
    expect(entries).toContainEqual(expect.objectContaining({
      kind: 'decision', operation: 'classify', path: target, status: 'CULPRIT',
      details: expect.objectContaining({ packageObjects: [parent] }),
    }))
    expect(entries.filter(entry => entry.kind === 'action' && entry.details.effect !== 'none')).toEqual([])
    expect([sddlOf(parent), sddlOf(target)]).toEqual(before)

    // The example retains both fixture paths and the fixture SID. Host-owned ACEs
    // and ancestors remain covered by the assertions above instead of the snapshot.
    const transcript = entries.filter(entry => entry.path === parent || entry.path === target).map((entry) => {
      let details: Record<string, unknown> = {}
      if (entry.operation === 'inspect_acl') {
        details = { fixturePackageAces: (entry.details.aces as { readonly sid: string }[]).filter(ace => ace.sid === PACKAGE_SID) }
      } else if (entry.operation === 'classify') {
        details = { packageObjects: entry.details.packageObjects }
      } else if (entry.kind === 'summary') {
        details = {
          exitCode: entry.details.exitCode, operations: entry.details.operations, automaticRollback: entry.details.automaticRollback,
        }
      }
      return JSON.stringify({ ...entry, details })
    }).join('\n').replaceAll(JSON.stringify(parent).slice(1, -1), '{{parent}}') + '\n'
    await expect(transcript).toMatchFileSnapshot(fileURLToPath(new URL('./expected/parent-package-report.jsonl', import.meta.url)))
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
    expect(reports(denyDiagnosis)).toContainEqual(expect.objectContaining({
      kind: 'observation', operation: 'inspect_acl', path: deny,
      details: expect.objectContaining({ aces: expect.arrayContaining([expect.objectContaining({ sid: PACKAGE_SID, type: 'Deny', inherited: false })]) }),
    }))

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
    expect(reports(contradictory)).toContainEqual(expect.objectContaining({ kind: 'error', status: 'stopped' }))
  }, 60_000)

  it.each(['-Fix', '-GrantFullControl'])('refuses ancestor junctions for %s without changing their destination', (repairSwitch) => {
    const allowed = makeDir(`junction-${repairSwitch}`)
    const outside = makeDir(`outside-${repairSwitch}`)
    const target = join(outside, 'target')
    mkdirSync(target)
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    stamp(target, PACKAGE_SID)
    const before = sddlOf(target)
    const link = join(allowed, 'link')
    symlinkSync(outside, link, 'junction')
    try {
      for (const allowRoot of [allowed, link]) {
        const repair = runScript(['-Path', join(link, 'target'), '-AllowRoot', allowRoot, '-Out', outDir, repairSwitch])
        expect(repair.output, repair.output).toContain('reparse point')
        expect(repair.code).not.toBe(0)
        expect(reports(repair)).toContainEqual(expect.objectContaining({ kind: 'decision', status: 'refused', reason: expect.stringContaining('reparse point') }))
        expect(sddlOf(target)).toBe(before)
      }
    } finally {
      unlinkSync(link)
    }
  })

  it.each(['-Fix', '-GrantFullControl'])('restores the original DACL with the rollback emitted by %s', (repairSwitch) => {
    const target = makeDir(`rollback-${repairSwitch}'s-directory`)
    icacls(target, '/setintegritylevel', 'L')
    if (repairSwitch === '-GrantFullControl') icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    else icacls(target, '/grant', `*${PACKAGE_SID}:(OI)(CI)(RX)`)
    icacls(target, '/grant', `*${CAPABILITY_SID}:(OI)(CI)(RX)`)
    const before = sddlOf(target)
    const linesBefore = normalized(target, aclLines(target)).sort()
    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, repairSwitch])
    expect(repair.code, repair.output).toBe(0)
    expect(sddlOf(target)).not.toBe(before)
    const rollback = repair.output.split(/\r?\n/u).find(line => line.startsWith('ROLLBACK '))
    expect(rollback, repair.output).toBeDefined()
    const restored = pwsh(rollback!.slice('ROLLBACK '.length))
    expect(reports({ code: 0, output: restored })).toContainEqual(expect.objectContaining({ kind: 'verification', operation: 'restore', status: 'verified' }))
    expect(sddlOf(target)).toBe(before)
    expect(normalized(target, aclLines(target)).sort()).toEqual(linesBefore)
  }, 60_000)

  it('repairs a directory whose full-control ACE only applies to children', () => {
    const target = makeDir('inherit-only-full-control')
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    icacls(target, '/grant', `*${meSid}:(OI)(CI)(IO)(F)`)
    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=PRECONDITION')
    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(repair.output, repair.output).toContain('SUMMARY FIXED=0 GRANTED=1 REFUSED=0')
    icacls(target, '/setintegritylevel', 'L')
  })

  it('refuses a recovery record for another path or a path outside the allowed root', () => {
    const target = makeDir('restore-guards')
    const other = makeDir('restore-other')
    const backups = makeDir('restore-backups')
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    const repair = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', backups, '-GrantFullControl'])
    expect(repair.code, repair.output).toBe(0)
    const record = join(backups, readdirSync(backups).find(file => file.endsWith('.json'))!)
    const before = sddlOf(target)
    const otherBefore = sddlOf(other)
    const mismatch = runScript(['-Path', other, '-AllowRoot', scratch, '-Restore', record])
    expect(mismatch.code).toBe(2)
    expect(mismatch.output).toContain('backup does not describe the requested path')
    expect(sddlOf(other)).toBe(otherBefore)
    const outside = runScript(['-Path', target, '-AllowRoot', other, '-Restore', record])
    expect(outside.code).toBe(2)
    expect(outside.output).toContain('outside -AllowRoot')
    expect(sddlOf(target)).toBe(before)
    const link = join(other, 'link')
    symlinkSync(target, link, 'junction')
    try {
      const throughLink = runScript(['-Path', link, '-AllowRoot', other, '-Restore', record])
      expect(throughLink.code).toBe(2)
      expect(throughLink.output).toContain('reparse point')
      expect(sddlOf(target)).toBe(before)
    } finally {
      unlinkSync(link)
    }
  }, 60_000)

  it('does not report a successful grant when a deny ACE blocks WRITE_OWNER', async () => {
    const target = makeDir('denied-write-owner')
    icacls(target, '/deny', `*${meSid}:(WO)`)
    try {
      const diagnosis = runScript(['-Path', target])
      expect(diagnosis.output, diagnosis.output).toContain('VERDICT=PRECONDITION')
      expect(reports(diagnosis)).toContainEqual(expect.objectContaining({
        kind: 'observation', operation: 'inspect_acl', path: target,
        details: expect.objectContaining({
          writeOwner: false,
          aces: expect.arrayContaining([expect.objectContaining({ sid: meSid, type: 'Deny', rights: 'TakeOwnership', inherited: false })]),
        }),
      }))
      const grant = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
      expect(grant.code, `${grant.output}\n${aclLines(target).join('\n')}`).toBe(2)
      expect(grant.output, grant.output).toContain('GRANT_FAILED')
      expect(grant.output).toContain('GRANTED=0 REFUSED=1')
      expect(aclLines(target).join('\n')).toContain('(DENY)(WO)')
      expect(reports(grant)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'action', operation: 'grant_dacl', status: 'completed' }),
        expect.objectContaining({ kind: 'verification', operation: 'grant', status: 'failed', details: expect.objectContaining({ recovery: expect.stringContaining('-Restore') }) }),
        expect.objectContaining({ kind: 'summary', details: expect.objectContaining({ automaticRollback: false, granted: 0 }) }),
      ]))
      const transcript = reports(grant)
        .filter(entry => entry.path === target && entry.kind !== 'observation')
        .map(entry => `${entry.kind} ${entry.operation} ${entry.status} path={{target}}: ${entry.reason.replaceAll(meSid, '{{caller_sid}}')}`)
        .join('\n') + '\n'
      await expect(transcript).toMatchFileSnapshot(fileURLToPath(new URL('./expected/denied-grant-report.txt', import.meta.url)))
    } finally {
      icacls(target, '/remove:d', `*${meSid}`)
    }
  })

  it('reports backup errors and no ACL write when the output path is a file', () => {
    const target = makeDir('backup-failure')
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    const outputFile = join(scratch, 'not-a-directory')
    writeFileSync(outputFile, 'Existing contents')
    const before = sddlOf(target)
    const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outputFile, '-GrantFullControl'])
    expect(run.code).toBe(1)
    const entries = reports(run)
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', operation: 'backup', status: 'failed', details: expect.objectContaining({ error: expect.any(String) }) }))
    expect(entries.filter(entry => entry.kind === 'action' && entry.details.effect === 'acl')).toEqual([])
    expect(sddlOf(target)).toBe(before)
  })

  it('reports unreadable ACLs as missing observations without inventing permissions', () => {
    const target = makeDir('unreadable-observation')
    const before = sddlOf(target)
    const run = runPowerShell(['-Command', `
function Get-Acl { param([string]$LiteralPath); throw [System.IO.IOException]::new('ACL observation unavailable') }
& '${script.replaceAll("'", "''")}' -Path '${target.replaceAll("'", "''")}'
exit $LASTEXITCODE
`])
    expect(run.code).toBe(0)
    expect(run.output).toContain('VERDICT=UNREADABLE')
    const entries = reports(run)
    expect(entries).toContainEqual(expect.objectContaining({
      kind: 'observation', path: target, status: 'unreadable',
      details: { error: expect.stringContaining('ACL observation unavailable') },
    }))
    expect(entries.at(-1)).toMatchObject({ status: 'partial', details: { observationFailures: expect.any(Number) } })
    expect(entries.filter(entry => entry.kind === 'action' && entry.details.effect !== 'none')).toEqual([])
    expect(sddlOf(target)).toBe(before)
  })

  it('reports the completed write and recovery command when the verification ACL read throws', () => {
    const target = makeDir('post-write-read-failure')
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    const before = sddlOf(target)
    const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
    const wrapper = join(scratch, 'fail-verification.ps1')
    // The real grant runs; only its subsequent observation fails in this child.
    writeFileSync(wrapper, `
$global:targetReads = 0
function Get-Acl {
  param([string]$LiteralPath)
  if ($LiteralPath -eq ${quote(target)}) {
    $global:targetReads++
    if ($global:targetReads -eq 4) { throw [System.IO.IOException]::new('verification read unavailable') }
  }
  Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $LiteralPath
}
& ${quote(script)} -Path ${quote(target)} -AllowRoot ${quote(scratch)} -Out ${quote(outDir)} -GrantFullControl
exit $LASTEXITCODE
`)
    const run = runPowerShell(['-File', wrapper])
    expect(run.code).toBe(2)
    const entries = reports(run)
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'action', operation: 'grant_dacl', status: 'completed' }),
      expect.objectContaining({ kind: 'observation', operation: 'inspect_acl', path: target, status: 'unreadable', details: expect.objectContaining({ error: expect.stringContaining('verification read unavailable') }) }),
      expect.objectContaining({ kind: 'verification', operation: 'grant', status: 'failed', details: expect.objectContaining({ recovery: expect.stringContaining('-Restore') }) }),
    ]))
    expect(sddlOf(target)).not.toBe(before)
    const rollback = run.output.split(/\r?\n/u).find(line => line.startsWith('ROLLBACK '))!
    pwsh(rollback.slice('ROLLBACK '.length))
    expect(sddlOf(target)).toBe(before)
  }, 60_000)

  it('reports a missing path and an already-satisfied grant without mutating either', () => {
    const missing = join(scratch, 'missing')
    const run = runScript(['-Path', missing, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(run.code).toBe(2)
    expect(reports(run)).toContainEqual(expect.objectContaining({ kind: 'decision', path: missing, status: 'skipped', reason: expect.stringContaining('does not exist') }))
    const healthy = makeDir('already-satisfied')
    const before = sddlOf(healthy)
    const grant = runScript(['-Path', healthy, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(grant.code, grant.output).toBe(0)
    expect(reports(grant)).toContainEqual(expect.objectContaining({ kind: 'decision', operation: 'grant', status: 'skipped', reason: expect.stringContaining('already available') }))
    expect(sddlOf(healthy)).toBe(before)
  })

  it('reports well-known package groups without treating them as a removable package ACE', () => {
    const target = makeDir('well-known-package-groups')
    for (const sid of ['S-1-15-2-1', 'S-1-15-2-2']) stamp(target, sid)
    const before = sddlOf(target)
    const run = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(run.code, run.output).toBe(0)
    expect(run.output).toContain('VERDICT=NOT_THIS_CLASS')
    expect(reports(run)).toContainEqual(expect.objectContaining({
      kind: 'observation', operation: 'inspect_acl', path: target,
      details: expect.objectContaining({ aces: expect.arrayContaining([
        expect.objectContaining({ sid: 'S-1-15-2-1', type: 'Allow' }),
        expect.objectContaining({ sid: 'S-1-15-2-2', type: 'Allow' }),
      ]) }),
    }))
    expect(sddlOf(target)).toBe(before)
  })

  it('grants missing rights before removing a package ACE when both problems are present', () => {
    const target = makeDir('both')
    icacls(target, '/inheritance:r', '/grant:r', `*${meSid}:(M)`)
    stamp(target, PACKAGE_SID)
    const ownerBefore = ownerOf(target)
    const diagnosis = runScript(['-Path', target])
    expect(diagnosis.output, diagnosis.output).toContain('VERDICT=BOTH')
    const grant = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-GrantFullControl'])
    expect(grant.output, grant.output).toContain('SUMMARY FIXED=0 GRANTED=1 REFUSED=0')
    expect(aclLines(target).join('\n')).toContain(PACKAGE_SID)
    const fix = runScript(['-Path', target, '-AllowRoot', scratch, '-Out', outDir, '-Fix'])
    expect(fix.output, fix.output).toContain('SUMMARY FIXED=1 GRANTED=0 REFUSED=0')
    expect(aclLines(target).join('\n')).not.toContain(PACKAGE_SID)
    expect(ownerOf(target)).toBe(ownerBefore)
  })
})
