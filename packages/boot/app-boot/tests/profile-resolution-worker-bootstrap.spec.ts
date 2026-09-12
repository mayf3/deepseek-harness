/** Worker bootstrap installs only the generation inherited from its parent. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProfileResolutionGeneration } from '../src/profile.ts'

const harness = vi.hoisted(() => ({
  data: undefined as {
    generation: ProfileResolutionGeneration
    behavior: 'enforce' | 'verify'
    nativeCacheDir?: string
  } | undefined,
  install: vi.fn(),
}))

let previousNativeCacheDir: string | undefined

vi.mock('node:worker_threads', () => ({
  getEnvironmentData: () => harness.data,
}))

vi.mock('../src/profile-resolution/resolver.ts', () => ({
  installProfileResolution: harness.install,
}))

beforeEach(() => {
  previousNativeCacheDir = process.env.NARB_NATIVE_CACHE_DIR
  delete process.env.NARB_NATIVE_CACHE_DIR
  harness.data = undefined
  harness.install.mockReset()
  vi.resetModules()
})

afterEach(() => {
  if (previousNativeCacheDir === undefined) delete process.env.NARB_NATIVE_CACHE_DIR
  else process.env.NARB_NATIVE_CACHE_DIR = previousNativeCacheDir
})

it('does nothing without inherited profile resolution data', async () => {
  await import('../src/profile-resolution/worker-bootstrap.ts')
  expect(harness.install).not.toHaveBeenCalled()
})

it('installs the inherited generation and behavior', async () => {
  const generation: ProfileResolutionGeneration = {
    profilesDir: '/profiles',
    profileDir: '/profiles/test',
    localPackageNames: [],
    entries: [],
  }
  harness.data = { generation, behavior: 'verify', nativeCacheDir: '/private/native-cache' }
  harness.install.mockImplementation(() => {
    expect(process.env.NARB_NATIVE_CACHE_DIR).toBe('/private/native-cache')
  })
  await import('../src/profile-resolution/worker-bootstrap.ts')
  expect(harness.install).toHaveBeenCalledWith(generation, 'verify')
  expect(process.env.NARB_NATIVE_CACHE_DIR).toBeUndefined()
})

it('restores an existing native-cache environment value after bootstrap', async () => {
  const generation: ProfileResolutionGeneration = {
    profilesDir: '/profiles',
    profileDir: '/profiles/test',
    localPackageNames: [],
    entries: [],
  }
  process.env.NARB_NATIVE_CACHE_DIR = '/existing/native-cache'
  harness.data = { generation, behavior: 'enforce' }
  await import('../src/profile-resolution/worker-bootstrap.ts')
  expect(process.env.NARB_NATIVE_CACHE_DIR).toBe('/existing/native-cache')
})
