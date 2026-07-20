/**
 * Cordis-free storage mechanics for the local spill backend: private
 * session-scoped directory selection, safe-name derivation, path-traversal
 * protection, and the exclusive owner-only write.
 *
 * @module @deepseek-ai/dsh-spill-local/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Filename prefix for the lazily-created private default spill roots
 * (`mkdtemp(tmpdir()/dsh-spill-)`). Startup cleanup rediscovers these
 * per-process roots (from prior runs that used no configured `root`) by this
 * prefix — see {@link discoverDefaultRoots}.
 */
export const DEFAULT_ROOT_PREFIX = 'dsh-spill-'

/**
 * A backend-generated default root name: `dsh-spill-` plus the 6-character
 * suffix `mkdtemp` appends (see {@link privateRoot}). Discovery matches this
 * EXACT shape, not the bare prefix, so an unrelated `dsh-spill-test-*` fixture
 * or a foreign tool's differently-shaped `dsh-spill-…` directory is never
 * mistaken for a backend root to sweep.
 */
const DEFAULT_ROOT_RE = /^dsh-spill-[A-Za-z0-9]{6}$/

/**
 * A backend-generated session directory name: `session-` plus the 12 lowercase
 * hex characters {@link sessionDir} derives from `sha256(sessionId)`. The sweep
 * only descends into entries of this EXACT shape, so an unrelated
 * `session-backup` directory under a shared configured root is never swept.
 */
const SESSION_DIR_RE = /^session-[0-9a-f]{12}$/

let defaultRoot: string | undefined

/**
 * The default spill root: a private (0700) per-process directory under the OS
 * tmpdir, created lazily. Predictable world-readable paths would let other
 * local users read spilled tool output or pre-create symlinks; `mkdtemp` gives
 * an unpredictable suffix and 0700 semantics.
 *
 * @returns The lazily-created private spill root.
 */
export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), DEFAULT_ROOT_PREFIX))
  return defaultRoot
}

// Spill keeps its empty-name policy local so storage backends stay decoupled.
/* jscpd:ignore-start */
/**
 * Encode an arbitrary string as one safe path segment, injectively over ALL JS
 * (UTF-16) strings. A session id / suggested name is untrusted input, so this
 * neutralizes `../`, absolute paths, NUL, and separators before any filesystem
 * use. Each code unit is kept literal (`[A-Za-z0-9._-]`, minus `~`) or escaped
 * as `~XXXX`; `~` is itself escaped, so the mapping is reversible and distinct
 * inputs never collide. The whole-segment tokens `.`/`..` are escaped so they
 * can never traverse. An empty string encodes to `~` (never an empty segment).
 *
 * @param raw The untrusted string to encode as one safe path segment.
 * @returns An injective, filesystem-safe single path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}
/* jscpd:ignore-end */

/**
 * The session-scoped directory: `<root>/session-<hash(sessionId)>`, a short stable hash.
 *
 * @param root The spill root directory.
 * @param sessionId The owning session id to hash into a stable directory name.
 * @returns The absolute session-scoped spill directory path.
 */
export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `session-${hash}`)
}

/** Options for {@link saveTextFile} — the resolved root and the request fields the store needs. */
export interface SaveTextOptions {
  /** The spill root directory (configured or the lazy private default). */
  root: string
  /** The owning session id (scopes the directory). */
  sessionId: string
  /** Caller-suggested base name; sanitized to one safe segment before use. */
  suggestedName: string
  /** The full text to persist. */
  content: string
}

/** A written spill file. */
export interface SavedText {
  path: string
  bytes: number
}

/**
 * Write `content` to a fresh file under the session-scoped directory and return
 * its path + byte length. The filename is a random hex prefix plus the
 * sanitized `suggestedName`, so it is unpredictable (defeats symlink planting in
 * a shared root) AND stays readable. The open is exclusive + owner-only
 * (`'wx', 0o600`): it fails on any existing path — symlink or not — so a
 * pre-planted target cannot redirect the write.
 *
 * @param options The resolved root and request fields required to save the file.
 * @returns The written file path and UTF-8 byte length.
 */
export async function saveTextFile(options: SaveTextOptions): Promise<SavedText> {
  const dir = sessionDir(options.root, options.sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const safeName = encodeSegment(options.suggestedName)
  const path = join(dir, `${randomBytes(6).toString('hex')}-${safeName}`)
  const bytes = Buffer.byteLength(options.content, 'utf8')
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(options.content)
  } finally {
    await handle.close()
  }
  return { path, bytes }
}

/** A one-argument warning sink — the sweep's only side effect on failure (never throws). */
export type WarnFn = (message: string) => void

/** One root to sweep, plus whether an emptied root directory should itself be pruned. */
export interface SweepRoot {
  /** Absolute spill root to sweep. */
  path: string
  /**
   * When `true`, remove the root directory itself once its last `session-*`
   * child is pruned. Set for DISCOVERED prior-default `dsh-spill-*` roots (one
   * per past process — otherwise they accumulate empty forever), never for the
   * active/configured root the live process is still writing into.
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
    warn(`spill-local: failed to delete ${path}: ${String(error)}`)
    /* v8 ignore stop */
  }
}

/**
 * True when `error` is a Node system error carrying the given `code`.
 *
 * @param error The caught value to test.
 * @param code The `NodeJS.ErrnoException` code to match (e.g. `'ENOENT'`).
 * @returns `true` when `error` is an `Error` whose `code` equals `code`.
 */
export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
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
    // A `session-*` entry that is not a readable directory (a stray file, or an
    // unreadable/vanished dir) is not ours to fix — report and leave it. False
    // keeps it out of the prune step.
    warn(`spill-local: failed to read ${dir}: ${String(error)}`)
    return false
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
      warn(`spill-local: failed to stat ${path}: ${String(error)}`)
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
 * under its `session-*` directories and prune any directory left empty. The
 * sweep is idempotent and safe to run concurrently with live spill writes and
 * with another process's sweep — per-file expiry preserves a fresh write even
 * if it lands mid-sweep, and every filesystem failure is caught and reported
 * rather than thrown, so a caller can await this during activation/disposal
 * without it ever rejecting.
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
      if (!isErrno(error, 'ENOENT')) warn(`spill-local: failed to read root ${root.path}: ${String(error)}`)
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
        if (!isErrno(error, 'ENOENT')) warn(`spill-local: failed to stat ${dir}: ${String(error)}`)
        continue
        /* v8 ignore stop */
      }
      if (!stats.isDirectory()) { rootEmptiable = false; continue }
      const empty = await sweepSessionDir(dir, cutoffMs, warn)
      if (!empty) { rootEmptiable = false; continue }
      try {
        await rmdir(dir)
      } catch (error: unknown) {
        /* v8 ignore start -- prune runs only on a dir observed empty; a failure
           here means a concurrent writer added a file (ENOTEMPTY) or a
           permission/IO fault struck — both are races outside deterministic
           in-process testing. */
        rootEmptiable = false
        if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
          warn(`spill-local: failed to prune ${dir}: ${String(error)}`)
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
        // A concurrent process may have written a fresh spill into this root
        // after our scan (ENOTEMPTY), or removed it already (ENOENT) — benign
        // races. Anything else is reported.
        if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) {
          warn(`spill-local: failed to prune root ${root.path}: ${String(error)}`)
        }
      }
    }
  }
}

/**
 * Discover prior default spill roots: the `dsh-spill-<6 chars>` directories
 * directly under `base` (the OS tmpdir) that earlier runs created via
 * {@link privateRoot} when no `root` was configured. A long-lived deployment
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
    warn(`spill-local: failed to scan ${base} for default roots: ${String(error)}`)
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
      if (!isErrno(error, 'ENOENT')) warn(`spill-local: failed to stat default root ${path}: ${String(error)}`)
      continue
      /* v8 ignore stop */
    }
    if (stats.isDirectory()) roots.push(path)
  }
  return roots
}
