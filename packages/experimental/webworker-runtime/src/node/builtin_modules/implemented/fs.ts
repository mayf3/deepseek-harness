/**
 * `node:fs` bridge over the worker's in-memory VFS. `MemoryVfs` owns paths,
 * bytes, the directory tree, and Node's error codes; this module adds only what
 * is Node-API-shaped and not VFS business: Buffer results, `Dirent` objects,
 * file descriptors, `mkdtemp`, access checks, watchers, streams, and the promise face.
 */
import { requireActiveVfs } from '../../../storage/active.ts'
import type { Vfs, VfsBigIntStats, VfsStatOptions, VfsStats, VfsWriteOptions } from '../../../storage/types.ts'
import { Buffer } from 'buffer'
import { Readable, Writable } from './stream.ts'
import { dirname } from './path.ts'
import {
  FSWatcher, StatWatcher, unwatchFile, watch, watchAsync, watchFile,
} from './fs-watch.ts'

const vfs = (): Vfs => requireActiveVfs()

export { FSWatcher, StatWatcher, unwatchFile, watch, watchFile }

type PathArg = string | URL | Uint8Array

const asPath = (path: PathArg): string => {
  if (typeof path === 'string') return path
  if (path instanceof URL) return decodeURIComponent(path.pathname)
  return new TextDecoder().decode(path)
}

type EncodingOption = BufferEncoding | { encoding?: BufferEncoding | null } | null | undefined

const encodingOf = (options: EncodingOption): BufferEncoding | undefined => {
  if (options === undefined || options === null) return undefined
  if (typeof options === 'string') return options
  return options.encoding ?? undefined
}

const bytesOf = (path: string): Uint8Array => vfs().readFileSync(path) as Uint8Array

/** Share the VFS bytes rather than copying them. */
const asBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** Node `Dirent` subset returned by `readdirSync(dir, { withFileTypes: true })`. */
export class Dirent {
  /** Entry name, without its directory. */
  readonly name: string
  /** Directory this entry was listed from. */
  readonly parentPath: string
  private readonly file: boolean

  /**
   * Build one directory entry.
   * @param name - entry name.
   * @param parentPath - directory holding it.
   * @param file - whether the entry is a regular file.
   */
  constructor(name: string, parentPath: string, file: boolean) {
    this.name = name
    this.parentPath = parentPath
    this.file = file
  }

  /**
   * Entry kind, as `readdirSync` observed it.
   * @returns Whether the entry is a regular file.
   */
  isFile(): boolean {
    return this.file
  }

  /**
   * Entry kind, as `readdirSync` observed it.
   * @returns Whether the entry is a directory.
   */
  isDirectory(): boolean {
    return !this.file
  }

  /**
   * Symlink test, answered from the image's own shape.
   * @returns False — the image is materialized without symlinks.
   */
  isSymbolicLink(): boolean {
    return false
  }
}

/** Access-mode constants; the VFS has no permission model, so all bits pass. */
export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 64,
  O_TRUNC: 512,
  O_APPEND: 1024,
}

/**
 * Read a file.
 * @param path - file path.
 * @param options - encoding, or an options object carrying one.
 * @returns bytes, or text when an encoding is given.
 */
export function readFileSync(path: PathArg, options?: EncodingOption): Buffer | string {
  const encoding = encodingOf(options)
  const bytes = bytesOf(asPath(path))
  return encoding === undefined || encoding === 'utf8' || encoding === 'utf-8'
    ? (encoding === undefined ? asBuffer(bytes) : new TextDecoder().decode(bytes))
    : asBuffer(bytes).toString(encoding)
}

/**
 * Write a file.
 * @param path - file path.
 * @param data - bytes or text.
 * @param options - write flag and creation mode, forwarded to the VFS.
 */
export function writeFileSync(path: PathArg, data: string | Uint8Array, options?: VfsWriteOptions): void {
  vfs().writeFileSync(asPath(path), data, options)
}

/**
 * Append to a file, creating it when absent.
 * @param path - file path.
 * @param data - bytes or text.
 */
export function appendFileSync(path: PathArg, data: string | Uint8Array): void {
  vfs().appendFileSync(asPath(path), data)
}

/**
 * Whether a path exists.
 * @param path - the path.
 * @returns true when present.
 */
export function existsSync(path: PathArg): boolean {
  return vfs().existsSync(asPath(path))
}

/**
 * Stat a path.
 * @param path - the path.
 * @param options - `bigint` selects the BigInt stats the filesystem service reads.
 * @returns the stats, in the plain or BigInt shape.
 */
export function statSync(path: PathArg, options?: VfsStatOptions): VfsStats | VfsBigIntStats {
  return vfs().statSync(asPath(path), options)
}

/**
 * Read stats through Node's callback form.
 * @param path - Path to stat.
 * @param optionsOrCallback - Stat options or the completion callback.
 * @param maybeCallback - Completion callback when options are present.
 */
export function stat(
  path: PathArg,
  optionsOrCallback: VfsStatOptions | ((error: NodeJS.ErrnoException | null, stats?: VfsStats | VfsBigIntStats) => void),
  maybeCallback?: (error: NodeJS.ErrnoException | null, stats?: VfsStats | VfsBigIntStats) => void,
): void {
  const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
  if (callback === undefined) throw new TypeError('The "callback" argument must be of type function')
  queueMicrotask(() => {
    try {
      callback(null, statSync(path, options))
    } catch (error) {
      callback(error as NodeJS.ErrnoException)
    }
  })
}

/**
 * Change an entry's permission bits; stat reads back exactly what was set.
 * @param path - the path.
 * @param mode - new permission bits (`0o777` mask), numeric or Node's octal string form.
 */
export function chmodSync(path: PathArg, mode: number | string): void {
  vfs().chmodSync(asPath(path), typeof mode === 'string' ? Number.parseInt(mode, 8) : mode)
}

/**
 * Stat a path without following symlinks (the image has none).
 * @param path - the path.
 * @param options - `bigint` selects the BigInt stats the filesystem service reads.
 * @returns the stats, in the plain or BigInt shape.
 */
export function lstatSync(path: PathArg, options?: VfsStatOptions): VfsStats | VfsBigIntStats {
  return statSync(path, options)
}

/**
 * Read link stats through Node's callback form; this symlink-free VFS delegates to stat.
 * @param path - Path to stat.
 * @param optionsOrCallback - Stat options or the completion callback.
 * @param maybeCallback - Completion callback when options are present.
 */
export function lstat(
  path: PathArg,
  optionsOrCallback: VfsStatOptions | ((error: NodeJS.ErrnoException | null, stats?: VfsStats | VfsBigIntStats) => void),
  maybeCallback?: (error: NodeJS.ErrnoException | null, stats?: VfsStats | VfsBigIntStats) => void,
): void {
  stat(path, optionsOrCallback, maybeCallback)
}

/**
 * Canonical path (normalization only: the image is symlink-free).
 * @param path - the path.
 * @returns the resolved path.
 */
export function realpathSync(path: PathArg): string {
  return vfs().realpathSync(asPath(path))
}

/**
 * List a directory.
 * @param path - directory path.
 * @param options - `withFileTypes` selects Dirent objects.
 * @returns names, or Dirent objects.
 */
export function readdirSync(
  path: PathArg,
  options?: { withFileTypes?: boolean } | BufferEncoding | null,
): string[] | Dirent[] {
  const target = asPath(path)
  const names = vfs().readdirSync(target)
  if (typeof options !== 'object' || options === null || options.withFileTypes !== true) return names
  return names.map(name => new Dirent(name, target, vfs().statSync(`${target}/${name}`).isFile()))
}

/**
 * Create a directory.
 * @param path - directory path.
 * @param options - `recursive` creates parents.
 * @returns the first created path when recursive, else undefined.
 */
export function mkdirSync(path: PathArg, options?: { recursive?: boolean; mode?: number }): string | undefined {
  return vfs().mkdirSync(asPath(path), options)
}

/**
 * Create a uniquely named directory.
 * @param prefix - path prefix; six random characters are appended.
 * @returns the created directory path.
 */
export function mkdtempSync(prefix: string): string {
  // Not crypto.randomUUID: browsers expose that only in secure contexts.
  const suffix = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(3)), byte => byte.toString(16).padStart(2, '0')).join('')
  const target = `${prefix}${suffix}`
  vfs().mkdirSync(target, { recursive: true })
  return target
}

/**
 * Remove a file or directory.
 * @param path - the path.
 * @param options - `recursive`/`force`, as in Node.
 */
export function rmSync(path: PathArg, options?: { recursive?: boolean; force?: boolean }): void {
  vfs().rmSync(asPath(path), options)
}

/**
 * Remove a file.
 * @param path - the path.
 */
export function unlinkSync(path: PathArg): void {
  vfs().rmSync(asPath(path))
}

/**
 * Rename a path.
 * @param from - source path.
 * @param to - target path.
 */
export function renameSync(from: PathArg, to: PathArg): void {
  vfs().renameSync(asPath(from), asPath(to))
}

/**
 * Access check: existence only.
 * @param path - the path.
 */
export function accessSync(path: PathArg): void {
  vfs().realpathSync(asPath(path))
}

interface OpenFile {
  path: string
  position: number
  append: boolean
}

const openFiles = new Map<number, OpenFile>()
let nextFd = 3

/**
 * Open a file descriptor.
 * @param path - file path.
 * @param flags - Node flag string: 'r', 'w', 'a', with optional '+' and the
 * exclusive 'x' (create-only) modifier.
 * @param mode - creation permission bits.
 * @returns the descriptor.
 */
export function openSync(path: PathArg, flags = 'r', mode?: number): number {
  const target = asPath(path)
  const exists = vfs().existsSync(target)
  if (flags.includes('x') && exists) {
    const error = new Error(`EEXIST: file already exists, open '${target}'`) as Error & { code: string; path: string }
    error.code = 'EEXIST'
    error.path = target
    throw error
  }
  if (flags.startsWith('r')) vfs().realpathSync(target)
  else if (flags.startsWith('w') || !exists) {
    vfs().writeFileSync(target, new Uint8Array(0), mode === undefined ? undefined : { mode })
  }
  const fd = nextFd++
  openFiles.set(fd, { path: target, position: 0, append: flags.startsWith('a') })
  return fd
}

const fileOf = (fd: number, syscall: string): OpenFile => {
  const file = openFiles.get(fd)
  if (file === undefined) throw new Error(`EBADF: bad file descriptor, ${syscall}`)
  return file
}

/**
 * Read from a descriptor.
 * @param fd - descriptor.
 * @param buffer - destination.
 * @param offset - destination offset.
 * @param length - byte count.
 * @param position - file position, or null to continue from the cursor.
 * @returns bytes read.
 */
export function readSync(
  fd: number,
  buffer: Uint8Array,
  offset = 0,
  length = buffer.byteLength,
  position: number | null = null,
): number {
  const file = fileOf(fd, 'read')
  const bytes = bytesOf(file.path)
  const from = position ?? file.position
  const slice = bytes.subarray(from, from + length)
  buffer.set(slice, offset)
  if (position === null) file.position = from + slice.byteLength
  return slice.byteLength
}

/**
 * Write through a descriptor.
 * @param fd - descriptor.
 * @param data - bytes or text.
 * @returns bytes written.
 */
export function writeSync(fd: number, data: string | Uint8Array): number {
  const file = fileOf(fd, 'write')
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  if (file.append) {
    vfs().appendFileSync(file.path, bytes)
    return bytes.byteLength
  }
  const existing = vfs().existsSync(file.path) ? bytesOf(file.path) : new Uint8Array(0)
  const merged = new Uint8Array(Math.max(existing.byteLength, file.position + bytes.byteLength))
  merged.set(existing, 0)
  merged.set(bytes, file.position)
  vfs().writeFileSync(file.path, merged)
  file.position += bytes.byteLength
  return bytes.byteLength
}

/**
 * Close a descriptor.
 * @param fd - descriptor.
 */
export function closeSync(fd: number): void {
  openFiles.delete(fd)
}

/**
 * Create a second name for one file's contents. Hard links do not exist in the
 * VFS, so the bytes are copied.
 * @param from - existing path.
 * @param to - new path.
 */
export function linkSync(from: PathArg, to: PathArg): void {
  writeFileSync(to, bytesOf(asPath(from)))
}

/**
 * Open file handle (`fs.FileHandle` subset): the atomic-write and durability
 * pair the storage backends use. `sync`/`datasync` settle the active VFS's
 * optional write-behind sink.
 */
export interface FileHandle {
  readonly fd: number
  readFile(options?: EncodingOption): Promise<Buffer | string>
  writeFile(data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>
  write(data: string | Uint8Array): Promise<{ bytesWritten: number }>
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }>
  stat(): Promise<VfsStats>
  truncate(length?: number): Promise<void>
  sync(): Promise<void>
  datasync(): Promise<void>
  close(): Promise<void>
}

/**
 * Open a file handle. Directories open read-only, which is what the durability
 * helpers do before an fsync.
 * @param path - file or directory path.
 * @param flags - Node flag string.
 * @param mode - creation permission bits.
 * @returns the handle.
 */
export function openHandleSync(path: PathArg, flags = 'r', mode?: number): FileHandle {
  const target = asPath(path)
  const directory = vfs().existsSync(target) && vfs().statSync(target).isDirectory()
  const append = flags.startsWith('a')
  const fd = directory ? -1 : openSync(target, flags, mode)
  return {
    fd,
    readFile: async (options?: EncodingOption) => readFileSync(target, options),
    // Node appends when the handle was opened with 'a'. The JSONL session log
    // depends on it — `open(path, 'a')` then `writeFile(batch)` — and replacing
    // the file there destroys the header frame its reader requires.
    writeFile: async (data: string | Uint8Array) => {
      if (append) appendFileSync(target, data)
      else writeFileSync(target, data)
    },
    write: async (data: string | Uint8Array) => ({ bytesWritten: writeSync(fd, data) }),
    read: async (buffer: Uint8Array, offset = 0, length = buffer.byteLength, position: number | null = null) => ({
      bytesRead: readSync(fd, buffer, offset, length, position),
      buffer,
    }),
    stat: async () => statSync(target) as VfsStats,
    truncate: async (length = 0) => {
      writeFileSync(target, bytesOf(target).subarray(0, length))
    },
    sync: async () => { await vfs().flush() },
    datasync: async () => { await vfs().flush() },
    close: async () => {
      if (fd !== -1) closeSync(fd)
    },
  }
}

/** Options supported by the VFS-backed read stream. */
export interface ReadStreamOptions {
  flags?: string
  encoding?: BufferEncoding | null
  autoClose?: boolean
  emitClose?: boolean
  start?: number
  end?: number
  highWaterMark?: number
  signal?: AbortSignal
}

/** Options supported by the VFS-backed write stream. */
export interface WriteStreamOptions {
  flags?: string
  encoding?: BufferEncoding | null
  mode?: number
  autoClose?: boolean
  emitClose?: boolean
  start?: number
  highWaterMark?: number
  signal?: AbortSignal
}

const aborted = (reason?: unknown): Error => {
  const error = new Error('The operation was aborted', { cause: reason }) as Error & { code: string }
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/** Read stream over one VFS file. */
export class ReadStream extends Readable {
  /** Resolved path opened by this stream. */
  readonly path: string
  /** Open descriptor, or null before open and after close. */
  fd: number | null = null
  /** Whether the descriptor is still waiting to open. */
  pending = true
  /** Bytes delivered by this stream. */
  bytesRead = 0
  private readonly start: number
  private readonly end: number
  private readonly flags: string
  private readonly signal: AbortSignal | undefined
  private readonly onAbort: (() => void) | undefined
  private position: number

  constructor(path: PathArg, options: ReadStreamOptions = {}) {
    super({
      autoDestroy: options.autoClose ?? true,
      emitClose: options.emitClose ?? true,
      highWaterMark: options.highWaterMark ?? 64 * 1024,
    })
    this.path = asPath(path)
    this.start = options.start ?? 0
    this.end = options.end ?? Number.POSITIVE_INFINITY
    this.flags = options.flags ?? 'r'
    this.position = this.start
    this.signal = options.signal
    this.onAbort = options.signal === undefined ? undefined : () => { this.destroy(aborted(options.signal?.reason)) }
    if (options.encoding !== undefined && options.encoding !== null) this.setEncoding(options.encoding)
    options.signal?.addEventListener('abort', this.onAbort as () => void, { once: true })
  }

  override _construct(callback: (error?: Error | null) => void): void {
    if (this.start < 0 || this.end < this.start) {
      callback(new RangeError('The value of "start" is out of range'))
      return
    }
    if (this.signal?.aborted === true) {
      callback(aborted(this.signal.reason))
      return
    }
    try {
      this.fd = openSync(this.path, this.flags)
      this.pending = false
      this.emit('open', this.fd)
      this.emit('ready')
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _read(size: number): void {
    if (this.fd === null) return
    const remaining = this.end === Number.POSITIVE_INFINITY ? size : Math.min(size, this.end - this.position + 1)
    if (remaining <= 0) {
      this.push(null)
      return
    }
    const buffer = Buffer.allocUnsafe(remaining)
    let count: number
    try {
      count = readSync(this.fd, buffer, 0, remaining, this.position)
    } catch (error) {
      this.destroy(error as Error)
      return
    }
    if (count === 0) {
      this.push(null)
      return
    }
    this.position += count
    this.bytesRead += count
    this.push(buffer.subarray(0, count))
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.signal?.removeEventListener('abort', this.onAbort as () => void)
    if (this.fd !== null) closeSync(this.fd)
    this.fd = null
    this.pending = false
    callback(error)
  }

  /**
   * Close the stream and release its descriptor.
   * @param callback - Optional completion callback after `close`.
   */
  close(callback?: (error?: NodeJS.ErrnoException | null) => void): void {
    if (callback !== undefined) this.once('close', () => { callback(null) })
    this.destroy()
  }
}

/** Writable stream committing chunks through the VFS file-descriptor face. */
export class WriteStream extends Writable {
  /** Resolved path opened by this stream. */
  readonly path: string
  /** Open descriptor, or null before open and after close. */
  fd: number | null = null
  /** Whether the descriptor is still waiting to open. */
  pending = true
  /** Bytes committed by this stream. */
  bytesWritten = 0
  private readonly flags: string
  private readonly mode: number | undefined
  private readonly start: number | undefined
  private readonly signal: AbortSignal | undefined
  private readonly onAbort: (() => void) | undefined

  constructor(path: PathArg, options: WriteStreamOptions = {}) {
    super({
      autoDestroy: options.autoClose ?? true,
      decodeStrings: true,
      defaultEncoding: options.encoding ?? 'utf8',
      emitClose: options.emitClose ?? true,
      highWaterMark: options.highWaterMark ?? 64 * 1024,
    })
    this.path = asPath(path)
    this.flags = options.flags ?? 'w'
    this.mode = options.mode
    this.start = options.start
    this.signal = options.signal
    this.onAbort = options.signal === undefined ? undefined : () => { this.destroy(aborted(options.signal?.reason)) }
    options.signal?.addEventListener('abort', this.onAbort as () => void, { once: true })
  }

  override _construct(callback: (error?: Error | null) => void): void {
    if (this.start !== undefined && this.start < 0) {
      callback(new RangeError('The value of "start" is out of range'))
      return
    }
    if (this.signal?.aborted === true) {
      callback(aborted(this.signal.reason))
      return
    }
    try {
      this.fd = openSync(this.path, this.flags, this.mode)
      if (this.start !== undefined) fileOf(this.fd, 'write').position = this.start
      this.pending = false
      this.emit('open', this.fd)
      this.emit('ready')
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _write(
    chunk: string | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      if (this.fd === null) throw new Error('EBADF: bad file descriptor, write')
      const data = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
      this.bytesWritten += writeSync(this.fd, data)
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.signal?.removeEventListener('abort', this.onAbort as () => void)
    closeDescriptor(this.fd)
    this.fd = null
    this.pending = false
    callback(error)
  }

  /**
   * Close the stream and release its descriptor.
   * @param callback - Optional completion callback after `close`.
   */
  close(callback?: (error?: NodeJS.ErrnoException | null) => void): void {
    if (callback !== undefined) this.once('close', () => { callback(null) })
    this.destroy()
  }
}

/** Close a stream-owned descriptor when it has opened successfully. */
function closeDescriptor(fd: number | null): void {
  if (fd !== null) closeSync(fd)
}

/**
 * Create a Node-compatible readable file stream over the VFS.
 * @param path - File path.
 * @param options - Encoding, range, open, buffer, and abort options.
 * @returns The readable file stream.
 */
export function createReadStream(path: PathArg, options?: ReadStreamOptions | BufferEncoding): ReadStream {
  return new ReadStream(path, typeof options === 'string' ? { encoding: options } : options)
}

/**
 * Create a Node-compatible writable file stream over the VFS.
 * @param path - File path.
 * @param options - Encoding, open, buffer, and abort options.
 * @returns The writable file stream.
 */
export function createWriteStream(path: PathArg, options?: WriteStreamOptions | BufferEncoding): WriteStream {
  return new WriteStream(path, typeof options === 'string' ? { encoding: options } : options)
}

/** Open directory handle (`fs.Dir` subset): iteration plus the close pair. */
export interface Dir {
  readonly path: string
  read(): Promise<Dirent | null>
  close(): Promise<void>
  closeSync(): void
  [Symbol.asyncIterator](): AsyncIterableIterator<Dirent>
}

/**
 * Open a directory handle. Callers use it to assert "this path is a directory"
 * and to walk entries; the listing is taken once, since the VFS has no external
 * writer to race with.
 * @param path - directory path.
 * @returns the handle.
 */
export function opendirSync(path: PathArg): Dir {
  const target = asPath(path)
  const entries = readdirSync(target, { withFileTypes: true }) as Dirent[]
  let index = 0
  const next = (): Dirent | null => entries[index++] ?? null
  return {
    path: target,
    read: async () => next(),
    close: async () => { index = entries.length },
    closeSync: () => { index = entries.length },
    async *[Symbol.asyncIterator]() {
      for (let entry = next(); entry !== null; entry = next()) yield entry
    },
  }
}

/**
 * Promise face (`node:fs/promises`) over the same VFS. Each member answers the
 * union the VFS produces rather than Node's encoding-dependent overloads, so the
 * check here is that every name is a real `node:fs/promises` export.
 */
export const promises = {
  readFile: async (path: PathArg, options?: EncodingOption): Promise<Buffer | string> => readFileSync(path, options),
  writeFile: async (
    path: PathArg,
    data: string | Uint8Array,
    options?: { flag?: string; mode?: number } | BufferEncoding | null,
  ): Promise<void> => {
    const flag = typeof options === 'object' && options !== null ? options.flag : undefined
    const mode = typeof options === 'object' && options !== null ? options.mode : undefined
    if (flag !== undefined && flag.includes('x') && existsSync(path)) {
      const error = new Error(`EEXIST: file already exists, open '${asPath(path)}'`) as Error & { code: string }
      error.code = 'EEXIST'
      throw error
    }
    if (flag !== undefined && flag.startsWith('a')) appendFileSync(path, data)
    else writeFileSync(path, data, { ...flag === undefined ? {} : { flag }, ...mode === undefined ? {} : { mode } })
  },
  appendFile: async (path: PathArg, data: string | Uint8Array): Promise<void> => { appendFileSync(path, data) },
  mkdir: async (path: PathArg, options?: { recursive?: boolean; mode?: number }): Promise<string | undefined> => mkdirSync(path, options),
  mkdtemp: async (prefix: string): Promise<string> => mkdtempSync(prefix),
  readdir: async (
    path: PathArg,
    options?: { withFileTypes?: boolean } | BufferEncoding,
  ): Promise<string[] | Dirent[]> => readdirSync(path, options),
  stat: async (path: PathArg, options?: VfsStatOptions): Promise<VfsStats | VfsBigIntStats> => statSync(path, options),
  lstat: async (path: PathArg, options?: VfsStatOptions): Promise<VfsStats | VfsBigIntStats> => lstatSync(path, options),
  realpath: async (path: PathArg): Promise<string> => realpathSync(path),
  rm: async (path: PathArg, options?: { recursive?: boolean; force?: boolean }): Promise<void> => { rmSync(path, options) },
  unlink: async (path: PathArg): Promise<void> => { unlinkSync(path) },
  rename: async (from: PathArg, to: PathArg): Promise<void> => { renameSync(from, to) },
  access: async (path: PathArg): Promise<void> => { accessSync(path) },
  chmod: async (path: PathArg, mode: number | string): Promise<void> => { chmodSync(path, mode) },
  cp: async (from: PathArg, to: PathArg): Promise<void> => {
    const source = asPath(from)
    const target = asPath(to)
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true })
      for (const name of vfs().readdirSync(source)) await promises.cp(`${source}/${name}`, `${target}/${name}`)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytesOf(source))
  },
  // The VFS has no inodes, so a hard link is a byte copy: the caller's contract
  // is only that both names read the same content until one is removed.
  link: async (from: PathArg, to: PathArg): Promise<void> => { linkSync(from, to) },
  open: async (path: PathArg, flags?: string, mode?: number): Promise<FileHandle> => openHandleSync(path, flags, mode),
  opendir: async (path: PathArg): Promise<Dir> => opendirSync(path),
  truncate: async (path: PathArg, length = 0): Promise<void> => {
    writeFileSync(path, bytesOf(asPath(path)).subarray(0, length))
  },
  watch: watchAsync,
  constants,
} satisfies Partial<Record<keyof typeof import('node:fs/promises'), unknown>>

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ./builtins.ts). */
export const __esModule = true

/**
 * Members Node declares as encoding- and option-dependent overload ladders
 * (`readFileSync` answering `Buffer` XOR `string`, `statSync` answering `Stats`
 * XOR `BigIntStats`, `mkdirSync` answering `string` XOR `void`). This module
 * answers the union its VFS actually produces from one signature, which no single
 * signature can present as all of Node's overloads; `realpathSync` additionally
 * carries Node's `.native` member, and `constants`, `promises`, and `Dirent` hold
 * the subsets the host tree reads.
 */
type OwnSignature =
  | 'constants' | 'promises' | 'Dirent' | 'FSWatcher' | 'StatWatcher' | 'ReadStream' | 'WriteStream'
  | 'readFileSync' | 'writeFileSync' | 'appendFileSync' | 'statSync' | 'lstatSync' | 'realpathSync'
  | 'readdirSync' | 'mkdirSync' | 'mkdtempSync' | 'rmSync' | 'opendirSync'
  | 'openSync' | 'readSync' | 'writeSync' | 'stat' | 'lstat' | 'watch' | 'watchFile' | 'unwatchFile'
  | 'createReadStream' | 'createWriteStream'

/**
 * The `node:fs` declarations this module stands in for. Every other member is
 * checked against Node; `openHandleSync` is the worker's own handle opener, which
 * `promises.open` answers with and Node has no synchronous counterpart for.
 */
type NodeFace = Partial<Omit<typeof import('node:fs'), OwnSignature>>
  & Record<OwnSignature | 'openHandleSync', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default {
  constants, promises, Dirent, FSWatcher, StatWatcher, ReadStream, WriteStream,
  readFileSync, writeFileSync, appendFileSync, existsSync, statSync, stat, lstatSync, lstat, realpathSync, chmodSync,
  readdirSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, renameSync, accessSync, opendirSync,
  openHandleSync, linkSync,
  openSync, readSync, writeSync, closeSync, watch, watchFile, unwatchFile,
  createReadStream, createWriteStream,
} satisfies NodeFace
