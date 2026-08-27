import { describe, expect, it } from 'vitest'
import { findDispatcherViolations, scanRepository, DISPATCHER_OWNER } from './verify-no-bare-dispatcher.ts'

const FILE = 'packages/web/web-fetch-http/src/network.ts'

function reasons(source: string, file = FILE): string[] {
  return findDispatcherViolations(file, source).map(violation => violation.what)
}

describe('bare dispatcher check', () => {
  it('rejects the shape that silently bypassed the proxy before this rule existed', () => {
    expect(reasons(`
      import { Agent } from 'undici'
      const dispatcher = new Agent({ connect: { lookup } })
      const response = await fetch(url, { dispatcher })
    `)).toEqual(['constructs an undici agent', 'passes an explicit \`dispatcher\`'])
  })

  it('rejects an explicit dispatcher option however the agent was obtained', () => {
    expect(reasons("      const response = await fetch(url, { method: 'GET', dispatcher: pooled })"))
      .toEqual(['passes an explicit \`dispatcher\`'])
  })

  it('rejects a namespaced construction', () => {
    expect(reasons(`
      import * as undici from 'undici'
      const agent = new undici.ProxyAgent(uri)
    `)).toEqual(['constructs an undici agent'])
  })

  it('reports the offending line number and text', () => {
    const source = "import { Agent } from 'undici'\nconst a = 1\nconst b = new Agent({})"
    expect(findDispatcherViolations(FILE, source)).toEqual([
      { file: FILE, line: 3, what: 'constructs an undici agent', text: 'const b = new Agent({})' },
    ])
  })

  it('accepts the sanctioned factory', () => {
    expect(reasons('      const dispatcher = await createDispatcher(url, options)')).toEqual([])
  })

  it('rejects the shorthand form a line-wise regex misses', () => {
    expect(reasons(`
      import { Agent } from 'undici'
      const dispatcher = pool
      const response = await fetch(url, { method: 'GET', dispatcher })
    `)).toEqual(['passes an explicit \`dispatcher\`'])
  })

  it('rejects a quoted dispatcher key', () => {
    expect(reasons("      await fetch(url, { 'dispatcher': pooled })"))
      .toEqual(['passes an explicit \`dispatcher\`'])
  })

  it('rejects construction through an import alias', () => {
    expect(reasons(`
      import { Agent as CustomAgent } from 'undici'
      const agent = new CustomAgent({})
    `)).toEqual(['constructs an undici agent'])
  })

  it('accepts an unrelated class that happens to be named Agent', () => {
    expect(reasons(`
      import { Agent } from './our-own-agent.ts'
      const agent = new Agent({})
    `)).toEqual([])
  })

  it('accepts an exemption annotated on the line above, where a long line puts it', () => {
    expect(reasons(`
      import { Agent } from 'undici'
      // proxy-exempt: the dispatcher already applied the active policy.
      const response = await fetch(url, { method: 'GET', headers, dispatcher })
    `)).toEqual([])
  })

  it('accepts an annotated exemption', () => {
    expect(reasons(`
      import { Agent } from 'undici'
      const agent = new Agent({}) // proxy-exempt: loopback transport for the local test server
    `)).toEqual([])
  })

  it('exempts the package that owns dispatcher construction', () => {
    expect(reasons("import { EnvHttpProxyAgent } from 'undici'\nconst agent = new EnvHttpProxyAgent()", `${DISPATCHER_OWNER}src/install.ts`)).toEqual([])
  })

  it('normalizes native separators before exempting the owning package', () => {
    expect(reasons("import { Agent } from 'undici'\nconst agent = new Agent({})", DISPATCHER_OWNER.replaceAll('/', '\\') + 'src\\install.ts')).toEqual([])
  })

  it('passes on the current tree', () => {
    expect(scanRepository()).toEqual([])
  })
})
