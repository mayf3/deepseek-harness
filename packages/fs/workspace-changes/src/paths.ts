/** Path classification and display forms for changed files. */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Slash-separated form of a native relative path. */
export function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** Whether `path` is `root` or lies under it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Canonical spellings of the temporary directories a workspace-write sandbox
 * grants: the host `/tmp` and the platform temp area, each also in its
 * symlink-resolved form so `/tmp` and `/private/tmp` match alike.
 * @param candidates - directories to canonicalize.
 * @returns absolute directory paths.
 */
export function temporaryRoots(candidates: readonly string[] = ['/tmp', tmpdir()]): string[] {
  const roots = new Set<string>()
  for (const root of candidates) {
    roots.add(root)
    try {
      roots.add(realpathSync.native(root))
    } catch {
      // A missing temporary root matches nothing.
    }
  }
  return [...roots]
}

/**
 * Whether a file lives under a temporary root, where the model keeps scratch work.
 * @param path - absolute file path.
 * @param roots - {@link temporaryRoots}.
 * @returns true for scratch paths that never enter the change summary.
 */
export function isTemporaryPath(path: string, roots: readonly string[]): boolean {
  return roots.some(root => isInside(root, path))
}

/**
 * Resolve a file-tool path against the Session working directory.
 * @param cwd - absolute Session working directory.
 * @param path - model-facing path, relative or absolute.
 * @returns the absolute native path.
 */
export function absolutePathOf(cwd: string, path: string): string {
  return resolve(cwd, path)
}

/** Sort key and label rules; see `WorkspaceChangedFile.display`. */
export function displayPathOf(absolute: string, cwd: string, root: string, home: string): string {
  const rel = relative(cwd, absolute)
  if (!rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel)
  if (isInside(root, absolute)) return toPosix(rel)
  if (home !== '' && isInside(home, absolute)) return `~/${toPosix(relative(home, absolute))}`
  return toPosix(absolute)
}

/** The durable `path` field: relative inside the working directory, absolute elsewhere. */
export function durablePathOf(absolute: string, cwd: string): string {
  const rel = relative(cwd, absolute)
  return !rel.startsWith('..') && !isAbsolute(rel) ? toPosix(rel) : absolute
}

/**
 * Code-unit order of display paths, which places `../` and absolute paths
 * before letters and matches git's own listing order for relative paths.
 */
export function compareDisplay(a: { display: string }, b: { display: string }): number {
  return a.display < b.display ? -1 : a.display > b.display ? 1 : 0
}
