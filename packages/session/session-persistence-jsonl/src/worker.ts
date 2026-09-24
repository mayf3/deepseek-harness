/** Worker entry for current-generation physical and logical verification. */

import { parentPort, workerData } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { verifyJsonlCurrentGeneration } from './generation.ts'
import type { JsonlExpectedPrefix } from './generation.ts'
import type { JsonlCompression } from './format.ts'

interface VerificationRequest {
  readonly path: string
  readonly compression: JsonlCompression
  readonly expectedId: string
  readonly expectedEventCount: number
  readonly expectedPrefix?: JsonlExpectedPrefix
}

function parseRequest(value: unknown): VerificationRequest {
  if (typeof value !== 'object' || value === null) throw new Error('migration verifier request must be an object')
  const request = value as Partial<VerificationRequest>
  if (typeof request.path !== 'string'
    || request.compression !== 'none' && request.compression !== 'zstd'
    || typeof request.expectedId !== 'string'
    || !Number.isSafeInteger(request.expectedEventCount)
    || (request.expectedEventCount as number) < 0
    || request.expectedPrefix !== undefined
      && (!Number.isSafeInteger(request.expectedPrefix.bytes)
        || request.expectedPrefix.bytes < 0
        || !/^[0-9a-f]{64}$/.test(request.expectedPrefix.digest))) {
    throw new Error('migration verifier request is malformed')
  }
  return request as VerificationRequest
}

async function verify(request: VerificationRequest, port: Pick<MessagePort, 'postMessage' | 'close'>): Promise<void> {
  try {
    const result = await verifyJsonlCurrentGeneration(
      request.path,
      request.compression,
      request.expectedId,
      request.expectedEventCount,
      request.expectedPrefix,
    )
    port.postMessage({ ok: true, result })
  } catch (error: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error))
    port.postMessage({ ok: false, message: failure.message, stack: failure.stack })
  } finally {
    port.close()
  }
}

if (parentPort !== null) {
  void verify(parseRequest(workerData), parentPort)
} else {
  const send = process.send?.bind(process)
  if (send === undefined) throw new Error('migration verifier requires a parent port or IPC channel')
  process.once('message', (value: unknown) => {
    void verify(parseRequest(value), {
      postMessage: (response) => { send(response) },
      close: () => { process.disconnect() },
    })
  })
}
