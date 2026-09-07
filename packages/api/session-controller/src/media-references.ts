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
 * - its extension must name an allowlisted media type (media bytes are never
 *   sniffed here: the allowlist keeps non-media content out, and browsers
 *   already reject corrupt image payloads);
 * - responses are private, uncached, sniff-proof, and support HTTP range
 *   requests so `<video>`/`<audio>` can seek without buffering the file.
 *
 * The route is deliberately presentational: it never writes and follows no
 * redirects, returning 400/403/404/415/416 instead of falling back to any
 * other file-serving behavior.
 *
 * The package entry imports only `SessionMediaReferences`; the remaining
 * module exports exist for same-package unit tests and are not part of the
 * package's public API.
 * @module @deepseek-ai/dsh-api-session-controller/media-references
 */

import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
// Cordis `ctx.connection` typing and the fetch-route contract.
import type {} from '@deepseek-ai/dsh-client-connection'
// Cordis `ctx.workspaceRegistry` typing.
import type {} from '@deepseek-ai/dsh-workspace'

/** Registered-workspace view the route reads; see the `workspaceRegistry` service. */
export interface MediaReferenceRegistry {
  /** List registered workspaces with their canonical root directories. */
  list(): readonly { path: string }[]
}

/** Media extensions the route serves, mapped to their content types. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
}

/**
 * The content type a file path may be served as, or undefined when the
 * extension is not an allowlisted media type.
 * @param path - Canonical file path (extension only is read).
 * @returns the content type, or undefined to refuse the file.
 */
export function mediaTypeForPath(path: string): string | undefined {
  return MEDIA_TYPES[extname(path).toLowerCase()]
}

/** One resolved byte-range within a file; `full` streams the whole file. */
type ByteRange =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly start: number; readonly end: number }

/**
 * Parse one single-range `Range` header value against the file size.
 * @param header - Raw `Range` request header, or null when absent.
 * @param size - Total file size in bytes.
 * @returns the byte range to serve, or undefined when the header names no
 * satisfiable single range (the caller answers 416 with a `bytes *\/size`
 * Content-Range header).
 */
export function parseByteRange(header: string | null, size: number): ByteRange | undefined {
  if (header === null) return { kind: 'full' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return undefined
  const startText = match[1]
  const endText = match[2]
  if (startText === '' && endText === '') return undefined
  let start: number
  let end: number
  if (startText === '') {
    // Suffix range: the last N bytes.
    const length = Number(endText)
    if (length === 0) return undefined
    start = Math.max(size - length, 0)
    end = size - 1
  } else {
    start = Number(startText)
    end = endText === '' ? size - 1 : Number(endText)
  }
  if (start > end || start >= size) return undefined
  return { kind: 'partial', start, end: Math.min(end, size - 1) }
}

/**
 * Serve one workspace-contained media file over the shared API channel.
 * @param request - Authenticated fetch-route request (GET or HEAD).
 * @param registry - Workspace registry; absent (or empty) denies everything.
 * @returns A streaming media response or a fail-closed status.
 */
export async function serveMediaReference(
  request: Request,
  registry: MediaReferenceRegistry | undefined,
): Promise<Response> {
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return new Response('missing path', { status: 400 })
  if (path.includes('\0') || !isAbsolute(path)) {
    return new Response('absolute path required', { status: 400 })
  }
  if (registry === undefined) return new Response('file serving is unavailable', { status: 403 })
  let canonical: string
  try {
    canonical = await realpath(path)
  } catch {
    return new Response('not found', { status: 404 })
  }
  const insideWorkspace = registry.list().some(root =>
    canonical === root.path || canonical.startsWith(root.path + sep))
  if (!insideWorkspace) return new Response('outside workspace roots', { status: 403 })
  let info
  try {
    info = await stat(canonical)
  } catch {
    return new Response('not found', { status: 404 })
  }
  if (!info.isFile()) return new Response('not a regular file', { status: 403 })
  const mediaType = mediaTypeForPath(canonical)
  if (mediaType === undefined) {
    return new Response('not an allowlisted media type', { status: 415 })
  }
  const range = parseByteRange(request.headers.get('range'), info.size)
  if (range === undefined) {
    const headers: Record<string, string> = {
      'Content-Range': 'bytes */' + String(info.size),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    }
    return new Response(null, { status: 416, headers })
  }
  const partial = range.kind === 'partial'
  const start = partial ? range.start : 0
  const end = partial ? range.end : info.size - 1
  const body: ReadableStream<Uint8Array> = Readable.toWeb(
    createReadStream(canonical, { start, end }),
  ) as ReadableStream<Uint8Array>
  const headers: Record<string, string> = {
    'Content-Type': mediaType,
    'Content-Length': String(partial ? end - start + 1 : info.size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (partial) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + String(info.size)
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
      fetch: request => serveMediaReference(request, ctx.workspaceRegistry),
    }), 'session-controller: /api/file')
  },
}
