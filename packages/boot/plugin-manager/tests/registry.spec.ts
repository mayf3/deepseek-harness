/** Which registries an operation asks, in order, and when a failed attempt sends it to the next one: pure, table-driven. */

import { describe, expect, it } from 'vitest'
import { askNextRegistry, normalizeRegistry, parseInstallSpec, registryPlan } from '@deepseek-ai/dsh-plugin-manager'

const MIRROR = 'https://registry.npmmirror.com/'
const CORP = 'https://npm.corp.example/'

describe('normalizeRegistry', () => {
  it('parses an http(s) URL into pnpm\'s comparison form: lower-case host, trailing slash', () => {
    expect(normalizeRegistry('https://REGISTRY.npmmirror.com')).toBe(MIRROR)
    expect(normalizeRegistry('http://npm.corp.example:4873/prefix')).toBe('http://npm.corp.example:4873/prefix/')
    expect(normalizeRegistry(MIRROR)).toBe(MIRROR)
  })

  it('refuses anything but an http(s) URL', () => {
    for (const url of ['registry.npmmirror.com', 'ftp://x/', 'file:///tmp', '', 'https://']) {
      expect(() => normalizeRegistry(url), url).toThrow(/http\(s\) URL/)
    }
  })
})

describe('registryPlan', () => {
  const configured = { registry: null, fallbackRegistries: [MIRROR] }

  it('asks the configured registry first, then the fallbacks', () => {
    expect(registryPlan(undefined, configured)).toEqual([null, MIRROR])
  })

  it('moves a requested registry to the front when it is one of the configured set', () => {
    expect(registryPlan(MIRROR, configured)).toEqual([MIRROR, null])
    expect(registryPlan('https://REGISTRY.npmmirror.com', configured)).toEqual([MIRROR, null])
    expect(registryPlan(null, { registry: MIRROR, fallbackRegistries: [] })).toEqual([null])
  })

  it('asks a registry outside the configured set alone, never followed by a public one', () => {
    expect(registryPlan(CORP, configured)).toEqual([CORP])
    expect(registryPlan(undefined, { registry: CORP, fallbackRegistries: [] })).toEqual([CORP])
    expect(registryPlan(undefined, { registry: CORP, fallbackRegistries: [MIRROR] })).toEqual([CORP, MIRROR])
  })

  it('lists each registry once', () => {
    expect(registryPlan(undefined, { registry: MIRROR, fallbackRegistries: [MIRROR, CORP] })).toEqual([MIRROR, CORP])
  })
})

describe('askNextRegistry', () => {
  const name = parseInstallSpec('dsh-x')
  const git = parseInstallSpec('github:acme/dsh-x')
  const tarball = parseInstallSpec('https://cdn.example.com/dsh-x-1.0.0.tgz')
  const registryLog = 'ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/dsh-x: getaddrinfo ENOTFOUND registry.npmjs.org'

  it('asks the next registry when this one was unreachable or may hold a stale copy', () => {
    for (const kind of ['network', 'timeout', 'not-found', 'no-matching-version'] as const) {
      expect(askNextRegistry(kind, registryLog, name), kind).toBe(true)
    }
  })

  it('stops on failures no other registry would change', () => {
    for (const kind of ['build-blocked', 'disk-full', 'permission', 'integrity', 'pnpm-missing', 'unknown'] as const) {
      expect(askNextRegistry(kind, registryLog, name), kind).toBe(false)
    }
  })

  it('keeps a failure that names the host a git or tarball spec is fetched from with that spec', () => {
    expect(askNextRegistry('network', 'fatal: unable to access \'https://github.com/acme/dsh-x/\': Could not resolve host: github.com', git)).toBe(false)
    expect(askNextRegistry('network', 'ssh: Could not resolve hostname GITHUB.COM: nodename nor servname provided', git)).toBe(false)
    expect(askNextRegistry('network', 'ERR_PNPM_FETCH_502  GET https://cdn.example.com/dsh-x-1.0.0.tgz: Bad Gateway', tarball)).toBe(false)
    // The same specs' dependencies still come from the registry.
    expect(askNextRegistry('network', registryLog, git)).toBe(true)
    expect(askNextRegistry('network', registryLog, tarball)).toBe(true)
    expect(askNextRegistry('not-found', 'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/left-pad: Not Found - 404', git)).toBe(true)
  })

  it('reads a failure that names no host as the registry\'s', () => {
    expect(askNextRegistry('network', 'ECONNRESET', git)).toBe(true)
    expect(askNextRegistry('network', 'socket hang up', name)).toBe(true)
  })
})
