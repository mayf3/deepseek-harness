/** Installed CLI leases held across Desktop update preparation and installer handoff. */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const CONTROL_TIMEOUT_MS = 15_000

/** A live command owns the runtime that the updater needs to replace. */
export class DesktopCliBusyError extends Error {}

/** Installation lifecycle supplied to the update coordinator. */
export interface DesktopInstallationGuard {
  /** Publish the handoff before the native installer can outlive Electron. */
  handoff(): Promise<void>
  /** Cancel this transaction and release its lease after failed or declined installation. */
  cancel(): Promise<void>
  /** Close the controller during application quit, retaining a committed handoff. */
  release(): Promise<void>
}

function controlEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => /^(?:systemroot|windir|temp|tmp|tmpdir|home|lang)$/iu.test(name)))
}

/** One native controller owns the installation lease until cancellation or GUI exit. */
export class DesktopCliUpdateGuard implements DesktopInstallationGuard {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly exited: Promise<number | null>
  private readonly token = randomUUID()
  private stderr = ''
  private failure: Error | undefined
  private expected: { line: string; resolve(): void; reject(error: Error): void } | undefined
  private cancellation: Promise<void> | undefined
  private handoffStarted = false

  private constructor(private readonly executable: string, version: string) {
    this.child = spawn(executable, ['hold', this.token, version], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: controlEnvironment(),
    })
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-8192)
    })
    this.child.stdin.on('error', (error: Error) => { this.expected?.reject(error) })
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', (line) => {
      const expected = this.expected
      if (expected === undefined || line !== expected.line) {
        this.failure = new Error('desktop CLI: invalid update controller response')
        expected?.reject(this.failure)
        this.child.kill()
        return
      }
      this.expected = undefined
      expected.resolve()
    })
    this.child.once('error', (error) => {
      this.failure = error
      this.expected?.reject(error)
    })
    this.exited = new Promise(resolve => this.child.once('close', (code) => {
      lines.close()
      const error = code === 75
        ? new DesktopCliBusyError('Finish running dsh commands, then retry the Desktop update.')
        : this.failure ?? new Error(this.stderr.trim() || 'desktop CLI: update controller exited')
      this.failure = error
      this.expected?.reject(error)
      this.expected = undefined
      resolve(code)
    }))
  }

  /**
   * Reject active CLI work and hold off new CLI starts while the update prepares.
   * @param executable - Absolute installed cli-control executable.
   * @param version - Exact application version selected for installation.
   * @returns A live installation guard, or a DesktopCliBusyError for active CLI work.
   */
  static async acquire(executable: string, version: string): Promise<DesktopCliUpdateGuard> {
    const guard = new DesktopCliUpdateGuard(executable, version)
    try {
      await guard.expect('READY')
      return guard
    } catch (error) {
      guard.child.stdin.destroy()
      guard.child.kill()
      await guard.exited
      throw error
    }
  }

  private async expect(line: string): Promise<void> {
    if (this.failure !== undefined) throw this.failure
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await new Promise<void>((resolve, reject) => {
        this.expected = { line, resolve, reject }
        timer = setTimeout(() => {
          this.expected = undefined
          reject(new Error('desktop CLI: update controller timed out'))
        }, CONTROL_TIMEOUT_MS)
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async handoff(): Promise<void> {
    this.handoffStarted = true
    const committed = this.expect('COMMITTED')
    this.child.stdin.write('HANDOFF\n', (error) => {
      if (error != null) this.expected?.reject(error)
    })
    await committed
  }

  cancel(): Promise<void> {
    return this.cancellation ??= this.doCancel()
  }

  private async doCancel(): Promise<void> {
    this.child.stdin.end('CANCEL\n')
    const timer = setTimeout(() => { this.child.kill() }, CONTROL_TIMEOUT_MS)
    let code: number | null
    try { code = await this.exited } finally { clearTimeout(timer) }
    if (code === 0 || !this.handoffStarted) return
    // A lost acknowledgement can follow a committed handoff. A new controller
    // removes only this token, after acquiring the same installation lease.
    await promisify(execFile)(this.executable, ['cancel', this.token], {
      windowsHide: true, env: controlEnvironment(), timeout: CONTROL_TIMEOUT_MS,
    })
  }

  async release(): Promise<void> {
    this.child.stdin.end()
    const code = await this.exited
    if (code !== 0) throw this.failure ?? new Error('desktop CLI: update controller failed')
  }
}
