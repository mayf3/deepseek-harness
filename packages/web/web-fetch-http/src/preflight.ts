/**
 * Public-destination preflight shared with permission consumers. This check is
 * advisory: the provider independently resolves and pins the actual request.
 *
 * @module @deepseek-ai/dsh-web-fetch-http/preflight
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { publicHttpNetwork } from './network.ts'
import { parseFetchUrl } from './policy.ts'

/**
 * Parse an HTTP(S) URL and require its current DNS answer set to contain only
 * public unicast addresses. A successful result does not authorize a later
 * connection; callers must use a provider that repeats and enforces the check.
 * @param rawUrl - URL proposed for a public fetch.
 * @param signal - cancellation for hostname resolution.
 * @returns the parsed URL after successful public-address resolution.
 */
export async function preflightPublicFetchUrl(rawUrl: string, signal: AbortSignal): Promise<URL> {
  const url = parseFetchUrl(rawUrl)
  try {
    await publicHttpNetwork.resolve(url.hostname, signal)
  } catch (error: unknown) {
    if (error instanceof WebError) throw error
    if (signal.aborted) {
      throw new WebError('web fetch aborted during permission preflight', 'WEB_ABORTED', { cause: error })
    }
    throw new WebError(`web fetch hostname resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  return url
}
