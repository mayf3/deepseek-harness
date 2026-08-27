import { describe, expect, it } from 'vitest'
import { findDispatcherViolations, scanRepository, DISPATCHER_OWNER } from './verify-no-bare-dispatcher.ts'

const FILE = 'packages/web/web-fetch-http/src/network.ts'

function reasons(source: string, file = FILE): string[] {
  return findDispatcherViolations(file, source).map(violation => violation.what)
}

describe('bare dispatcher check', () => {
  it('rejects the shape that silently bypassed the proxy before this rule existed', () => {
    expect(reasons(`
      const dispatcher = new Agent({ connect: { lookup } })
      const response = await fetch(url, { dispatcher })
    `)).toEqual(['constructs an undici agent'])
  })

  it('rejects an explicit dispatcher option however the agent was obtained', () => {
    expect(reasons("      const response = await fetch(url, { method: 'GET', dispatcher: pooled })"))
      .toEqual(['passes an explicit `dispatcher`'])
  })

  it('rejects a namespaced construction', () => {
    expect(reasons('      const agent = new undici.ProxyAgent(uri)')).toEqual(['constructs an undici agent'])
  })

  it('reports the offending line number and text', () => {
    expect(findDispatcherViolations(FILE, 'const a = 1\nconst b = new Agent({})')).toEqual([
      { file: FILE, line: 2, what: 'constructs an undici agent', text: 'const b = new Agent({})' },
    ])
  })

  it('accepts the sanctioned factory', () => {
    expect(reasons('      const dispatcher = await createDispatcher(url, options)')).toEqual([])
  })

  it('accepts an annotated exemption', () => {
    expect(reasons('      const agent = new Agent({}) // proxy-exempt: loopback transport for the local test server'))
      .toEqual([])
  })

  it('exempts the package that owns dispatcher construction', () => {
    expect(reasons('const agent = new EnvHttpProxyAgent()', `${DISPATCHER_OWNER}src/install.ts`)).toEqual([])
  })

  it('normalizes native separators before exempting the owning package', () => {
    expect(reasons('const agent = new Agent({})', DISPATCHER_OWNER.replaceAll('/', '\\') + 'src\\install.ts')).toEqual([])
  })

  it('passes on the current tree', () => {
    expect(scanRepository()).toEqual([])
  })
})
