/**
 * In-memory filesystem behind the worker's `node:fs` proxy. Contents come from
 * the build-time image (see {@link loadVfsImage}); this remains the synchronous
 * authority when an asynchronous durable sink mirrors selected subtrees.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory
 */
import { dirname, join, normalize, resolve, SEP } from '../module-system/posix-path.ts'
import { parseTar } from './tar.ts'
import type {
  Vfs, VfsBigIntStats, VfsDir, VfsDirent, VfsEncoding, VfsError, VfsFileHandle, VfsMutation,
  VfsMutationListener, VfsMutationSink, VfsReadOptions, VfsSeedOptions, VfsStatOptions, VfsStats, VfsWriteOptions,
} from './types.ts'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

interface FileNode {
  bytes: Uint8Array
  mtimeMs: number
  /** Permission bits (`0o777` mask), set at creation and changed only by `chmod`. */
  mode: number
}

/** Creation default for files, Node's `0o666` under the classic `022` umask. */
const DEFAULT_FILE_MODE = 0o644

/** Creation default for directories, Node's `0o777` under the classic `022` umask. */
const DEFAULT_DIRECTORY_MODE = 0o755

function fail(code: string, syscall: string, path: string, detail?: string): never {
  const error = new Error(`${code}: ${detail ?? syscall} failed, ${syscall} '${path}'`) as VfsError
  error.code = code
  error.path = path
  error.syscall = syscall
  throw error
}

function encodingOf(options: VfsReadOptions): VfsEncoding | undefined {
  if (options === null || options === undefined) return undefined
  if (typeof options === 'string') return options
  return options.encoding ?? undefined
}

// Permission bits are entry state: creation takes the caller's mode (or the
// umask-free default), `chmod` changes it, and both stat shapes report the
// stored value — the round-trip consumers like dsh-credentials-local's
// owner-only check rely on. The bits are never enforced: a single-owner
// filesystem reads and writes as its owner regardless, like root.
function statsOf(size: number, mtimeMs: number, directory: boolean, ino: bigint, mode: number): VfsStats {
  return {
    size,
    ino: Number(ino),
    mtimeMs,
    ctimeMs: mtimeMs,
    atimeMs: mtimeMs,
    birthtimeMs: mtimeMs,
    mtime: new Date(mtimeMs),
    mode: (directory ? 0o040000 : 0o100000) | (mode & 0o777),
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  }
}

/**
 * The same entry as {@link statsOf}, in the BigInt shape.
 *
 * Timestamps carry millisecond resolution scaled to nanoseconds, which is what
 * the underlying `mtimeMs` holds; the VFS keeps that value strictly increasing
 * per entry so two writes inside one millisecond still differ.
 * @param size - Byte length; zero for a directory.
 * @param mtimeMs - Modification time the entry carries.
 * @param directory - Whether the entry is a directory.
 * @param ino - Identity of the entry at this path.
 * @param mode - Stored permission bits of the entry.
 * @returns Stats in the shape Node returns under `{ bigint: true }`.
 */
function bigIntStatsOf(size: number, mtimeMs: number, directory: boolean, ino: bigint, mode: number): VfsBigIntStats {
  const milliseconds = BigInt(Math.trunc(mtimeMs))
  const nanoseconds = milliseconds * 1_000_000n
  const time = new Date(mtimeMs)
  return {
    size: BigInt(size),
    mode: BigInt((directory ? 0o040000 : 0o100000) | (mode & 0o777)),
    dev: 1n,
    ino,
    nlink: 1n,
    mtimeMs: milliseconds,
    mtimeNs: nanoseconds,
    ctimeMs: milliseconds,
    ctimeNs: nanoseconds,
    atimeMs: milliseconds,
    atimeNs: nanoseconds,
    birthtimeMs: milliseconds,
    birthtimeNs: nanoseconds,
    mtime: time,
    ctime: time,
    atime: time,
    birthtime: time,
    isFile: () => !directory,
    isDirectory: () => directory,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  }
}

/** Construction inputs for {@link MemoryVfs}. */
export interface MemoryVfsOptions {
  /** Durable write-behind observer; absent leaves the filesystem ephemeral. */
  readonly sink?: VfsMutationSink
}

/**
 * Filesystem held in two maps: one for file bytes, one for directories.
 * Every path is normalized to an absolute POSIX path without a trailing
 * separator, so callers may pass either form.
 */
export class MemoryVfs implements Vfs {
  private readonly files = new Map<string, FileNode>()
  private readonly directories = new Set<string>([SEP])
  /** Directory permission bits; absence means {@link DEFAULT_DIRECTORY_MODE}. */
  private readonly directoryModes = new Map<string, number>()
  /** Directory mtimes advance when their immediate entry set changes. */
  private readonly directoryMtimes = new Map<string, number>()
  private readonly mutationListeners = new Set<VfsMutationListener>()
  private readonly sink: VfsMutationSink | undefined
  private temporaries = 0
  // Identity per path, assigned on first stat and dropped when the path goes:
  // the filesystem service builds its version token from `ino` plus the
  // timestamp, so a recreated path must not look like the entry it replaced.
  private readonly identities = new Map<string, bigint>()
  private lastIdentity = 0n

  /**
   * Build the synchronous filesystem authority.
   * @param options - Optional durable write-behind sink.
   */
  constructor(options: MemoryVfsOptions = {}) {
    this.sink = options.sink
  }

  /**
   * Settle the durable sink without changing in-memory success.
   * @returns A promise that resolves when all recorded mutations are stored.
   */
  async flush(): Promise<void> {
    await this.sink?.flush()
  }

  /**
   * Observe committed runtime mutations. Image seeding is deliberately silent.
   * @param listener - Consumer called after each successful mutation.
   * @returns A disposer that prevents future calls.
   */
  subscribe(listener: VfsMutationListener): () => void {
    this.mutationListeners.add(listener)
    return () => { this.mutationListeners.delete(listener) }
  }

  /** Publish after state changes; one faulty observer cannot roll back a write. */
  private publish(mutation: VfsMutation): void {
    const observers: VfsMutationListener[] = [
      ...(this.sink === undefined ? [] : [(change: VfsMutation): void => { this.sink?.record(change) }]),
      ...this.mutationListeners,
    ]
    for (const listener of observers) {
      try {
        listener(mutation)
      } catch (error) {
        console.error('webworker vfs: mutation observer failed', error)
      }
    }
  }

  /** Promise face mirroring `node:fs/promises` for the methods the roster uses. */
  readonly promises = {
    readFile: async (path: string, options?: VfsReadOptions): Promise<string | Uint8Array> => this.readFileSync(path, options),
    writeFile: async (path: string, data: string | Uint8Array, options?: VfsWriteOptions): Promise<void> => {
      this.writeFileSync(path, data, options)
    },
    appendFile: async (path: string, data: string | Uint8Array): Promise<void> => { this.appendFileSync(path, data) },
    mkdir: async (path: string, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined> =>
      this.mkdirSync(path, options),
    readdir: async (path: string, options?: { withFileTypes?: boolean }): Promise<string[] & VfsDirent[]> =>
      this.readdirSync(path, options),
    stat: async (path: string, options?: VfsStatOptions): Promise<VfsStats | VfsBigIntStats> => this.statSync(path, options),
    lstat: async (path: string, options?: VfsStatOptions): Promise<VfsStats | VfsBigIntStats> => this.statSync(path, options),
    realpath: async (path: string): Promise<string> => this.realpathSync(path),
    rename: async (from: string, to: string): Promise<void> => { this.renameSync(from, to) },
    unlink: async (path: string): Promise<void> => { this.unlinkSync(path) },
    rm: async (path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> => { this.rmSync(path, options) },
    mkdtemp: async (prefix: string): Promise<string> => this.mkdtempSync(prefix),
    link: async (existing: string, next: string): Promise<void> => { this.linkSync(existing, next) },
    truncate: async (path: string, length?: number): Promise<void> => { this.truncateSync(path, length) },
    chmod: async (path: string, mode: number): Promise<void> => { this.chmodSync(path, mode) },
    opendir: async (path: string): Promise<VfsDir> => this.opendir(path),
    open: async (path: string, flags?: string, mode?: number): Promise<VfsFileHandle> => this.open(path, flags, mode),
    /** Resolves for any existing path: the VFS grants read and write to everything it holds. */
    access: async (path: string): Promise<void> => {
      const target = normalize(resolve(path))
      if (!this.files.has(target) && !this.directories.has(target)) fail('ENOENT', 'access', target)
    },
  }

  /** @returns Absolute path with no trailing separator. */
  private key(path: string): string {
    const absolute = normalize(resolve(path))
    return absolute.length > 1 && absolute.endsWith(SEP) ? absolute.slice(0, -1) : absolute
  }

  /**
   * Read a file.
   * @param path - File path.
   * @param options - `'utf8'` or `{encoding}` for text; omitted for bytes.
   * @returns Text or a copy-free view of the stored bytes.
   */
  readFileSync(path: string, options?: VfsReadOptions): string | Uint8Array {
    const target = this.key(path)
    const node = this.files.get(target)
    if (node === undefined) {
      if (this.directories.has(target)) fail('EISDIR', 'read', target)
      fail('ENOENT', 'open', target)
    }
    return encodingOf(options) === undefined ? node.bytes : decoder.decode(node.bytes)
  }

  /**
   * Report whether a path exists.
   * @param path - Path to test.
   * @returns True for files and directories.
   */
  existsSync(path: string): boolean {
    const target = this.key(path)
    return this.files.has(target) || this.directories.has(target)
  }

  /**
   * Stat a path.
   * @param path - Path to stat.
   * @param options - `bigint` selects the BigInt stats Node returns for it.
   * @returns Stats for the file or directory.
   */
  statSync(path: string, options?: VfsStatOptions): VfsStats | VfsBigIntStats {
    const target = this.key(path)
    const node = this.files.get(target)
    const [size, mtimeMs, directory, mode] = node !== undefined
      ? [node.bytes.length, node.mtimeMs, false, node.mode] as const
      : this.directories.has(target)
        ? [0, this.directoryMtimes.get(target) ?? 0, true, this.directoryModes.get(target) ?? DEFAULT_DIRECTORY_MODE] as const
        : fail('ENOENT', 'stat', target)
    const identity = this.identityOf(target)
    return options?.bigint === true
      ? bigIntStatsOf(size, mtimeMs, directory, identity, mode)
      : statsOf(size, mtimeMs, directory, identity, mode)
  }

  /** @returns Stats in the plain shape, for internal callers that read `size`/`mtimeMs`. */
  private plainStats(path: string): VfsStats {
    return this.statSync(path) as VfsStats
  }

  /** @returns The stable identity of an existing path, assigning one on first observation. */
  private identityOf(target: string): bigint {
    const existing = this.identities.get(target)
    if (existing !== undefined) return existing
    this.lastIdentity += 1n
    this.identities.set(target, this.lastIdentity)
    return this.lastIdentity
  }

  /** Forget a removed path's identity, so a recreated path reports a new one. */
  private forgetIdentity(target: string): void {
    this.identities.delete(target)
    const prefix = `${target}${SEP}`
    for (const known of [...this.identities.keys()]) {
      if (known.startsWith(prefix)) this.identities.delete(known)
    }
  }

  /**
   * Modification time for a write, strictly after the entry's previous one.
   *
   * The clock has millisecond resolution and these writes are in memory, so two
   * revisions of one file routinely land in the same millisecond. The filesystem
   * service's stale-write guard compares timestamps, so an equal one would let a
   * stale overwrite through.
   * @param target - Normalized path being written.
   * @returns Now, or one millisecond past the entry's current time.
   */
  private touch(target: string): number {
    const previous = this.files.get(target)?.mtimeMs
    const now = Date.now()
    return previous === undefined ? now : Math.max(now, previous + 1)
  }

  /** Advance a directory's mtime after its immediate children change. */
  private touchDirectory(target: string): void {
    const previous = this.directoryMtimes.get(target)
    const now = Date.now()
    this.directoryMtimes.set(target, previous === undefined ? now : Math.max(now, previous + 1))
  }

  /**
   * List a directory.
   * @param path - Directory path.
   * @param options - `withFileTypes` returns {@link VfsDirent} objects instead of names.
   * @returns Immediate entry names, or directory entries.
   */
  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] & VfsDirent[] {
    const target = this.key(path)
    if (!this.directories.has(target)) {
      if (this.files.has(target)) fail('ENOTDIR', 'scandir', target)
      fail('ENOENT', 'scandir', target)
    }
    const prefix = target === SEP ? SEP : `${target}${SEP}`
    const names = new Set<string>()
    for (const candidate of [...this.files.keys(), ...this.directories]) {
      if (!candidate.startsWith(prefix) || candidate === target) continue
      const rest = candidate.slice(prefix.length)
      if (rest === '') continue
      const [head = rest] = rest.split(SEP)
      names.add(head)
    }
    const sorted = [...names].sort()
    if (options?.withFileTypes !== true) return sorted as string[] & VfsDirent[]
    return sorted.map(name => this.direntOf(target, name)) as string[] & VfsDirent[]
  }

  /** @returns Directory entry for one child of `directory`. */
  private direntOf(directory: string, name: string): VfsDirent {
    const stats = this.plainStats(join(directory, name))
    return {
      name,
      parentPath: directory,
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory(),
      isSymbolicLink: () => false,
    }
  }

  /**
   * Resolve a path; the VFS has no symlinks, so this only normalizes.
   * @param path - Path to resolve.
   * @returns Absolute path.
   */
  realpathSync(path: string): string {
    const target = this.key(path)
    if (!this.existsSync(target)) fail('ENOENT', 'realpath', target)
    return target
  }

  /**
   * Create a directory.
   * @param path - Directory path.
   * @param options - `recursive` creates missing parents.
   * @returns First created path when recursive, otherwise undefined.
   */
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined {
    const target = this.key(path)
    if (this.files.has(target)) fail('EEXIST', 'mkdir', target)
    if (this.directories.has(target)) {
      if (options?.recursive === true) return undefined
      fail('EEXIST', 'mkdir', target)
    }
    const parent = dirname(target)
    if (!this.directories.has(parent)) {
      if (options?.recursive !== true) fail('ENOENT', 'mkdir', target)
      this.mkdirSync(parent, options)
    }
    this.directories.add(target)
    this.touchDirectory(target)
    this.touchDirectory(parent)
    const mode = (options?.mode ?? DEFAULT_DIRECTORY_MODE) & 0o777
    if (mode !== DEFAULT_DIRECTORY_MODE) this.directoryModes.set(target, mode)
    this.publish({ kind: 'mkdir', path: target, mode })
    return target
  }

  /**
   * Write a file, replacing existing contents.
   * @param path - File path; its parent directory must exist.
   * @param data - Text or bytes.
   * @param options - `flag` `wx` refuses an existing file, `a` appends.
   */
  writeFileSync(path: string, data: string | Uint8Array, options?: VfsWriteOptions): void {
    const target = this.key(path)
    if (this.directories.has(target)) fail('EISDIR', 'open', target)
    if (!this.directories.has(dirname(target))) fail('ENOENT', 'open', target)
    const flag = options?.flag ?? 'w'
    if (flag.startsWith('wx') && this.files.has(target)) fail('EEXIST', 'open', target)
    if (flag.startsWith('a')) {  this.appendFileSync(target, data); return }
    // POSIX open(O_CREAT): the mode applies at creation only; a rewrite keeps
    // the entry's bits.
    const previous = this.files.get(target)
    const mode = previous?.mode ?? (options?.mode !== undefined ? options.mode & 0o777 : DEFAULT_FILE_MODE)
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    this.files.set(target, { bytes, mtimeMs: this.touch(target), mode })
    if (previous === undefined) this.touchDirectory(dirname(target))
    this.publish({
      kind: 'write', path: target, bytes, mode, entryChanged: previous === undefined,
    })
  }

  /**
   * Open a directory; consumers enumerate entries or just prove it is one.
   * @param path - Directory path.
   * @returns Directory handle.
   */
  opendir(path: string): VfsDir {
    const target = this.key(path)
    const names = this.readdirSync(target)
    let cursor = 0
    const direntOf = (name: string): VfsDirent => this.direntOf(target, name)
    return {
      path: target,
      close: async (): Promise<void> => {},
      read: async (): Promise<{ name: string } | null> => {
        const name = names[cursor]
        cursor += 1
        return name === undefined ? null : direntOf(name)
      },
      async *[Symbol.asyncIterator]() {
        for (const name of names) yield direntOf(name)
      },
    }
  }

  /**
   * Open a file handle.
   * @param path - File path.
   * @param flags - Node open flags; `r` requires the file, `wx` refuses an existing one.
   * @param mode - Permission bits applied when the open creates the file.
   * @returns File handle.
   */
  open(path: string, flags = 'r', mode?: number): VfsFileHandle {
    const target = this.key(path)
    // Durable writers fsync the parent directory by opening it read-only.
    if (this.directories.has(target)) {
      if (!flags.startsWith('r')) fail('EISDIR', 'open', target)
      return {
        write: async (): Promise<{ bytesWritten: number }> => fail('EISDIR', 'write', target),
        writeFile: async (): Promise<void> => fail('EISDIR', 'write', target),
        readFile: async (): Promise<string | Uint8Array> => fail('EISDIR', 'read', target),
        truncate: async (): Promise<void> => fail('EISDIR', 'ftruncate', target),
        ...this.handleTail(target),
      }
    }
    const exists = this.files.has(target)
    if (flags.startsWith('r') && !exists) fail('ENOENT', 'open', target)
    if (flags.startsWith('wx') && exists) fail('EEXIST', 'open', target)
    if (!flags.startsWith('r') && !this.directories.has(dirname(target))) fail('ENOENT', 'open', target)
    const creation = mode === undefined ? {} : { mode }
    if (flags.startsWith('w') && !flags.startsWith('wx')) this.writeFileSync(target, new Uint8Array(), creation)
    if (flags.startsWith('wx')) this.writeFileSync(target, new Uint8Array(), { flag: 'wx', ...creation })
    if (flags.startsWith('a') && !exists) this.writeFileSync(target, new Uint8Array(), creation)
    const appending = flags.startsWith('a')
    return {
      write: async (data: string | Uint8Array): Promise<{ bytesWritten: number }> => {
        const bytes = typeof data === 'string' ? encoder.encode(data) : data
        this.appendFileSync(target, bytes)
        return { bytesWritten: bytes.length }
      },
      // A handle opened for append must append here too: session persistence
      // opens the log with `a` and writes each batch through this method, so a
      // truncating write would replace the whole log with the newest batch.
      writeFile: async (data: string | Uint8Array): Promise<void> => {
        if (appending) this.appendFileSync(target, data)
        else this.writeFileSync(target, data)
      },
      readFile: async (options?: VfsReadOptions): Promise<string | Uint8Array> => this.readFileSync(target, options),
      truncate: async (length = 0): Promise<void> => {
        const node = this.files.get(target)
        if (node === undefined) fail('ENOENT', 'ftruncate', target)
        const bytes = node.bytes.slice(0, length)
        this.files.set(target, { bytes, mtimeMs: this.touch(target), mode: node.mode })
        this.publish({ kind: 'write', path: target, bytes, mode: node.mode, entryChanged: false })
      },
      ...this.handleTail(target),
    }
  }

  /**
   * The handle members that do not depend on how the file was opened.
   *
   * `sync`/`datasync` settle an attached durable sink; an ephemeral filesystem
   * resolves immediately. `close` releases nothing, so both directory and file
   * handles share this tail.
   * @param target - Normalized path the handle was opened on.
   * @returns Metadata plus the no-op durability and release calls.
   */
  private handleTail(target: string): Pick<VfsFileHandle, 'stat' | 'sync' | 'datasync' | 'close'> {
    return {
      stat: async (): Promise<VfsStats> => this.plainStats(target),
      sync: async (): Promise<void> => { await this.flush() },
      datasync: async (): Promise<void> => { await this.flush() },
      close: async (): Promise<void> => {},
    }
  }

  /**
   * Append to a file, creating it when absent.
   * @param path - File path.
   * @param data - Text or bytes.
   */
  appendFileSync(path: string, data: string | Uint8Array): void {
    const target = this.key(path)
    const existing = this.files.get(target)
    const addition = typeof data === 'string' ? encoder.encode(data) : data
    if (existing === undefined) {  this.writeFileSync(target, addition); return }
    const merged = new Uint8Array(existing.bytes.length + addition.length)
    merged.set(existing.bytes)
    merged.set(addition, existing.bytes.length)
    this.files.set(target, { bytes: merged, mtimeMs: this.touch(target), mode: existing.mode })
    this.publish({
      kind: 'write', path: target, bytes: merged, mode: existing.mode,
      entryChanged: false, appendedFrom: existing.bytes.length,
    })
  }

  /**
   * Move a file or directory subtree.
   * @param from - Source path.
   * @param to - Destination path.
   */
  renameSync(from: string, to: string): void {
    const source = this.key(from)
    const destination = this.key(to)
    const node = this.files.get(source)
    if (node !== undefined) {
      if (!this.directories.has(dirname(destination))) fail('ENOENT', 'rename', destination)
      this.files.delete(source)
      this.files.set(destination, node)
      this.forgetIdentity(source)
      this.forgetIdentity(destination)
      this.touchDirectory(dirname(source))
      this.touchDirectory(dirname(destination))
      this.publish({ kind: 'remove', path: source })
      this.publish({ kind: 'write', path: destination, bytes: node.bytes, mode: node.mode, entryChanged: true })
      return
    }
    if (!this.directories.has(source)) fail('ENOENT', 'rename', source)
    const prefix = `${source}${SEP}`
    const movedFiles: Array<{ path: string; bytes: Uint8Array; mode: number }> = []
    for (const [candidate, value] of [...this.files]) {
      if (!candidate.startsWith(prefix)) continue
      this.files.delete(candidate)
      const target = join(destination, candidate.slice(prefix.length))
      this.files.set(target, value)
      movedFiles.push({ path: target, bytes: value.bytes, mode: value.mode })
    }
    const movedDirectories: Array<{ path: string; mode: number }> = []
    for (const candidate of [...this.directories]) {
      if (!candidate.startsWith(prefix) && candidate !== source) continue
      const moved = candidate === source ? destination : join(destination, candidate.slice(prefix.length))
      this.directories.delete(candidate)
      this.directories.add(moved)
      const bits = this.directoryModes.get(candidate)
      this.directoryModes.delete(candidate)
      if (bits !== undefined) this.directoryModes.set(moved, bits)
      movedDirectories.push({ path: moved, mode: bits ?? DEFAULT_DIRECTORY_MODE })
      const mtime = this.directoryMtimes.get(candidate)
      this.directoryMtimes.delete(candidate)
      if (mtime !== undefined) this.directoryMtimes.set(moved, mtime)
    }
    this.forgetIdentity(source)
    this.forgetIdentity(destination)
    this.touchDirectory(dirname(source))
    this.touchDirectory(dirname(destination))
    this.publish({ kind: 'remove', path: source })
    for (const directory of movedDirectories) {
      this.publish({ kind: 'mkdir', path: directory.path, mode: directory.mode })
    }
    for (const entry of movedFiles) {
      this.publish({
        kind: 'write', path: entry.path, bytes: entry.bytes, mode: entry.mode, entryChanged: true,
      })
    }
  }

  /**
   * Give existing bytes a second name.
   *
   * There are no inodes here, so the two names share the bytes present at link
   * time and diverge on the next write through either name; session persistence
   * links a finished file to a stable name, which this satisfies.
   * @param existing - Source file path.
   * @param next - Additional path; its parent must exist and it must be free.
   */
  linkSync(existing: string, next: string): void {
    const source = this.key(existing)
    const target = this.key(next)
    const node = this.files.get(source)
    if (node === undefined) fail('ENOENT', 'link', source)
    if (this.files.has(target) || this.directories.has(target)) fail('EEXIST', 'link', target)
    if (!this.directories.has(dirname(target))) fail('ENOENT', 'link', target)
    this.files.set(target, node)
    this.touchDirectory(dirname(target))
    this.publish({ kind: 'write', path: target, bytes: node.bytes, mode: node.mode, entryChanged: true })
  }

  /**
   * Shorten a file.
   * @param path - File path.
   * @param length - Byte length to keep; defaults to zero.
   */
  truncateSync(path: string, length = 0): void {
    const target = this.key(path)
    const node = this.files.get(target)
    if (node === undefined) fail('ENOENT', 'truncate', target)
    const bytes = node.bytes.slice(0, length)
    this.files.set(target, { bytes, mtimeMs: this.touch(target), mode: node.mode })
    this.publish({ kind: 'write', path: target, bytes, mode: node.mode, entryChanged: false })
  }

  /**
   * Change an entry's permission bits; stat reads back exactly what was set.
   * @param path - File or directory path.
   * @param mode - New permission bits (`0o777` mask).
   */
  chmodSync(path: string, mode: number): void {
    const target = this.key(path)
    const node = this.files.get(target)
    if (node !== undefined) {
      node.mode = mode & 0o777
      this.publish({ kind: 'chmod', path: target, mode: node.mode })
      return
    }
    if (this.directories.has(target)) {
      const bits = mode & 0o777
      this.directoryModes.set(target, bits)
      this.publish({ kind: 'chmod', path: target, mode: bits })
      return
    }
    fail('ENOENT', 'chmod', target)
  }

  /**
   * Remove a file.
   * @param path - File path.
   */
  unlinkSync(path: string): void {
    const target = this.key(path)
    if (!this.files.delete(target)) fail('ENOENT', 'unlink', target)
    this.forgetIdentity(target)
    this.touchDirectory(dirname(target))
    this.publish({ kind: 'remove', path: target })
  }

  /**
   * Remove a file or directory.
   * @param path - Path to remove.
   * @param options - `recursive` removes subtrees, `force` ignores absence.
   */
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void {
    const target = this.key(path)
    if (this.files.delete(target)) {
      this.forgetIdentity(target)
      this.touchDirectory(dirname(target))
      this.publish({ kind: 'remove', path: target })
      return
    }
    if (this.directories.has(target)) {
      if (options?.recursive !== true) fail('ERR_FS_EISDIR', 'rm', target)
      const prefix = `${target}${SEP}`
      for (const candidate of [...this.files.keys()]) if (candidate.startsWith(prefix)) this.files.delete(candidate)
      for (const candidate of [...this.directories]) {
        if (!candidate.startsWith(prefix)) continue
        this.directories.delete(candidate)
        this.directoryModes.delete(candidate)
        this.directoryMtimes.delete(candidate)
      }
      this.directories.delete(target)
      this.directoryModes.delete(target)
      this.directoryMtimes.delete(target)
      this.forgetIdentity(target)
      this.touchDirectory(dirname(target))
      this.publish({ kind: 'remove', path: target })
      return
    }
    if (options?.force !== true) fail('ENOENT', 'rm', target)
  }

  /**
   * Create a uniquely named directory beside `prefix`, as `fs.mkdtempSync` does.
   * @param prefix - Path prefix; the suffix is appended without a separator.
   * @returns The created directory path.
   */
  mkdtempSync(prefix: string): string {
    this.temporaries += 1
    const target = `${prefix}${Date.now().toString(36)}${this.temporaries.toString(36)}`
    this.mkdirSync(target, { recursive: true })
    return this.key(target)
  }

  /**
   * Seed a file and its parent directories, for image loading and tests.
   * @param path - File path.
   * @param data - Text or bytes.
   * @param options - Permission bits and modification time supplied by the image or durable store.
   */
  seed(path: string, data: string | Uint8Array, options: VfsSeedOptions = {}): void {
    const target = this.key(path)
    this.seedDirectory(dirname(target))
    this.files.set(target, {
      bytes: typeof data === 'string' ? encoder.encode(data) : data,
      mtimeMs: options.mtimeMs ?? this.touch(target),
      mode: (options.mode ?? DEFAULT_FILE_MODE) & 0o777,
    })
    this.touchDirectory(dirname(target))
  }

  /**
   * Create a directory and its parents.
   * @param path - Directory path.
   * @param options - Permission bits and modification time supplied by the image or durable store.
   */
  seedDirectory(path: string, options: VfsSeedOptions = {}): void {
    const target = this.key(path)
    if (!this.directories.has(target)) {
      const parent = dirname(target)
      if (parent !== target) this.seedDirectory(parent)
      if (this.files.has(target)) fail('EEXIST', 'mkdir', target)
      this.directories.add(target)
      this.directoryMtimes.set(target, options.mtimeMs ?? Date.now())
      this.touchDirectory(parent)
    }
    if (options.mode !== undefined) this.directoryModes.set(target, options.mode & 0o777)
    if (options.mtimeMs !== undefined) this.directoryMtimes.set(target, options.mtimeMs)
  }

  /**
   * Report what this filesystem holds, for the host's boot diagnostics.
   * @returns File count, directory count, and total byte size.
   */
  usage(): { files: number; directories: number; bytes: number } {
    let bytes = 0
    for (const node of this.files.values()) bytes += node.bytes.length
    return { files: this.files.size, directories: this.directories.size, bytes }
  }
}

/**
 * Mount a tar image produced by the build-time collector.
 *
 * Entry names are relative to `root` (`node_modules/...`, `config/cordis.yml`);
 * an absolute entry name is a collector defect and fails loud. File contents
 * stay views into `image` — nothing is copied at mount time.
 * @param image - The ustar archive, as `inflateImage` produces it from the fetched image.
 * @param root - Virtual root the entries mount under.
 * @param vfs - Filesystem to fill; a fresh one by default.
 * @returns The filled filesystem.
 */
export function loadVfsImage(image: Uint8Array, root = '/dsh', vfs = new MemoryVfs()): MemoryVfs {
  vfs.seedDirectory(root)
  for (const entry of parseTar(image)) {
    const relativeName = entry.name.startsWith('./') ? entry.name.slice(2) : entry.name
    if (relativeName.startsWith(SEP)) {
      throw new Error(`webworker vfs: image entry must be relative to ${root}, received "${entry.name}"`)
    }
    const target = join(root, relativeName)
    if (entry.directory) {
      vfs.seedDirectory(target, { mode: entry.mode })
      continue
    }
    vfs.seed(target, entry.bytes, { mode: entry.mode })
  }
  return vfs
}
