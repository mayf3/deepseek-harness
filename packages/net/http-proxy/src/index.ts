/**
 * Outbound HTTP proxy support for DeepSeek Harness.
 *
 * Node's built-in `fetch` ignores `HTTP_PROXY` and friends, so every harness request would connect
 * directly no matter what the user exported. This package resolves one policy from the launch
 * environment and installs it as undici's global dispatcher, which is what `fetch` resolves — so
 * LLM adapters, web search, MCP over HTTP, telemetry, and sandbox SDKs are all covered without
 * touching their code.
 *
 * The launcher installs the environment-derived policy for every profile. This plugin exists for a
 * composition that wants the policy in `cordis.yml` instead: it replaces the launcher's dispatcher
 * for as long as it is mounted, and restores it on disposal. It is not part of any shipped bundle,
 * so the default path installs exactly once.
 * @module @deepseek-ai/dsh-http-proxy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { installGlobalProxy } from './install.ts'
import { describeProxyPolicy, resolveProxyPolicy, type ProxyConfig } from './policy.ts'

export {
  bypassesProxy,
  describeProxyPolicy,
  proxyForUrl,
  resolveProxyPolicy,
  DIRECT_POLICY,
  LOOPBACK_NO_PROXY,
  PROXY_ENV_NAMES,
  type ProxyConfig,
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

/** Cordis plugin name. */
export const name = 'http-proxy'

/** Composition-declared proxy settings; every field is optional and the environment outranks them. */
export interface Config extends ProxyConfig {}

/** Schema for {@link Config}; a malformed proxy URL here fails the load rather than warning. */
export const Config: z<Config> = z.object({
  mode: z.union([z.const('env'), z.const('custom'), z.const('off')]).description(
    'Whether to resolve from the environment (`env`, the default), do the same for a composition that supplies its own proxy (`custom`), or keep this process direct (`off`).',
  ),
  httpProxy: z.string().description('Proxy for `http:` origins when the environment supplies none.'),
  httpsProxy: z.string().description('Proxy for `https:` origins when the environment supplies none.'),
  noProxy: z.string().description('Bypass list when the environment supplies none; loopback is always added.'),
})

/**
 * Install the composition's proxy policy for as long as this plugin is mounted.
 *
 * A value this plugin's own `Config` supplied and that failed validation throws: it is the harness's
 * configuration surface, where a typo must be loud. A rejected *environment* value only warns,
 * because the same variable may have been exported for other tools and must not stop the agent from
 * starting.
 *
 * Installing IS this plugin's lifetime, so the disposer is returned as the startup effect rather than
 * registered through `ctx.effect()`: a caller awaiting the mount must observe an installed dispatcher,
 * which a separately-scheduled async effect would not guarantee.
 *
 * @param ctx - the mounting context, read for the launch environment snapshot and the logger.
 * @param config - composition-declared settings.
 * @returns the disposer restoring the previous dispatcher, policy, and environment.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  const { policy, diagnostics } = resolveProxyPolicy(launchEnvironmentOf(ctx), config)
  const fatal = diagnostics.filter(diagnostic => diagnostic.origin.startsWith('config.'))
  if (fatal.length > 0) {
    throw new Error(`http-proxy: ${fatal.map(diagnostic => diagnostic.message).join('; ')}`)
  }
  for (const diagnostic of diagnostics) ctx.logger.warn('http-proxy: %s', diagnostic.message)
  if (policy.source !== 'none') ctx.logger.debug('http-proxy: %s', describeProxyPolicy(policy))
  return await installGlobalProxy(policy)
}
