/**
 * Proxy installation: the transport half of this package. It owns undici's global dispatcher, the
 * process-wide record of which policy is active, and the dispatcher factory every other package uses
 * instead of constructing a bare agent.
 *
 * `undici` is imported dynamically so the pure {@link ProxyPolicy} half stays loadable where no Node
 * transport exists, matching how `dsh-web-fetch-http` defers its own transport import.
 * @module @deepseek-ai/dsh-http-proxy/install
 */

import type { Agent, Dispatcher } from 'undici'
import { DIRECT_POLICY, proxyForUrl, type ProxyPolicy } from './policy.ts'

/**
 * The environment names each policy field owns, lowercase first. Both casings are written together:
 * undici reads the lowercase name first, so leaving a stale uppercase value behind would let it
 * shadow the resolved one on Windows, where the two names are the same variable.
 */
const POLICY_ENV_NAMES = {
  httpProxy: ['http_proxy', 'HTTP_PROXY'],
  httpsProxy: ['https_proxy', 'HTTPS_PROXY'],
  noProxy: ['no_proxy', 'NO_PROXY'],
} as const

/** The active policy, or `undefined` until one is installed. Process-wide, like the dispatcher it tracks. */
let active: ProxyPolicy | undefined

/**
 * The policy governing this process's outbound requests.
 *
 * @returns the installed policy, or `undefined` when {@link installGlobalProxy} has not run. A caller
 *   that only needs to route a URL can treat `undefined` as {@link DIRECT_POLICY}.
 */
export function currentProxyPolicy(): ProxyPolicy | undefined {
  return active
}

/**
 * Publish a policy through the proxy environment variables so both undici and every spawned child
 * observe the one resolved answer — including the `ALL_PROXY` fallback and the merged loopback
 * bypass, neither of which they would derive on their own.
 *
 * @param policy - the policy to publish.
 * @returns a function restoring every name this call changed.
 */
function applyPolicyEnv(policy: ProxyPolicy): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const value = policy[field as keyof typeof POLICY_ENV_NAMES]
    for (const name of names) {
      previous.set(name, process.env[name])
      if (value === undefined || value === '') Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
}

/**
 * Route this process's outbound HTTP through `policy`.
 *
 * Installing replaces undici's global dispatcher, which is what Node's built-in `fetch` resolves, so
 * every caller that issues a plain `fetch()` is covered without knowing this package exists. A policy
 * that proxies nothing installs no dispatcher and leaves the environment untouched.
 *
 * Worker threads do not inherit the global dispatcher; each one calls this with the policy its host
 * passed through `workerData`.
 *
 * @param policy - the resolved policy to install.
 * @returns a disposer restoring the previous dispatcher, policy, and environment, then closing the agent.
 */
export async function installGlobalProxy(policy: ProxyPolicy): Promise<() => Promise<void>> {
  const previousPolicy = active
  if (policy.source === 'none') {
    active = policy
    return () => {
      active = previousPolicy
      return Promise.resolve()
    }
  }
  const restoreEnv = applyPolicyEnv(policy)
  const { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const previousDispatcher = getGlobalDispatcher()
  // Constructed with no options on purpose: it reads the names applyPolicyEnv just wrote, so the
  // agent and `proxyForUrl` answer from the same values instead of each parsing the raw environment.
  const agent = new EnvHttpProxyAgent()
  setGlobalDispatcher(agent)
  active = policy
  return async () => {
    setGlobalDispatcher(previousDispatcher)
    active = previousPolicy
    restoreEnv()
    await agent.close()
  }
}

/**
 * Build a dispatcher for one request URL that honors the active policy.
 *
 * Use this wherever a call site needs its own agent options — connection limits, timeouts, a custom
 * DNS lookup. Constructing `new Agent(...)` directly and passing it as `dispatcher` silently bypasses
 * the global one and therefore the proxy, which is the defect this function exists to prevent.
 * `verify-no-bare-dispatcher` enforces that outside this package.
 *
 * @param url - the request URL, which decides whether the policy proxies or bypasses it.
 * @param options - agent options; applied to whichever agent the policy selects.
 * @returns a dispatcher the caller owns and must close once the response body is consumed.
 */
export async function createDispatcher(url: URL, options: Agent.Options = {}): Promise<Dispatcher> {
  const undici = await import('undici')
  const proxy = proxyForUrl(active ?? DIRECT_POLICY, url)
  if (proxy === undefined) return new undici.Agent(options)
  return new undici.ProxyAgent({ ...options, uri: proxy })
}

/**
 * Build a `node:http` or `node:https` Agent that honors the active policy.
 *
 * The global dispatcher reaches undici, and therefore `fetch`, but not `node:http`. An SDK that
 * issues requests through the core modules — the OTLP exporter is the one this repository ships —
 * accepts an agent instead, and this is the agent to give it.
 *
 * Node's own `proxyEnv` option does the routing, reading the names {@link installGlobalProxy}
 * published. It reaches Node 22.21+ and 24.5+; an older runtime ignores the unknown option and
 * connects directly, the same seam a spawned child Node has.
 *
 * @param protocol - the target's protocol, `https:` selecting the TLS agent.
 * @param options - agent options merged under the proxy routing.
 * @returns an agent the caller passes to the SDK that needs one.
 */
export async function createNodeHttpAgent(
  protocol: string,
  options: Readonly<Record<string, unknown>> = {},
): Promise<import('node:http').Agent> {
  const core = protocol === 'https:' ? await import('node:https') : await import('node:http')
  const proxied = active !== undefined && active.source !== 'none'
  // `proxyEnv` postdates the @types/node this workspace pins, so the option is applied through a
  // widened record rather than the typed constructor overload.
  const agentOptions = { ...options, ...proxied ? { proxyEnv: process.env } : {} }
  return new core.Agent(agentOptions as ConstructorParameters<typeof core.Agent>[0])
}

/**
 * The proxy this URL is reached through, for an SDK that takes a proxy URL of its own rather than a
 * dispatcher or an agent. `undefined` means the SDK should connect directly.
 *
 * @param url - the endpoint the SDK will call.
 * @returns the proxy URL to hand the SDK, or `undefined` for a direct connection.
 */
export function proxyUrlFor(url: URL): string | undefined {
  return proxyForUrl(active ?? DIRECT_POLICY, url)
}

/**
 * The proxy environment a separate Node execution context needs: the resolved policy plus the flag
 * that makes Node's built-in HTTP clients honor it.
 *
 * This covers both shapes DSH spawns. A child process inherits the parent environment, so the proxy
 * names merely restate what {@link installGlobalProxy} already published and the flag is what it
 * gains. A worker thread is given an explicit, near-empty environment instead, so it needs the names
 * as well — and worker threads do not inherit the global dispatcher, which is why they are handled
 * here rather than left to the parent's installation.
 *
 * The flag reaches only Node 22.21+ and 24+; an older runtime keeps that context direct. Such a
 * context also matches bypass entries with Node's own `NO_PROXY` rules, which differ from this
 * package's in their separators and IPv4-range support. Non-Node children (curl, git, pnpm) ignore
 * the flag and read the variables themselves.
 *
 * @returns names to merge into the child or worker environment, or an empty object when no proxy is active.
 */
export function childProxyEnv(): Record<string, string> {
  if (active === undefined || active.source === 'none') return {}
  const env: Record<string, string> = { NODE_USE_ENV_PROXY: '1' }
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const value = active[field as keyof typeof POLICY_ENV_NAMES]
    if (value === undefined || value === '') continue
    for (const name of names) env[name] = value
  }
  return env
}
