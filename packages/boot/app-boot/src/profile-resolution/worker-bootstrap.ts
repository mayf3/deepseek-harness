/** Install an inherited profile resolution generation in one Harness-owned Worker. */

import { getEnvironmentData } from 'node:worker_threads'
import { installProfileResolution, type ProfileResolutionBehavior } from './resolver.ts'
import type { ProfileResolutionGeneration } from '../profile.ts'

const registration = getEnvironmentData(
  '@deepseek-ai/dsh-app-boot/profile-resolution',
) as {
  generation: ProfileResolutionGeneration
  behavior: ProfileResolutionBehavior
  nativeCacheDir?: string
} | undefined
if (registration !== undefined) {
  const previous = process.env.NARB_NATIVE_CACHE_DIR
  if (registration.nativeCacheDir !== undefined) process.env.NARB_NATIVE_CACHE_DIR = registration.nativeCacheDir
  try {
    installProfileResolution(registration.generation, registration.behavior)
  } finally {
    if (previous === undefined) delete process.env.NARB_NATIVE_CACHE_DIR
    else process.env.NARB_NATIVE_CACHE_DIR = previous
  }
}
