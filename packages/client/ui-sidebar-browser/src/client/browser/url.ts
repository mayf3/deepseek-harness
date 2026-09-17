/** Address parsing for the Sidebar browser's HTTPS and loopback HTTP allowlist. */

/** Maximum accepted address length; this bounds persisted navigation state. */
export const MAX_BROWSER_URL_LENGTH = 16 * 1024

/** A normalized Browser navigation target. */
export type BrowserTarget =
  | { readonly kind: 'https'; readonly url: string; readonly title: string }
  | { readonly kind: 'http'; readonly url: string; readonly title: string }

/** Why an address was refused before navigation. */
export type BrowserAddressFailure = 'empty' | 'invalid' | 'protocol' | 'credentials' | 'application-origin' | 'loopback'

/** Result of parsing an address-bar value. */
export type BrowserAddressResult =
  | { readonly ok: true; readonly target: BrowserTarget }
  | { readonly ok: false; readonly reason: BrowserAddressFailure }

/**
 * Parse one address-bar value into the fixed protocol allowlist.
 * @param input - user or typed-open input.
 * @param applicationOrigin - current DSH document origin, blocked for HTTPS.
 * @returns a canonical target or the refusal reason.
 */
export function parseBrowserAddress(input: string, applicationOrigin?: string): BrowserAddressResult {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (trimmed.length > MAX_BROWSER_URL_LENGTH) return { ok: false, reason: 'invalid' }
  const explicitScheme = /^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(trimmed)
  const nonHierarchicalScheme = /^(?:about|blob|data|javascript|mailto|tel|view-source):/iu.test(trimmed)
  const candidate = explicitScheme || nonHierarchicalScheme ? trimmed : `https://${trimmed}`
  let url: URL
  try { url = new URL(candidate) } catch { return { ok: false, reason: 'invalid' } }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) {
    if (applicationOrigin !== undefined && applicationOrigin !== 'null') {
      try {
        if (url.origin === new URL(applicationOrigin).origin) return { ok: false, reason: 'application-origin' }
      } catch {
        // An unavailable application origin cannot grant access to a target.
      }
    }
    return { ok: true, target: { kind: url.protocol === 'https:' ? 'https' : 'http', url: url.href, title: url.hostname } }
  }
  return { ok: false, reason: 'protocol' }
}

/**
 * Test whether a normalized URL host belongs to the local loopback interface.
 * @param hostname - URL hostname with IPv6 brackets retained.
 * @returns whether the hostname is localhost, IPv6 loopback, or IPv4 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const octets = hostname.split('.')
  return octets.length === 4 && octets[0] === '127'
    && octets.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}
