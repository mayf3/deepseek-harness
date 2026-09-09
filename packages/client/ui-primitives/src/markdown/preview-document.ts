/** Static preview documents: opaque sandbox frames with no scripts, navigation, or remote resources. */

import DOMPurify from 'dompurify'

// This policy belongs to the preview document, before any source-controlled markup.
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

function documentOf(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body>${body}</body></html>`
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
 * Prepare an SVG image inside an isolated document, without activating SVG scripts or links.
 * @param code - Complete SVG XML; malformed XML or a non-SVG root throws.
 * @param signal - Prevents preparation after the preview owner is cancelled.
 * @returns A srcdoc document containing a responsive inert SVG image.
 */
export function renderSvg(code: string, signal: AbortSignal): string {
  signal.throwIfAborted()
  const parsed = new DOMParser().parseFromString(code, 'image/svg+xml')
  if (parsed.querySelector('parsererror') !== null || parsed.documentElement.localName !== 'svg'
    || parsed.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg') {
    throw new Error('Invalid SVG document')
  }
  // Double-quoted attributes keep encodeURIComponent's literal apostrophes inert.
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`
  return documentOf(`<img style="display:block;max-width:100%;height:auto;margin:auto" src="${url}" alt="">`)
}
