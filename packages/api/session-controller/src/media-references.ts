/**
 * GET/HEAD /api/file — same-origin media bytes for a local path authored in
 * conversation prose. Browsers cannot read Host files, so local media
 * destinations (images today; video/audio the same way) are rewritten to this
 * one route; the route re-validates every request because the rewrite itself
 * proves nothing.
 *
 * Policy (enforced per request, fail-closed):
 * - the requested path must be one absolute filesystem path;
 * - its canonical location must lie inside a registered workspace root
 *   (`ctx.workspaceRegistry`); no other directory is readable;
 * - its MIME type (resolved by `mime-types`) must belong to the served
 *   categories image/video/audio, excluding `image/svg+xml`; media bytes are
 *   never sniffed here, and a corrupt payload fails in the browser;
 * - the file must exist and be a regular file (checked before opening, so a
 *   named pipe or device node is refused instead of blocking the open);
 *   reading binds to the opened file, and comparing its stat identity with
 *   the pre-open stat narrows (does not fully close) a concurrent
 *   replacement window;
 * - multi-range requests are answered with the full 200 body (no Range is
 *   honored) rather than a mislabeled single-segment 206;
 * - responses are private, uncached, sniff-proof, and stream with HTTP range
 *   support (parsed by `range-parser`) so `<video>`/`<audio>` can seek; the
 *   file stream is destroyed when the client aborts, and HEAD never opens
 *   one.
 *
 * The route is deliberately presentational: it never writes and follows no
 * redirects, returning 400/403/404/415/416 instead of falling back to any
 * other file-serving behavior.
 *
 * Only the plugin contribution below is exported: package-internal policy
 * helpers stay module-private and are exercised through the registered route.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import { Readable, addAbortSignal } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
// Cordis `ctx.connection` typing and the fetch-route contract.
import type {} from '@deepseek-ai/dsh-client-connection'
// Cordis `ctx.workspaceRegistry` typing.
import type {} from '@deepseek-ai/dsh-workspace'
import mime from 'mime-types'
import rangeParser from 'range-parser'

/** MIME categories this route serves; `image/svg+xml` is refused separately because SVG can carry script. */
const SERVED_MEDIA_TYPE = /^(?:image|video|audio)\//
/** Headers every response carries: private, uncached, sniff-proof. */
const BASE_HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }

/**
 * Serve one workspace-contained media file over the shared API channel.
 * @param request - Authenticated fetch-route request (GET or HEAD).
 * @param roots - Registered workspace root directories.
 * @returns A streaming media response or a fail-closed status.
 */
async function serveMediaReference(
  request: Request,
  roots: readonly { path: string }[],
): Promise<Response> {
  // Error responses carry a text body for GET debugging; HEAD responses must
  // never carry one.
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status })
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) {
    return fail(400, 'absolute path required')
  }
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch {
    return fail(404, 'not found')
  }
  // Containment compares path components; a filesystem root already ends in
  // the separator and prefixes every absolute path.
  const contained = roots.some(({ path: root }) =>
    canonical === root || canonical.startsWith(root.endsWith(sep) ? root : root + sep))
  if (!contained) return fail(403, 'outside workspace roots')
  const mediaType = mime.lookup(canonical)
  if (mediaType === false || mediaType === 'image/svg+xml' || !SERVED_MEDIA_TYPE.test(mediaType)) {
    return fail(415, 'not an allowlisted media type')
  }
  // Open only after proving the validated path is a regular file: opening a
  // FIFO or device node first would block or read unbounded data.
  let before
  try {
    before = await stat(canonical)
  } catch {
    /* v8 ignore next 1 -- the path cannot vanish between the realpath above and this stat except in a concurrent deletion race */
    return fail(404, 'not found')
  }
  if (!before.isFile()) return fail(403, 'not a regular file')
  let handle
  try {
    handle = await open(canonical, 'r')
  } catch {
    return fail(404, 'not found')
  }
  let streamed = false
  try {
    const after = await handle.stat()
    /* v8 ignore next 1 -- only a concurrent replacement could make the opened file non-regular after the pre-open check */
    if (!after.isFile()) return fail(403, 'not a regular file')
    // The opened handle's identity must match the validated stat; this only
    // narrows a replacement race between the stat and the open, it does not
    // eliminate the earlier realpath-to-stat window.
    /* v8 ignore next 2 -- the replacement race cannot be produced deterministically; this arm refuses it when it happens */
    if (after.dev !== before.dev || after.ino !== before.ino) {
      return fail(403, 'file changed during validation')
    }
    const total = after.size
    const rangeHeader = request.headers.get('range')?.trim() ?? null
    // range-parser never validates the range unit, so only a `bytes` header is
    // parsed here; malformed, unknown-unit, and multi-range headers are ignored
    // per RFC 9110 and get the full 200 body below.
    const ranges = rangeHeader !== null && rangeHeader.toLowerCase().startsWith('bytes=')
      ? rangeParser(total, rangeHeader)
      : undefined
    if (ranges === -1) {
      // Only an unsatisfiable range answers 416 with the total size. Malformed
      // (-2) and unknown-unit or multi-range headers are ignored per RFC 9110
      // and get the full 200 body below.
      const headers = { ...BASE_HEADERS, 'Content-Range': `bytes */${total}` }
      return new Response(null, { status: 416, headers })
    }
    // Only a single range is honored; a multi-range header gets the full body.
    const slice = Array.isArray(ranges) && ranges.length === 1 ? ranges[0] : undefined
    const { start, end } = slice ?? { start: 0, end: total - 1 }
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mediaType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    }
    if (slice !== undefined) headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    const status = slice === undefined ? 200 : 206
    // HEAD never opens a stream; an already-aborted client cannot receive a
    // body either, and the handle closes through the finally below.
    if (request.method === 'HEAD' || request.signal.aborted) {
      return new Response(null, { status, headers })
    }
    streamed = true
    // Bound the full-body stream to the stat'ed size so concurrent appends
    // cannot push the payload past the declared Content-Length.
    const stream = handle.createReadStream(slice ?? { start: 0, end: total - 1 })
    const source = addAbortSignal(request.signal, stream)
    return new Response(Readable.toWeb(source) as ReadableStream<Uint8Array>, { status, headers })
  } finally {
    if (!streamed) await handle.close()
  }
}

/**
 * `/api/file` fetch-route contribution, the media counterpart of
 * `SessionFileReferences`: that contribution lets the GUI discover the files
 * a Session references, this one lets it display referenced local media
 * paths as same-origin bytes. Declared injects gate activation: a host
 * composition without a connection service (or a workspace registry) never
 * activates this plugin, so the route simply does not exist there — the same
 * pending-until-composed posture the package's other optional contributions
 * use. The channel's trust fence and browser authentication apply before any
 * request reaches the handler.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'workspaceRegistry'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => serveMediaReference(request, ctx.workspaceRegistry.list()),
    }), 'session-controller: /api/file')
  },
}
