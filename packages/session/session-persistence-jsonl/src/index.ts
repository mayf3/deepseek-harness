/**
 * JSONL durable session-persistence backend. It stores a header and contiguous
 * events in one append-only file per session, and delegates orchestration to
 * {@link PersistenceCoordinator}. Its side-effect-free locator returns the
 * absolute per-session log target before materialization.
 * @module @deepseek-ai/dsh-session-persistence-jsonl
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SessionFormatUnsupportedMigrationError,
  sessionFormatCatalog,
} from '@deepseek-ai/dsh-session-format-catalog'
import { readdirSync, type Dirent } from 'node:fs'
import { open, mkdir, readFile, readdir, realpath, link, rm, stat, truncate } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS,
  SessionPersistence, SessionPersistenceRevision, PersistenceCoordinator, SessionFormatUnsupportedError,
  sessionFormatVersionRefusal,
  type BorrowedSessionSource,
  type PersistenceBackend, type SessionLocation, type SessionPersistenceListing, type SessionPersistenceSnapshot,
  type SessionEventSuffix, type SessionInspection,
  type SessionPersistenceRevision as PersistenceRevision, type SessionRawArtifact,
  type SessionStorageMetadata,
  type StoredPrefix,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  Session,
  SessionEvent,
  SessionId,
  SessionHeader,
  SessionLogOffset,
  SessionPreparation,
} from '@deepseek-ai/dsh-session'
import {
  SESSION_FORMAT_VERSION,
  SessionId as makeSessionId,
  interruptedTurnClosers,
} from '@deepseek-ai/dsh-session'
import {
  encodeSegment, eventLines, generationLogFilename, generationLogPath, logPath, logSuffix,
  parseGenerationLogFilename, parseHeader, parseHeaderValue, projectDir, scanLog, sessionDir,
  SessionLogScanner, toHeaderLine,
  type JsonlCompression,
} from './format.ts'
import {
  compressZstdFrame, createZstdFrameDecoder, decompressZstdFrame, decompressZstdPrefix, scanZstdFrames,
  type ZstdFrameDecoder,
} from './zstd.ts'
import { ensureDurableDirectoryWin32, publishNewFileWin32 } from './win32.ts'
import {
  ensureJsonlGenerationCurrent,
  JsonlGenerationNewerVersionError,
  JsonlGenerationUnsupportedMigrationError,
  type JsonlGenerationFormatAdapter,
  type JsonlZstdBodyFrames,
} from './generation.ts'

export type { JsonlCompression } from './format.ts'

const DEFAULT_PACK_CHUNKS = true
const DEFAULT_COMPRESSION: JsonlCompression = 'zstd'
/**
 * Internal scheduling constant, not deployment configuration: balance
 * frame-boundary event-loop yields against `setImmediate` overhead. One frame
 * remains an indivisible synchronous decode.
 */
const ZSTD_DECODE_YIELD_INTERVAL_MS = 500

/** Assert that the independently decodable first frame contains only the header record. */
function assertZstdHeaderFrame(plaintext: Buffer): void {
  if (plaintext.length === 0 || plaintext.indexOf(0x0A) !== plaintext.length - 1) {
    throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
  }
}

/** Loader schema for the JSONL artifact's physical encoding. */
export const JsonlCompressionSchema: z<JsonlCompression> = z.union([
  z.const('zstd'),
  z.const('none'),
]).default(DEFAULT_COMPRESSION)

/** Plugin config: where the JSONL backend keeps its session logs, and the packed-row write switch. */
export interface Config {
  /**
   * Root directory for all session files. Required (no default): a default of
   * `process.cwd()` would scatter session files as the process's cwd changes
   * (bash calls, subprocesses). Sessions group under human-readable project
   * directories, then per-session directories. An existing root must be a
   * readable directory; an absent root is created on first materialization.
   */
  root: string
  /**
   * Write runs of consecutive `assistant/chunk` delta events as packed
   * `text-chunks`/`reasoning-chunks`/`tool-call-chunks` rows (lossless,
   * ~60% smaller logs measured on a real session). Defaults to true; false
   * keeps one `SessionEvent` per line for diagnostics. Reading packed rows is
   * unconditional: a log's layout never depends on this switch.
   */
  packChunks?: boolean
  /** Physical encoding; defaults to checksummed Zstandard frames. */
  compression?: JsonlCompression
  /** Maximum cold Session preparations retained for history-to-resume reuse. */
  preparedSessionCacheSize?: number
  /** Fixed live-event coalescing window; not a backend completion deadline. */
  writeBatchMaxDelayMs?: number
}

/** Opaque coordinator token for replacing bytes recovered from a torn frame. */
interface JsonlTornMarker {
  truncateTo: number
  recoveredEvents: SessionEvent[]
}

interface FileRevisionIdentity {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

interface CurrentJsonlFile {
  readonly path: string
  readonly buffer: Buffer
  readonly revision: PersistenceRevision
  readonly storage: SessionStorageMetadata
  readonly headerRecord: Buffer
  readonly zstdBody?: JsonlZstdBodyFrames
}

/** One authoritative immutable generation selected from a Session directory. */
interface ResolvedJsonlGeneration {
  readonly sourcePath: string
  readonly sourceVersion: number
  readonly currentPath: string
}

/** Build the source-qualified revision shared by full and lightweight reads. */
function fileRevision(identity: FileRevisionIdentity): PersistenceRevision {
  return SessionPersistenceRevision([
    identity.dev,
    identity.ino,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
  ].join(':'))
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * The JSONL persistence backend. Load as a plugin; it registers as
 * `ctx.sessionPersistence` and (via the coordinator) installs the write-path
 * listeners. Its torn-tail marker carries the byte offset and any events
 * recovered from an incomplete final Zstandard frame.
 */
export class JsonlSessionPersistence extends SessionPersistence implements PersistenceBackend<JsonlTornMarker> {
  override readonly supportsRawArtifacts = true

  static inject = ['sessions']

  static Config: z<Config> = z.object({
    root: z.string().required(),
    packChunks: z.boolean().default(DEFAULT_PACK_CHUNKS),
    compression: JsonlCompressionSchema,
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  /**
   * Backend label for coordinator diagnostics and effects. It shadows
   * `Service.name` without changing the service key captured by the base
   * constructor.
   */
  override readonly name = 'session-persistence-jsonl'

  private root: string
  private packChunks: boolean
  private compression: JsonlCompression
  private coordinator: PersistenceCoordinator<JsonlTornMarker>
  private rootEncodingCheck: Promise<void> | undefined
  /** Current selections validated by this backend instance under the one-writer assumption. */
  private readonly validatedCurrentGenerations = new Map<SessionId, ResolvedJsonlGeneration>()
  private readonly generationFormat: JsonlGenerationFormatAdapter

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    if (sessionFormatCatalog.currentVersion !== SESSION_FORMAT_VERSION) {
      throw new Error(
        `session-persistence-jsonl: format catalog v${sessionFormatCatalog.currentVersion} `
        + `does not match Session v${SESSION_FORMAT_VERSION}`,
      )
    }
    // Resolve once so later process.cwd() changes cannot split one backend across roots.
    this.root = resolve(config.root)
    // Programmatic wrappers may construct the backend without Schemastery normalization.
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE
    const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs
      ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS
    this.packChunks = config.packChunks ?? DEFAULT_PACK_CHUNKS
    this.compression = config.compression ?? DEFAULT_COMPRESSION
    this.generationFormat = {
      currentVersion: sessionFormatCatalog.currentVersion,
      migrate: (source) => {
        const decoded = sessionFormatCatalog.decodeRecoverableArtifact(source.header, source.rows)
        const current = sessionFormatCatalog.migrate(decoded)
        const closers = interruptedTurnClosers(current.events as unknown as readonly SessionEvent[])
        const repaired = closers.length === 0
          ? current
          : {
            ...current,
            events: [...current.events, ...closers] as unknown as typeof current.events,
          }
        return sessionFormatCatalog.encodeCurrent(repaired, { packChunks: this.packChunks })
      },
      validateCurrent: (candidate) => {
        const decoded = sessionFormatCatalog.decodeArtifact(candidate.header, candidate.rows)
        sessionFormatCatalog.migrate(decoded)
      },
      isUnsupportedMigrationError: (error): error is SessionFormatUnsupportedMigrationError =>
        error instanceof SessionFormatUnsupportedMigrationError,
    }
    this.assertUsableRoot()
    this.coordinator = new PersistenceCoordinator<JsonlTornMarker>(this.ctx, this, {
      preparedSessionCacheSize,
      writeBatchMaxDelayMs,
    })
  }

  // Each backend keeps the typed service API beside its storage hooks;
  // extracting these trivial forwards would add an inheritance layer.
  /* jscpd:ignore-start */
  // --- SessionPersistence service API (delegated to the coordinator) ---

  /** Resolve the absolute target path without touching the filesystem. */
  locate(meta: SessionHeader): SessionLocation {
    return { kind: 'jsonl', path: logPath(this.root, meta.cwd, meta.id, this.compression) }
  }

  create(meta: SessionHeader, inheritedEventCount?: SessionLogOffset): Promise<void> {
    return this.coordinator.create(meta, inheritedEventCount)
  }

  override ensureMaterialized(session: Session): Promise<void> {
    return this.coordinator.ensureMaterialized(session)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<SessionInspection> {
    return this.coordinator.load(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return this.coordinator.inspect(id, signal)
  }

  override borrowSession(id: SessionId, signal?: AbortSignal): Promise<BorrowedSessionSource> {
    return this.coordinator.borrowSession(id, signal)
  }

  // JSONL is sequential media: no loadStoredFrom hook, so the coordinator
  // parses the stored prefix (both encodings) and skips forward to fromSeq.
  readFrom(id: SessionId, fromSeq: SessionLogOffset, signal?: AbortSignal): Promise<SessionEventSuffix> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  override readRaw(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    return this.coordinator.readRaw(id, signal)
  }

  // One method serves both public `list` and the backend hook; delegating it to
  // the coordinator would call this hook recursively.

  /* jscpd:ignore-end */
  // --- PersistenceBackend hooks (the file-bytes storage primitives) ---

  /** Publish a current successor for one supported historical generation. */
  async ensureCurrent(id: SessionId, signal?: AbortSignal): Promise<void> {
    const current = await this.readCurrentFile(id, signal)
    if (current === undefined) return
    try {
      await this.assertStoredIdentity(
        current.path,
        sessionFormatCatalog.currentVersion,
        current.storage.meta,
        id,
        signal,
      )
      this.rememberCurrentGeneration(id, current.path)
    } finally {
      current.zstdBody?.[Symbol.dispose]()
    }
  }

  /** Ensure and decode one current stored prefix from a single coherent physical read. */
  async loadCurrentStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<JsonlTornMarker> | undefined> {
    const current = await this.readCurrentFile(id, signal)
    if (current === undefined) return undefined
    try {
      const prefix = await this.decodePrefix(current.path, current.buffer, current.revision, id, signal, current)
      this.rememberCurrentGeneration(id, current.path)
      return prefix
    } finally {
      current.zstdBody?.[Symbol.dispose]()
    }
  }

  /** Resolve, migrate when required, and retain the resulting current physical snapshot. */
  private async readCurrentFile(id: SessionId, signal?: AbortSignal): Promise<CurrentJsonlFile | undefined> {
    signal?.throwIfAborted()
    const selected = await this.findLog(id, signal)
    if (selected === undefined) return
    try {
      const result = await ensureJsonlGenerationCurrent({
        sourcePath: selected.sourcePath,
        sourceVersion: selected.sourceVersion,
        currentPath: selected.currentPath,
        compression: this.compression,
        format: this.generationFormat,
        validateHistoricalHeader: headerValue => this.validateSourceIdentity(
          selected.sourcePath,
          selected.sourceVersion,
          headerValue,
          id,
          signal,
        ),
        ...signal === undefined ? {} : { signal },
      })
      try {
        const storage = parseHeaderValue(result.snapshot.headerValue)
        if (storage === undefined) {
          throw new Error(`corrupt session log: invalid current header in "${result.path}"`)
        }
        return {
          path: result.path,
          buffer: result.snapshot.bytes,
          revision: fileRevision(result.snapshot.identity),
          storage,
          headerRecord: result.snapshot.headerRecord,
          ...result.snapshot.zstdBody === undefined ? {} : { zstdBody: result.snapshot.zstdBody },
        }
      } catch (error: unknown) {
        result.snapshot.zstdBody?.[Symbol.dispose]()
        throw error
      }
    } catch (error: unknown) {
      if (error instanceof JsonlGenerationNewerVersionError) {
        const reason = sessionFormatVersionRefusal(error.storedId, error.storedVersion)
        throw new SessionFormatUnsupportedError(
          `${reason} (raw log: ${selected.sourcePath})`,
          { kind: 'jsonl', path: selected.sourcePath },
        )
      }
      if (error instanceof JsonlGenerationUnsupportedMigrationError) {
        throw new SessionFormatUnsupportedError(
          `${error.message}; source v${error.fromVersion} artifact remains unchanged (raw log: ${selected.sourcePath})`,
          { kind: 'jsonl', path: selected.sourcePath },
        )
      }
      throw error
    }
  }

  /** Read a stored prefix by id across all project directories when cwd is unknown. */
  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<JsonlTornMarker> | undefined> {
    signal?.throwIfAborted()
    const selected = await this.findLog(id, signal)
    if (selected === undefined) return undefined
    const prefix = await this.readPrefix(selected.sourcePath, id, signal)
    this.rememberDecodedCurrentGeneration(id, selected)
    return prefix
  }

  /**
   * Read one log's stat-derived revision without loading its event bytes.
   * Resolving an id with unknown cwd still scans the project directories.
   */
  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const selected = await this.findLog(id, signal)
    if (selected === undefined) return undefined
    try {
      const identity = await stat(selected.sourcePath, { bigint: true })
      signal?.throwIfAborted()
      return fileRevision(identity)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  /**
   * Read a session's stored artifact text verbatim: the durable file bytes
   * decoded from this backend's physical encoding (complete zstd frames
   * concatenated, or UTF-8 plaintext). The content is the exact JSONL text the
   * backend wrote — never a reconstruction from parsed events — so packed-
   * chunk rows, key order, and line breaks survive byte-for-byte. A torn
   * final frame is omitted, matching the committed-prefix semantics of every
   * other read.
   * @param id - the persisted session to read.
   * @param signal - optional cancellation for the stat/read/decode work.
   * @returns the raw artifact text plus the header parsed from its own first
   * line, or `undefined` when the session has no stored artifact.
   */
  async readRawStored(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    signal?.throwIfAborted()
    const selected = await this.findLog(id, signal)
    if (selected === undefined) return undefined
    const { buffer } = await this.readStableFile(selected.sourcePath, signal)
    const artifact = this.decodeRawStored(selected.sourcePath, buffer, id, signal)
    await this.assertStoredIdentity(
      selected.sourcePath,
      selected.sourceVersion,
      artifact.meta,
      id,
      signal,
    )
    this.rememberDecodedCurrentGeneration(id, selected)
    return artifact
  }

  /** Ensure and decode one current raw artifact from a single coherent physical read. */
  async readCurrentRawStored(id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined> {
    const current = await this.readCurrentFile(id, signal)
    if (current === undefined) return undefined
    try {
      const artifact = this.decodeRawStored(current.path, current.buffer, id, signal, current)
      await this.assertStoredIdentity(
        current.path,
        sessionFormatCatalog.currentVersion,
        artifact.meta,
        id,
        signal,
      )
      this.rememberCurrentGeneration(id, current.path)
      return artifact
    } finally {
      current.zstdBody?.[Symbol.dispose]()
    }
  }

  private decodeRawStored(
    path: string,
    buffer: Buffer,
    id: SessionId,
    signal?: AbortSignal,
    current?: CurrentJsonlFile,
  ): SessionRawArtifact {
    let content: string
    if (this.compression === 'zstd') {
      const { frames } = current?.zstdBody?.scan ?? scanZstdFrames(buffer)
      if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
      const plaintexts: Buffer[] = current === undefined
        ? []
        : [Buffer.from(current.headerRecord)]
      let decoder: ZstdFrameDecoder | undefined
      let decodedFrames: Generator<Buffer, void, void>
      if (current?.zstdBody !== undefined) {
        decodedFrames = current.zstdBody.frames
      } else {
        decoder = createZstdFrameDecoder()
        decodedFrames = decoder.decode(buffer, current === undefined ? frames : frames.slice(1))
      }
      // The decoder yields views into a reused buffer; copy each frame's
      // plaintext immediately so a later concat cannot read overwritten memory.
      try {
        for (const plaintext of decodedFrames) {
          signal?.throwIfAborted()
          plaintexts.push(Buffer.from(plaintext))
        }
      } finally {
        decoder?.close()
      }
      content = Buffer.concat(plaintexts).toString('utf8')
    } else {
      content = buffer.toString('utf8')
    }
    const storage = current?.storage ?? parseHeader(content.split('\n', 1)[0] as string)
    if (storage === undefined || storage.meta.id !== id) {
      throw new Error(`corrupt session log: invalid header line in "${path}"`)
    }
    // Raw transfer retains the immutable generation name while removing only
    // the physical compression suffix from a Zstandard artifact.
    const storedFilename = basename(path)
    const filename = this.compression === 'zstd'
      ? storedFilename.slice(0, -'.zstd'.length)
      : storedFilename
    return { ...storage, filename, content }
  }

  /**
   * Read a file's bytes under a revision-stable loop: a writer appending
   * between stat and readFile would yield a torn physical file, so retry
   * while the stat revision changes.
   * @param path - the artifact file to read.
   * @param signal - optional cancellation for the stat/read work.
   * @returns the stable bytes and the revision that matched both stats.
   */
  private async readStableFile(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; revision: PersistenceRevision }> {
    for (;;) {
      signal?.throwIfAborted()
      const before = fileRevision(await stat(path, { bigint: true }))
      const buffer = await readFile(path, { signal })
      signal?.throwIfAborted()
      const after = fileRevision(await stat(path, { bigint: true }))
      if (before === after) return { buffer, revision: after }
    }
  }

  /**
   * Read a stored prefix and convert torn-tail state to the opaque marker the
   * coordinator can round-trip without knowing the physical encoding.
   */
  private async readPrefix(
    path: string,
    expectedId?: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<JsonlTornMarker>> {
    const { buffer, revision } = await this.readStableFile(path, signal)
    return this.decodePrefix(path, buffer, revision, expectedId, signal)
  }

  /** Decode one already-stable physical snapshot without reopening its file. */
  private async decodePrefix(
    path: string,
    buffer: Buffer,
    revision: PersistenceRevision,
    expectedId?: SessionId,
    signal?: AbortSignal,
    prefetched?: CurrentJsonlFile,
  ): Promise<StoredPrefix<JsonlTornMarker>> {
    let prefix: Omit<StoredPrefix<JsonlTornMarker>, 'revision'>
    try {
      if (this.compression === 'zstd') {
        prefix = await this.readZstdPrefix(buffer, signal, prefetched)
      } else {
        signal?.throwIfAborted()
        let scanned: ReturnType<typeof scanLog>
        if (prefetched === undefined) {
          scanned = scanLog(buffer)
        } else {
          const scanner = new SessionLogScanner(prefetched.headerRecord, prefetched.storage)
          scanner.write(buffer.subarray(prefetched.headerRecord.byteLength))
          scanned = scanner.finish()
        }
        const { meta, inheritedEventCount, events, committedBytes } = scanned
        signal?.throwIfAborted()
        prefix = {
          meta,
          inheritedEventCount,
          events,
          ...committedBytes < buffer.byteLength
            ? { tornMarker: { truncateTo: committedBytes, recoveredEvents: [] } }
            : {},
        }
      }
    } catch (error: unknown) {
      // A parse-time format refusal predates any SessionHeader, so the
      // coordinator's locate-based enrichment cannot run; attach the artifact
      // this read actually refused.
      if (error instanceof SessionFormatUnsupportedError && error.location === undefined) {
        throw new SessionFormatUnsupportedError(`${error.message} (raw log: ${path})`, { kind: 'jsonl', path })
      }
      throw error
    }
    signal?.throwIfAborted()
    const storedVersion = parseGenerationLogFilename(basename(path), this.compression)
    /* v8 ignore next -- discovery and current-path construction only select canonical names. */
    if (storedVersion === undefined) throw new Error(`invalid JSONL generation path "${path}"`)
    await this.assertStoredIdentity(path, storedVersion, prefix.meta, expectedId, signal)
    signal?.throwIfAborted()
    return { ...prefix, revision }
  }

  /** Decode complete frames and retain complete JSONL records from a torn final frame. */
  private async readZstdPrefix(
    buffer: Buffer,
    signal?: AbortSignal,
    prefetched?: CurrentJsonlFile,
  ): Promise<Omit<StoredPrefix<JsonlTornMarker>, 'revision'>> {
    signal?.throwIfAborted()
    const { frames, tornStart } = prefetched?.zstdBody?.scan ?? scanZstdFrames(buffer)
    signal?.throwIfAborted()
    if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')

    let decoder: ZstdFrameDecoder | undefined
    let yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS
    try {
      let decodedFrames: Generator<Buffer, void, void>
      let scanner: SessionLogScanner
      let remainingFrames: number
      if (prefetched === undefined) {
        decoder = createZstdFrameDecoder()
        decodedFrames = decoder.decode(buffer, frames)
        signal?.throwIfAborted()
        const headerFrame = decodedFrames.next()
        signal?.throwIfAborted()
        /* v8 ignore next -- a non-empty structural frame list makes the decoder yield its first frame or throw. */
        if (headerFrame.done) throw new Error('empty or header-less Zstandard session log')
        assertZstdHeaderFrame(headerFrame.value)
        scanner = new SessionLogScanner(headerFrame.value)
        remainingFrames = frames.length - 1
      } else {
        assertZstdHeaderFrame(prefetched.headerRecord)
        scanner = new SessionLogScanner(prefetched.headerRecord, prefetched.storage)
        if (prefetched.zstdBody === undefined) {
          decoder = createZstdFrameDecoder()
          decodedFrames = decoder.decode(buffer, frames.slice(1))
        } else {
          decodedFrames = prefetched.zstdBody.frames
        }
        remainingFrames = frames.length - 1
      }
      for (const plaintext of decodedFrames) {
        signal?.throwIfAborted()
        scanner.write(plaintext)
        remainingFrames -= 1
        if (remainingFrames > 0 && performance.now() >= yieldDeadline) {
          await scheduler.yield()
          signal?.throwIfAborted()
          yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS
        }
      }
      signal?.throwIfAborted()
      const complete = scanner.checkpoint()
      if (complete.committedBytes !== complete.inputBytes) {
        throw new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record')
      }
      if (tornStart === undefined) {
        const prefix = scanner.finish()
        return {
          meta: prefix.meta,
          inheritedEventCount: prefix.inheritedEventCount,
          events: prefix.events,
        }
      }

      let recoveredPlaintext: Buffer = Buffer.alloc(0)
      try {
        signal?.throwIfAborted()
        recoveredPlaintext = await decompressZstdPrefix(buffer.subarray(tornStart))
      } catch {
        /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
        if (signal?.aborted) signal.throwIfAborted()
        // A structurally incomplete final frame may end before Node's decoder can
        // emit any plaintext; the complete prior frames remain recoverable.
      }
      signal?.throwIfAborted()
      scanner.write(recoveredPlaintext)
      const recoveredPrefix = scanner.finish()
      signal?.throwIfAborted()
      return {
        meta: recoveredPrefix.meta,
        inheritedEventCount: recoveredPrefix.inheritedEventCount,
        events: recoveredPrefix.events,
        tornMarker: {
          truncateTo: tornStart,
          recoveredEvents: recoveredPrefix.events.slice(complete.eventCount),
        },
      }
    } catch (error) {
      /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
      if (signal?.aborted) signal.throwIfAborted()
      throw error
    } finally {
      decoder?.close()
    }
  }

  /** Durably append a batch, lazily materializing the file when not yet present. */
  async appendBatch(
    storage: SessionStorageMetadata,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    await this.ensureRootEncoding()
    if (isMaterialized) {
      await this.appendLines(storage.meta, events)
    } else {
      await this.materialize(storage, events)
    }
  }

  /** Materialize a header-only JSONL artifact for an explicitly durable empty session. */
  async materializeHeader(storage: SessionStorageMetadata): Promise<void> {
    await this.materialize(storage, [])
  }

  /**
   * Make a crash repair durable: truncate a torn tail, restore complete events
   * decoded from it, then append synthetic closers. Two fsync'd steps — the seam
   * does not require this to be atomic.
   */
  async commitRepair(
    storage: SessionStorageMetadata,
    tornMarker: JsonlTornMarker | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    const { meta } = storage
    if (tornMarker !== undefined) await this.repair(meta, tornMarker.truncateTo)
    const repairedEvents = [...(tornMarker?.recoveredEvents ?? []), ...closers]
    if (repairedEvents.length > 0) await this.appendLines(meta, repairedEvents)
    if (tornMarker !== undefined) this.ctx.logger.warn(`${this.name}: session "${meta.id}" recovered from a torn tail; incomplete tail bytes were discarded`)
  }

  /** List each Session directory's authoritative generation from its header only. */
  async list(signal?: AbortSignal): Promise<SessionPersistenceListing[]> {
    return (await this.listArtifacts(signal)).map(artifact => artifact.listing)
  }

  /** List metadata plus a stat-derived identity for each append-only log. */
  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const snapshots: SessionPersistenceSnapshot[] = []
    for (const artifact of await this.listArtifacts(signal)) {
      signal?.throwIfAborted()
      try {
        const identity = await stat(artifact.path, { bigint: true })
        signal?.throwIfAborted()
        snapshots.push({ ...artifact.listing, revision: fileRevision(identity) })
      } catch (error: unknown) {
        signal?.throwIfAborted()
        if (!isENOENT(error)) throw error
      }
    }
    signal?.throwIfAborted()
    return snapshots
  }

  private async listArtifacts(signal?: AbortSignal): Promise<Array<{
    listing: SessionPersistenceListing
    path: string
  }>> {
    signal?.throwIfAborted()
    const artifacts: Array<{ listing: SessionPersistenceListing; path: string }> = []
    const readableIds = new Map<SessionId, number[]>()
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      for (const dir of await this.listSessionDirs(project, signal)) {
        signal?.throwIfAborted()
        const selected = await this.resolveGenerationInDirectory(dir, signal)
        if (selected === undefined) continue
        const path = selected.sourcePath
        // Read only headers so listing scales with session count, not log size.
        const location = { kind: 'jsonl' as const, path }
        let listing: SessionPersistenceListing
        try {
          const first = this.compression === 'zstd'
            ? await this.readFirstZstdLine(path, signal)
            : await this.readFirstLine(path, signal)
          signal?.throwIfAborted()
          if (first === undefined) {
            listing = {
              status: 'malformed',
              targetVersion: sessionFormatCatalog.currentVersion,
              location,
              reason: 'session artifact has no complete independently readable header',
            }
          } else {
            let headerValue: unknown
            try {
              headerValue = JSON.parse(first)
            } catch (error) {
              throw new Error('session header is not valid JSON', { cause: error })
            }
            const result = sessionFormatCatalog.readHeader(headerValue)
            if ('storedVersion' in result && result.storedVersion !== selected.sourceVersion) {
              throw new Error(
                `session generation filename identifies v${selected.sourceVersion}, `
                + `but its header identifies v${result.storedVersion}`,
              )
            }
            if (result.status === 'current') {
              const header = this.currentHeader(result.header)
              await this.assertStoredIdentity(path, selected.sourceVersion, header, undefined, signal)
              listing = {
                status: 'current',
                storedVersion: result.storedVersion,
                targetVersion: result.targetVersion,
                header,
                location,
              }
            } else if (result.status === 'migration-required') {
              const header = this.currentHeader(result.header)
              await this.assertStoredIdentity(path, selected.sourceVersion, header, undefined, signal)
              listing = {
                status: 'migration-required',
                storedVersion: result.storedVersion,
                targetVersion: result.targetVersion,
                header,
                location,
              }
            } else if (result.status === 'unsupported') {
              listing = {
                status: 'unsupported',
                storedVersion: result.storedVersion,
                targetVersion: result.targetVersion,
                location,
                reason: result.reason,
              }
            } else {
              const malformed = result as { readonly targetVersion: number; readonly reason: string }
              listing = {
                status: 'malformed',
                targetVersion: malformed.targetVersion,
                location,
                reason: malformed.reason,
              }
            }
          }
        } catch (error: unknown) {
          signal?.throwIfAborted()
          let reason: string
          /* v8 ignore else -- built-in header readers reject with Error instances. */
          if (error instanceof Error) reason = error.message
          else reason = String(error)
          listing = {
            status: 'malformed',
            targetVersion: sessionFormatCatalog.currentVersion,
            location,
            reason,
          }
        }
        const index = artifacts.push({ listing, path }) - 1
        if (listing.status === 'current' || listing.status === 'migration-required') {
          const indices = readableIds.get(listing.header.id) ?? []
          indices.push(index)
          readableIds.set(listing.header.id, indices)
        }
      }
    }
    for (const [id, indices] of readableIds) {
      if (indices.length < 2) continue
      for (const index of indices) {
        const artifact = artifacts[index] as { listing: SessionPersistenceListing; path: string }
        artifact.listing = {
          status: 'malformed',
          targetVersion: sessionFormatCatalog.currentVersion,
          location: { kind: 'jsonl', path: artifact.path },
          reason: `duplicate JSONL session id "${id}" appears in multiple project directories`,
        }
      }
    }
    signal?.throwIfAborted()
    return artifacts
  }

  /** Convert format-catalog string identities to current branded Session metadata. */
  private currentHeader(header: {
    readonly version: number
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
    readonly parentSession?: string
    readonly isSeeded: boolean
    readonly origin?: 'subagent'
    readonly delegationDepth: number
    readonly agentPreset?: string
  }): SessionHeader {
    /* v8 ignore next -- readable catalog results always carry the configured current version. */
    if (header.version !== sessionFormatCatalog.currentVersion) {
      throw new Error(`format catalog returned non-current logical header v${header.version}`)
    }
    return {
      version: SESSION_FORMAT_VERSION,
      id: makeSessionId(header.id),
      createdAt: header.createdAt,
      ...header.cwd === undefined ? {} : { cwd: header.cwd },
      ...header.parentSession === undefined ? {} : { parentSession: makeSessionId(header.parentSession) },
      isSeeded: header.isSeeded,
      ...header.origin === undefined ? {} : { origin: header.origin },
      delegationDepth: header.delegationDepth,
      ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
    }
  }

  // --- materialization / append / repair (file mechanics) ---

  /** Atomically write the header line + first batch (temp-write, fsync, publish). */
  private async materialize(storage: SessionStorageMetadata, events: readonly SessionEvent[]): Promise<void> {
    const { meta } = storage
    const project = projectDir(this.root, meta.cwd)
    const dir = sessionDir(this.root, meta.cwd, meta.id)
    const finalPath = logPath(this.root, meta.cwd, meta.id, this.compression)
    await this.rejectOppositeArtifact(meta.cwd, meta.id)
    const content = await this.encodeMaterialization(storage, events)
    /* v8 ignore next -- native Windows coverage exercises this platform dispatch; Linux covers the POSIX peer */
    if (process.platform === 'win32') {
      await this.materializeWin32(project, dir, finalPath, meta.id, content)
    } else {
      await this.materializePosix(project, dir, finalPath, meta.id, content)
    }
    this.rememberCurrentGeneration(meta.id, finalPath)
  }

  /* v8 ignore start -- Windows uses the Win32 durable-publish path; POSIX coverage exercises this peer. */
  private async materializePosix(
    project: string,
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(dirname(this.root))
    await mkdir(project, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(this.root)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await this.syncDirPosix(project)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    // Publish via link()+unlink(), NOT rename(): link fails with EEXIST if the
    // final path already exists, so two processes materializing the same id
    // concurrently cannot clobber each other. rename() would silently overwrite.
    let linked = false
    try {
      await link(tmp, finalPath)
      linked = true
    } finally {
      // Remove an unpublished temp on failure. After publication, defer cleanup
      // until the directory entry is durable so cleanup cannot reject a live log.
      /* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */
      if (!linked) await rm(tmp, { force: true })
    }
    // link() succeeded — the log is published. fsync the directory so the new
    // entry survives a power loss: the new link is not crash-durable until the
    // parent directory's metadata is synced.
    await this.syncDirPosix(dir)
    // Best-effort temp cleanup: the log is already published and durable, so a
    // failure to remove the redundant temp hard link must NOT reject the
    // append. Swallow only the rm failure; nothing else of consequence runs here.
    try {
      await rm(tmp, { force: true })
    } catch {
      /* v8 ignore next -- redundant temp link; publish already durable, rm failure is an unreachable IO edge */
    }
  }
  /* v8 ignore stop */

  /* v8 ignore start -- native Windows coverage exercises this integration path */
  private async materializeWin32(
    project: string,
    dir: string,
    finalPath: string,
    id: SessionId,
    content: Buffer | string,
  ): Promise<void> {
    await ensureDurableDirectoryWin32(this.root)
    await ensureDurableDirectoryWin32(project)
    await ensureDurableDirectoryWin32(dir)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    try {
      await publishNewFileWin32(tmp, finalPath)
    } catch (error) {
      await rm(tmp, { force: true })
      throw error
    }
  }
  /* v8 ignore stop */

  private async rejectExistingLog(finalPath: string, id: SessionId): Promise<void> {
    // Never publish over an existing committed log: materialize is the first
    // write of a session the backend believes is new. A file here means a
    // different session shares this id on disk — reject loudly. (createCore
    // already guards the create path, so this is unreachable-in-practice TOCTOU
    // defense.)
    /* v8 ignore next 3 -- createCore guards collisions before materialize; this is a TOCTOU backstop */
    if (await this.resolveGenerationInDirectory(dirname(finalPath)) !== undefined) {
      throw new Error(`refusing to materialize "${id}": a log already exists on disk (load/resume it instead)`)
    }
  }

  private async writeSyncedTempFile(finalPath: string, content: Buffer | string): Promise<string> {
    const tmp = `${finalPath}.${randomBytes(6).toString('hex')}.tmp`
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return tmp
  }

  /** Encode the header and first batch without combining their frame boundaries. */
  private async encodeMaterialization(
    storage: SessionStorageMetadata,
    events: readonly SessionEvent[],
  ): Promise<Buffer | string> {
    const header = JSON.stringify(toHeaderLine(storage.meta, storage.inheritedEventCount)) + '\n'
    if (events.length === 0) {
      return this.compression === 'none' ? header : compressZstdFrame(header)
    }
    const body = eventLines(events, this.packChunks) + '\n'
    if (this.compression === 'none') return header + body
    const headerFrame = await compressZstdFrame(header)
    const eventFrame = await compressZstdFrame(body)
    return Buffer.concat([headerFrame, eventFrame])
  }

  /** Encode one durable append batch in the configured physical representation. */
  private async encodeEventBatch(events: readonly SessionEvent[]): Promise<Buffer | string> {
    const body = eventLines(events, this.packChunks) + '\n'
    return this.compression === 'zstd' ? compressZstdFrame(body) : body
  }

  /** fsync a POSIX directory so a just-created or linked entry is crash-durable. */
  /* v8 ignore start -- Windows uses write-through namespace operations; POSIX coverage exercises directory fsync. */
  private async syncDirPosix(dir: string): Promise<void> {
    const handle = await open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  /* v8 ignore stop */

  /**
   * Append and fsync event lines. On a partial write or sync failure, restore the
   * previous size before rethrowing because the unchanged cursor will retry the
   * batch; leaving partial bytes would create duplicate sequence numbers.
   */
  private async appendLines(meta: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    const content = await this.encodeEventBatch(events)
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    const handle = await open(path, 'a')
    let closed = false
    const closeAppendHandle = async (): Promise<void> => {
      if (closed) return
      closed = true
      await handle.close()
    }

    try {
      const { size: before } = await handle.stat()
      try {
        await handle.writeFile(content)
        await handle.sync()
      } catch (error) {
        try {
          await closeAppendHandle()
          await this.rollbackAppend(path, before)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back append to "${path}"`)
        }
        throw error
      }
    } finally {
      await closeAppendHandle()
    }
  }

  private async rollbackAppend(path: string, size: number): Promise<void> {
    const handle = await open(path, 'r+')
    try {
      await handle.truncate(size)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** Truncate the log file to `offset` bytes and fsync (discard the crash tail). */
  private async repair(meta: SessionHeader, offset: number): Promise<void> {
    const path = logPath(this.root, meta.cwd, meta.id, this.compression)
    await truncate(path, offset)
    const handle = await open(path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  // --- discovery helpers ---

  /**
   * Read the first newline-terminated line of a file without loading the whole
   * file. Returns undefined if the file is empty or has no complete first line.
   * Reads in bounded chunks so a huge log costs only the header read.
   */
  private async readFirstLine(path: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const handle = await open(path, 'r')
    try {
      signal?.throwIfAborted()
      const chunks: Buffer[] = []
      const buf = Buffer.alloc(8192)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buf, 0, buf.length, null)
        signal?.throwIfAborted()
        if (bytesRead === 0) return undefined // EOF with no newline → no complete line
        const slice = buf.subarray(0, bytesRead)
        const nl = slice.indexOf(0x0a)
        if (nl !== -1) {
          chunks.push(slice.subarray(0, nl))
          signal?.throwIfAborted()
          return Buffer.concat(chunks).toString('utf8')
        }
        chunks.push(Buffer.from(slice))
      }
    } finally {
      await handle.close()
    }
  }

  /** Read and validate only the independently compressed header frame. */
  private async readFirstZstdLine(path: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const handle = await open(path, 'r')
    try {
      signal?.throwIfAborted()
      let content = Buffer.alloc(0)
      const chunk = Buffer.alloc(8192)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
        signal?.throwIfAborted()
        if (bytesRead === 0) return undefined
        signal?.throwIfAborted()
        content = Buffer.concat([content, chunk.subarray(0, bytesRead)])
        signal?.throwIfAborted()
        const first = scanZstdFrames(content, 1).frames[0]
        signal?.throwIfAborted()
        if (first === undefined) continue
        let plaintext: Buffer
        try {
          signal?.throwIfAborted()
          plaintext = await decompressZstdFrame(content.subarray(first.start, first.end))
        } catch (error) {
          /* v8 ignore next -- decoder failure plus concurrent abort is timing-dependent */
          if (signal?.aborted) signal.throwIfAborted()
          throw new Error('corrupt Zstandard session log: header frame failed validation', { cause: error })
        }
        signal?.throwIfAborted()
        assertZstdHeaderFrame(plaintext)
        return plaintext.subarray(0, -1).toString('utf8')
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Scan one Session directory and select its highest canonical immutable
   * generation. Callers that require a current body consult the validated
   * per-instance cache before reaching this cold path; header listing always
   * scans so it reports the directory's authoritative generation.
   */
  private async resolveGenerationInDirectory(
    dir: string,
    signal?: AbortSignal,
  ): Promise<ResolvedJsonlGeneration | undefined> {
    signal?.throwIfAborted()
    const currentPath = join(
      dir,
      generationLogFilename(sessionFormatCatalog.currentVersion, this.compression),
    )
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
    signal?.throwIfAborted()

    const generations: Array<{ readonly path: string; readonly version: number }> = []
    const opposite: Array<{ readonly path: string; readonly version: number }> = []
    for (const entry of entries) {
      const version = parseGenerationLogFilename(entry.name, this.compression)
      if (version !== undefined) {
        generations.push({ path: join(dir, entry.name), version })
        continue
      }
      const oppositeVersion = parseGenerationLogFilename(entry.name, this.oppositeCompression())
      if (oppositeVersion !== undefined) {
        opposite.push({ path: join(dir, entry.name), version: oppositeVersion })
      }
    }
    if (opposite.length > 0) {
      const incompatible = opposite[0] as { readonly path: string; readonly version: number }
      throw this.encodingMismatch(incompatible.path)
    }
    if (generations.length === 0) return undefined
    const latest = generations.sort((a, b) => b.version - a.version)[0] as {
      readonly path: string
      readonly version: number
    }
    return {
      sourcePath: latest.path,
      sourceVersion: latest.version,
      currentPath,
    }
  }

  /** Retain one already-validated current selection for same-process fast opens. */
  private rememberCurrentGeneration(id: SessionId, path: string): void {
    this.validatedCurrentGenerations.set(id, {
      sourcePath: path,
      sourceVersion: sessionFormatCatalog.currentVersion,
      currentPath: path,
    })
  }

  /** Cache one direct decoder result only when its canonical filename is current. */
  private rememberDecodedCurrentGeneration(id: SessionId, selected: ResolvedJsonlGeneration): void {
    if (selected.sourceVersion !== sessionFormatCatalog.currentVersion) {
      throw new Error(
        `resolved JSONL source filename identifies v${selected.sourceVersion}, `
        + `but its decoded header identifies v${sessionFormatCatalog.currentVersion}: ${selected.sourcePath}`,
      )
    }
    this.rememberCurrentGeneration(id, selected.sourcePath)
  }

  /** Find the unique authoritative generation for an id across every project directory. */
  private async findLog(id: SessionId, signal?: AbortSignal): Promise<ResolvedJsonlGeneration | undefined> {
    const cached = this.validatedCurrentGenerations.get(id)
    if (cached !== undefined) {
      signal?.throwIfAborted()
      return cached
    }
    const matches: ResolvedJsonlGeneration[] = []
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      await this.rejectLegacyFlatArtifact(project, id, signal)
      signal?.throwIfAborted()
      const dir = join(project, encodeSegment(id))
      const selected = await this.resolveGenerationInDirectory(dir, signal)
      if (selected !== undefined) matches.push(selected)
    }
    if (matches.length > 1) {
      throw new Error(`duplicate JSONL session id "${id}" appears in multiple project directories`)
    }
    signal?.throwIfAborted()
    return matches[0]
  }

  /** Require an existing configured root to be a readable directory. */
  private assertUsableRoot(): void {
    try {
      readdirSync(this.root)
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }

  /** Reject metadata that does not identify the selected physical log. */
  private assertStoredIdentity(
    path: string,
    storedVersion: number,
    meta: SessionHeader,
    expectedId?: SessionId,
    signal?: AbortSignal,
  ): void | Promise<void> {
    signal?.throwIfAborted()
    if (expectedId !== undefined && meta.id !== expectedId) {
      throw new Error(`corrupt session log "${path}": requested id "${expectedId}" does not match header id "${meta.id}"`)
    }
    let expectedPath: string
    try {
      expectedPath = generationLogPath(this.root, meta.cwd, meta.id, storedVersion, this.compression)
    } catch (error) {
      throw new Error(`corrupt session log "${path}": header id cannot name a storage path`, { cause: error })
    }
    if (path === expectedPath) return
    return this.assertStoredAlias(path, expectedPath, meta.id, signal)
  }

  /** Require a non-identical path spelling to resolve to the same physical artifact. */
  private async assertStoredAlias(
    path: string,
    expectedPath: string,
    headerId: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!await this.sameFile(path, expectedPath, signal)) {
      throw new Error(`corrupt session log "${path}": header id "${headerId}" and cwd identify "${expectedPath}"`)
    }
    signal?.throwIfAborted()
  }

  /** Validate a supported source header against the already-selected artifact before migration. */
  private validateSourceIdentity(
    path: string,
    storedVersion: number,
    headerValue: Readonly<Record<string, unknown>>,
    expectedId: SessionId,
    signal?: AbortSignal,
  ): void | Promise<void> {
    const result = sessionFormatCatalog.readHeader(headerValue)
    if (result.status !== 'current' && result.status !== 'migration-required') return
    return this.assertStoredIdentity(path, storedVersion, this.currentHeader(result.header), expectedId, signal)
  }

  /**
   * Whether two path spellings resolve to the same physical file. This admits
   * case aliases on case-insensitive filesystems without weakening identity
   * checks on case-sensitive stores.
   */
  private async sameFile(path: string, expectedPath: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    try {
      const [actual, expected] = await Promise.all([realpath(path), realpath(expectedPath)])
      signal?.throwIfAborted()
      return actual === expected
    } catch (error) {
      signal?.throwIfAborted()
      /* v8 ignore else -- non-ENOENT realpath failures require an external permission or I/O fault */
      if (isENOENT(error)) return false
      /* v8 ignore next -- non-ENOENT realpath failures are external I/O faults, propagated unchanged */
      throw error
    }
  }

  /** The human-readable project directories under the configured root. */
  private async listProjectDirs(signal?: AbortSignal): Promise<string[]> {
    try {
      signal?.throwIfAborted()
      const entries = await readdir(this.root, { withFileTypes: true })
      signal?.throwIfAborted()
      return entries.filter(e => e.isDirectory()).map(e => join(this.root, e.name))
    } catch (error) {
      // Only an absent root means no sessions; rethrow every other I/O failure.
      if (isENOENT(error)) return []
      throw error
    }
  }

  /** List session-owned directories and reject the obsolete flat-file layout. */
  private async listSessionDirs(project: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    const entries = await readdir(project, { withFileTypes: true })
    signal?.throwIfAborted()
    const legacy = entries.find(entry =>
      entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')))
    if (legacy !== undefined) throw this.legacyLayout(join(project, legacy.name))
    return entries.filter(entry => entry.isDirectory()).map(entry => join(project, entry.name))
  }

  /** Reject a root that already belongs to the other physical encoding. */
  private ensureRootEncoding(): Promise<void> {
    this.rootEncodingCheck ??= this.checkRootEncoding()
    return this.rootEncodingCheck
  }

  private async checkRootEncoding(): Promise<void> {
    for (const project of await this.listProjectDirs()) {
      for (const dir of await this.listSessionDirs(project)) {
        const incompatible = await this.findOppositeGenerationInDirectory(dir)
        if (incompatible !== undefined) throw this.encodingMismatch(incompatible)
      }
    }
  }

  private async rejectLegacyFlatArtifact(
    project: string,
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const encoded = encodeSegment(id)
    for (const compression of ['zstd', 'none'] as const) {
      const path = join(project, encoded + logSuffix(compression))
      const artifactExists = await this.exists(path)
      signal?.throwIfAborted()
      if (artifactExists) throw this.legacyLayout(path)
    }
  }

  private async rejectOppositeArtifact(cwd: string | undefined, id: SessionId): Promise<void> {
    const path = await this.findOppositeGenerationInDirectory(sessionDir(this.root, cwd, id))
    if (path !== undefined) throw this.encodingMismatch(path)
  }

  /** Return the highest canonical generation encoded with the unconfigured suffix. */
  private async findOppositeGenerationInDirectory(dir: string): Promise<string | undefined> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
    const generations: Array<{ readonly name: string; readonly version: number }> = []
    for (const entry of entries) {
      const version = parseGenerationLogFilename(entry.name, this.oppositeCompression())
      if (version !== undefined) generations.push({ name: entry.name, version })
    }
    const latest = generations.sort((a, b) => b.version - a.version)[0]
    return latest === undefined ? undefined : join(dir, latest.name)
  }

  private oppositeCompression(): JsonlCompression {
    return this.compression === 'zstd' ? 'none' : 'zstd'
  }

  private encodingMismatch(path: string): Error {
    return new Error(
      `session artifact ${JSON.stringify(path)} uses ${logSuffix(this.oppositeCompression())}, `
      + `but this backend is configured for compression ${JSON.stringify(this.compression)}; `
      + 'use a separate root or select the matching compression mode',
    )
  }

  private legacyLayout(path: string): Error {
    return new Error(
      `session artifact ${JSON.stringify(path)} uses the unsupported flat-file layout; `
      + 'use a separate root or move it into a project/session directory before loading',
    )
  }

  private async exists(path: string): Promise<boolean> {
    try {
      const handle = await open(path, 'r')
      await handle.close()
      return true
    } catch (error) {
      // Only ENOENT means absent. A permission/I/O error must surface rather
      // than letting load or collision checks proceed under false absence.
      /* v8 ignore else -- Windows reports file-valued parents as ENOENT; POSIX covers direct ENOTDIR. */
      if (isENOENT(error)) {
        // Windows reports ENOENT, not ENOTDIR, for `regular-file/child`, so it
        // alone verifies the immediate parent to keep a blocked session
        // directory a storage fault. POSIX open already reported ENOTDIR before
        // this point, where the extra stat would only cost a syscall per probe.
        /* v8 ignore next -- native Windows coverage exercises this platform dispatch; POSIX reports ENOTDIR from open */
        if (process.platform === 'win32') await this.assertLogParentAllowsAbsence(path)
        return false
      }
      /* v8 ignore next -- Windows repairs ENOTDIR from ENOENT above; POSIX covers direct ENOTDIR. */
      throw error
    }
  }

  /* v8 ignore start -- native Windows coverage exercises this repair; POSIX open reports ENOTDIR before this point. */
  private async assertLogParentAllowsAbsence(path: string): Promise<void> {
    try {
      const parent = dirname(path)
      const info = await stat(parent)
      if (info.isDirectory()) return
      const error = new Error(`ENOTDIR: parent path exists but is not a directory: ${parent}`) as NodeJS.ErrnoException
      error.code = 'ENOTDIR'
      error.path = parent
      throw error
    } catch (error) {
      if (isENOENT(error)) return
      throw error
    }
  }
  /* v8 ignore stop */
}

export default JsonlSessionPersistence
