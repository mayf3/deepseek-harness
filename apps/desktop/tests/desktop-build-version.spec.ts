import { describe, expect, it } from 'vitest'
import {
  DESKTOP_BUILD_VERSION_ENV,
  resolveDesktopBuildVersion,
  validateDesktopBuildVersion,
} from '../scripts/desktop-build-version.mjs'

const PRODUCT = '0.1.6-alpha.2'

describe('desktop release id', () => {
  it('publishes the product version when no identifier is present', () => {
    expect(resolveDesktopBuildVersion({}, PRODUCT)).toBe(PRODUCT)
    expect(resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: '   ' }, PRODUCT)).toBe(PRODUCT)
  })

  it.each(['0.1.6-alpha.2.20260921.1', '0.1.6-alpha.2.20260921.12', '0.1.6-alpha.2.nightly'])(
    'accepts %s as an extension of the product prerelease', (releaseId) => {
      expect(resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: releaseId }, PRODUCT)).toBe(releaseId)
      expect(validateDesktopBuildVersion(releaseId, PRODUCT)).toBe(releaseId)
    })

  it('accepts the product version itself', () => {
    expect(validateDesktopBuildVersion(PRODUCT, PRODUCT)).toBe(PRODUCT)
  })

  it.each(['', 'nightly', '0.1.6-alpha.2.'])(
    'rejects %j as a version', (releaseId) => {
      expect(() => validateDesktopBuildVersion(releaseId, PRODUCT)).toThrow(/is not a version/u)
    })

  it('normalizes what the artifacts carry, so validation and publication agree', () => {
    expect(validateDesktopBuildVersion('v0.1.6-alpha.2.1', PRODUCT)).toBe('0.1.6-alpha.2.1')
  })

  it('rejects build metadata, which does not affect updater precedence', () => {
    expect(() => validateDesktopBuildVersion('0.1.6-alpha.2.1+build', PRODUCT)).toThrow(/build metadata/u)
  })

  it.each(['0.1.7-alpha.2.20260921.1', '0.2.6-alpha.2.20260921.1'])(
    'rejects %s because it leaves the product release numbers', (releaseId) => {
      expect(() => validateDesktopBuildVersion(releaseId, PRODUCT)).toThrow(/must extend product version/u)
    })

  it.each(['0.1.6-beta.2.20260921.1', '0.1.6-alpha.3', '0.1.6'])(
    'rejects %s because it does not extend the product prerelease', (releaseId) => {
      expect(() => validateDesktopBuildVersion(releaseId, PRODUCT)).toThrow(/must extend prerelease/u)
    })

  it('refuses to extend a stable product version, which an update would never offer', () => {
    // semver ranks 0.1.6.20260921.1 below every 0.1.7 prerelease and it is not a version at all.
    expect(() => validateDesktopBuildVersion('0.1.6-20260921.1', '0.1.6')).toThrow(/carries no prerelease/u)
  })
})
