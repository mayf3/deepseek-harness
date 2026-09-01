/**
 * Outbound HTTP proxy support for DeepSeek Harness.
 *
 * Node's built-in `fetch` ignores `HTTP_PROXY` and friends, so every harness request would connect
 * directly no matter what the user exported. This library resolves one policy from the launch
 * environment and installs it as undici's global dispatcher, which is what `fetch` resolves — so
 * LLM adapters, web search, MCP over HTTP, telemetry, and sandbox SDKs are all covered without
 * touching their code.
 *
 * The launcher resolves and installs once, before the first plugin mounts. This is a library, not a
 * plugin: transport policy has one answer per process, so there is nothing for a composition to
 * mount, swap, or scope.
 *
 * Six exports, one per way a caller can need the policy: resolve it, install it, get a dispatcher
 * for a request, get a `node:http` agent for an SDK that takes one, get a proxy URL for an SDK that
 * takes that, and get the environment a spawned child needs.
 * @module @deepseek-ai/dsh-http-proxy
 */

export {
  proxyForUrl,
  resolveProxyPolicy,
  PROXY_ENV_NAMES,
  type EnvLookup,
  type ProxyDiagnostic,
  type ProxyPolicy,
  type ProxyResolution,
} from './policy.ts'

export {
  childProxyEnv,
  createDispatcher,
  createNodeHttpAgent,
  currentProxyPolicy,
  installGlobalProxy,
  proxyUrlFor,
} from './install.ts'
