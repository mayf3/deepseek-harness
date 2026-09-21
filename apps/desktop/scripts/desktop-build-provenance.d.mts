/** Commit a build came from, and whether its checkout carried uncommitted changes. */
export interface DesktopBuildProvenance {
  readonly commit: string
  readonly dirty: boolean
}

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV: 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV: 'DSH_DESKTOP_BUILD_DIRTY'

/**
 * Read the checkout's current commit and whether it carries uncommitted changes.
 * @param repositoryRoot - Directory to inspect.
 * @returns Provenance of the tree being packaged.
 */
export function readDesktopBuildProvenance(repositoryRoot: string): DesktopBuildProvenance

/**
 * Resolve provenance a parent packaging process recorded.
 * @param env - Packaging environment.
 * @returns Provenance, or undefined outside a packaging run.
 */
export function resolveDesktopBuildProvenance(env: NodeJS.ProcessEnv): DesktopBuildProvenance | undefined

/**
 * Describe provenance as the environment variables child processes read.
 * @param provenance - Provenance to pass down.
 * @returns Variables to merge into a child environment.
 */
export function desktopBuildProvenanceEnvironment(provenance: DesktopBuildProvenance): Record<string, string>
