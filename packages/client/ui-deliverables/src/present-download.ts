/** Authorize downloads against the Session log, then stream only the saved Presented file bytes. */
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { isPresentedData, isPresentedFile, PRESENT_DOWNLOAD_PATH } from './presented.ts'
import type {} from '@deepseek-ai/dsh-session-query'

/**
 * Register a streaming download inside Connection's existing authentication fence.
 * @param ctx - Host services owning Session reads, attachments, and HTTP routing.
 */
export function registerPresentDownload(ctx: Context): void {
  ctx.connection.fetch.register({
    path: PRESENT_DOWNLOAD_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => download(ctx, request),
  })
}

async function download(ctx: Context, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const id = query.get('sessionId')
  const seq = query.get('seq')
  const index = query.get('index')
  if (!id || seq === null || index === null || !/^\d+$/.test(seq) || !/^\d+$/.test(index)
    || !Number.isSafeInteger(Number(seq)) || !Number.isSafeInteger(Number(index))) {
    return new Response('Invalid Presented file coordinates.', { status: 400 })
  }
  try {
    const { target } = await ctx.sessionQuery.readEvent({
      sessionId: id as SessionId, seq: Number(seq) as SessionSeq, before: 0, after: 0,
    }, request.signal)
    const artifact = target.type === 'deliverables/presented' && isPresentedData(target.data) ? target.data.files[Number(index)] : undefined
    if (!isPresentedFile(artifact)) return new Response('Presented file not found in this Session result.', { status: 404 })
    const filename = encodeURIComponent(artifact.name.toWellFormed())
      .replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    const iterator = ctx.attachments.readFileStream(artifact, request.signal)[Symbol.asyncIterator]()
    // Open before sending headers so an absent snapshot is a 404, not an empty successful download.
    let first: IteratorResult<Uint8Array> | undefined = await iterator.next()
    const data: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]() { return this },
      next() {
        const pending = first
        first = undefined
        return pending === undefined ? iterator.next() : Promise.resolve(pending)
      },
      async return() {
        await iterator.return?.()
        return { done: true, value: undefined }
      },
    }
    const body = Readable.toWeb(Readable.from(data, { signal: request.signal })) as ReadableStream<Uint8Array>
    return new Response(body, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${filename}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    const missing = error instanceof Error && 'code' in error
      && (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error.code === 'SESSION_QUERY_EVENT_NOT_FOUND')
    const absentSnapshot = ctx.attachments.isAttachmentError(error) && error.code === 'ATTACHMENT_NOT_FOUND'
    const status = missing || absentSnapshot ? 404 : 500
    return new Response('Presented file snapshot unavailable.', { status })
  }
}
