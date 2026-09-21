/** Environment variable that carries the build identifier through one packaging and upload run. */
export const DESKTOP_BUILD_VERSION_ENV: 'DSH_DESKTOP_BUILD_VERSION'

/**
 * Validate a build identifier against the product version it must extend.
 * @param buildVersion - Build identifier to publish under.
 * @param productVersion - Version the manifests declare.
 * @returns The identifier as semver normalizes it, which is what the artifacts will carry.
 */
export function validateDesktopBuildVersion(buildVersion: string, productVersion: string): string

/**
 * Resolve the version a build publishes.
 * @param env - Packaging or upload environment.
 * @param productVersion - Version the manifests declare.
 * @returns The build identifier when one is present, otherwise the product version.
 */
export function resolveDesktopBuildVersion(env: NodeJS.ProcessEnv, productVersion: string): string
