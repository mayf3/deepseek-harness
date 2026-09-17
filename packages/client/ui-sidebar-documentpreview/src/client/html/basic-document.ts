/** Static HTML preview with no scripts, network resources, forms or nested frames. */
import { decodeText } from './bytes.ts'

/**
 * Prepare static content before the browser can load any document resources.
 * @param data - complete UTF-8 HTML bytes.
 * @returns document with the restrictive CSP first in its head.
 */
export function createBasicHtmlDocument(data: Uint8Array<ArrayBuffer>): string {
  const template = document.createElement('template')
  template.innerHTML = decodeText(data)
  for (const element of template.content.querySelectorAll('script, base, meta[http-equiv], iframe, frame, object, embed')) {
    element.remove()
  }
  for (const link of template.content.querySelectorAll('a, area')) {
    link.removeAttribute('href')
    link.removeAttribute('xlink:href')
  }
  const policy = document.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'")
  return `<!doctype html>${policy.outerHTML}${template.innerHTML}`
}
