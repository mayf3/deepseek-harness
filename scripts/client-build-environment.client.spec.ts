import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientBuildEnvironmentDefines } from './client-build-environment.ts'
import { clientBundle } from '../packages/client/tsdown.client.ts'

const root = resolve(import.meta.dirname, '..')
const PROBE_NAME = 'DSH_CLIENT_BUILD_TEST'
const PROBE_KEY = `process.env.${PROBE_NAME}`
const originalProbe = process.env[PROBE_NAME]
const dshBuildWorkflows = [
  'build-exe-for-python-sdk.yml',
  'ci.yml',
  'e2b-e2e.yml',
  'e2e.yml',
  'release.yml',
  'sandbox.yml',
]

afterEach(() => {
  if (originalProbe === undefined) Reflect.deleteProperty(process.env, PROBE_NAME)
  else process.env[PROBE_NAME] = originalProbe
  vi.resetModules()
})

describe('client build environment', () => {
  it('defines only public client values over a non-enumerable fallback', () => {
    expect(clientBuildEnvironmentDefines({
      PATH: '/bin',
      DSH_TEST_API_KEY: 'secret',
      DSH_CLIENT_VARIANT: 'quoted "value"',
      DSH_CLIENT_EMPTY: '',
      DSH_CLIENT_UNSET: undefined,
    })).toEqual({
      'process.env': '{}',
      'process.env.DSH_CLIENT_EMPTY': '""',
      'process.env.DSH_CLIENT_VARIANT': '"quoted \\"value\\""',
    })
  })

  it('feeds the same build-process value to dynamic tsdown bundles and the Vite shell', async () => {
    process.env[PROBE_NAME] = 'shared-value'

    const configs = clientBundle('@deepseek-ai/dsh-client-ui-sidebar', [
      'lib/types/index.js',
      'lib/types/invariant.js',
    ])({ env: { DSH_BUILD_FACE: 'client' } })
    if (!Array.isArray(configs)) throw new TypeError('client bundle config must be an array')
    const dynamic = configs.find(config => config.name === '@deepseek-ai/dsh-client-ui-sidebar/client')
    expect(dynamic?.define).toMatchObject({
      'process.env': '{}',
      [PROBE_KEY]: '"shared-value"',
    })

    const viteConfigPath = '../apps/web/vite.config.ts'
    const viteModule: unknown = await import(viteConfigPath)
    if (typeof viteModule !== 'object' || viteModule === null) {
      throw new TypeError('web Vite config module must be an object')
    }
    const viteConfig: unknown = Reflect.get(viteModule, 'default')
    if (typeof viteConfig === 'function') throw new TypeError('web Vite config must be an object')
    if (typeof viteConfig !== 'object' || viteConfig === null) {
      throw new TypeError('web Vite config must be an object')
    }
    expect(Reflect.get(viteConfig, 'define')).toMatchObject({
      'process.env': '{}',
      [PROBE_KEY]: '"shared-value"',
    })
  })

  it('sets the official client build variant in DSH artifact build workflows', () => {
    for (const name of dshBuildWorkflows) {
      const path = `.github/workflows/${name}`
      const document: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
      if (typeof document !== 'object' || document === null || Array.isArray(document)) {
        throw new TypeError(`${path} must contain a workflow object`)
      }
      const environment: unknown = Reflect.get(document, 'env')
      expect(environment, path).toMatchObject({ DSH_CLIENT_BRAND: 'official' })
    }
  })
})
