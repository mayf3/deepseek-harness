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
 * - the file must exist and be a regular file;
 * - its MIME type (resolved by `mime-types`) must belong to the served
 *   categories image/video/audio, excluding `image/svg+xml`; media bytes are
 *   never sniffed here, and a corrupt payload fails in the browser;
 * - responses are private, uncached, sniff-proof, and stream with HTTP range
 *   support (parsed by `range-parser`) so `<video>`/`<audio>` can seek.
 *
 * The route is deliberately presentational: it never writes and follows no
 * redirects, returning 400/403/404/415/416 instead of falling back to any
 * other file-serving behavior.
 *
 * Only the plugin contribution below is exported: package-internal policy
 * helpers stay module-private and are exercised through the registered route.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
// Cordis `ctx.connection` typing and the fetch-route contract.
import type {} from '@deepseek-ai/dsh-client-connection'
// Cordis `ctx.workspaceRegistry` typing.
import type {} from '@deepseek-ai/dsh-workspace'
import mime from 'mime-types'
import rangeParser from 'range-parser'

/** Media categories this route serves. */
const MEDIA_CATEGORIES: ReadonlySet<string> = new Set(['image', 'video', 'audio'])
/** Category matches that still must not be served. */
const DENIED_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/svg+xml'])

/**
 * The content type a file path may be served as, or undefined when it is not
 * an allowlisted media type.
 * @param path - Canonical file path (extension only is read).
 * @returns the content type, or undefined to refuse the file.
 */
function mediaTypeForPath(path: string): string | undefined {
  const looked = mime.lookup(path)
  if (looked === false) return undefined
  if (DENIED_MEDIA_TYPES.has(looked)) return undefined
  const category = looked.slice(0, looked.indexOf('/'))
  return MEDIA_CATEGORIES.has(category) ? looked : undefined
}

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
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return new Response('missing path', { status: 400 })
  if (path.includes('\0') || !isAbsolute(path)) {
    return new Response('absolute path required', { status: 400 })
  }
  let canonical: string
  let info
  try {
    canonical = await realpath(path)
    info = await stat(canonical)
  } catch {
    return new Response('not found', { status: 404 })
  }
  const insideWorkspace = roots.some(root =>
    canonical === root.path || canonical.startsWith(root.path + sep))
  if (!insideWorkspace) return new Response('outside workspace roots', { status: 403 })
  if (!info.isFile()) return new Response('not a regular file', { status: 403 })
  const mediaType = mediaTypeForPath(canonical)
  if (mediaType === undefined) {
    return new Response('not an allowlisted media type', { status: 415 })
  }
  const total = info.size
  const rangeHeader = request.headers.get('range')
  let start = 0
  let end = total - 1
  let partial = false
  if (rangeHeader !== null) {
    const parsed = rangeParser(total, rangeHeader)
    // -1 (unsatisfiable) and -2 (malformed) both answer the same terminal
    // way; array results always carry at least one range.
    const first = Array.isArray(parsed) ? parsed[0] : undefined
    if (first === undefined) {
      const headers: Record<string, string> = {
        'Content-Range': 'bytes */' + String(total),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      }
      return new Response(null, { status: 416, headers })
    }
    start = first.start
    end = first.end
    partial = true
  }
  const body: ReadableStream<Uint8Array> = Readable.toWeb(
    createReadStream(canonical, partial ? { start, end } : undefined),
  ) as ReadableStream<Uint8Array>
  const headers: Record<string, string> = {
    'Content-Type': mediaType,
    'Content-Length': String(partial ? end - start + 1 : total),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (partial) {
    headers['Content-Range'] = 'bytes ' + String(start) + '-' + String(end) + '/' + String(total)
  }
  const head = request.method === 'HEAD'
  return new Response(head ? null : body, { status: partial ? 206 : 200, headers })
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
