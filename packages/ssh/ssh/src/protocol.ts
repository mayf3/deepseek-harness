/** Bounded, versioned requests between an SSH client and its private remote helper. */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'

/** Wire version shared by the installed helper and client package. */
export const SSH_PROTOCOL_VERSION = 1

const errorSchema = z.object({ name: z.string(), message: z.string(), code: z.string().optional() }).strict()
const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), id: z.string(), method: z.string(), params: z.unknown() }).strict(),
  z.object({ type: z.literal('result'), id: z.string(), value: z.unknown() }).strict(),
  z.object({ type: z.literal('error'), id: z.string(), error: errorSchema }).strict(),
  z.object({ type: z.literal('cancel'), id: z.string() }).strict(),
])
type Frame = z.infer<typeof frameSchema>
type RequestHandler = (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>

/** A remote error retains its typed filesystem or sandbox code. */
export class RemoteOperationError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'RemoteOperationError'
  }
}

/** The peer owns pending calls and rejects ambiguous operations on connection loss; it never replays requests. */
export class SshRpcPeer extends EventEmitter {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  private readonly active = new Map<string, AbortController>()
  private writeTail = Promise.resolve()
  private queuedBytes = 0
  private failure: Error | undefined

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly maxFrameBytes: number,
    private readonly maxPending: number,
    private readonly handler?: RequestHandler,
  ) {
    super()
    input.on('error', (error) => { this.close(error) })
    output.on('error', (error) => { this.close(error) })
    output.on('close', () => { this.close() })
    void this.readFrames().catch((error) => { this.close(error instanceof Error ? error : new Error(String(error))) })
  }

  /**
   * Send one request and validate its response before exposing it to the caller.
   * @param method - the private helper operation.
   * @param params - JSON request fields.
   * @param schema - validation for the remote response.
   * @param signal - cancellation without rollback of remote effects.
   * @returns the validated response or a transport/remote-operation rejection.
   */
  async request<T>(method: string, params: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (this.failure !== undefined) throw this.failure
    if (this.pending.size >= this.maxPending) throw new Error('SSH helper pending request limit reached')
    const id = randomUUID()
    const result = Promise.withResolvers<unknown>()
    void result.promise.catch(() => {})
    this.pending.set(id, result)
    const abort = (): void => {
      this.pending.delete(id)
      result.reject(new Error('SSH operation cancelled; a completed remote mutation is not rolled back'))
      void this.send({ type: 'cancel', id }).catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      void this.send({ type: 'request', id, method, params }).catch((error: unknown) => {
        result.reject(error instanceof Error ? error : new Error(String(error)))
      })
      return schema.parse(await result.promise)
    } finally {
      this.pending.delete(id)
      signal?.removeEventListener('abort', abort)
    }
  }

  /**
   * Fail pending operations and abort remote handlers without claiming rollback.
   * @param error - the transport failure reported to all pending operations.
   */
  close(error = new Error('SSH connection lost; remote operation outcome and cleanup are unknown')): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    for (const controller of this.active.values()) controller.abort(error)
    this.active.clear()
    this.input.destroy()
    this.output.destroy()
    this.emit('closed', error)
  }

  private send(frame: Frame): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const body = Buffer.from(JSON.stringify(frame))
    if (body.length > this.maxFrameBytes || this.queuedBytes + body.length + 4 > this.maxFrameBytes * 2) {
      return Promise.reject(new Error('SSH helper frame or write queue limit exceeded'))
    }
    const header = Buffer.alloc(4)
    header.writeUInt32BE(body.length)
    const bytes = Buffer.concat([header, body])
    this.queuedBytes += bytes.length
    const write = this.writeTail.then(async () => {
      if (this.failure !== undefined) throw this.failure
      if (!this.output.write(bytes)) await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          this.output.off('drain', drained)
          this.off('closed', closed)
        }
        const drained = (): void => { cleanup(); resolve() }
        const closed = (error: Error): void => { cleanup(); reject(error) }
        this.output.once('drain', drained)
        this.once('closed', closed)
        if (this.failure !== undefined) closed(this.failure)
      })
    })
    this.writeTail = write.catch((error) => { this.close(error instanceof Error ? error : new Error(String(error))) })
    return write.finally(() => { this.queuedBytes -= bytes.length })
  }

  private async readFrames(): Promise<void> {
    const header = Buffer.alloc(4)
    let headerBytes = 0
    let payload: Buffer | undefined
    let payloadBytes = 0
    for await (const raw of this.input) {
      const chunk: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
      let offset = 0
      while (offset < chunk.length) {
        if (payload === undefined) {
          const count = Math.min(4 - headerBytes, chunk.length - offset)
          chunk.copy(header, headerBytes, offset, offset + count)
          headerBytes += count
          offset += count
          if (headerBytes < 4) continue
          const size = header.readUInt32BE(0)
          if (size === 0 || size > this.maxFrameBytes) throw new Error('SSH helper sent an invalid frame length')
          payload = Buffer.alloc(size)
          payloadBytes = 0
        }
        const count = Math.min(payload.length - payloadBytes, chunk.length - offset)
        chunk.copy(payload, payloadBytes, offset, offset + count)
        payloadBytes += count
        offset += count
        if (payloadBytes === payload.length) {
          const frame = frameSchema.parse(JSON.parse(payload.toString('utf8')))
          payload = undefined
          headerBytes = 0
          this.receive(frame)
        }
      }
    }
    throw new Error(headerBytes > 0 || payload !== undefined ? 'SSH helper disconnected during a frame; outcome is unknown' : 'SSH helper disconnected; outcome is unknown')
  }

  private receive(frame: Frame): void {
    if (frame.type === 'result' || frame.type === 'error') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return // A cancelled request can still complete remotely.
      this.pending.delete(frame.id)
      if (frame.type === 'result') pending.resolve(frame.value)
      else pending.reject(new RemoteOperationError(frame.error.message, frame.error.code))
      return
    }
    if (frame.type === 'cancel') {
      this.active.get(frame.id)?.abort(new Error('SSH caller cancelled the operation'))
      return
    }
    if (this.handler === undefined || this.active.has(frame.id) || this.active.size >= this.maxPending) {
      throw new Error('SSH helper received an unexpected or excessive request')
    }
    const controller = new AbortController()
    this.active.set(frame.id, controller)
    void this.handler(frame.method, frame.params, controller.signal).then(
      value => this.send({ type: 'result', id: frame.id, value: value ?? null }),
      (error: unknown) => {
        const detail = error instanceof Error ? error : new Error(String(error))
        const code = 'code' in detail && typeof detail.code === 'string' ? detail.code : undefined
        return this.send({ type: 'error', id: frame.id, error: {
          name: detail.name, message: detail.message, ...(code === undefined ? {} : { code }),
        } })
      },
    ).catch((error) => { this.close(error instanceof Error ? error : new Error(String(error))) })
      .finally(() => { this.active.delete(frame.id) })
  }
}
