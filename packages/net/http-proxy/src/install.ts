/**
 * Proxy installation: the transport half of this package. It owns undici's global dispatcher, the
 * process-wide record of which policy is active, and the dispatcher factory every other package uses
 * instead of constructing a bare agent.
 *
 * `undici` is imported dynamically so the pure {@link ProxyPolicy} half stays loadable where no Node
 * transport exists, matching how `dsh-web-fetch-http` defers its own transport import.
 * @module @deepseek-ai/dsh-http-proxy/install
 */

import type { Agent, Dispatcher, Pool } from 'undici'
import { DIRECT_POLICY, POLICY_ENV_NAMES, proxyForUrl, type ProxyPolicy } from './policy.ts'


/** The active policy, or `undefined` until one is installed. Process-wide, like the dispatcher it tracks. */
let active: ProxyPolicy | undefined

/**
 * The proxy environment as the user exported it, or `undefined` when no policy is installed.
 *
 * Owned by the OUTERMOST install: a nested one — the plugin mounted over the launcher's policy —
 * would otherwise record the outer policy's published values as if the user had written them, and
 * hand every child a normalization the user never asked for.
 *
 * {@link childProxyEnv} keeps a value the user set rather than the one this process resolved from
 * it, so a SOCKS proxy `curl` can use is not replaced by an HTTP proxy named for another scheme.
 */
let inheritedProxyEnv: Readonly<Record<string, string | undefined>> | undefined

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
 * Publish a policy through the proxy environment variables, which is how the consumers that read an
 * environment rather than a policy object — `node:http`'s `proxyEnv` and every spawned child — see
 * the one resolved answer, including the `ALL_PROXY` fallback and the merged loopback bypass that
 * neither derives on its own. The global dispatcher does not read these; it routes by the policy.
 *
 * @param policy - the policy to publish.
 * @returns a function restoring every name this call changed.
 */
function applyPolicyEnv(policy: ProxyPolicy): () => void {
  // Snapshot EVERY name before writing any of them. Windows folds environment names case-insensitively,
  // so reading the uppercase spelling after writing the lowercase one would read back the value just
  // written and restore the policy instead of the user's environment.
  const previous = new Map<string, string | undefined>()
  for (const names of Object.values(POLICY_ENV_NAMES)) {
    for (const name of names) previous.set(name, process.env[name])
  }
  const previousInherited = inheritedProxyEnv
  inheritedProxyEnv = previousInherited ?? Object.fromEntries(previous)
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const value = policy[field as keyof typeof POLICY_ENV_NAMES]
    for (const name of names) {
      if (value === undefined || value === '') Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
    inheritedProxyEnv = previousInherited
  }
}

/**
 * Build the global dispatcher for one policy.
 *
 * Routing runs through {@link proxyForUrl} per origin, so `fetch` and every caller that asks where a
 * URL goes read the same answer from the same matcher. undici's `EnvHttpProxyAgent` cannot express
 * this policy: with no `HTTPS_PROXY` present it reuses the HTTP proxy for `https:`, which would
 * tunnel a scheme this package deliberately keeps direct after refusing the SOCKS or malformed URL
 * the user named for it — the route and the diagnostic would then disagree.
 *
 * @param policy - the policy to route by; it must proxy at least one scheme.
 * @returns the dispatcher to install, owning every per-origin agent its factory created.
 */
async function createPolicyDispatcher(policy: ProxyPolicy): Promise<Dispatcher> {
  const { Agent, Pool, ProxyAgent } = await import('undici')
  return new Agent({
    factory(origin, options) {
      // undici declares this parameter as `Object`, discarding the pool options it actually passes.
      const passed = options as Pool.Options
      const proxy = proxyForUrl(policy, new URL(origin.toString()))
      if (proxy !== undefined) return new ProxyAgent({ ...passed, uri: proxy })
      // What undici's own default factory builds for these options, which `factory` replaces
      // wholesale. It reaches for a bare `Client` only at `connections: 1`, an option this
      // dispatcher never carries: it is constructed with undici's defaults.
      return new Pool(origin, passed)
    },
  })
}

/**
 * Route this process's outbound HTTP through `policy`.
 *
 * Installing replaces undici's global dispatcher, which is what Node's built-in `fetch` resolves, so
 * every caller that issues a plain `fetch()` is covered without knowing this package exists. A policy
 * that proxies nothing installs a direct dispatcher and leaves the environment untouched.
 *
 * A worker thread has its own `globalThis` and so its own dispatcher; installing here does not
 * reach it. No worker installs one today: both this repository ships — the workflow engine and the
 * code runtime — evaluate model-authored scripts, which must not receive a proxy URL that may carry
 * credentials. A worker that needs the policy has to be handed one explicitly and install it itself.
 *
 * @param policy - the resolved policy to install.
 * @returns a disposer restoring the previous dispatcher, policy, and environment, then closing the agent.
 */
export async function installGlobalProxy(policy: ProxyPolicy): Promise<() => Promise<void>> {
  const previousPolicy = active
  if (policy.source === 'none') {
    // A direct policy mounted over an installed one must actually stop proxying. Recording the policy
    // alone would leave the previous agent as the global dispatcher, so a plain `fetch()` would keep
    // tunnelling while `proxyForUrl()` reported a direct connection — and `mode: 'off'` would be a
    // silent no-op. With nothing installed there is nothing to displace.
    if (previousPolicy === undefined) {
      active = policy
      return () => {
        active = previousPolicy
        return Promise.resolve()
      }
    }
    const undici = await import('undici')
    const previous = undici.getGlobalDispatcher()
    const direct = new undici.Agent()
    undici.setGlobalDispatcher(direct)
    active = policy
    return async () => {
      undici.setGlobalDispatcher(previous)
      active = previousPolicy
      await direct.close()
    }
  }
  const restoreEnv = applyPolicyEnv(policy)
  const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici')
  const previousDispatcher = getGlobalDispatcher()
  const agent = await createPolicyDispatcher(policy)
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
 * @param options - agent options; applied to whichever agent the policy selects. On the proxied path
 *   `connect` governs the connection to the PROXY, not to the origin, so a lookup meant to pin an
 *   origin address belongs only on a URL the policy bypasses.
 * @param policy - the policy to route by, defaulting to the active one. A caller that already
 *   branched on {@link proxyForUrl} MUST pass the same policy object it branched on: reading the
 *   active policy again would let a mount or disposal between the two reads return a direct agent
 *   for a URL the caller cleared as proxied, dropping the address checks that branch skipped.
 * @returns a dispatcher the caller owns and must close once the response body is consumed.
 */
export async function createDispatcher(
  url: URL,
  options: Agent.Options = {},
  policy: ProxyPolicy = active ?? DIRECT_POLICY,
): Promise<Dispatcher> {
  const undici = await import('undici')
  const proxy = proxyForUrl(policy, url)
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
 * The proxy environment a spawned child needs.
 *
 * A child inherits the parent environment, which this process rewrote to its own resolved policy.
 * Handing that normalization straight through would replace values the user set for other tools, so
 * each proxy name the user exported is restored to what they wrote: a SOCKS proxy `curl` uses is
 * not swapped for the HTTP one this package fell back to for that scheme.
 *
 * A scheme the user named in neither casing carries the resolved value instead of being removed.
 * Without that the child's routing silently diverges from its parent's: `NODE_USE_ENV_PROXY` reads
 * neither `ALL_PROXY` nor a proxy that came from `cordis.yml`, so the child would connect directly
 * while the parent proxies.
 *
 * The bypass list is always the resolved one. It only ever adds the loopback entries to what
 * the user wrote, so nothing is lost, and the child stops sending its own localhost traffic to a
 * proxy that cannot route it.
 *
 * The flag reaches only Node 22.21+ and 24+; an older runtime keeps that child direct. Such a child
 * also matches bypass entries with Node's own `NO_PROXY` rules, which differ from this package's in
 * their separators and IPv4-range support. Non-Node children (curl, git, pnpm) ignore the flag and
 * read the variables themselves.
 *
 * A worker thread is deliberately NOT served here — see the workflow engine, which runs
 * model-authored scripts and must not receive a proxy URL that may carry credentials.
 *
 * @returns names to apply to the child environment, where `undefined` means remove, or an empty
 *   object when no proxy is active.
 */
export function childProxyEnv(): Readonly<Record<string, string | undefined>> {
  const policy = active
  const inherited = inheritedProxyEnv
  if (policy === undefined || policy.source === 'none' || inherited === undefined) return {}
  const overlay: Record<string, string | undefined> = { NODE_USE_ENV_PROXY: '1' }
  for (const [field, names] of Object.entries(POLICY_ENV_NAMES)) {
    const resolved = policy[field as keyof typeof POLICY_ENV_NAMES]
    // Naming a scheme in either casing claims that scheme: the child then gets exactly what the
    // user wrote, in the casing they wrote it, rather than a value derived for this process.
    const named = field !== 'noProxy' && names.some(name => inherited[name] !== undefined)
    for (const name of names) overlay[name] = named ? inherited[name] : resolved
  }
  return overlay
}
