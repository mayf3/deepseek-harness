/** OpenSSH connection owner for one version-matched POSIX helper and its independent forwarded streams. */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { helloSchema } from './schemas.ts'

const execute = promisify(execFile)
type Hello = z.infer<typeof helloSchema>

/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
export interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Absolute remote Node executable. */
  node: string
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Bound on connection establishment and individual administrative requests. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum outstanding administrative requests. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context { ssh: SshConnection }
}

/** One non-reconnecting SSH session; loss invalidates all active operations. */
export class SshConnection extends Service {
  static Config: schema<Config> = schema.object({
    host: schema.string().required(), node: schema.string().required(), helper: schema.string().required(),
    helperHash: schema.string().required(), workspace: schema.string().required(),
    requestTimeoutMs: schema.number().default(30_000), maxFrameBytes: schema.number().default(64 * 1024 * 1024),
    maxPending: schema.number().default(128), leaseMs: schema.number().default(30_000),
  })

  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>
  /** Installed helper entry in the remote filesystem. */
  readonly helperPath: string
  private rpc: SshRpcPeer | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private childClosed: Promise<void> | undefined
  private directory: string | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private closed = false
  private failure: Error | undefined
  private sockets = new Set<Socket>()
  private nextSocket = 0
  private readonly config: Required<Config>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH runtime requires a POSIX client')
    this.config = z.object({
      host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/),
      node: z.string().startsWith('/'), helper: z.string().startsWith('/'), helperHash: z.string().regex(/^[0-9a-f]{64}$/),
      workspace: z.string().startsWith('/'), requestTimeoutMs: z.number().int().positive(),
      maxFrameBytes: z.number().int().positive().max(256 * 1024 * 1024), maxPending: z.number().int().positive(),
      leaseMs: z.number().int().min(3000).max(600_000),
    }).parse(config)
    this.helperPath = this.config.helper
    this.ready = this.start()
    void this.ready.catch((error) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
    ctx.effect(() => () => this.dispose())
  }

  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void> { await this.ready }

  /** Send a helper operation; cancellation never automatically replays an ambiguous mutation. */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait = false): Promise<T> {
    await this.ready
    if (this.failure !== undefined) throw this.failure
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    return (this.rpc as SshRpcPeer).request(method, params, result, bounded)
  }

  /** Forward one private remote socket through an independent SSH channel. */
  async connectStream(remote: string, signal?: AbortSignal): Promise<Socket> {
    const hello = await this.ready
    if (!remote.startsWith(`${hello.root}/`) || /[:\r\n\0]/u.test(remote)) throw new Error('SSH helper returned an invalid stream path')
    signal?.throwIfAborted()
    const local = join(this.directory as string, `s${this.nextSocket++}`)
    const forward = `${local}:${remote}`
    await execute('ssh', ['-S', this.controlPath(), '-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-L', forward, this.config.host], {
      timeout: this.config.requestTimeoutMs, ...(signal === undefined ? {} : { signal }), maxBuffer: 64 * 1024,
    })
    if (this.closed) throw new Error('SSH connection closed before stream establishment')
    const socket = createConnection({ path: local, ...(signal === undefined ? {} : { signal }) })
    this.sockets.add(socket)
    socket.once('close', () => {
      this.sockets.delete(socket)
      if (!this.closed) void execute('ssh', ['-S', this.controlPath(), '-O', 'cancel', '-L', forward, this.config.host], { timeout: this.config.requestTimeoutMs }).catch(() => {})
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    return socket
  }

  /** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      await this.ready
      if (this.failure === undefined) await this.rpc?.request('close', {}, z.null(), AbortSignal.timeout(this.config.requestTimeoutMs))
    } finally {
      this.rpc?.close()
      for (const socket of this.sockets) socket.destroy()
      this.child?.kill('SIGTERM')
      const force = setTimeout(() => { this.child?.kill('SIGKILL') }, this.config.requestTimeoutMs)
      try { await this.childClosed } finally { clearTimeout(force) }
      if (this.directory !== undefined) await rm(this.directory, { recursive: true, force: true })
    }
  }

  private controlPath(): string { return join(this.directory as string, 'master') }

  private fail(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.rpc?.close(error)
    for (const socket of this.sockets) socket.destroy(error)
    this.child?.kill('SIGTERM')
  }

  private async start(): Promise<Hello> {
    this.directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-'))
    if (this.closed) throw new Error('SSH connection closed before startup')
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const command = [this.config.node, this.config.helper].map(quote).join(' ')
    const child = spawn('ssh', [
      '-T', '-M', '-S', this.controlPath(), '-o', 'ControlPersist=no', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', this.config.host, command,
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    this.childClosed = new Promise((resolve) => { child.once('close', () => { resolve() }) })
    child.stderr.resume() // SSH diagnostics can contain configured paths; operation errors remain structured.
    child.once('error', (error) => { this.fail(error) })
    child.once('close', () => { this.fail(new Error('SSH helper disconnected; remote outcomes and cleanup are unknown')) })
    const rpc = new SshRpcPeer(child.stdout, child.stdin, this.config.maxFrameBytes, this.config.maxPending)
    this.rpc = rpc
    rpc.once('closed', (error) => { this.fail(error as Error) })
    const hello = await rpc.request('hello', {
      protocol: SSH_PROTOCOL_VERSION, workspace: this.config.workspace, leaseMs: this.config.leaseMs,
    }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper digest differs from the configured artifact')
    this.heartbeat = setInterval(() => {
      void rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2)).catch((error) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }
}

export default SshConnection
