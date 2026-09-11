/** OpenSSH connection owner for one version-matched POSIX helper and its independent forwarded streams. */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { promisify } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { helloSchema, type SshStreamEndpoint } from './schemas.ts'
import { authenticateStream } from './stream-security.ts'

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
  /** Optional preinstalled built PTC entry, paired with its expected digest. */
  bootstrapPath?: string
  /** SHA-256 of bootstrapPath; both fields must be supplied together. */
  bootstrapHash?: string
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
    bootstrapPath: schema.string(), bootstrapHash: schema.string(),
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
  private readonly config: Required<Omit<Config, 'bootstrapPath' | 'bootstrapHash'>> & Pick<Config, 'bootstrapPath' | 'bootstrapHash'>
  private remote: Hello | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH runtime requires a POSIX client')
    this.config = z.object({
      host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/),
      node: z.string().startsWith('/'), helper: z.string().startsWith('/'), helperHash: z.string().regex(/^[0-9a-f]{64}$/),
      workspace: z.string().startsWith('/'), requestTimeoutMs: z.number().int().positive(),
      bootstrapPath: z.string().startsWith('/').optional(), bootstrapHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      maxFrameBytes: z.number().int().positive().max(64 * 1024 * 1024), maxPending: z.number().int().positive(),
      leaseMs: z.number().int().min(3000).max(600_000),
    }).refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined), 'bootstrapPath and bootstrapHash must be paired')
      .parse(config) as typeof this.config
    this.helperPath = this.config.helper
    this.ready = this.start()
    void this.ready.catch((error) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
    ctx.effect(() => () => this.dispose())
  }

  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void> { await this.ready }

  /** Verified remote Node executable for the paired code runtime. */
  get nodeExecutable(): string {
    if (this.remote === undefined) throw new Error('SSH helper is not ready')
    return this.remote.node
  }

  /** Verified preinstalled PTC entry; unconfigured runtimes fail before program execution. */
  get bootstrapPath(): string {
    if (this.remote === undefined || this.config.bootstrapPath === undefined) throw new Error('SSH PTC requires a verified bootstrapPath and bootstrapHash')
    return this.config.bootstrapPath
  }

  /**
   * Send a helper operation; cancellation never replays an ambiguous mutation.
   * @param method - the private helper operation.
   * @param params - JSON request fields validated by the helper.
   * @param result - response validation before returning provider-visible data.
   * @param signal - cancellation, which does not undo completed remote effects.
   * @param wait - allow a process observation to outlast the administrative deadline.
   * @returns the validated remote result.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait = false): Promise<T> {
    await this.ready
    if (this.failure !== undefined) throw this.failure
    const bounded = wait ? signal : signal === undefined
      ? AbortSignal.timeout(this.config.requestTimeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    return (this.rpc as SshRpcPeer).request(method, params, result, bounded)
  }

  /**
   * Forward one authenticated stream through an independent SSH channel.
   * @param endpoint - private coordinates issued by this connection's helper.
   * @param signal - cancellation of allocation and the resulting socket.
   * @returns a paused socket; attach a consumer before resuming it.
   */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    const hello = await this.ready
    const remote = endpoint.path
    if (!remote.startsWith(`${hello.root}/`) || /[:\r\n\0]/u.test(remote)) throw new Error('SSH helper returned an invalid stream path')
    signal?.throwIfAborted()
    const local = join(this.directory as string, `s${this.nextSocket++}`)
    const forward = `${local}:${remote}`
    const cancelForward = async (): Promise<void> => {
      if (!this.closed) await execute('ssh', ['-S', this.controlPath(), '-O', 'cancel', '-L', forward, this.config.host], {
        timeout: this.config.requestTimeoutMs,
      }).catch(() => {})
      await rm(local, { force: true })
    }
    try {
      await execute('ssh', ['-S', this.controlPath(), '-O', 'forward', '-o', 'ExitOnForwardFailure=yes', '-L', forward, this.config.host], {
        timeout: this.config.requestTimeoutMs, ...(signal === undefined ? {} : { signal }), maxBuffer: 64 * 1024,
      })
    } catch (error) { await cancelForward(); throw error }
    if (this.closed) throw new Error('SSH connection closed before stream establishment')
    const socket = createConnection({ path: local, allowHalfOpen: true, ...(signal === undefined ? {} : { signal }) })
    this.sockets.add(socket)
    socket.once('close', () => {
      this.sockets.delete(socket)
      void cancelForward().catch(() => {})
    })
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.off('connect', connected)
        socket.off('error', failed)
        socket.off('close', closed)
      }
      const connected = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { failed(new Error('SSH connection closed before stream establishment')) }
      socket.once('connect', connected)
      socket.once('error', failed)
      socket.once('close', closed)
    })
    const authenticated = await authenticateStream(socket, endpoint.capability, this.config.requestTimeoutMs)
    this.sockets.add(authenticated)
    authenticated.on('error', () => { authenticated.destroy() })
    authenticated.once('close', () => { this.sockets.delete(authenticated) })
    return authenticated
  }

  /** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    try {
      await this.ready.catch(() => {})
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
    this.directory = await mkdtemp('/tmp/dsh-ssh-')
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
      ...(this.config.bootstrapPath === undefined ? {} : { bootstrapPath: this.config.bootstrapPath }),
    }, helloSchema, AbortSignal.timeout(this.config.requestTimeoutMs))
    if (hello.hash !== this.config.helperHash) throw new Error('SSH helper digest differs from the configured artifact')
    if (hello.bootstrapHash !== this.config.bootstrapHash) throw new Error('SSH PTC bootstrap digest differs from the configured artifact')
    this.remote = hello
    this.heartbeat = setInterval(() => {
      void rpc.request('heartbeat', {}, z.null(), AbortSignal.timeout(this.config.leaseMs / 2)).catch((error) => { this.fail(error instanceof Error ? error : new Error(String(error))) })
    }, Math.floor(this.config.leaseMs / 3))
    this.heartbeat.unref()
    return hello
  }
}

export default SshConnection
