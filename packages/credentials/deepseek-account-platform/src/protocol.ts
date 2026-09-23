/** Validated platform HTTP messages and restricted browser destinations. */
import { z } from 'zod'
import type { AccountBonusOrderId } from '@deepseek-ai/dsh-deepseek-account/types'

/**
 * Write one `[deepseek-account]` diagnostic with a UTC timestamp.
 * Single writer for provider diagnostics so every line carries the same `at` field.
 * @param message - suffix after the log prefix.
 * @param fields - structured values, already free of credentials.
 */
export function logAccountDiagnostic(message: string, fields: Record<string, unknown> = {}): void {
  console.info(`[deepseek-account] ${message}`, { at: new Date().toISOString(), ...fields })
}

/** Protocol errors expose a stable code, never a response body or authorization URL. */
export class PlatformAuthError extends Error {
  /** @param code - safe error classification. */
  constructor(readonly code: 'network' | 'protocol' | 'expired' | 'storage') { super(`account: ${code}`) }
}

/**
 * Accept HTTPS platform endpoints, or explicitly configured loopback development HTTP.
 * @param value - configured origin.
 * @param allowLoopbackHttp - development-only opt-in.
 * @returns normalized origin.
 */
export function platformOrigin(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || (allowLoopbackHttp && loopback && url.protocol === 'http:'))) {
    throw new Error('account: platformOrigin must be an HTTPS origin or explicitly enabled loopback HTTP origin')
  }
  return url.origin
}

/**
 * Validate platform-owned browser destinations without forwarding arbitrary URLs.
 * @param value - returned browser URL.
 * @param origin - configured platform origin.
 * @param path - fixed authorize or completion path.
 * @param rewriteOrigin - map validated browser pages to the configured development origin.
 * @returns normalized URL on the configured origin.
 */
export function browserUrl(value: string, origin: string, path: string, rewriteOrigin = false): string {
  let url: URL
  try { url = new URL(value) } catch {
    logAccountDiagnostic('browser URL rejected', { path, reason: 'invalid-url' })
    throw new PlatformAuthError('protocol')
  }
  const allowedOrigin = url.origin === origin || (rewriteOrigin && url.protocol === 'https:')
  if (!allowedOrigin || url.pathname !== path || url.username || url.password || url.hash) {
    logAccountDiagnostic('browser URL rejected', {
      path, originMismatch: !allowedOrigin, pathMismatch: url.pathname !== path,
      hasCredentials: Boolean(url.username || url.password), hasFragment: Boolean(url.hash),
    })
    throw new PlatformAuthError('protocol')
  }
  return rewriteOrigin ? `${origin}${url.pathname}${url.search}` : url.href
}

/**
 * Validate Host-only deployment headers without exposing their values in diagnostics.
 * @param values - configured headers for the Platform origin.
 * @returns normalized headers; authorization, routing and framing remain provider-owned.
 */
export function platformHeaders(values: Record<string, string>): Record<string, string> {
  const headers = new Headers()
  const names = new Set<string>()
  for (const [name, value] of Object.entries(values)) {
    const key = name.toLowerCase()
    if (['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(key)
      || names.has(key)) throw new Error('account: requestHeaders contains a reserved or duplicate header')
    names.add(key)
    try { headers.set(name, value) }
    catch { throw new Error('account: requestHeaders contains an invalid header') }
  }
  return Object.fromEntries(headers)
}

const envelope = z.object({ code: z.literal(0), data: z.object({ biz_code: z.number().int(), biz_data: z.unknown() }) })
// Failure envelopes may carry `data: null`, so the numeric codes stay readable without the success fields.
const responseCodes = z.object({
  code: z.number().int(), data: z.object({ biz_code: z.number().int() }).nullish(),
})
/** Successful initialization response. */
export const initialization = z.object({
  authorize_url: z.url(), authorize_id: z.string().min(1), expires_in: z.number().positive(),
})
/** Successful code exchange response. */
export const exchange = z.object({ token: z.string().regex(/^[\x21-\x7e]+$/), authorized_url: z.url(), user: z.unknown().optional() })

/**
 * Read one bounded platform response with stable, non-secret diagnostics.
 * @param origin - validated platform origin.
 * @param method - platform endpoint suffix.
 * @param body - protocol request, never logged.
 * @param signal - attempt cancellation and timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns successful business payload, validated by its caller.
 */
export async function requestPlatform(origin: string, method: string, body: unknown,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/auth-api/v0/dsh/${method}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, signal)
}

/**
 * Fetch a fixed Platform account endpoint with the grant kept in Host request headers.
 * @param origin - configured and grant-matched origin.
 * @param path - account endpoint.
 * @param token - account grant.
 * @param signal - credential lifetime and request timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns successful business payload.
 */
export function requestAccount(origin: string, path: '/auth-api/v0/users/current' | '/api/v0/users/get_user_summary',
  token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}${path}`, { method: 'GET', headers: accountHeaders(headers, token) }, signal)
}

/**
 * Read the granted bonuses Platform has not yet recorded as displayed.
 * @param origin - configured origin matching the grant issuer.
 * @param token - stored account grant.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers for this origin.
 * @returns successful business payload holding the unnotified bonus list.
 */
export function requestUnnotifiedBonuses(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/api/v0/users/get_unnotified_bonuses`,
    { method: 'GET', headers: accountHeaders(headers, token) }, signal)
}

/**
 * Acknowledge an actually displayed bonus to Platform.
 * @param origin - configured origin matching the grant issuer.
 * @param token - stored account grant.
 * @param orderId - granted bonus order the user saw.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers for this origin.
 * @returns successful business payload, which carries no data.
 */
export function requestBonusNotified(origin: string, token: string, orderId: AccountBonusOrderId,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/api/v0/users/ack_bonus_notified`, {
    method: 'POST', headers: { ...accountHeaders(headers, token), 'content-type': 'application/json' },
    body: JSON.stringify({ order_id: orderId }),
  }, signal)
}

// The grant is provider-owned; deployment requestHeaders cannot override it or the client identity.
function accountHeaders(headers: Record<string, string>, token: string): Record<string, string> {
  return { ...headers, 'x-dsh-auth-token': token }
}

/**
 * End the Platform session using its existing logout endpoint.
 * @param origin - configured origin matching the grant issuer.
 * @param token - stored account token.
 * @param signal - logout request deadline.
 * @param headers - validated deployment headers for this origin.
 * @returns after Platform confirms logout.
 */
export async function logoutAccount(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  await platformRequest(`${origin}/auth-api/v0/users/logout`, {
    method: 'POST', headers: { ...headers, 'x-dsh-auth-token': token },
  }, signal)
}

async function platformRequest(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const path = new URL(url).pathname
  const secrets = requestSecrets(init)
  logAccountDiagnostic('request', { path, method: init.method })
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal })
  } catch {
    logAccountDiagnostic('request failed', { path, errorCode: 'network', aborted: signal.aborted })
    throw new PlatformAuthError('network')
  }
  logAccountDiagnostic('response', { path, status: response.status })
  if (!response.ok || response.body === null) {
    // The failure body names the server-side cause; the request and its headers never reach the log.
    const read = response.body === null ? { ok: false as const, reason: 'empty' as const } : await readBounded(response.body)
    const payload = read.ok ? parseJson(read.text) : undefined
    logAccountDiagnostic('response failed', read.ok ? {
      path, status: response.status, errorCode: 'network', bodyState: 'read',
      ...codesOf(payload), body: sanitizedBody(read.text, payload, secrets),
    } : { path, status: response.status, errorCode: 'network', bodyState: read.reason })
    throw new PlatformAuthError('network')
  }
  const read = await readBounded(response.body)
  if (!read.ok) {
    logAccountDiagnostic('response rejected', {
      path, status: response.status, stage: read.reason === 'limit' ? 'body-limit' : 'read-body',
      errorCode: 'protocol', bodyState: read.reason,
    })
    throw new PlatformAuthError('protocol')
  }
  const payload = parseJson(read.text)
  if (payload === undefined) {
    logAccountDiagnostic('response rejected', {
      path, status: response.status, stage: 'parse-json', errorCode: 'protocol',
      body: sanitizedBody(read.text, undefined, secrets),
    })
    throw new PlatformAuthError('protocol')
  }
  const codes = codesOf(payload)
  if (codes.code !== undefined || codes.bizCode !== undefined) {
    logAccountDiagnostic('response codes', { path, ...codes })
  }
  const parsed = envelope.safeParse(payload)
  if (!parsed.success) {
    logAccountDiagnostic('envelope rejected', {
      path, status: response.status, errorCode: 'protocol', body: sanitizedBody(read.text, payload, secrets),
      issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
    })
    throw new PlatformAuthError('protocol')
  }
  if (parsed.data.data.biz_code !== 0) {
    // TODO(product-error-ui): Apply product-defined copy and UI behavior for the supplied biz_code values.
    // Business failures use the existing generic failure UI until then; backend messages stay Host-only.
    logAccountDiagnostic('business rejected', {
      path, status: response.status, errorCode: 'protocol', code: parsed.data.code,
      bizCode: parsed.data.data.biz_code, body: sanitizedBody(read.text, payload, secrets),
    })
    throw new PlatformAuthError('protocol')
  }
  // A validated success body is logged after every credential-bearing field is replaced.
  logAccountDiagnostic('response body', {
    path, status: response.status, body: sanitizedBody(read.text, payload, secrets),
  })
  return parsed.data.data.biz_data
}

/** Parse one response body; `undefined` marks invalid JSON because `JSON.parse` never returns it. */
function parseJson(text: string): unknown { try { return JSON.parse(text) } catch { return undefined } }

/** Numeric envelope codes; absent when the failure body is not a recognized envelope. */
function codesOf(payload: unknown): { code?: number; bizCode?: number } {
  const parsed = responseCodes.safeParse(payload)
  if (!parsed.success) return {}
  return parsed.data.data?.biz_code === undefined
    ? { code: parsed.data.code } : { code: parsed.data.code, bizCode: parsed.data.data.biz_code }
}

const BODY_LIMIT = 65_536
const LOG_LIMIT = 2_048
// Credential-bearing field names; `code` is matched exactly so `error_code` and `decoder` stay readable.
const CREDENTIAL_KEY = /(token|password|secret|cookie|authorization|api[-_]?key|authorize|code_verifier)/i
const EXACT_CODE_KEY = /^code$/i
const NUMERIC_CODE_KEY = /^(code|biz_code)$/i
const CREDENTIAL_HEADER = /(authorization|cookie|token|api[-_]?key|secret|password|session)/i
const URL_KEY = /(?:url|uri)$/i
const ABSOLUTE_URL = /https?:\/\/[^\s"'<>]+/gi
const AUTHORIZE_URL = /\/dsh\/authorize|[?&]code=/i
// A deployment routing cookie carries no credential; its value can be a bare flag like 1 or 20022.
// Replacing so little text everywhere would erase the digits of server-authored dates, amounts and
// order ids, so only a cookie value this short is restricted to whole-value matches.
const COOKIE_VALUE_SUBSTRING_MIN_LENGTH = 8

/** Read one bounded platform response body; never throws. */
async function readBounded(body: ReadableStream<Uint8Array>): Promise<{ ok: true; text: string } | { ok: false; reason: 'limit' | 'stream' }> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > BODY_LIMIT) return { ok: false, reason: 'limit' }
      chunks.push(next.value)
    }
    return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
  } catch {
    return { ok: false, reason: 'stream' }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Serialize one failure body for the log with credential keys and echoed request secrets removed. */
function sanitizedBody(text: string, payload: unknown, secrets: RequestSecrets): string {
  // Parsed payloads scrub each string and key individually; a raw body is scrubbed as text. Re-scrubbing
  // the serialized JSON would also rewrite numeric codes that a short request secret happens to match.
  if (payload === undefined) return clip(scrubText(text, secrets.substrings, secrets.exact))
  return clip(JSON.stringify(sanitize(payload, secrets)))
}

function sanitize(value: unknown, secrets: RequestSecrets): unknown {
  if (typeof value === 'string') return scrubText(value, secrets.substrings, secrets.exact)
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      // Numeric protocol codes stay readable; a numeric credential still redacts.
      if (!(NUMERIC_CODE_KEY.test(key) && typeof item === 'number') && isCredentialKey(key)) return [key, '[redacted]']
      if (URL_KEY.test(key) && typeof item === 'string' && /^https?:\/\//i.test(item)) return [key, '[authorize-url]']
      return [key, sanitize(item, secrets)]
    }))
  }
  return value
}

function isCredentialKey(key: string): boolean { return EXACT_CODE_KEY.test(key) || CREDENTIAL_KEY.test(key) }

function scrubText(text: string, substrings: readonly string[], exact: readonly string[] = []): string {
  if (exact.includes(text)) return '[redacted]'
  let value = text.replace(ABSOLUTE_URL, url => AUTHORIZE_URL.test(url) ? '[authorize-url]' : url)
  for (const secret of substrings) value = value.split(secret).join('[redacted]')
  return value
}

function clip(text: string): string { return text.length > LOG_LIMIT ? `${text.slice(0, LOG_LIMIT)}…` : text }

/**
 * Request-owned values to remove from an echoed copy of a response body.
 * `substrings` redact wherever they appear; `exact` redact only when an echoed string is exactly
 * that value, which keeps a short deployment routing flag from rewriting unrelated dates, amounts
 * or order ids that happen to contain the same characters.
 */
interface RequestSecrets {
  /** Values redacted wherever they appear in an echoed body. */
  readonly substrings: readonly string[]
  /** Short cookie values redacted only when an echoed string is exactly this value. */
  readonly exact: readonly string[]
}

/** Collect the request values that must not be echoed back, split by how precisely they can match. */
function requestSecrets(init: RequestInit): RequestSecrets {
  // Credentials always redact as substrings; only a deployment cookie's own short value is restricted
  // to whole-value matches, because a routing flag is not a secret and overlaps ordinary numbers.
  const values: string[] = []
  const exact = new Set<string>()
  for (const [name, value] of new Headers(init.headers)) {
    // Only credential-bearing headers are collected; content types and framing stay readable.
    if (!CREDENTIAL_HEADER.test(name)) continue
    if (name.toLowerCase() !== 'cookie') {
      values.push(value)
      continue
    }
    for (const pair of value.split(';')) {
      const entry = pair.trim()
      const component = entry.slice(entry.indexOf('=') + 1)
      // The whole pair is not numeric-looking text on its own, so it stays a substring.
      values.push(entry)
      if (component.length < COOKIE_VALUE_SUBSTRING_MIN_LENGTH) exact.add(component)
      else values.push(component)
    }
  }
  if (typeof init.body === 'string') {
    collectCredentialValues(parseJson(init.body), values)
  }
  const substrings = [...new Set(values.filter(value => value !== ''))]
    // Longest first so a secret containing another secret cannot leave a partial echo behind.
    .sort((left, right) => right.length - left.length)
  return { substrings, exact: [...exact].filter(value => value !== '') }
}

function collectCredentialValues(value: unknown, values: string[]): void {
  if (Array.isArray(value)) { for (const item of value) collectCredentialValues(item, values); return }
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (isCredentialKey(key) && typeof item === 'string') values.push(item)
    else collectCredentialValues(item, values)
  }
}

/**
 * Accept a browser-accessible loopback HTTP origin for local or SSH-forwarded login.
 * @param value - loopback HTTP origin with an explicit port supplied by the authenticated initiating client.
 * @returns normalized origin; remote domains and path-based proxies are unsupported.
 */
export function loginOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new PlatformAuthError('protocol') }
  const explicitPort = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/i.exec(value)?.[1]
  if (explicitPort === undefined || Number(explicitPort) === 0
    || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new PlatformAuthError('protocol')
  }
  return `${url.protocol}//${url.hostname}:${Number(explicitPort)}`
}
