/** Raw Fetch file intake used by the browser background-upload carrier. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { SESSION_FILE_UPLOAD_PATH } from './file-upload-path.ts'
import type { SessionUploadFileValue } from './types.ts'
import type { SessionCommandController } from './commands.ts'

interface FileUploadConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ['POST']
      readonly requestBody: 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

type FileUploadResult =
  | { readonly ok: true; readonly value: SessionUploadFileValue }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

/**
 * Install the authenticated raw-byte route on Connection's shared Fetch registry.
 * @param ctx - Host context that provides Connection.
 * @param commands - Session command owner that validates and stages stored bytes.
 */
export function registerSessionFileUploadHttp(ctx: Context, commands: SessionCommandController): void {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection') as FileUploadConnection
    connection.fetch.register({
      path: SESSION_FILE_UPLOAD_PATH,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: request => handleSessionFileUploadHttp(commands, request),
    })
  })
}

/**
 * Handle one authenticated raw-byte upload after the physical carrier applies
 * its trust policy.
 * @param commands - Session command owner that validates and stages stored bytes.
 * @param request - Fetch request carrying the raw file body.
 * @returns JSON receipt or a precise validation response.
 */
export async function handleSessionFileUploadHttp(
  commands: SessionCommandController,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/octet-stream') {
    return new Response('content type must be application/octet-stream', { status: 415 })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('sessionId is required', { status: 400 })
  }
  const name = url.searchParams.get('name') ?? undefined
  let result: FileUploadResult
  try {
    result = {
      ok: true,
      value: await commands.uploadFileStream({
        sessionId: SessionId(sessionId),
        data: requestBodyChunks(request.body),
        signal: request.signal,
        ...(name === undefined ? {} : { name }),
      }),
    }
  } catch (error) {
    const failure = remoteErrorOf(error)
    result = {
      ok: false,
      error: failure !== undefined
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
    }
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function* requestBodyChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}
