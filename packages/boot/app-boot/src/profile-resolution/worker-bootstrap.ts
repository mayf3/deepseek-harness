/** Install an inherited profile resolution generation in one Harness-owned Worker. */

import { getEnvironmentData } from 'node:worker_threads'
import { installProfileResolution } from './resolver.ts'
import type { ProfileResolutionGeneration } from '../profile.ts'

const registration = getEnvironmentData(
  '@deepseek-ai/dsh-app-boot/profile-resolution',
) as {
  generation: ProfileResolutionGeneration
} | undefined
if (registration !== undefined) installProfileResolution(registration.generation)
