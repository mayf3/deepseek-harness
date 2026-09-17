/** Static HTML preview with no scripts, network resources, forms or nested frames. */
import { decodeText } from './bytes.ts'

/**
 * Prepare static content before the browser can load any document resources.
 * @param data - complete UTF-8 HTML bytes.
 * @returns document with the restrictive CSP first in its head.
 */
export function createBasicHtmlDocument(data: Uint8Array<ArrayBuffer>): string {
  const parsed = new DOMParser().parseFromString(decodeText(data), 'text/html')
  const sanitize = (root: Document | DocumentFragment): void => {
    for (const element of root.querySelectorAll('script, noscript, base, link, meta[http-equiv], iframe, frame, object, embed, set, animate, animateMotion, animateTransform')) {
      element.remove()
    }
    for (const link of root.querySelectorAll('a, area')) {
      link.removeAttribute('href')
      link.removeAttribute('xlink:href')
    }
    for (const template of root.querySelectorAll('template')) sanitize(template.content)
  }
  sanitize(parsed)
  const policy = document.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'")
  parsed.head.prepend(policy)
  return `<!doctype html>${parsed.documentElement.outerHTML}`
}
