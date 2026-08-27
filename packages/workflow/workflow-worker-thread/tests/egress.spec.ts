import { describe, expect, it } from 'vitest'
import { PROXY_ENV_NAMES, installGlobalProxy, type ProxyPolicy } from '@deepseek-ai/dsh-http-proxy'
import { workerSpawnEnv } from '../src/host.ts'

/** A policy carrying credentials, the shape that must never reach model-authored code. */
const CREDENTIALED: ProxyPolicy = {
  httpProxy: 'http://alice:s3cret@proxy.example:8080',
  httpsProxy: 'http://alice:s3cret@proxy.example:8080',
  noProxy: '',
  source: 'env',
}

describe('workflow worker egress', () => {
  it('hands the worker no proxy configuration, credentialed or not', async () => {
    const dispose = await installGlobalProxy(CREDENTIALED)
    try {
      const env = workerSpawnEnv()
      // The worker executes the model-authored script body, so a proxy URL that may carry
      // `user:password` must not be readable from its environment.
      for (const name of PROXY_ENV_NAMES) expect(env).not.toHaveProperty(name)
      expect(env).not.toHaveProperty('NODE_USE_ENV_PROXY')
      expect(JSON.stringify(env)).not.toContain('s3cret')
    } finally {
      await dispose()
    }
  })

  it('still carries the platform temp path the worker needs on Windows', () => {
    expect(workerSpawnEnv('win32')).toHaveProperty('TMP')
  })
})
