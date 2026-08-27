/**
 * Proxy policy resolution: the pure, transport-free half of this package. It turns the launch
 * environment plus optional configuration into one {@link ProxyPolicy}, and answers which proxy
 * (if any) a given URL goes through.
 *
 * Nothing here imports `undici`, so the module stays loadable in the browser-worker runtime that
 * evaluates `dsh-web-fetch-http` without a Node transport.
 * @module @deepseek-ai/dsh-http-proxy/policy
 */

import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

/**
 * Loopback entries merged into every policy's `noProxy`. A proxy that also serves the harness's own
 * loopback traffic turns the Web UI, the Connection transport, and every local test server into a
 * routing loop, so the bypass is not optional.
 *
 * `::1` and `[::1]` are both listed because the resolved string is also handed to undici, whose
 * matcher reads a bare `::1` as host `:` port `1` and therefore never bypasses it.
 */
export const LOOPBACK_NO_PROXY: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]']

/**
 * The environment names each policy field owns, lowercase first — undici reads the lowercase name
 * first, so both casings are always written or cleared together.
 */
export const POLICY_ENV_NAMES = {
  httpProxy: ['http_proxy', 'HTTP_PROXY'],
  httpsProxy: ['https_proxy', 'HTTPS_PROXY'],
  noProxy: ['no_proxy', 'NO_PROXY'],
} as const

/**
 * Every environment name that carries proxy configuration, including the `ALL_PROXY` fallback this
 * package resolves but never writes back. A caller that must isolate a child from the machine's
 * network policy clears exactly these.
 */
export const PROXY_ENV_NAMES: readonly string[] = [
  ...Object.values(POLICY_ENV_NAMES).flat(),
  'all_proxy',
  'ALL_PROXY',
]

/** Proxy URL schemes this package routes through. Everything else is reported, never silently dropped. */
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:'])

/** Schemes recognised well enough to name in a diagnostic instead of calling them malformed. */
const SOCKS_PROTOCOLS = new Set(['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'])

/**
 * One resolved outbound proxy policy. Plain data with no methods: worker threads receive it through
 * `workerData`'s structured clone, so both sides run the identical policy rather than each re-reading
 * an environment they may not share.
 */
export interface ProxyPolicy {
  /** Proxy for `http:` origins, or absent for a direct connection. Always a validated `http(s):` URL. */
  readonly httpProxy?: string
  /** Proxy for `https:` origins, or absent for a direct connection. Always a validated `http(s):` URL. */
  readonly httpsProxy?: string
  /** The bypass list, already merged with {@link LOOPBACK_NO_PROXY}. Empty when nothing is bypassed. */
  readonly noProxy: string
  /** Which layer supplied the winning proxy URL; `env` when either field came from the environment. */
  readonly source: 'env' | 'config' | 'none'
}

/** A policy that proxies nothing. Callers that have not installed a policy resolve URLs against this. */
export const DIRECT_POLICY: ProxyPolicy = { noProxy: '', source: 'none' }

/** Why one candidate proxy value was not used. Callers decide whether this warns or fails the load. */
export interface ProxyDiagnostic {
  /** `socks` for a SOCKS or PAC URL this package cannot route; `invalid` for anything unparseable. */
  readonly kind: 'socks' | 'invalid'
  /** Where the rejected value came from: an environment variable name, or `config.<field>`. */
  readonly origin: string
  /** Operator-facing sentence naming the rejection and the way forward. Carries no credential. */
  readonly message: string
}

/**
 * Proxy settings a composition may declare in `cordis.yml`. Real environment variables win over every
 * field here except `mode`, which governs whether the environment is consulted at all.
 */
export interface ProxyConfig {
  /**
   * `env` (default) resolves from the environment and lets the fields below fill the gaps; `custom`
   * does the same but is the honest label for a composition that supplies its own proxy; `off`
   * ignores every source and keeps the harness's own requests direct.
   *
   * `off` governs requests this process issues. It does not strip proxy variables from the
   * environment child tools inherit, because those belong to the user, not to the harness.
   */
  mode?: 'env' | 'custom' | 'off'
  /** Proxy for `http:` origins when the environment supplies none. */
  httpProxy?: string
  /** Proxy for `https:` origins when the environment supplies none. */
  httpsProxy?: string
  /** Bypass list when the environment supplies none. {@link LOOPBACK_NO_PROXY} is merged in regardless. */
  noProxy?: string
}

/** A resolved policy plus every candidate value that was rejected on the way to it. */
export interface ProxyResolution {
  /** The policy to install. Never carries a rejected value. */
  readonly policy: ProxyPolicy
  /** Rejections, in the order the candidates were considered. Empty on a clean resolution. */
  readonly diagnostics: readonly ProxyDiagnostic[]
}

/**
 * Read one environment name in undici's precedence order — lowercase first, uppercase as the
 * fallback — treating a blank value as unset. Blank matters: undici's own `??` chain lets an empty
 * lowercase name shadow a populated uppercase one.
 *
 * @param env - the launch environment snapshot to read.
 * @param lower - the lowercase variable name.
 * @returns the trimmed value and the name that supplied it, or `undefined` when neither is set.
 */
function readEnv(
  env: LaunchEnvironmentSnapshot,
  lower: string,
): { value: string; name: string } | undefined {
  for (const name of [lower, lower.toUpperCase()]) {
    const value = env.get(name)?.value.trim()
    if (value !== undefined && value !== '') return { value, name }
  }
  return undefined
}

/**
 * What one environment or configuration slot supplied. A rejected slot is distinct from an absent
 * one: the user named a proxy for that scheme, so falling back to another scheme's proxy would route
 * the request somewhere they never asked for while the diagnostic said it stayed direct.
 */
type ProxyCandidate =
  | { readonly kind: 'accepted'; readonly value: string }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'absent' }

/** A slot nobody filled. */
const ABSENT: ProxyCandidate = { kind: 'absent' }

/**
 * Validate one candidate proxy URL.
 *
 * @param candidate - the raw value and the origin to name in a diagnostic.
 * @param diagnostics - collector the rejection is appended to.
 * @returns the candidate's usability, distinguishing a rejected slot from an empty one.
 */
function acceptProxyUrl(
  candidate: { value: string; name: string } | undefined,
  diagnostics: ProxyDiagnostic[],
): ProxyCandidate {
  if (candidate === undefined) return ABSENT
  const parsed = URL.parse(candidate.value)
  if (parsed === null) {
    diagnostics.push({
      kind: 'invalid',
      origin: candidate.name,
      message: `${candidate.name} is not a valid URL; connecting directly`,
    })
    return { kind: 'rejected' }
  }
  if (SOCKS_PROTOCOLS.has(parsed.protocol)) {
    diagnostics.push({
      kind: 'socks',
      origin: candidate.name,
      message: `${candidate.name} names a SOCKS proxy, which is not supported; connecting directly for that scheme — set an http:// or https:// proxy URL instead`,
    })
    return { kind: 'rejected' }
  }
  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    diagnostics.push({
      kind: 'invalid',
      origin: candidate.name,
      message: `${candidate.name} uses the unsupported ${parsed.protocol}// scheme; connecting directly for that scheme — set an http:// or https:// proxy URL instead`,
    })
    return { kind: 'rejected' }
  }
  return { kind: 'accepted', value: candidate.value }
}

/**
 * Resolve one scheme's proxy from its own slot, then the fallbacks — but only when the scheme's own
 * slot was empty. A rejected slot keeps that scheme direct, so the diagnostic and the route agree.
 *
 * @param own - what the scheme's own name supplied.
 * @param fallbacks - values to try in order when `own` is absent.
 * @returns the proxy URL for that scheme, or `undefined` for a direct connection.
 */
function resolveScheme(own: ProxyCandidate, ...fallbacks: (string | undefined)[]): string | undefined {
  if (own.kind === 'accepted') return own.value
  if (own.kind === 'rejected') return undefined
  return fallbacks.find(value => value !== undefined)
}

/**
 * Merge {@link LOOPBACK_NO_PROXY} into a bypass list, preserving the caller's entries and order.
 * A list of `*` already bypasses everything and is returned unchanged.
 *
 * @param noProxy - the bypass list as the environment or configuration supplied it.
 * @returns the effective bypass list.
 */
function withLoopback(noProxy: string | undefined): string {
  const entries = (noProxy ?? '').split(/[,\s]+/).map(entry => entry.trim()).filter(entry => entry !== '')
  if (entries.includes('*')) return '*'
  const present = new Set(entries.map(entry => entry.toLowerCase()))
  return [...entries, ...LOOPBACK_NO_PROXY.filter(entry => !present.has(entry))].join(',')
}

/**
 * Split one bypass entry into host and optional port.
 *
 * A bare IPv6 literal carries several colons and no port, so only a single-colon entry splits;
 * a bracketed literal takes its port from after the bracket. Getting this wrong is how undici
 * turns `::1` into host `:` port `1`.
 *
 * @param entry - one already-trimmed bypass entry.
 * @returns the entry's host and, when it carries one, its port.
 */
function splitHostPort(entry: string): { host: string; port?: string } {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close !== -1) {
      const rest = entry.slice(close + 1)
      const host = entry.slice(1, close)
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host }
    }
  }
  const colon = entry.indexOf(':')
  if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) }
  }
  return { host: entry }
}

/**
 * Decide whether a bypass list exempts one URL. Entries match an exact host, a `.suffix` or
 * `*.suffix` domain, an optional `:port`, or `*` for everything. CIDR notation is not matched —
 * an operating system's bypass list often carries `10.0.0.0/8`, which must be rewritten as suffixes.
 *
 * @param noProxy - the effective bypass list.
 * @param url - the request URL.
 * @returns true when the URL must bypass the proxy.
 */
export function bypassesProxy(noProxy: string, url: URL): boolean {
  // `URL.hostname` keeps the brackets around an IPv6 literal, while a bypass entry may be written
  // either way, so both sides are unbracketed before they are compared.
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const split = splitHostPort(entry)
    if (split.port !== undefined && split.port !== port) continue
    const candidate = split.host.replace(/^\*?\./, '').replace(/\.$/, '')
    if (candidate === '') continue
    if (host === candidate || host.endsWith(`.${candidate}`)) return true
  }
  return false
}

/**
 * Resolve the outbound proxy policy for this process.
 *
 * Precedence is environment first, configuration second: a value the user exported wins over one a
 * composition declares, and `ALL_PROXY` backs both schemes. HTTPS falls back to the HTTP proxy last,
 * matching undici, so this function and the installed dispatcher never disagree about one URL.
 *
 * @param env - the launch environment snapshot, whose own layering already prefers real variables over `.env` files.
 * @param config - optional composition-declared settings.
 * @returns the policy to install plus every rejected candidate.
 */
export function resolveProxyPolicy(
  env: LaunchEnvironmentSnapshot,
  config: ProxyConfig = {},
): ProxyResolution {
  const diagnostics: ProxyDiagnostic[] = []
  if (config.mode === 'off') return { policy: DIRECT_POLICY, diagnostics }

  const all = acceptProxyUrl(readEnv(env, 'all_proxy'), diagnostics)
  const allValue = all.kind === 'accepted' ? all.value : undefined
  const configHttp = acceptProxyUrl(
    config.httpProxy === undefined ? undefined : { value: config.httpProxy, name: 'config.httpProxy' },
    diagnostics,
  )
  const configHttps = acceptProxyUrl(
    config.httpsProxy === undefined ? undefined : { value: config.httpsProxy, name: 'config.httpsProxy' },
    diagnostics,
  )
  const configHttpValue = configHttp.kind === 'accepted' ? configHttp.value : undefined
  const configHttpsValue = configHttps.kind === 'accepted' ? configHttps.value : undefined

  const envHttp = acceptProxyUrl(readEnv(env, 'http_proxy'), diagnostics)
  const envHttps = acceptProxyUrl(readEnv(env, 'https_proxy'), diagnostics)
  const httpProxy = resolveScheme(envHttp, allValue, configHttpValue)
  // HTTPS falls back to the HTTP proxy last, matching undici — but never past a value the user named
  // for HTTPS and this package refused.
  const httpsProxy = resolveScheme(envHttps, allValue, configHttpsValue, httpProxy)
  if (httpProxy === undefined && httpsProxy === undefined) return { policy: DIRECT_POLICY, diagnostics }

  const noProxy = withLoopback(readEnv(env, 'no_proxy')?.value ?? config.noProxy)
  const fromEnv = envHttp.kind === 'accepted' || envHttps.kind === 'accepted' || all.kind === 'accepted'
  return {
    policy: {
      ...httpProxy === undefined ? {} : { httpProxy },
      ...httpsProxy === undefined ? {} : { httpsProxy },
      noProxy,
      source: fromEnv ? 'env' : 'config',
    },
    diagnostics,
  }
}

/**
 * Resolve which proxy one URL goes through under a policy.
 *
 * This is the single answer both the installed dispatcher and `dsh-web-fetch-http` consult, so a URL
 * can never be pinned to a resolved address by one and tunnelled by the other.
 *
 * @param policy - the active policy.
 * @param url - the request URL.
 * @returns the proxy URL to tunnel through, or `undefined` for a direct connection.
 */
export function proxyForUrl(policy: ProxyPolicy, url: URL): string | undefined {
  const proxy = url.protocol === 'https:' ? policy.httpsProxy : url.protocol === 'http:' ? policy.httpProxy : undefined
  if (proxy === undefined) return undefined
  return bypassesProxy(policy.noProxy, url) ? undefined : proxy
}

/**
 * Render a policy for an operator, with any proxy password replaced. The username survives because it
 * identifies the account without granting it, which is what makes the line useful in a bug report.
 *
 * @param policy - a policy whose URLs {@link resolveProxyPolicy} already validated.
 * @returns one line naming the effective proxies and bypass list.
 */
export function describeProxyPolicy(policy: ProxyPolicy): string {
  if (policy.source === 'none') return 'no proxy (direct)'
  const redact = (value: string): string => {
    const url = new URL(value)
    if (url.password !== '') url.password = '***'
    return url.toString()
  }
  const parts = [
    `http=${policy.httpProxy === undefined ? 'direct' : redact(policy.httpProxy)}`,
    `https=${policy.httpsProxy === undefined ? 'direct' : redact(policy.httpsProxy)}`,
    `no_proxy=${policy.noProxy}`,
    `from=${policy.source}`,
  ]
  return parts.join(' ')
}
