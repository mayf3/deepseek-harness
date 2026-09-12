/** Experimental packages excluded from public releases and npm baselines. */
export const PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES = [
  'packages/experimental/auto-review',
  'packages/experimental/inspector',
  'packages/experimental/ptc-runtime-python',
  'packages/experimental/webworker-packer',
  'packages/experimental/webworker-runtime',
] as const

const privateExperimentalPackageDirectories = new Set<string>(PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES)

/**
 * Whether an experimental package publishes under the default-public policy.
 * @param directory - repository-relative package directory.
 * @returns Whether the package publishes with the dsh family.
 */
export function isPublicExperimentalPackageDirectory(directory: string): boolean {
  return /^packages\/experimental\/[^/]+$/.test(directory)
    && !privateExperimentalPackageDirectories.has(directory)
}
