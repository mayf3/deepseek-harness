import { describe, expect, it } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  bypassesProxy,
  describeProxyPolicy,
  proxyForUrl,
  resolveProxyPolicy,
  DIRECT_POLICY,
} from '../src/policy.ts'

const PROXY = 'http://127.0.0.1:7897'
const OTHER = 'http://127.0.0.1:8080'

function env(values: Record<string, string>): ReturnType<typeof createLaunchEnvironmentSnapshot> {
  return createLaunchEnvironmentSnapshot([{ source: 'process', values }])
}

/** Windows folds environment names, so a case distinction cannot be expressed there at all. */
const FOLDS_ENV_CASE = process.platform === 'win32'

describe('resolveProxyPolicy', () => {
  it('resolves nothing when the environment carries no proxy', () => {
    const { policy, diagnostics } = resolveProxyPolicy(env({}))
    expect(policy).toEqual(DIRECT_POLICY)
    expect(diagnostics).toEqual([])
  })

  it('reads both schemes and merges loopback into the bypass list', () => {
    const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: PROXY, HTTPS_PROXY: OTHER, NO_PROXY: 'example.com' }))
    expect(policy.httpProxy).toBe(PROXY)
    expect(policy.httpsProxy).toBe(OTHER)
    expect(policy.noProxy).toBe('example.com,localhost,127.0.0.1,::1,[::1]')
    expect(policy.source).toBe('env')
  })

  it('prefers the lowercase name, matching undici', () => {
    const { policy } = resolveProxyPolicy(env({ http_proxy: PROXY, HTTP_PROXY: OTHER }))
    // Windows has no such preference to express: the launch snapshot folds names, so the two
    // spellings are one variable there and the later entry is simply the value. Asserted rather
    // than skipped, so a change to that folding fails here instead of passing unnoticed.
    expect(policy.httpProxy).toBe(FOLDS_ENV_CASE ? OTHER : PROXY)
  })

  it('treats a blank lowercase value as unset instead of letting it shadow the uppercase one', () => {
    const { policy } = resolveProxyPolicy(env({ http_proxy: '   ', HTTP_PROXY: PROXY }))
    expect(policy.httpProxy).toBe(PROXY)
  })

  it('backs both schemes with ALL_PROXY, which neither Node nor undici reads', () => {
    const { policy } = resolveProxyPolicy(env({ ALL_PROXY: PROXY }))
    expect(policy.httpProxy).toBe(PROXY)
    expect(policy.httpsProxy).toBe(PROXY)
  })

  it('lets a scheme-specific value outrank ALL_PROXY', () => {
    const { policy } = resolveProxyPolicy(env({ ALL_PROXY: PROXY, HTTPS_PROXY: OTHER }))
    expect(policy.httpProxy).toBe(PROXY)
    expect(policy.httpsProxy).toBe(OTHER)
  })

  it('falls HTTPS back to the HTTP proxy last, so the dispatcher and proxyForUrl agree', () => {
    const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: PROXY }))
    expect(policy.httpsProxy).toBe(PROXY)
  })

  it('keeps a bypass list of * unchanged', () => {
    const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: PROXY, NO_PROXY: '*' }))
    expect(policy.noProxy).toBe('*')
  })

  it('does not repeat a loopback entry the user already listed', () => {
    const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: PROXY, NO_PROXY: 'localhost, 127.0.0.1' }))
    expect(policy.noProxy).toBe('localhost,127.0.0.1,::1,[::1]')
  })

  it('keeps a scheme direct when its own value was refused, rather than falling back', () => {
    const { policy, diagnostics } = resolveProxyPolicy(env({ HTTPS_PROXY: 'socks5://127.0.0.1:1080', HTTP_PROXY: PROXY }))
    expect(policy.httpProxy).toBe(PROXY)
    // The diagnostic says HTTPS connects directly; the route must agree rather than borrowing the
    // HTTP proxy the user never named for HTTPS.
    expect(policy.httpsProxy).toBeUndefined()
    expect(proxyForUrl(policy, new URL('https://example.com/'))).toBeUndefined()
    expect(diagnostics[0]?.message).toMatch(/connecting directly for that scheme/)
  })

  it('keeps a scheme direct when its own value was malformed, past ALL_PROXY too', () => {
    const { policy } = resolveProxyPolicy(env({ HTTPS_PROXY: 'not a url', ALL_PROXY: PROXY }))
    expect(policy.httpProxy).toBe(PROXY)
    expect(policy.httpsProxy).toBeUndefined()
  })

  it('reports a SOCKS proxy instead of silently ignoring it', () => {
    const { policy, diagnostics } = resolveProxyPolicy(env({ HTTP_PROXY: 'socks5://127.0.0.1:7890' }))
    expect(policy).toEqual(DIRECT_POLICY)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.kind).toBe('socks')
    expect(diagnostics[0]?.message).toMatch(/SOCKS proxy, which is not supported/)
  })

  it('reports an unparseable proxy URL', () => {
    const { policy, diagnostics } = resolveProxyPolicy(env({ HTTP_PROXY: 'not a url' }))
    expect(policy).toEqual(DIRECT_POLICY)
    expect(diagnostics[0]?.kind).toBe('invalid')
    // The origin names the spelling resolution asked for, which on a folded environment is the
    // lowercase one it tries first — the same variable the user set, reported in the other case.
    expect(diagnostics[0]?.origin).toBe(FOLDS_ENV_CASE ? 'http_proxy' : 'HTTP_PROXY')
  })

  it('reports a proxy URL whose scheme is neither http(s) nor SOCKS', () => {
    const { diagnostics } = resolveProxyPolicy(env({ HTTP_PROXY: 'ftp://proxy.example' }))
    expect(diagnostics[0]?.message).toMatch(/unsupported ftp:\/\/ scheme/)
  })

  it('lets configuration fill a gap the environment leaves', () => {
    const { policy } = resolveProxyPolicy(env({}), { httpProxy: PROXY, noProxy: 'internal.example' })
    expect(policy.httpProxy).toBe(PROXY)
    expect(policy.httpsProxy).toBe(PROXY)
    expect(policy.noProxy).toBe('internal.example,localhost,127.0.0.1,::1,[::1]')
    expect(policy.source).toBe('config')
  })

  it('takes each scheme from its own configured field', () => {
    const { policy } = resolveProxyPolicy(env({}), { httpProxy: PROXY, httpsProxy: OTHER })
    expect(policy.httpProxy).toBe(PROXY)
    expect(policy.httpsProxy).toBe(OTHER)
    expect(policy.source).toBe('config')
  })

  it('lets the environment outrank configuration', () => {
    const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: PROXY }), { httpProxy: OTHER })
    expect(policy.httpProxy).toBe(PROXY)
    expect(policy.source).toBe('env')
  })

  it('names configuration as the origin of a rejected configured value', () => {
    const { diagnostics } = resolveProxyPolicy(env({}), { httpsProxy: 'socks5://127.0.0.1:1080' })
    expect(diagnostics[0]?.origin).toBe('config.httpsProxy')
  })

  it('ignores every source under mode off', () => {
    const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: PROXY }), { mode: 'off' })
    expect(policy).toEqual(DIRECT_POLICY)
  })
})

describe('bypassesProxy', () => {
  const cases: [string, string, boolean][] = [
    ['example.com', 'http://example.com/a', true],
    ['example.com', 'http://sub.example.com/a', true],
    ['example.com', 'http://notexample.com/a', false],
    ['.example.com', 'http://sub.example.com/a', true],
    ['*.example.com', 'http://sub.example.com/a', true],
    ['example.com', 'http://example.com./a', true],
    ['*', 'http://anything.example/a', true],
    ['example.com:8080', 'http://example.com:8080/a', true],
    ['example.com:8080', 'http://example.com:9090/a', false],
    ['example.com:80', 'http://example.com/a', true],
    ['example.com:443', 'https://example.com/a', true],
    ['EXAMPLE.com', 'http://example.COM/a', true],
    ['localhost', 'http://localhost:3000/a', true],
    ['127.0.0.1', 'http://127.0.0.1:7777/a', true],
  ]
  it.each(cases)('bypass %j against %j is %s', (noProxy, url, expected) => {
    expect(bypassesProxy(noProxy, new URL(url))).toBe(expected)
  })

  it('bypasses a bare IPv6 loopback, which undici reads as host ":" port "1"', () => {
    expect(bypassesProxy('::1', new URL('http://[::1]:3000/a'))).toBe(true)
  })

  it('bypasses the bracketed IPv6 form as well', () => {
    expect(bypassesProxy('[::1]', new URL('http://[::1]/a'))).toBe(true)
  })

  it('honors a port on a bracketed IPv6 entry', () => {
    expect(bypassesProxy('[::1]:3000', new URL('http://[::1]:3000/a'))).toBe(true)
    expect(bypassesProxy('[::1]:3000', new URL('http://[::1]:4000/a'))).toBe(false)
  })

  it('does not match CIDR notation, so an OS bypass list must be rewritten as suffixes', () => {
    expect(bypassesProxy('10.0.0.0/8', new URL('http://10.1.2.3/a'))).toBe(false)
  })

  it('skips blank and bracket-only entries', () => {
    expect(bypassesProxy(' , , [ , .', new URL('http://example.com/a'))).toBe(false)
  })
})

describe('proxyForUrl', () => {
  const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: PROXY, HTTPS_PROXY: OTHER, NO_PROXY: 'direct.example' }))

  it('routes http through the http proxy', () => {
    expect(proxyForUrl(policy, new URL('http://example.com/'))).toBe(PROXY)
  })

  it('routes https through the https proxy', () => {
    expect(proxyForUrl(policy, new URL('https://example.com/'))).toBe(OTHER)
  })

  it('returns nothing for a bypassed host', () => {
    expect(proxyForUrl(policy, new URL('https://direct.example/'))).toBeUndefined()
  })

  it('returns nothing for loopback, which is always bypassed', () => {
    expect(proxyForUrl(policy, new URL('http://127.0.0.1:9000/'))).toBeUndefined()
  })

  it('returns nothing for a non-http scheme', () => {
    expect(proxyForUrl(policy, new URL('ws://example.com/'))).toBeUndefined()
  })

  it('returns nothing under a direct policy', () => {
    expect(proxyForUrl(DIRECT_POLICY, new URL('https://example.com/'))).toBeUndefined()
  })
})

describe('describeProxyPolicy', () => {
  it('names a direct policy', () => {
    expect(describeProxyPolicy(DIRECT_POLICY)).toBe('no proxy (direct)')
  })

  it('replaces the password and keeps the username', () => {
    const { policy } = resolveProxyPolicy(env({ HTTP_PROXY: 'http://alice:s3cret@proxy.example:8080' }))
    const described = describeProxyPolicy(policy)
    expect(described).toContain('alice')
    expect(described).toContain('***')
    expect(described).not.toContain('s3cret')
  })

  it('reports a scheme left direct', () => {
    expect(describeProxyPolicy({ httpsProxy: PROXY, noProxy: '', source: 'env' })).toContain('http=direct')
    expect(describeProxyPolicy({ httpProxy: PROXY, noProxy: '', source: 'env' })).toContain('https=direct')
  })

  it('resolves an https-only environment without an http proxy', () => {
    const { policy } = resolveProxyPolicy(env({ HTTPS_PROXY: PROXY }))
    expect(policy.httpProxy).toBeUndefined()
    expect(policy.httpsProxy).toBe(PROXY)
  })
})
