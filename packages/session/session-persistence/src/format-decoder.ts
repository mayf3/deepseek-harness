/**
 * Static Session format decoding from backend-owned JSON records to the
 * current durable header and event types.
 * @module @deepseek-ai/dsh-session-persistence/format-decoder
 */

import {
  adoptSessionEvent,
  KNOWN_SESSION_EVENT_TYPES,
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  snapshotJsonValue,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  unversionedFormatCompatibility,
} from './format-v0-compat.ts'
import type { UnversionedFormatCompatibility } from './format-v0-compat.ts'
import { asStoredRecord, assertNoRetiredSessionEvent, readStoredEventEnvelope } from './format-json.ts'
import type { SessionLocation } from './index.ts'
import { SESSION_FORMAT_MIGRATIONS } from './format-migrations/index.ts'
import type { SessionPersistenceRevision } from './revision.ts'

/** One single-use adjacent-version migration instance. */
interface SessionFormatMigrationInstance {
  /**
   * Transform and validate the header fields understood by this migration.
   * The detached result must carry the constructor's `to` version and preserve
   * the source id and cwd.
   * @param meta - detached input header for the constructor's `from` version.
   * @returns detached header JSON carrying the constructor's `to` version.
   */
  header(meta: unknown): unknown
  /**
   * Transform exactly one event while retaining its sequence number. Instance
   * fields may accumulate facts from the header and earlier events.
   * @param event - detached input event in durable sequence order.
   * @returns exactly one detached event for the same sequence number.
   */
  event(event: unknown): unknown
  /**
   * Validate accumulated state after the complete input stream reaches EOF.
   * Header-only reads do not call this method; it cannot emit another event.
   */
  finish?(): void
}

/** Static identity and constructor for one adjacent-version migration. */
export interface SessionFormatMigration {
  /** Input Session format version. */
  readonly from: number
  /** Output Session format version; must equal `from + 1`. */
  readonly to: number
  /**
   * Create fresh state for one header decode and its optional complete event
   * stream. Instances are never shared across sessions or decode attempts.
   * @returns a single-use migration instance.
   */
  new(): SessionFormatMigrationInstance
}

/** Options for one physical event read. */
export interface StoredEventReadOptions {
  /** First physical event sequence to request. */
  readonly fromSeq?: number
}

/** Completion metadata produced after a physical event stream reaches EOF. */
export interface StoredEventReadCompletion<TornMarker> {
  /** Backend-owned token for a recoverable physical tail. */
  readonly tornMarker?: TornMarker
}

/** One revision-bound physical event stream. */
export interface StoredEventRead<TornMarker> {
  /** Parsed JSON records from the exact source revision. */
  readonly events: AsyncIterable<unknown>
  /** Resolves only after the stream reaches EOF at the same revision. */
  readonly completed: Promise<StoredEventReadCompletion<TornMarker>>
}

/** Repeatable access to one stored header and exact durable revision. */
export interface StoredSessionSource<TornMarker> {
  /** Parsed header JSON; format validation belongs to the decoder. */
  readonly meta: unknown
  /** Exact backend revision every event read must reproduce or reject. */
  readonly revision: SessionPersistenceRevision
  /** Raw artifact location used to enrich unsupported-format diagnostics. */
  readonly location?: SessionLocation
  /**
   * Open a new event read bound to {@link revision}. A concurrent replacement
   * rejects the read instead of returning events from another revision.
   * @param options - optional suffix request.
   * @returns one independently consumable physical event read.
   */
  readEvents(options?: StoredEventReadOptions): StoredEventRead<TornMarker>
}

/**
 * Build the standard lazy event stream and EOF metadata around one backend
 * read, shared by every first-party backend.
 * @param load - revision-checked batch loader owned by the backend.
 * @param include - whether one loaded event belongs in this physical read.
 * @param signal - optional cancellation checked between yielded events.
 * @returns an independently consumable event read.
 */
export function createStoredEventRead<TornMarker>(
  load: () => Promise<{ readonly events: readonly unknown[]; readonly tornMarker?: TornMarker }>,
  include: (event: unknown) => boolean,
  signal?: AbortSignal,
): StoredEventRead<TornMarker> {
  const completed = Promise.withResolvers<StoredEventReadCompletion<TornMarker>>()
  const events = (async function* (): AsyncIterable<unknown> {
    try {
      const batch = await load()
      for (const event of batch.events) {
        signal?.throwIfAborted()
        if (include(event)) yield event
      }
      completed.resolve(batch.tornMarker === undefined ? {} : { tornMarker: batch.tornMarker })
    } catch (error: unknown) {
      completed.reject(error)
      throw error
    }
  })()
  return { events, completed: completed.promise }
}

/** One decoded current-format read bound to an exact stored revision. */
export interface DecodedSession<TornMarker> {
  /** Validated current-format header. */
  readonly meta: SessionHeader
  /** Version observed before any format migration ran. */
  readonly sourceVersion: number
  /** Exact backend revision represented by this source. */
  readonly revision: SessionPersistenceRevision
  /** Validated current-format events at or past the requested sequence. */
  readonly events: AsyncIterable<SessionEvent>
  /** Completion metadata from the physical read supplying the events. */
  readonly completed: Promise<StoredEventReadCompletion<TornMarker>>
}

/**
 * The stored log is intact but this runtime cannot faithfully interpret its
 * format version or required event vocabulary.
 */
export class SessionFormatUnsupportedError extends Error {
  /**
   * @param message - stable refusal reason, including the raw location when available.
   * @param location - backend artifact location when one exists.
   */
  constructor(message: string, readonly location?: SessionLocation) {
    super(message)
    this.name = 'SessionFormatUnsupportedError'
  }
}

/**
 * Direction-aware refusal text for a stored format version this build cannot
 * decode.
 * @param id - stored session identity.
 * @param version - stored format version.
 * @returns stable refusal text without a raw-location suffix.
 */
export function sessionFormatVersionRefusal(id: string, version: number): string {
  return version > SESSION_FORMAT_VERSION
    ? `session "${id}" uses log format v${version}, but this harness reads only v${SESSION_FORMAT_VERSION}: the log was written by a newer harness — upgrade the harness to open it`
    : `session "${id}" uses log format v${version}, older than the supported v${SESSION_FORMAT_VERSION}, and this build ships no upgrade path for it`
}

function buildMigrationIndex(
  migrations: readonly SessionFormatMigration[],
): ReadonlyMap<number, SessionFormatMigration> {
  const byFrom = new Map<number, SessionFormatMigration>()
  for (const Migration of migrations) {
    if (!Number.isSafeInteger(Migration.from) || Migration.from < 0 || Migration.to !== Migration.from + 1) {
      throw new TypeError(`Session format migration must be an adjacent non-negative version, got v${Migration.from} -> v${Migration.to}`)
    }
    if (byFrom.has(Migration.from)) {
      throw new TypeError(`duplicate Session format migration from v${Migration.from}`)
    }
    if (Migration.to > SESSION_FORMAT_VERSION) {
      throw new TypeError(`Session format migration v${Migration.from} -> v${Migration.to} targets a version newer than this build's v${SESSION_FORMAT_VERSION}`)
    }
    byFrom.set(Migration.from, Migration)
  }
  // A missing migration is a per-session concern, decided by planMigrations() at decode
  // time: it refuses sessions at or below the gap, while later versions whose
  // path to the current version is complete still upgrade. Initialization
  // therefore checks only migration legality and duplicates here.
  return byFrom
}

const MIGRATION_BY_FROM = buildMigrationIndex(SESSION_FORMAT_MIGRATIONS)

type PlannedMigration = readonly [SessionFormatMigration, SessionFormatMigrationInstance]

interface DecodedHeader {
  readonly meta: SessionHeader
  readonly sourceVersion: number
  readonly migrations: readonly PlannedMigration[]
  readonly unversionedCompatibility?: UnversionedFormatCompatibility
}

interface StoredHeaderSource {
  readonly meta: unknown
  readonly location?: SessionLocation
}

function unsupported(
  source: StoredHeaderSource,
  reason: string,
): SessionFormatUnsupportedError {
  const location = source.location
  return new SessionFormatUnsupportedError(
    location === undefined ? reason : `${reason} (raw log: ${location.path})`,
    location,
  )
}

function readSourceHeader(
  source: StoredHeaderSource,
  expectedId: SessionId,
): { meta: Record<string, unknown>; version: number; id: SessionId } {
  const snapshot = snapshotJsonValue(source.meta)
  const meta = asStoredRecord(snapshot)
  if (meta === undefined) throw new Error('stored session header is not a lossless JSON record')
  if (!Number.isSafeInteger(meta['version'])) {
    throw new Error(`stored session header has invalid format version ${String(meta['version'])}`)
  }
  const version = meta['version'] as number
  if (version > SESSION_FORMAT_VERSION) {
    throw unsupported(source, sessionFormatVersionRefusal(String(meta['id']), version))
  }
  if (typeof meta['id'] !== 'string') throw new Error('stored session header has no string id')
  const id = SessionId(meta['id'])
  if (id !== expectedId) {
    throw new Error(`stored session identity mismatch: requested "${expectedId}", header contains "${id}"`)
  }
  return { meta, version, id }
}

function planMigrations(
  source: StoredHeaderSource,
  id: SessionId,
  fromVersion: number,
): readonly SessionFormatMigration[] {
  const migrations: SessionFormatMigration[] = []
  for (let version = fromVersion; version < SESSION_FORMAT_VERSION; version++) {
    const Migration = MIGRATION_BY_FROM.get(version)
    if (Migration === undefined) {
      throw unsupported(
        source,
        `session "${id}" uses log format v${fromVersion}, older than the supported v${SESSION_FORMAT_VERSION}, and this build has no upgrade path to it: missing v${version} -> v${version + 1}`,
      )
    }
    migrations.push(Migration)
  }
  return migrations
}

function decodeHeader(
  source: StoredHeaderSource,
  expectedId: SessionId,
): DecodedHeader {
  const stored = readSourceHeader(source, expectedId)
  const migrations: PlannedMigration[] = []
  let meta: unknown = stored.meta
  for (const Migration of planMigrations(source, stored.id, stored.version)) {
    let instance: SessionFormatMigrationInstance
    try {
      instance = new Migration()
      meta = snapshotJsonValue(instance.header(meta))
    } catch (error: unknown) {
      throw new Error(
        `session "${stored.id}" header migration v${Migration.from} -> v${Migration.to} failed`,
        { cause: error },
      )
    }
    const record = asStoredRecord(meta)
    const actual = record?.['version']
    if (actual !== Migration.to) {
      throw new Error(`Session format migration v${Migration.from} -> v${Migration.to} returned header version ${String(actual)}`)
    }
    if (record === undefined
      || record['id'] !== stored.id
      || record['cwd'] !== stored.meta['cwd']) {
      throw new Error(`Session format migration v${Migration.from} -> v${Migration.to} changed session storage identity`)
    }
    migrations.push([Migration, instance])
  }
  const current = Session.create(stored.id, undefined, meta as SessionHeader).header
  const compatibility = unversionedFormatCompatibility(stored.version)
  return {
    meta: current,
    sourceVersion: stored.version,
    migrations,
    ...(compatibility === undefined ? {} : { unversionedCompatibility: compatibility }),
  }
}

/**
 * Decode one stored header without opening its event log. Listing uses the
 * same static format path as full Session reads.
 * @param meta - parsed backend header JSON.
 * @param expectedId - identity selected by the backend or caller.
 * @param location - optional raw artifact location for refusal diagnostics.
 * @returns the validated current-format header.
 */
export function decodeStoredSessionHeader(
  meta: unknown,
  expectedId: SessionId,
  location?: SessionLocation,
): SessionHeader {
  return decodeHeader({ meta, ...location === undefined ? {} : { location } }, expectedId).meta
}

function assertCurrentEnvelope(value: unknown, id: SessionId): SessionEvent {
  const snapshot = snapshotJsonValue(value)
  return readStoredEventEnvelope(snapshot, id)
}

function assertCurrentEventSupported<TornMarker>(
  source: StoredSessionSource<TornMarker>,
  meta: SessionHeader,
  event: SessionEvent,
): void {
  assertNoRetiredSessionEvent(event, meta.id)
  if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) return
  throw unsupported(
    source,
    `session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`,
  )
}

async function* decodeCurrentEvents<TornMarker>(
  source: StoredSessionSource<TornMarker>,
  meta: SessionHeader,
  events: AsyncIterable<unknown>,
  expectedSeq: number,
): AsyncIterable<SessionEvent> {
  let nextSeq = expectedSeq
  for await (const raw of events) {
    const event = assertCurrentEnvelope(raw, meta.id)
    if (event.seq !== nextSeq) {
      throw new Error(`session "${meta.id}" event seq mismatch: expected ${nextSeq}, got ${event.seq}`)
    }
    const current = adoptSessionEvent(event)
    assertCurrentEventSupported(source, meta, current)
    nextSeq += 1
    yield current
  }
}

async function* transformEvents(
  events: AsyncIterable<unknown>,
  migrations: readonly PlannedMigration[],
  id: SessionId,
): AsyncIterable<unknown> {
  for await (let value of events) {
    for (const [Migration, instance] of migrations) {
      const sourceSeq = asStoredRecord(value)?.['seq']
      let output: unknown
      try {
        output = instance.event(value)
      } catch (error: unknown) {
        throw new Error(
          `session "${id}" event migration v${Migration.from} -> v${Migration.to} failed at seq ${String(sourceSeq)}`,
          { cause: error },
        )
      }
      const targetSeq = asStoredRecord(output)?.['seq']
      if (targetSeq !== sourceSeq) {
        throw new Error(`session "${id}" event migration v${Migration.from} -> v${Migration.to} changed event seq ${String(sourceSeq)} to ${String(targetSeq)}`)
      }
      value = output
    }
    yield value
  }
  for (const [Migration, instance] of migrations) {
    try {
      instance.finish?.()
    } catch (error: unknown) {
      throw new Error(
        `session "${id}" event migration v${Migration.from} -> v${Migration.to} failed at EOF`,
        { cause: error },
      )
    }
  }
}

async function* snapshotStoredEvents(
  events: AsyncIterable<unknown>,
  id: SessionId,
): AsyncIterable<unknown> {
  for await (const event of events) {
    const snapshot = snapshotJsonValue(event)
    if (snapshot === undefined) {
      throw new Error(`session "${id}" contains an event that is not losslessly JSON-serializable`)
    }
    yield snapshot
  }
}

function decodedRead<TornMarker>(
  source: StoredSessionSource<TornMarker>,
  header: DecodedHeader,
  requestedFromSeq: number,
): {
  readonly events: AsyncIterable<SessionEvent>
  readonly completed: Promise<StoredEventReadCompletion<TornMarker>>
} {
  const completion = Promise.withResolvers<StoredEventReadCompletion<TornMarker>>()
  const migrating = header.migrations.length > 0
  const compatibility = header.unversionedCompatibility
  let physical: StoredEventRead<TornMarker> | undefined

  const events = (async function* (): AsyncIterable<SessionEvent> {
    try {
      let physicalFromSeq = migrating ? 0 : requestedFromSeq
      physical = source.readEvents({ fromSeq: physicalFromSeq })
      void physical.completed.catch(() => undefined)
      let raw: AsyncIterable<unknown> = physical.events
      let physicalCompletion: StoredEventReadCompletion<TornMarker> | undefined

      if (!migrating && requestedFromSeq > 0 && compatibility !== undefined) {
        const suffix: unknown[] = []
        for await (const value of raw) suffix.push(value)
        physicalCompletion = await physical.completed
        if (suffix.some(value => compatibility.requiresPrefix(value))) {
          physicalFromSeq = 0
          physical = source.readEvents({ fromSeq: 0 })
          void physical.completed.catch(() => undefined)
          raw = physical.events
          physicalCompletion = undefined
        } else {
          raw = (async function* () {
            for (const value of suffix) yield await Promise.resolve(value)
          })()
        }
      }

      const storedEvents = snapshotStoredEvents(raw, header.meta.id)
      const canonicalEvents = compatibility === undefined
        ? storedEvents
        : compatibility.canonicalizeEvents(storedEvents, header.meta.id)
      const transformed = transformEvents(
        canonicalEvents,
        header.migrations,
        header.meta.id,
      )
      const current = decodeCurrentEvents(source, header.meta, transformed, physicalFromSeq)
      for await (const event of current) {
        if (event.seq >= requestedFromSeq) yield event
      }
      completion.resolve(physicalCompletion ?? await physical.completed)
    } catch (error: unknown) {
      completion.reject(error)
      throw error
    }
  })()

  return { events, completed: completion.promise }
}

/**
 * Decode one backend source through the static adjacent-version migrations and
 * the current header/event validators. Format selection is complete before any
 * consumer-specific recovery runs.
 * @param source - backend-owned header, revision, and event reader factory.
 * @param expectedId - session identity selected by the caller.
 * @param fromSeq - first current-format event sequence to return.
 * @returns one decoded current-format stream bound to the stored revision.
 */
export function decodeStoredSession<TornMarker>(
  source: StoredSessionSource<TornMarker>,
  expectedId: SessionId,
  fromSeq = 0,
): DecodedSession<TornMarker> {
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
    throw new TypeError(`stored event fromSeq must be a non-negative safe integer, got ${String(fromSeq)}`)
  }
  const header = decodeHeader(source, expectedId)
  const read = decodedRead(source, header, fromSeq)
  return {
    meta: header.meta,
    sourceVersion: header.sourceVersion,
    revision: source.revision,
    events: read.events,
    completed: read.completed,
  }
}
