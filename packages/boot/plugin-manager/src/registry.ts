/**
 * Which registries one package operation asks, in order, and whether a failed
 * attempt sends it to the next one. A registry is asked with pnpm's
 * `--registry`; `null` is the one pnpm's own configuration names.
 * @module @deepseek-ai/dsh-plugin-manager/registry
 */

import type { ParsedInstallSpec } from './install-spec.ts'
import type { PluginInstallFailureKind, PluginRegistries, Registry } from './types.ts'

/**
 * Parse a registry URL into the form pnpm compares registries in: lower-case host, trailing slash.
 * @param url - the registry as configured or requested.
 * @returns the normalized URL.
 * @throws {Error} for anything but an http(s) URL.
 */
export function normalizeRegistry(url: string): string {
  let parsed: URL | undefined
  try { parsed = new URL(url) }
  catch { /* named below: only an http(s) URL is a registry */ }
  if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(`a registry must be an http(s) URL: ${url}`)
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.href
}

/**
 * The registries one operation asks, first to last.
 * @param requested - the caller's registry; undefined defers to the configured first one.
 * @param configured - the configured first registry and the fallbacks after it.
 * @returns the requested or configured registry first, then the rest of the configured set; a requested
 * registry outside that set is asked alone, so a private registry never falls through to a public one.
 */
export function registryPlan(requested: Registry | undefined, configured: PluginRegistries): Registry[] {
  const normalize = (registry: Registry): Registry => registry === null ? null : normalizeRegistry(registry)
  const known: Registry[] = []
  for (const registry of [configured.registry, ...configured.fallbackRegistries]) {
    const normalized = normalize(registry)
    if (!known.includes(normalized)) known.push(normalized)
  }
  const first = normalize(requested === undefined ? configured.registry : requested)
  if (!known.includes(first)) return [first]
  return [first, ...known.filter(registry => registry !== first)]
}

/** The failures after which another registry can answer differently: this one was unreachable, or its copy may be stale. */
const NEXT_REGISTRY_KINDS: ReadonlySet<PluginInstallFailureKind> = new Set(['network', 'timeout', 'not-found', 'no-matching-version'])

/**
 * Whether the next registry is worth asking after a failed attempt.
 * @param kind - how the attempt failed.
 * @param log - what the attempt printed.
 * @param spec - the spec the attempt installed.
 * @returns true for a failure another registry can change; false for one it cannot, and for a failure that
 * names the host a git or tarball spec is fetched from, which no registry stands in for.
 */
export function askNextRegistry(kind: PluginInstallFailureKind, log: string, spec: ParsedInstallSpec): boolean {
  if (!NEXT_REGISTRY_KINDS.has(kind)) return false
  const host = spec.kind === 'git' || spec.kind === 'tarball' ? spec.host : undefined
  return host === undefined || !log.toLowerCase().includes(host.toLowerCase())
}
