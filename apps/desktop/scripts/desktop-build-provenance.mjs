/**
 * Carry the commit a build came from into its artifacts.
 *
 * A build that reaches a colleague or a test feed is not reachable from a tag,
 * so the only way back to its sources is what the build recorded about itself.
 * The packaging entry reads the checkout once and passes the result to every
 * child process, because the build tree it hands to electron-builder no longer
 * resembles a checkout.
 */

import { execFileSync } from 'node:child_process'

/** Environment variable that carries the packaged commit. */
export const DESKTOP_BUILD_COMMIT_ENV = 'DSH_DESKTOP_BUILD_COMMIT'

/** Environment variable that records whether the packaged checkout had uncommitted changes. */
export const DESKTOP_BUILD_DIRTY_ENV = 'DSH_DESKTOP_BUILD_DIRTY'

/**
 * Read the checkout's current commit and whether it carries uncommitted changes.
 * @param {string} repositoryRoot - Directory to inspect.
 * @returns {{ commit: string, dirty: boolean }} Provenance of the tree being packaged.
 */
export function readDesktopBuildProvenance(repositoryRoot) {
  const git = (args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
  return {
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--untracked-files=normal']) !== '',
  }
}

/**
 * Resolve provenance a parent packaging process recorded.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ commit: string, dirty: boolean } | undefined} Provenance, or undefined outside a packaging run.
 */
export function resolveDesktopBuildProvenance(env) {
  const commit = env[DESKTOP_BUILD_COMMIT_ENV]?.trim()
  if (commit === undefined || commit === '') return undefined
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`desktop build provenance: ${DESKTOP_BUILD_COMMIT_ENV} must be a commit hash`)
  const dirty = env[DESKTOP_BUILD_DIRTY_ENV]?.trim()
  if (dirty !== undefined && dirty !== '' && dirty !== '0' && dirty !== '1') {
    throw new Error(`desktop build provenance: ${DESKTOP_BUILD_DIRTY_ENV} must be 0 or 1`)
  }
  return { commit, dirty: dirty === '1' }
}

/**
 * Describe provenance as the environment variables child processes read.
 * @param {{ commit: string, dirty: boolean }} provenance - Provenance to pass down.
 * @returns {Record<string, string>} Variables to merge into a child environment.
 */
export function desktopBuildProvenanceEnvironment(provenance) {
  return {
    [DESKTOP_BUILD_COMMIT_ENV]: provenance.commit,
    [DESKTOP_BUILD_DIRTY_ENV]: provenance.dirty ? '1' : '0',
  }
}
