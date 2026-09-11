/** Remote subprocess and PTY handles with independent SSH streams and helper-owned process lifetimes. */
import { Duplex, PassThrough, type Readable, type Writable } from 'node:stream'
import type { Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessCollectedOutputs, SubprocessHandle, SubprocessOutcome, SubprocessOutputMode, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSignal, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import type { SshConnection } from '@deepseek-ai/dsh-ssh'
import { doneSchema, foregroundSchema, preparedSchema, remotePath } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'

function environment(env?: NodeJS.ProcessEnv): Record<string, string | null> | undefined {
  return env === undefined ? undefined : Object.fromEntries(Object.entries(env).map(([key, value]) => [key, value ?? null]))
}

/** One remote ordinary process; stdin and control remain usable during asynchronous SSH allocation. */
class RemoteProcess implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly control: Duplex | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  private readonly inbound = new PassThrough()
  private readonly out = new PassThrough()
  private readonly err = new PassThrough()
  private readonly toControl = new PassThrough()
  private readonly fromControl = new PassThrough()
  private readonly controller = new AbortController()
  private readonly started: Promise<void>
  private id: string | undefined
  private sockets: Socket[] = []
  private failure: unknown
  private quiescent = false
  private readonly detachAbort: () => void
  private spills: { stdout?: string | undefined; stderr?: string | undefined } = {}

  constructor(private readonly ssh: SshConnection, private readonly spec: SubprocessSpawnSpec) {
    this.stdin = spec.stdio.stdin === 'pipe' ? this.inbound : undefined
    this.stdout = spec.stdio.stdout === 'pipe' ? this.out : undefined
    this.stderr = spec.stdio.stderr === 'pipe' ? this.err : undefined
    const requestedControl = (spec.stdio as typeof spec.stdio & { control?: 'pipe' }).control
    this.control = requestedControl === undefined ? undefined : Duplex.from({ writable: this.toControl, readable: this.fromControl })
    for (const stream of [this.inbound, this.out, this.err, this.toControl, this.fromControl, this.control]) stream?.on('error', () => {})
    const collect = (name: 'stdout' | 'stderr', stream: PassThrough, mode: SubprocessOutputMode) => {
      if (mode === 'pipe') return undefined
      if (mode === 'inherit') { stream.pipe(name === 'stdout' ? process.stdout : process.stderr, { end: false }); return undefined }
      const collector = new OutputCollector(mode.maxBytes, undefined, name, '')
      stream.on('data', (chunk: Buffer) => { collector.push(chunk) })
      return {
        readFrom: (offset: number) => ({
          ...collector.readFrom(offset), ...(this.spills[name] === undefined ? {} : { spillPath: this.spills[name] }),
        }),
      }
    }
    const stdout = collect('stdout', this.out, spec.stdio.stdout)
    const stderr = collect('stderr', this.err, spec.stdio.stderr)
    this.collected = { ...(stdout === undefined ? {} : { stdout }), ...(stderr === undefined ? {} : { stderr }) }
    const onAbort = (): void => { this.terminate() }
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    this.detachAbort = () => { spec.signal?.removeEventListener('abort', onAbort) }
    this.started = this.start()
    this.done = this.started.then(async () => {
      const result = await ssh.request('process.done', { id: this.id }, doneSchema, undefined, true)
      this.spills = result.spills
      return { exitCode: result.outcome.exitCode, signal: result.outcome.signal as NodeJS.Signals | null }
    }).catch((error: unknown) => {
      this.failure = error
      this.terminate()
      for (const stream of [this.inbound, this.out, this.err, this.toControl, this.fromControl]) {
        stream.destroy(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    })
    void this.done.catch(() => {})
  }

  private async start(): Promise<void> {
    this.spec.signal?.throwIfAborted()
    const prepared = await this.ssh.request(
      'process.prepare', { ...this.spec, signal: undefined, env: environment(this.spec.env) }, preparedSchema, this.controller.signal,
    )
    this.id = prepared.id
    try {
      const sockets = await Promise.all(Object.entries(prepared.streams).map(async ([name, path]) =>
        [name, await this.ssh.connectStream(path, this.controller.signal)] as const))
      this.sockets = sockets.map(([, socket]) => socket)
      for (const [name, socket] of sockets) {
        if (name === 'stdout') socket.pipe(this.out)
        if (name === 'stderr') socket.pipe(this.err)
        if (name === 'stdin') this.inbound.pipe(socket)
        if (name === 'control') { this.toControl.pipe(socket); socket.pipe(this.fromControl) }
      }
      this.controller.signal.throwIfAborted()
      await this.ssh.request('process.start', { id: this.id }, z.object({}).strict(), this.controller.signal)
    } catch (error) {
      await this.ssh.request('process.terminate', { id: this.id }, z.null()).catch(() => {})
      for (const socket of this.sockets) socket.destroy()
      throw error
    }
  }

  terminate(): void {
    this.controller.abort(new Error('SSH process terminated'))
    if (this.id !== undefined) void this.ssh.request('process.terminate', { id: this.id }, z.null()).catch((error: unknown) => { this.failure = error })
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.quiescent) return true
    await this.started
    if (this.failure !== undefined) throw this.failure
    const result = await this.ssh.request('process.wait', { id: this.id }, z.boolean(), signal, true)
    if (result) { this.quiescent = true; this.detachAbort() }
    return result
  }
}

/** SSH provider paired with the SSH filesystem; the remote helper selects POSIX process ownership. */
export class SshSubprocessRuntime extends SubprocessRuntime {
  static inject = ['ssh']
  private readonly live = new Set<SubprocessHandle>()
  private readonly terminals = new Set<SubprocessTerminalHandle>()

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      for (const handle of this.live) handle.terminate()
      const results = await Promise.allSettled([
        ...[...this.live].map(handle => handle.waitForExit()),
        ...[...this.terminals].map(handle => handle.terminate()),
      ])
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'SSH process cleanup could not be confirmed')
    })
  }

  override resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.ctx.ssh.request('executable', { command, env }, remotePath, signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    spec.signal?.throwIfAborted()
    const handle = new RemoteProcess(this.ctx.ssh, spec)
    this.live.add(handle)
    void handle.done.then(() => handle.waitForExit()).then(() => { this.live.delete(handle) }).catch(() => {})
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const ssh = this.ctx.ssh
    const prepared = await ssh.request('process.prepare', {
      argv: spec.argv, cwd: spec.cwd, env: environment(spec.env), graceMs: spec.graceMs,
      terminal: { rows: spec.rows, cols: spec.cols },
    }, preparedSchema, spec.signal)
    const id = prepared.id
    let socket: Socket | undefined
    try {
      socket = await ssh.connectStream(z.string().parse(prepared.streams.terminal), spec.signal)
      const started = await ssh.request('process.start', { id }, z.object({ pid: z.number().int().positive() }).strict(), spec.signal)
      const output = socket
      const done = ssh.request('process.done', { id }, doneSchema, undefined, true).then(result => ({ exitCode: result.outcome.exitCode, signal: result.outcome.signal as NodeJS.Signals | null }))
      void done.catch(() => {})
      let closing: Promise<void> | undefined
      const handle: SubprocessTerminalHandle = {
        pid: started.pid, output, done,
        write: async (data) => { await ssh.request('terminal.write', { id, value: data }, z.null()) },
        inspectForeground: async () => await ssh.request('terminal.inspect', { id }, foregroundSchema) ?? undefined,
        signalForeground: (signal: SubprocessTerminalSignal) => ssh.request('terminal.signal', { id, value: signal }, z.number().int().positive()),
        terminate: () => {
          closing ??= ssh.request('process.terminate', { id }, z.null(), undefined, true).then(() => {
            output.destroy()
            this.terminals.delete(handle)
          }).catch((error: unknown) => { closing = undefined; throw error })
          return closing
        },
      }
      this.terminals.add(handle)
      return handle
    } catch (error) {
      socket?.destroy()
      await ssh.request('process.terminate', { id }, z.null()).catch(() => {})
      throw error
    }
  }
}

export default SshSubprocessRuntime
