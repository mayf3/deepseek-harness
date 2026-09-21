/**
 * Resolve the version one build publishes, which is not always the version the
 * repository declares.
 *
 * A release publishes the version in the manifests, aligned with the `dsh` npm
 * package. Test and hand-delivered builds publish a build identifier that
 * extends it with dot-separated segments, conventionally a date and a sequence
 * number, so one update feed can carry several builds of a single product
 * version. Passing that identifier here keeps it out of the manifests: the
 * tracked version stays the product's, and the build identifier reaches
 * electron-builder, the update feed, and the upload validation as one input.
 *
 * `electron-updater` compares feed versions with `semver.gt` against the
 * installed `app.getVersion()`, so validation here uses the same library: an
 * identifier must be a version that library accepts, and must outrank the
 * product version it extends. Semver gives a prerelease lower precedence than
 * its release and orders prerelease identifiers field by field, so
 * `0.1.6-alpha.2.20260921.1` outranks `0.1.6-alpha.2` while `0.1.6.20260921.1`
 * is not a version at all. An identifier therefore only extends a product
 * version that already carries a prerelease.
 */

import { gt, parse } from 'semver'

/** Environment variable that carries the build identifier through one packaging and upload run. */
export const DESKTOP_BUILD_VERSION_ENV = 'DSH_DESKTOP_BUILD_VERSION'

/**
 * Parse a version the updater would accept.
 * @param {string} version - Version to read.
 * @param {string} label - Description used in failures.
 * @returns {import('semver').SemVer} The parsed version.
 */
function parseVersion(version, label) {
  const parsed = parse(version, { loose: false })
  if (parsed === null) throw new Error(`desktop build version: ${label} ${version} is not a version`)
  if (parsed.build.length > 0) {
    // Build metadata does not participate in precedence, so two builds would compare equal to the updater.
    throw new Error(`desktop build version: ${label} ${version} cannot carry build metadata`)
  }
  return parsed
}

/**
 * Validate a build identifier against the product version it must extend.
 * @param {string} buildVersion - Build identifier to publish under.
 * @param {string} productVersion - Version the manifests declare.
 * @returns {string} The identifier as semver normalizes it, which is what the artifacts will carry.
 */
export function validateDesktopBuildVersion(buildVersion, productVersion) {
  const identifier = parseVersion(buildVersion, 'build identifier')
  const product = parseVersion(productVersion, 'product version')
  if (identifier.version === product.version) return identifier.version
  if (identifier.compareMain(product) !== 0) {
    throw new Error(`desktop build version: ${buildVersion} must extend product version ${productVersion}`)
  }
  if (product.prerelease.length === 0) {
    // On a stable version an identifier ranks below every prerelease of the next release, so no update would offer it.
    throw new Error(`desktop build version: ${productVersion} carries no prerelease, so ${buildVersion} cannot extend it`)
  }
  const extendsProduct = identifier.prerelease.length > product.prerelease.length
    && product.prerelease.every((field, index) => identifier.prerelease[index] === field)
  if (!extendsProduct || !gt(identifier, product)) {
    throw new Error(`desktop build version: ${buildVersion} must extend prerelease ${product.prerelease.join('.')} of ${productVersion}`)
  }
  return identifier.version
}

/**
 * Resolve the version a build publishes.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {string} productVersion - Version the manifests declare.
 * @returns {string} The build identifier when one is present, otherwise the product version.
 */
export function resolveDesktopBuildVersion(env, productVersion) {
  const buildVersion = env[DESKTOP_BUILD_VERSION_ENV]?.trim()
  if (buildVersion === undefined || buildVersion === '') return productVersion
  return validateDesktopBuildVersion(buildVersion, productVersion)
}
