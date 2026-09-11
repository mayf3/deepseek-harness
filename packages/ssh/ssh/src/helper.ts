/** Private POSIX SSH helper; filesystem and process effects use the installed local providers. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { FsError, type FsTarget, type FsEditRequest, type FsWriteIntent, type FsVersion } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from './protocol.ts'
import { RemoteProcesses } from './helper-processes.ts'
import { editSchema, environmentSchema, intentSchema, policySchema, remotePath, targetSchema } from './schemas.ts'

const MAX_FRAME_BYTES = 64 * 1024 * 1024
const MAX_TEXT_BYTES = 8 * 1024 * 1024
const object = z.object({}).strict()
const idRequest = z.object({ id: z.string().uuid() }).strict()

async function services() {
  const ctx = new Context()
  const fibers = [await ctx.plugin(SessionProjectionRegistry)]
  fibers.push(await ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: process.cwd() }))
  fibers.push(await ctx.plugin(SandboxedFileSystem, { cwd: process.cwd(), diffBasisMaxBytes: 10 * 1024 * 1024 }))
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  fibers.push(await ctx.plugin(LocalSandboxProvider, { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000 }))
  return { ctx, close: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}

/** Run the private helper until the SSH channel closes or its client lease expires. */
export async function runSshHelper(): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH helper requires a POSIX host')
  const runtime = await services()
  const { ctx } = runtime
  const root = await mkdtemp('/tmp/dsh-ssh-')
  const processes = new RemoteProcesses(ctx, root, 128, 30_000)
  const iterators = new Map<string, AsyncIterator<string>>()
  let lease: NodeJS.Timeout | undefined
  let leaseMs = 30_000
  let initialized = false
  let cleanup: Promise<void> | undefined
  const close = (): Promise<void> => {
    cleanup ??= (async () => {
      if (lease !== undefined) clearTimeout(lease)
      await Promise.allSettled([...iterators.values()].map(iterator => iterator.return?.()))
      await processes.close()
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    })()
    return cleanup
  }
  const touchLease = (): void => {
    if (lease !== undefined) clearTimeout(lease)
    lease = setTimeout(() => { peer.close(new Error('SSH helper client lease expired')); void close().catch(() => { process.exitCode = 1 }) }, leaseMs)
  }
  const policy = async (raw: unknown): Promise<SandboxExecutionPolicy> => {
    const parsed = policySchema.parse(raw)
    const target = await ctx.fs.resolve(parsed.workspaceRoot)
    return { ...parsed, workspaceRoot: ctx.fs.processPath(target) } as SandboxExecutionPolicy
  }
  const asTarget = (raw: unknown): FsTarget => targetSchema.parse(raw) as FsTarget
  const peer = new SshRpcPeer(process.stdin, process.stdout, MAX_FRAME_BYTES, 128, async (method, raw, signal) => {
    if (method === 'hello') {
      if (initialized) throw new Error('SSH helper handshake already completed')
      const input = z.object({
        protocol: z.literal(SSH_PROTOCOL_VERSION), workspace: remotePath, leaseMs: z.number().int().min(3000).max(600_000),
        bootstrapPath: remotePath.optional(),
      }).strict().parse(raw)
      const workspace = ctx.fs.processPath(await ctx.fs.resolve(input.workspace, { signal }))
      process.chdir(workspace)
      leaseMs = input.leaseMs
      initialized = true
      touchLease()
      return {
        protocol: SSH_PROTOCOL_VERSION, hash: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
        platform: process.platform, nodeVersion: process.version, node: process.execPath, root, workspace,
        ...(input.bootstrapPath === undefined ? {} : { bootstrapHash: createHash('sha256').update(readFileSync(input.bootstrapPath)).digest('hex') }),
      }
    }
    if (!initialized || cleanup !== undefined) throw new Error('SSH helper is not accepting operations')
    if (method === 'heartbeat') { object.parse(raw); touchLease(); return null }
    if (method === 'close') { object.parse(raw); await close(); return null }
    if (method === 'process.prepare') return processes.prepare(raw)
    if (method === 'process.start') return processes.start(idRequest.parse(raw).id, signal)
    if (method === 'process.done') return processes.done(idRequest.parse(raw).id)
    if (method === 'process.wait') return processes.wait(idRequest.parse(raw).id, signal)
    if (method === 'process.terminate') { await processes.terminate(idRequest.parse(raw).id); return null }
    if (method === 'terminal.write' || method === 'terminal.inspect' || method === 'terminal.signal') {
      const input = z.object({ id: z.string().uuid(), value: z.string().optional() }).strict().parse(raw)
      return processes.terminal(input.id, method === 'terminal.write' ? 'write' : method === 'terminal.inspect' ? 'inspect' : 'signal', input.value)
    }
    if (method === 'executable') {
      const input = z.object({ command: z.string(), env: environmentSchema.optional() }).strict().parse(raw)
      const env = input.env === undefined ? undefined : Object.fromEntries(
        Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== null),
      )
      return ctx.subprocess.resolveExecutable(input.command, env, signal)
    }
    if (method === 'sandbox') {
      const input = z.object({ argv: z.array(z.string()).min(1), policy: policySchema }).strict().parse(raw)
      const resolved = await policy(input.policy)
      if (resolved.mode === 'danger-full-access') throw new Error('Unconfined argv does not need a sandbox wrapper')
      return ctx.sandbox.confine(input.argv, resolved as SandboxPolicy)
    }
    if (method === 'fs.resolve' || method === 'fs.lstat') {
      const input = z.object({ path: z.string(), cwd: remotePath.optional() }).strict().parse(raw)
      return method === 'fs.resolve' ? ctx.fs.resolve(input.path, { cwd: input.cwd ?? process.cwd(), signal }) : await ctx.fs.lstat(input.path, { cwd: input.cwd ?? process.cwd() }, signal) ?? null
    }
    if (method === 'fs.stat' || method === 'fs.list' || method === 'fs.readText' || method === 'fs.stream') {
      const target = asTarget(z.object({ target: targetSchema }).strict().parse(raw).target)
      if (method === 'fs.stat') return await ctx.fs.stat(target, signal) ?? null
      if (method === 'fs.list') return ctx.fs.listDir(target, signal)
      const stream = await ctx.fs.streamText(target, signal)
      if (method === 'fs.stream') {
        const { randomUUID } = await import('node:crypto')
        const id = randomUUID()
        if (iterators.size >= 128) throw new Error('SSH text stream limit reached')
        iterators.set(id, stream[Symbol.asyncIterator]())
        return id
      }
      let text = ''
      let bytes = 0
      for await (const chunk of stream) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_TEXT_BYTES) throw new FsError('SSH whole-text transfer exceeds its bounded frame budget; use streaming', 'FS_TOO_LARGE')
        text += chunk
      }
      return text
    }
    if (method === 'fs.next' || method === 'fs.streamClose') {
      const { id } = idRequest.parse(raw)
      const iterator = iterators.get(id)
      if (iterator === undefined) throw new Error('Unknown SSH text stream')
      if (method === 'fs.streamClose') { iterators.delete(id); await iterator.return?.(); return null }
      const next = await iterator.next()
      if (next.done) iterators.delete(id)
      return { done: next.done ?? false, value: next.value ?? '' }
    }
    if (method === 'fs.readBytes' || method === 'fs.readRange') {
      const input = z.object({
        target: targetSchema, maxBytes: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional(),
      }).strict().parse(raw)
      const target = asTarget(input.target)
      const bytes = method === 'fs.readBytes'
        ? await ctx.fs.readBytes(target, signal, Math.min(z.number().int().nonnegative().parse(input.maxBytes), MAX_TEXT_BYTES))
        : await ctx.fs.readByteRange(target, {
          offset: z.number().int().nonnegative().parse(input.offset),
          length: z.number().int().nonnegative().max(MAX_TEXT_BYTES).parse(input.length),
        }, signal)
      return Buffer.from(bytes).toString('base64')
    }
    if (method === 'fs.write' || method === 'fs.edit') {
      const input = z.object({
        target: targetSchema, content: z.string().optional(), edit: editSchema.optional(),
        expected: z.union([intentSchema, z.object({ version: z.string() }).strict()]).optional(), policy: policySchema,
      }).strict().parse(raw)
      const target = asTarget(input.target)
      const resolved = await policy(input.policy)
      if (method === 'fs.write') return ctx.fs.writeText(
        target, z.string().parse(input.content),
        input.expected === undefined ? undefined : intentSchema.parse(input.expected) as FsWriteIntent, signal, resolved,
      )
      return ctx.fs.editText(
        target, editSchema.parse(input.edit) as FsEditRequest,
        input.expected === undefined
          ? undefined : z.object({ version: z.string() }).strict().parse(input.expected) as { version: FsVersion },
        signal, resolved,
      )
    }
    throw new Error(`Unknown SSH helper operation: ${method}`)
  })
  peer.once('closed', () => { void close().catch(() => { process.exitCode = 1 }) })
  const onSignal = (): void => { peer.close(new Error('SSH helper transport was terminated')) }
  process.once('SIGTERM', onSignal)
  process.once('SIGHUP', onSignal)
  process.once('SIGINT', onSignal)
  touchLease()
  try {
    await new Promise<void>((resolve) => { peer.once('closed', () => { resolve() }) })
    await close()
  } finally {
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
    process.off('SIGINT', onSignal)
  }
}

async function confine(): Promise<void> {
  const runtime = await services()
  try {
    const request = z.object({
      policy: policySchema, runner: z.string(), enforcement: z.enum(['full', 'partial']), denialSignatures: z.array(z.string()),
    }).strict().parse(JSON.parse(process.argv[3] ?? ''))
    const { policy } = request
    if (policy.mode === 'danger-full-access' || process.argv[4] !== '--') throw new Error('Invalid remote sandbox invocation')
    const workspaceRoot = runtime.ctx.fs.processPath(await runtime.ctx.fs.resolve(policy.workspaceRoot))
    const wrapped = runtime.ctx.sandbox.confine(process.argv.slice(5), { ...policy, workspaceRoot } as SandboxPolicy)
    if (wrapped.argv[0] !== request.runner || wrapped.enforcement !== request.enforcement
      || JSON.stringify(wrapped.denialSignatures) !== JSON.stringify(request.denialSignatures)) {
      throw new Error('Remote sandbox backend changed; this connection cannot attest the requested confinement')
    }
    const control = process.env.DSH_SUBPROCESS_CONTROL === 'pipe'
    const result = spawnSync(wrapped.argv[0] as string, wrapped.argv.slice(1), {
      stdio: control ? ['inherit', 'inherit', 'inherit', 'ignore', 'ignore', 'ignore', 'ignore', 7] : 'inherit',
      env: process.env,
    })
    if (result.error !== undefined) throw result.error
    process.exitCode = result.status ?? 128
  } finally { await runtime.close() }
}

if (import.meta.main) {
  void (process.argv[2] === '--confine' ? confine() : runSshHelper()).catch((error) => {
    process.stderr.write(`dsh-ssh-sandbox: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 127
  })
}
