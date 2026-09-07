/**
 * Pure local-path → same-origin workspace-file mapping for closing prose. The
 * renderer seam consumes this vocabulary; the served endpoint re-validates
 * every request, so this side only decides whether a destination *looks*
 * like an absolute local path the Host could serve. One endpoint covers every
 * served media type (images today; video/audio the same way), so consumers
 * rewrite the path without knowing what kind of media it names.
 */

/**
 * Map one authored media destination to the same-origin workspace-file URL.
 * @param protocol - `window.location.protocol` at render time.
 * @param origin - `window.location.origin` at render time.
 * @param value - The authored markdown destination, exactly as written.
 * @returns The API URL for an absolute POSIX path on an HTTP(S) page, or
 * undefined when the destination cannot be a Host-served local file
 * (non-HTTP transport such as Electron `file://`, protocol-relative or
 * relative destinations).
 */
export function localPathMediaUrl(protocol: string, origin: string, value: string): string | undefined {
  if (protocol !== 'http:' && protocol !== 'https:') return undefined
  if (value.length === 0 || !value.startsWith('/') || value.startsWith('//')) return undefined
  return `${origin}/api/file?path=${encodeURIComponent(value)}`
}
