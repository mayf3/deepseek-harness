import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { lookupIpCountry } from '../src/index.ts'

it('uses the configured Host proxy for the country request', async () => {
  const seen: string[] = []
  const proxy = createServer((request, response) => {
    seen.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"country":"CN","ip":"203.0.113.1"}')
  })
  await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
  try {
    const address = proxy.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener')
    const dispose = await installProxyFromEnvironment({
      get: name => name === 'HTTP_PROXY' ? { value: `http://127.0.0.1:${address.port}` } : undefined,
    }, () => undefined)
    try {
      expect(await lookupIpCountry({
        endpoint: 'http://country.invalid/', maxResponseBytes: 4096, signal: AbortSignal.timeout(10000),
      })).toBe('CN')
      expect(seen).toEqual(['http://country.invalid/'])
    } finally {
      await dispose()
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => { if (error === undefined) resolve(); else reject(error) })
      proxy.closeAllConnections()
    })
  }
})
