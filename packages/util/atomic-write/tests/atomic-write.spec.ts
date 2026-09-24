import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withFileLock, writeFileAtomic } from '../src/index.ts'

const state = vi.hoisted(() => ({
  afterClaim: undefined as ((claim: string) => Promise<void>) | undefined,
  claimFailure: undefined as string | undefined,
  claimRemovalFails: false,
  lockPermissionFailures: 0,
  releaseLockBeforeProbe: false,
  renameAttempts: 0,
  renameFailures: [] as string[],
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      state.renameAttempts += 1
      const code = state.renameFailures.shift()
      if (code !== undefined) {
        if (code === 'NO_CODE') throw new Error('injected rename failure without a code')
        throw Object.assign(new Error(`${code}: injected rename failure`), { code })
      }
      return actual.rename(...args)
    }),
    rm: (async (...args: Parameters<typeof actual.rm>) => {
      if (state.claimRemovalFails && String(args[0]).includes('.lock.takeover-')) {
        throw Object.assign(new Error('EBUSY: injected claim removal failure'), { code: 'EBUSY' })
      }
      return actual.rm(...args)
    }),
    writeFile: (async (path: unknown, ...rest: never[]) => {
      if (String(path).includes('.lock.takeover-')) {
        if (state.claimFailure !== undefined) {
          throw Object.assign(new Error(`${state.claimFailure}: injected claim failure`), { code: state.claimFailure })
        }
        await (actual.writeFile as (path: unknown, ...args: never[]) => Promise<void>)(path, ...rest)
        await state.afterClaim?.(String(path))
        return
      }
      if (state.lockPermissionFailures > 0 && String(path).endsWith('.lock')) {
        state.lockPermissionFailures -= 1
        if (state.releaseLockBeforeProbe) await actual.rm(String(path))
        throw Object.assign(new Error('EPERM: injected exclusive-create failure'), { code: 'EPERM' })
      }
      return (actual.writeFile as (path: unknown, ...args: never[]) => Promise<void>)(path, ...rest)
    }) as typeof actual.writeFile,
  }
})

const scratchDirs: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  state.afterClaim = undefined
  state.claimFailure = undefined
  state.claimRemovalFails = false
  state.lockPermissionFailures = 0
  state.releaseLockBeforeProbe = false
  state.renameAttempts = 0
  state.renameFailures.length = 0
  await Promise.all(scratchDirs.splice(0).map(dir => rm(dir, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 20,
  })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-write-'))
  scratchDirs.push(dir)
  return dir
}

/** The PID of a process that has already exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  return child.pid as number
}

/** The lock record a holder writes. */
function record(pid: number): string {
  return `${String(pid)}\n`
}

/** Resolve once the lockfile exists, so contention is measured against a held lock. */
async function waitForLock(lockPath: string): Promise<void> {
  for (;;) {
    try {
      await stat(lockPath)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

describe('writeFileAtomic', () => {
  it('creates the file and its parents with exactly the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'nested', 'deep', 'doc.yaml')
    await writeFileAtomic(target, 'a: 1\n', { dirMode: 0o700, mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('a: 1\n')
    if (process.platform !== 'win32') {
      expect((await stat(dirname(target))).mode & 0o777).toBe(0o700)
      expect((await stat(target)).mode & 0o777).toBe(0o600)
    }
  })

  it('replaces existing content and narrows a wider-permission file to the stated mode', async () => {
    const dir = await scratch()
    const target = join(dir, 'doc.yaml')
    await writeFile(target, 'old', { mode: 0o644 })
    await writeFileAtomic(target, 'new', { mode: 0o600 })
    expect(await readFile(target, 'utf8')).toBe('new')
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces a symlinked target itself without writing through to the referent', async () => {
    const dir = await scratch()
    const victim = join(dir, 'victim')
    await writeFile(victim, 'victim-content')
    const target = join(dir, 'doc.yaml')
    await symlink(victim, target)
    await writeFileAtomic(target, 'replaced', { mode: 0o600 })
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('replaced')
    expect(await readFile(victim, 'utf8')).toBe('victim-content')
  })

  it('retries transient Windows rename interference and commits the replacement', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.useFakeTimers()
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(target, 'old')
    state.renameFailures.push('EACCES', 'EBUSY', 'EPERM')

    const replacement = writeFileAtomic(target, 'new', { mode: 0o600 })
    await vi.waitFor(() => { expect(state.renameAttempts).toBeGreaterThan(0) })
    await vi.runAllTimersAsync()
    await replacement

    expect(state.renameAttempts).toBe(4)
    expect(await readFile(target, 'utf8')).toBe('new')
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('leaves no temp sibling after bounded Windows rename retries expire', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.useFakeTimers()
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(target, 'old')
    state.renameFailures.push(...Array.from({ length: 9 }, () => 'EPERM'))

    const replacement = writeFileAtomic(target, 'new', { mode: 0o600 })
    await vi.waitFor(() => { expect(state.renameAttempts).toBeGreaterThan(0) })
    await vi.runAllTimersAsync()
    await expect(replacement).rejects.toMatchObject({ code: 'EPERM' })

    expect(state.renameAttempts).toBe(9)
    expect(await readFile(target, 'utf8')).toBe('old')
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('does not retry a Windows rename failure without a transient code', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const dir = await scratch()
    const target = join(dir, 'document')
    state.renameFailures.push('NO_CODE')

    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toThrow(/without a code/)
    expect(state.renameAttempts).toBe(1)
    expect((await readdir(dir)).filter(entry => entry.includes('.tmp'))).toEqual([])
  })

  it('does not retry rename permission failures outside Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const dir = await scratch()
    const target = join(dir, 'document')
    state.renameFailures.push('EPERM')

    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toMatchObject({ code: 'EPERM' })
    expect(state.renameAttempts).toBe(1)
  })
})

describe('withFileLock', () => {
  it('retries EPERM only when the lock path currently exists', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const lockPath = `${target}.lock`
    await writeFile(lockPath, 'holder\n')
    const release = setTimeout(() => { void rm(lockPath, { force: true }) }, 50)
    state.lockPermissionFailures = 1
    let called = false

    try {
      await withFileLock(target, async () => { called = true })
    } finally {
      clearTimeout(release)
    }
    expect(called).toBe(true)
  })

  it.each(['win32', 'linux'] as const)('preserves persistent EPERM on %s when no lock path exists', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const dir = await scratch()
    const operation = vi.fn(async () => {})
    state.lockPermissionFailures = 2

    await expect(withFileLock(join(dir, 'document'), operation)).rejects.toMatchObject({ code: 'EPERM' })
    expect(operation).not.toHaveBeenCalled()
  })

  it('acquires the Windows lock when its holder releases before the contention probe', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, 'holder\n')
    state.lockPermissionFailures = 1
    state.releaseLockBeforeProbe = true
    const operation = vi.fn(async () => 'acquired')

    await expect(withFileLock(target, operation)).resolves.toBe('acquired')
    expect(operation).toHaveBeenCalledOnce()
    expect(await readdir(dir)).toEqual([])
  })

  it('rejects an invalid parent hierarchy before running the operation', async () => {
    const dir = await scratch()
    const parent = join(dir, 'not-a-directory')
    await writeFile(parent, 'occupied')
    let called = false

    await expect(withFileLock(join(parent, 'document'), async () => {
      called = true
    })).rejects.toThrow(/ENOENT|ENOTDIR|not a directory/i)
    expect(called).toBe(false)
  })

  it('takes over a lock whose holder exited', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, record(await exitedPid()))

    await expect(withFileLock(target, async () => await readFile(`${target}.lock`, 'utf8'), { waitMs: 0 }))
      .resolves.toBe(record(process.pid))
    expect(await readdir(dir)).toEqual([])
  })

  it('admits one contender at a time when several take over the same exited holder', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, record(await exitedPid()))
    let active = 0
    let overlapped = false

    await Promise.all(Array.from({ length: 8 }, () => withFileLock(target, async () => {
      active += 1
      overlapped ||= active > 1
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
    }, { waitMs: 10_000 })))
    expect(overlapped).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it.each([
    ['a live holder', () => record(process.pid)],
    ['an empty record', () => ''],
    ['an incomplete record', () => '12'],
    ['a record that is not a PID', () => 'holder\n'],
    ['a record naming a process group', () => record(0)],
    ['a record beyond the safe integer range', () => '99999999999999999999\n'],
  ])('waits for the lock of %s', async (_label, render) => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const held = render()
    await writeFile(`${target}.lock`, held)
    const operation = vi.fn(async () => {})

    await expect(withFileLock(target, operation, { waitMs: 50 })).rejects.toThrow(/timed out waiting for the writer lock/)
    expect(operation).not.toHaveBeenCalled()
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(held)
  })

  it('waits for a holder whose process exists under another user', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const pid = await exitedPid()
    await writeFile(`${target}.lock`, record(pid))
    const kill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (target === pid) throw Object.assign(new Error('EPERM: injected'), { code: 'EPERM' })
      return kill(target, signal)
    })

    await expect(withFileLock(target, async () => {}, { waitMs: 50 })).rejects.toThrow(/timed out waiting for the writer lock/)
  })

  it('waits for a lock it cannot read', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await mkdir(`${target}.lock`)

    await expect(withFileLock(target, async () => {}, { waitMs: 50 })).rejects.toThrow(/timed out waiting for the writer lock/)
  })

  it('leaves an exited holder\'s lock to the contender that claimed its record', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    const held = record(await exitedPid())
    await writeFile(`${target}.lock`, held)
    const claim = `${target}.lock.takeover-${createHash('sha256').update(held).digest('hex').slice(0, 16)}`
    await writeFile(claim, '1\n')

    await expect(withFileLock(target, async () => {}, { waitMs: 50 })).rejects.toThrow(/timed out waiting for the writer lock/)
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(held)
  })

  it('keeps a lock that another contender acquired while this one claimed the exited record', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, record(await exitedPid()))
    const successor = record(process.pid)
    state.afterClaim = async () => {
      state.afterClaim = undefined
      await writeFile(`${target}.lock`, successor)
    }

    await expect(withFileLock(target, async () => {}, { waitMs: 50 })).rejects.toThrow(/timed out waiting for the writer lock/)
    expect(await readFile(`${target}.lock`, 'utf8')).toBe(successor)
    expect(await readdir(dir)).toEqual(['document.lock'])
  })

  it('retries after Windows refuses a claim that is still being deleted', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, record(await exitedPid()))
    state.claimFailure = 'EPERM'
    setTimeout(() => { state.claimFailure = undefined }, 30)

    await expect(withFileLock(target, async () => 'acquired', { waitMs: 10_000 })).resolves.toBe('acquired')
  })

  it('surfaces a claim failure that is not contention', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, record(await exitedPid()))
    state.claimFailure = 'EIO'
    const operation = vi.fn(async () => {})

    await expect(withFileLock(target, operation)).rejects.toMatchObject({ code: 'EIO' })
    expect(operation).not.toHaveBeenCalled()
  })

  it('runs the operation when its claim cannot be removed afterwards', async () => {
    const dir = await scratch()
    const target = join(dir, 'document')
    await writeFile(`${target}.lock`, record(await exitedPid()))
    state.claimRemovalFails = true

    await expect(withFileLock(target, async () => 'acquired', { waitMs: 0 })).resolves.toBe('acquired')
  })

  it('waits for the caller-stated limit rather than the protocol default', async () => {
    // An operation whose work includes a network round trip legitimately holds
    // the lock far longer than the render-and-rename the default was sized
    // for. The limit is per call so one such operation cannot fail every other
    // writer of the same file, and a caller that states a short one still
    // fails fast.
    const dir = await scratch()
    const target = join(dir, 'document')
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const holder = withFileLock(target, () => held)
    // The holder owns the lock once its lockfile exists; contending before
    // that would measure nothing.
    await waitForLock(`${target}.lock`)

    // Elapsed time is the assertion that distinguishes a honoured limit from
    // the ignored argument: without it the contender simply waits out the
    // protocol default and fails with the same message.
    const startedAt = Date.now()
    await expect(withFileLock(target, async () => 'impatient', { waitMs: 50 }))
      .rejects.toThrow(/timed out waiting for the writer lock/)
    expect(Date.now() - startedAt).toBeLessThan(1_000)

    const patient = withFileLock(target, async () => 'patient', { waitMs: 10_000 })
    release()
    await holder
    expect(await patient).toBe('patient')
  })
})
