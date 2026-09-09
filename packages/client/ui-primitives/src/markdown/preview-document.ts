/** Static HTML documents and SVG image URLs without executable source markup. */

import DOMPurify from 'dompurify'
import { readPreviewTheme } from './preview-theme.ts'

// This policy belongs to the preview document, before any source-controlled markup.
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

function documentOf(body: string): string {
  const scheme = readPreviewTheme().dark ? 'dark' : 'light'
  return `<!doctype html><html style="color-scheme:${scheme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body>${body}</body></html>`
}

/**
 * Prepare static HTML for an iframe without scripts, same-origin access, or navigation.
 * @param code - Untrusted HTML document or fragment; inline styles and embedded images are retained.
 * @param signal - Prevents preparation after the preview owner is cancelled.
 * @returns A sanitized srcdoc document. Copying uses the original source, not this document.
 */
export function renderHtml(code: string, signal: AbortSignal): string {
  signal.throwIfAborted()
  const body = DOMPurify.sanitize(code, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link'],
    FORBID_ATTR: ['href', 'xlink:href', 'action', 'formaction', 'target'],
  })
  return documentOf(body)
}

/**
 * Prepare an SVG image URL without activating SVG scripts, links, or external resources.
 * @param code - Complete SVG XML; malformed XML or a non-SVG root throws.
 * @param signal - Prevents preparation after the preview owner is cancelled.
 * @returns A data URL for an image whose intrinsic dimensions determine the preview height.
 */
export function renderSvg(code: string, signal: AbortSignal): string {
  signal.throwIfAborted()
  const parsed = new DOMParser().parseFromString(code, 'image/svg+xml')
  if (parsed.querySelector('parsererror') !== null || parsed.documentElement.localName !== 'svg'
    || parsed.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg') {
    throw new Error('Invalid SVG document')
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`
}
