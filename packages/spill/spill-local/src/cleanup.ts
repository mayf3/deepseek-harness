/** Startup cleanup mechanics for local spill roots. */
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_ROOT_PREFIX, isErrno } from './store.ts'

/**
 * A backend-generated default root name: `dsh-spill-` plus the 6-character
 * suffix `mkdtemp` appends. Discovery matches this
 * EXACT shape, not the bare prefix, so an unrelated `dsh-spill-test-*` fixture
 * or a foreign tool's differently-shaped `dsh-spill-…` directory is never
 * mistaken for a backend root to sweep.
 */
const DEFAULT_ROOT_RE = new RegExp(`^${DEFAULT_ROOT_PREFIX}[A-Za-z0-9]{6}$`)

/**
 * A backend-generated session directory name: `session-` plus the 12 lowercase
 * hex characters {@link sessionDir} derives from `sha256(sessionId)`. The sweep
 * only descends into entries of this EXACT shape, so an unrelated
 * `session-backup` directory under a shared configured root is never swept.
 */
const SESSION_DIR_RE = /^session-[0-9a-f]{12}$/

/** A one-argument warning sink — the sweep's only side effect on failure (never throws). */
export type WarnFn = (message: string) => void

/** Report a best-effort sweep failure without allowing the warning sink to reject cleanup. */
function warnSafely(warn: WarnFn, message: string): void {
  try {
    warn(message)
  } catch {
    // Warning sinks are observational callbacks; cleanup must remain best-effort
    // even when a logger implementation throws.
  }
}

/** One root to sweep, plus whether its empty session directories and root may be pruned. */
export interface SweepRoot {
  /** Absolute spill root to sweep. */
  path: string
  /**
   * When `true`, prune empty `session-*` children and then remove the root once
   * empty. Set for DISCOVERED prior-default `dsh-spill-*` roots (one per past
   * process — otherwise they accumulate empty forever), never for the
   * active/configured root the live process is still writing into. Writes retry
   * if another process still using a discovered root races its pruning.
   */
  pruneWhenEmpty: boolean
}

/** Options for {@link sweepSpillRoots} — the roots to scan, the age cutoff, and a failure sink. */
export interface SweepOptions {
  /** Roots to sweep (configured/active root and/or discovered prior-default roots). */
  roots: SweepRoot[]
  /**
   * Epoch-millis cutoff: a regular file is deleted when its `mtime` is strictly
   * older than this. The caller derives it from `now - cleanupPeriodDays`, so a
   * file written exactly at the boundary is kept (only strictly-older expires).
   */
  cutoffMs: number
  /** Where a contained filesystem failure is reported; the sweep itself never throws. */
  warn: WarnFn
}

/**
 * Delete a single path, treating a concurrent-race disappearance as success.
 * A parallel process (or another sweep) may `unlink` the same file between our
 * scan and our own `unlink` — ENOENT then means the goal (file gone) already
 * holds, so it is not a failure. Any other error is reported and swallowed.
 *
 * @param path The absolute file path to remove.
 * @param warn Sink for a non-ENOENT failure message.
 * @returns Resolves once the removal was attempted (never rejects).
 */
async function unlinkIdempotent(path: string, warn: WarnFn): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    /* v8 ignore start -- reached only when a file selected for deletion (a
       regular file that passed lstat) then fails to unlink: either it raced away
       (ENOENT) or a permission/IO fault struck between the stat and the unlink.
       Neither is deterministically reproducible in-process. */
    if (isErrno(error, 'ENOENT')) return
    warnSafely(warn, `spill-local: failed to delete ${path}: ${String(error)}`)
    /* v8 ignore stop */
  }
}

/**
 * Sweep one spill session directory: delete expired regular files, skip
 * everything else, and report the directory empty afterward so the caller can
 * prune it. The `dir` entry MUST be a real directory — the caller `lstat`s it
 * first and skips a symlink, so this never follows a `session-*` symlink into a
 * foreign tree. Inside, a symlink or any non-regular entry (socket, fifo, nested
 * dir) is left untouched — `lstat` never follows a link, so a planted symlink
 * can neither be deleted nor redirect the age check. Every per-entry failure is
 * contained: one unreadable file does not abort the directory.
 *
 * @param dir The absolute session directory to scan (already confirmed a real dir).
 * @param cutoffMs Files with `mtime` strictly older than this are deleted.
 * @param warn Sink for contained filesystem failures.
 * @returns `true` when the directory holds no entries after the sweep (a prune candidate).
 */
async function sweepSessionDir(dir: string, cutoffMs: number, warn: WarnFn): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error: unknown) {
    /* v8 ignore start -- the caller lstat'd this entry and confirmed a real
       directory just before the call, so readdir fails only when the dir races
       away (ENOENT) or a permission/IO fault strikes in that window; not
       deterministically reproducible. False keeps it out of the prune step. */
    warnSafely(warn, `spill-local: failed to read ${dir}: ${String(error)}`)
    return false
    /* v8 ignore stop */
  }
  let remaining = names.length
  for (const name of names) {
    const path = join(dir, name)
    let stats
    try {
      stats = await lstat(path)
    } catch (error: unknown) {
      /* v8 ignore start -- an entry that readdir just returned then fails to
         lstat only by racing away (ENOENT) or a permission/IO fault; keep it out
         of the deterministic test surface. */
      if (isErrno(error, 'ENOENT')) { remaining--; continue }
      warnSafely(warn, `spill-local: failed to stat ${path}: ${String(error)}`)
      continue
      /* v8 ignore stop */
    }
    // Only regular files expire. Symlinks and other special entries are skipped
    // (never followed) so the sweep cannot be redirected or delete a link.
    if (!stats.isFile()) continue
    if (stats.mtimeMs >= cutoffMs) continue
    await unlinkIdempotent(path, warn)
    remaining--
  }
  return remaining === 0
}

/**
 * Best-effort one-shot cleanup: across each root, delete expired regular files
 * under its `session-*` directories, pruning empty directories only in
 * discovered prior-default roots. The active root keeps its session directories
 * to avoid racing a local write; writes recreate a directory pruned by another
 * process. Every filesystem and warning-sink failure is contained, so a caller
 * can await this during activation/disposal without it ever rejecting.
 *
 * @param options The roots to sweep, the age cutoff, and the failure sink.
 * @returns Resolves when the sweep finishes (never rejects).
 */
export async function sweepSpillRoots(options: SweepOptions): Promise<void> {
  const { roots, cutoffMs, warn } = options
  for (const root of roots) {
    let entries: string[]
    try {
      entries = await readdir(root.path)
    } catch (error: unknown) {
      // A root that does not exist yet (no spill ever written) is the common
      // case, not an error: ENOENT is silent, anything else is reported.
      if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to read root ${root.path}: ${String(error)}`)
      continue
    }
    // Track whether the root holds ANY entry the sweep did not fully reclaim, so
    // a discovered prior-default root can be pruned only when nothing remains.
    let rootEmptiable = true
    for (const name of entries) {
      // Only the backend's own `session-<12 hex>` directories are swept; an
      // unrelated sibling (`session-backup`, a stray file) is left untouched and
      // blocks pruning the root.
      if (!SESSION_DIR_RE.test(name)) { rootEmptiable = false; continue }
      const dir = join(root.path, name)
      let stats
      try {
        // lstat the session entry itself: a `session-*` SYMLINK must never be
        // followed (readdir/unlink through it would delete files in a foreign
        // target). Only a real directory is swept.
        stats = await lstat(dir)
      } catch (error: unknown) {
        /* v8 ignore start -- an entry readdir just returned fails to lstat only
           by racing away (ENOENT) or a permission/IO fault; not deterministically
           reproducible. */
        if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to stat ${dir}: ${String(error)}`)
        continue
        /* v8 ignore stop */
      }
      if (!stats.isDirectory()) { rootEmptiable = false; continue }
      const empty = await sweepSessionDir(dir, cutoffMs, warn)
      if (!empty) { rootEmptiable = false; continue }
      if (!root.pruneWhenEmpty) {
        // The active root remains writable while cleanup runs. Leaving its empty
        // session directories in place closes the mkdir/rmdir race with saveText.
        rootEmptiable = false
        continue
      }
      try {
        await rmdir(dir)
      } catch (error: unknown) {
        /* v8 ignore start -- prune runs only on a dir observed empty; a failure
           here means a concurrent writer added a file (ENOTEMPTY) or a
           permission/IO fault struck — both are races outside deterministic
           in-process testing. */
        rootEmptiable = false
        if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
          warnSafely(warn, `spill-local: failed to prune ${dir}: ${String(error)}`)
        }
        /* v8 ignore stop */
      }
    }
    // A discovered prior-default root (one per past process) is removed once its
    // last session dir is gone — otherwise empty roots accumulate forever and
    // every future startup rescans them. The active/configured root is never
    // pruned (the live process is still writing into it).
    if (root.pruneWhenEmpty && rootEmptiable) {
      try {
        await rmdir(root.path)
      } catch (error: unknown) {
        /* v8 ignore start -- prune runs only on a root whose every child was
           reclaimed; a failure here means a concurrent writer added a fresh
           spill after our scan (ENOTEMPTY) or removed the root already (ENOENT)
           or a permission/IO fault struck — all races outside deterministic
           in-process testing. */
        if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
          warnSafely(warn, `spill-local: failed to prune root ${root.path}: ${String(error)}`)
        }
        /* v8 ignore stop */
      }
    }
  }
}

/**
 * Discover prior default spill roots: the `dsh-spill-<6 chars>` directories
 * directly under `base` (the OS tmpdir) that earlier default-root runs created.
 * A long-lived deployment
 * with a configured root will find none; a series of default-root runs
 * accumulates one per process, so the startup sweep reclaims them all. Matching
 * is the EXACT `mkdtemp` shape (see {@link DEFAULT_ROOT_RE}), not the bare
 * prefix, so an unrelated `dsh-spill-test-*` fixture or a foreign
 * differently-shaped directory is never swept; symlinks and non-directories are
 * excluded too — only real directories the backend could have created.
 *
 * @param warn Sink for a failure reading `base` (returns `[]` on failure).
 * @param base The directory to scan; defaults to the OS tmpdir (a test seam).
 * @returns Absolute paths of the discovered default roots (possibly empty).
 */
export async function discoverDefaultRoots(warn: WarnFn, base: string = tmpdir()): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch (error: unknown) {
    warnSafely(warn, `spill-local: failed to scan ${base} for default roots: ${String(error)}`)
    return []
  }
  const roots: string[] = []
  for (const name of entries) {
    if (!DEFAULT_ROOT_RE.test(name)) continue
    const path = join(base, name)
    let stats
    try {
      // lstat, not stat: a symlink named `dsh-spill-*` must not be treated as a
      // root we then sweep (it could point anywhere).
      stats = await lstat(path)
    } catch (error: unknown) {
      /* v8 ignore start -- an entry readdir just returned fails to lstat only by
         racing away (ENOENT) or a permission/IO fault; not deterministically
         reproducible. */
      if (!isErrno(error, 'ENOENT')) warnSafely(warn, `spill-local: failed to stat default root ${path}: ${String(error)}`)
      continue
      /* v8 ignore stop */
    }
    if (stats.isDirectory()) roots.push(path)
  }
  return roots
}
