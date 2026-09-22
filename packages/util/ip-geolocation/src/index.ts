/** Country lookup for the calling process's public network exit, using a JSON country field. */

/** Explicit transport limits and endpoint for one country lookup. */
export interface IpGeolocationRequest {
  /** HTTP(S) endpoint returning a `country` field; omitting an IP queries the caller's exit. */
  readonly endpoint: string
  /** Cancels both the request and response-body reading. */
  readonly signal: AbortSignal
  /** Maximum response-body bytes, including fields the caller does not consume. */
  readonly maxResponseBytes: number
}

/**
 * Query the network exit country through the process's ordinary fetch transport.
 * No address, country, or result is retained by this library.
 * @param request - endpoint, cancellation, and response limit supplied by the consumer.
 * @returns uppercase two-letter country code, or null for an unknown country (HTTP 404 or JSON null).
 * @throws on cancellation, HTTP failure, oversized body, or invalid JSON/country data.
 */
export async function lookupIpCountry(request: IpGeolocationRequest): Promise<string | null> {
  const response = await fetch(request.endpoint, { signal: request.signal, redirect: 'error', headers: { accept: 'application/json' } })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 404) return null
    throw new Error(`IP geolocation returned HTTP ${response.status}`)
  }
  if (response.body === null) throw new TypeError('IP geolocation returned no JSON body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > request.maxResponseBytes) throw new RangeError('IP geolocation response exceeds maxResponseBytes')
      chunks.push(value)
    }
  } finally {
    try { await reader.cancel() }
    finally { reader.releaseLock() }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (typeof value !== 'object' || value === null || !('country' in value)
    || (value.country !== null && (typeof value.country !== 'string' || !/^[A-Z]{2}$/.test(value.country)))) {
    throw new TypeError('IP geolocation must return a country code or null')
  }
  return value.country
}
