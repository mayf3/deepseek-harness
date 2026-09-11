/** Remote process ownership and separately forwarded byte streams. */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex, Readable, Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { spawnSchema } from './schemas.ts'
import { z } from 'zod'

type Request = z.infer<typeof spawnSchema>
type Channel = 'stdin' | 'stdout' | 'stderr' | 'control' | 'terminal'
interface Endpoint { path: string; server: Server; connected: Promise<Socket>; socket?: Socket }
interface ProcessRecord {
  request: Request
  directory: string
  endpoints: Partial<Record<Channel, Endpoint>>
  ordinary?: SubprocessHandle
  terminal?: SubprocessTerminalHandle
  start?: Promise<void>
  done?: Promise<{ outcome: { exitCode: number | null; signal: NodeJS.Signals | null }; spills: { stdout?: string; stderr?: string } }>
  expiry: NodeJS.Timeout
}

/** Owns remote launch reservations through final process-range quiescence. */
export class RemoteProcesses {
  private readonly records = new Map<string, ProcessRecord>()
  private readonly completed = new Map<string, unknown>()
  private closing = false

  constructor(
    private readonly ctx: Context, private readonly root: string,
    private readonly limit: number, private readonly preparationMs: number,
  ) {}

  /** Allocate private stream listeners; no target executes until start(). */
  async prepare(raw: unknown): Promise<{ id: string; streams: Partial<Record<Channel, string>> }> {
    if (this.closing || this.records.size >= this.limit) throw new Error('SSH process capacity unavailable')
    const request = spawnSchema.parse(raw)
    const id = randomUUID()
    const directory = join(this.root, id)
    await mkdir(directory, { mode: 0o700 })
    const record: ProcessRecord = {
      request, directory, endpoints: {},
      expiry: setTimeout(() => { void this.release(id).catch(() => {}) }, this.preparationMs),
    }
    this.records.set(id, record)
    try {
      const names: Channel[] = request.terminal === undefined
        ? ['stdout', 'stderr', ...(request.stdio?.stdin === 'pipe' ? ['stdin' as const] : []), ...(request.stdio?.control === 'pipe' ? ['control' as const] : [])]
        : ['terminal']
      for (const name of names) record.endpoints[name] = await this.endpoint(join(directory, name))
      return { id, streams: Object.fromEntries(Object.entries(record.endpoints).map(([name, endpoint]) => [name, endpoint.path])) }
    } catch (error) {
      await this.release(id)
      throw error
    }
  }

  /** Start once all data channels are connected; duplicate starts refuse rather than replay. */
  async start(id: string): Promise<{ pid?: number }> {
    const record = this.record(id)
    if (record.start !== undefined) throw new Error('SSH process launch was already requested')
    record.start = this.startOnce(id, record)
    await record.start
    return record.terminal === undefined ? {} : { pid: record.terminal.pid }
  }

  private async startOnce(id: string, record: ProcessRecord): Promise<void> {
    await Promise.all(Object.values(record.endpoints).map(endpoint => endpoint.connected))
    clearTimeout(record.expiry)
    if (this.closing) throw new Error('SSH helper is closing')
    const request = record.request
    const cwd = this.ctx.fs.processPath(await this.ctx.fs.resolve(request.cwd))
    const env = request.env === undefined ? {} : Object.fromEntries(
      Object.entries(request.env).map(([key, value]) => [key, value ?? undefined]),
    )
    if (request.terminal !== undefined) {
      const terminal = await this.ctx.subprocess.spawnTerminal({
        argv: request.argv, cwd,
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        graceMs: request.graceMs, ...request.terminal,
      })
      record.terminal = terminal
      const socket = await (record.endpoints.terminal as Endpoint).connected
      const output = pipeline(terminal.output, socket).catch(() => {})
      record.done = terminal.done.then(outcome => ({ outcome, spills: {} }))
      void record.done.catch(() => {})
      void record.done.then(async (result) => {
        await terminal.terminate()
        await output
        this.rememberCompleted(id, record, result)
      }).catch(() => {})
      return
    }
    const stdio = request.stdio as NonNullable<Request['stdio']>
    const spec: SubprocessSpawnSpec = { argv: request.argv, cwd, env, graceMs: request.graceMs,
      stdio: { stdin: stdio.stdin, stdout: 'pipe', stderr: 'pipe', ...(stdio.control === undefined ? {} : { control: stdio.control }) },
    }
    const ordinary = this.ctx.subprocess.spawn(spec)
    record.ordinary = ordinary
    const collectors: Partial<Record<'stdout' | 'stderr', OutputCollector>> = {}
    const streams: Promise<void>[] = []
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = ordinary[name] as Readable
      const mode = stdio[name]
      if (typeof mode === 'object') {
        const collector = new OutputCollector(mode.maxBytes, mode.spill?.maxBytes, name, record.directory)
        collectors[name] = collector
        stream.on('data', (chunk: Buffer) => { collector.push(chunk) })
      }
      const socket = await (record.endpoints[name] as Endpoint).connected
      streams.push(pipeline(stream, socket).catch(() => {}))
    }
    if (record.endpoints.stdin !== undefined) {
      const socket = await record.endpoints.stdin.connected
      void pipeline(socket, ordinary.stdin as Writable).catch(() => {})
    }
    if (record.endpoints.control !== undefined) {
      const control = (ordinary as SubprocessHandle & { control?: Duplex }).control
      if (control === undefined) { ordinary.terminate(); throw new Error('Remote subprocess provider did not establish fd 7') }
      const socket = await record.endpoints.control.connected
      socket.pipe(control).pipe(socket)
      socket.on('error', () => { control.destroy() })
      control.on('error', () => { socket.destroy() })
      streams.push(finished(socket, { readable: false, cleanup: true }).catch(() => {}))
    }
    record.done = ordinary.done.then(async (outcome) => {
      // A paused output reader may defer EOF, but must not retain the process-range owner.
      await Promise.race([
        Promise.all(streams),
        new Promise<void>((resolve) => { const timer = setTimeout(resolve, request.graceMs); timer.unref() }),
      ])
      const spills: { stdout?: string; stderr?: string } = {}
      for (const name of ['stdout', 'stderr'] as const) {
        collectors[name]?.seal()
        const path = collectors[name]?.readFrom(0).spillPath
        if (path !== undefined) spills[name] = path
      }
      return { outcome, spills }
    })
    void record.done.catch(() => {})
    void record.done.then(async (result) => {
      await ordinary.waitForExit()
      await Promise.all(streams)
      this.rememberCompleted(id, record, result)
    }).catch(() => {})
  }

  /** Await the direct result without claiming all descendants have exited. */
  async done(id: string): Promise<unknown> {
    if (this.completed.has(id)) return this.completed.get(id)
    const record = this.record(id)
    if (record.start === undefined) throw new Error('SSH process has not started')
    await record.start
    return record.done
  }

  /** Observe the same native managed range used for termination. */
  async wait(id: string, signal?: AbortSignal): Promise<boolean> {
    if (this.completed.has(id)) return true
    const record = this.record(id)
    await record.start
    if (record.ordinary !== undefined) return record.ordinary.waitForExit(signal)
    if (record.terminal !== undefined) { await record.terminal.terminate(); return true }
    throw new Error('SSH process was not started')
  }

  /** Start managed termination without serializing it behind output. */
  async terminate(id: string): Promise<void> {
    if (this.completed.has(id)) return
    const record = this.record(id)
    record.ordinary?.terminate()
    if (record.terminal !== undefined) await record.terminal.terminate()
    if (record.start === undefined) await this.release(id)
  }

  /** Operate on the one terminal owned by the request id. */
  async terminal(id: string, operation: 'write' | 'inspect' | 'signal', value?: string): Promise<unknown> {
    const terminal = this.record(id).terminal
    if (terminal === undefined) throw new Error('SSH handle does not own a terminal')
    if (operation === 'write') { await terminal.write(z.string().parse(value)); return null }
    if (operation === 'inspect') return await terminal.inspectForeground() ?? null
    return terminal.signalForeground(z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP']).parse(value) as SubprocessTerminalSignal)
  }

  /** Stop every owned process on lease expiry or disconnect. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const outcomes = await Promise.allSettled([...this.records.keys()].map(id => this.release(id)))
    const errors = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'SSH remote process cleanup failed')
  }

  private async release(id: string): Promise<void> {
    const record = this.records.get(id)
    if (record === undefined) return
    clearTimeout(record.expiry)
    for (const endpoint of Object.values(record.endpoints)) { endpoint.socket?.destroy(); endpoint.server.close() }
    record.ordinary?.terminate()
    if (record.ordinary !== undefined) await record.ordinary.waitForExit()
    if (record.terminal !== undefined) await record.terminal.terminate()
    this.records.delete(id)
    await rm(record.directory, { recursive: true, force: true })
  }

  private record(id: string): ProcessRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new Error('Unknown or expired SSH process handle')
    return record
  }

  private rememberCompleted(id: string, record: ProcessRecord, result: unknown): void {
    if (this.records.get(id) !== record) return
    this.records.delete(id)
    this.completed.set(id, result)
    if (this.completed.size > this.limit * 4) this.completed.delete(this.completed.keys().next().value as string)
    // Completed spill files remain in the helper's private root until connection disposal.
    for (const endpoint of Object.values(record.endpoints)) { endpoint.server.close(); endpoint.socket?.destroy() }
  }

  private async endpoint(path: string): Promise<Endpoint> {
    const connected = Promise.withResolvers<Socket>()
    const server = createServer({ allowHalfOpen: true })
    const endpoint: Endpoint = { path, server, connected: connected.promise }
    void connected.promise.catch(() => {})
    server.on('connection', (socket) => {
      if (endpoint.socket !== undefined) { socket.destroy(); return }
      endpoint.socket = socket
      socket.on('error', () => {})
      server.close()
      connected.resolve(socket)
    })
    server.on('error', (error) => { connected.reject(error) })
    server.on('close', () => { if (endpoint.socket === undefined) connected.reject(new Error('SSH stream reservation closed')) })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
    await chmod(path, 0o600)
    return endpoint
  }
}
