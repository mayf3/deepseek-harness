/** Authorize delivery actions against the Session log, using only saved attachment bytes. */
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { isPresentedData, isPresentedFile, PRESENT_DOWNLOAD_PATH, PRESENT_OPEN_PATH } from './presented.ts'
import { createPresentedOpener } from './present-open.ts'
import type {} from '@deepseek-ai/dsh-session-query'

/**
 * Register snapshot downloads and native opening inside Connection's authentication fence.
 * @param ctx - Host services owning Session reads, attachments, and HTTP routing.
 */
export function registerPresentDownload(ctx: Context): void {
  const open = createPresentedOpener(ctx)
  ctx.connection.fetch.register({
    path: PRESENT_DOWNLOAD_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => handleDelivery(ctx, request),
  })
  ctx.connection.fetch.register({
    path: PRESENT_OPEN_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleDelivery(ctx, request, open),
  })
}

async function handleDelivery(ctx: Context, request: Request, open?: ReturnType<typeof createPresentedOpener>): Promise<Response> {
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
    if (open !== undefined) {
      await open(artifact, request.signal)
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    }
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
