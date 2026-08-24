/**
 * Network-free URL validation shared with permission consumers.
 *
 * @module @deepseek-ai/dsh-web-fetch-http/preflight
 */

import { isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'
import { isPublicIpAddress } from './network.ts'
import { validateFetchUrl } from './policy.ts'

/**
 * Validate an HTTP(S) URL before permission is requested without causing
 * network activity. Literal IP destinations must already be public; hostnames
 * are resolved and enforced only by the provider after consent.
 * @param rawUrl - URL proposed for a public fetch.
 * @returns the parsed URL after network-free validation.
 */
export function validateFetchApprovalUrl(rawUrl: string): URL {
  const url = validateFetchUrl(rawUrl)
  const hostname = stripIpv6Brackets(url.hostname)
  if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
    throw new WebError(`URL hostname "${url.hostname}" is a non-public IP address`, 'WEB_BLOCKED_URL')
  }
  return url
}

/** WHATWG URL retains brackets around IPv6 hostnames; IP parsers do not. */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
}
