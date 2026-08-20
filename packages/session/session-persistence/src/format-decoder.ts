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
import { SESSION_FORMAT_STEPS } from './format-migrations/index.ts'
import { SessionPersistenceRevisionConflictError, type SessionPersistenceRevision } from './revision.ts'

/** Stable facts available to one format step invocation. */
export interface SessionFormatContext {
  /** Session identity read from the source header. */
  readonly sessionId: SessionId
}

/** One static adjacent-version transform in the durable format decoder. */
export interface SessionFormatStep {
  /** Input Session format version. */
  readonly from: number
  /** Output Session format version; must equal `from + 1`. */
  readonly to: number
  /**
   * Transform and validate the header fields understood by this step. The
   * detached result must carry {@link to} and preserve the source id and cwd.
   * @param meta - detached input header for {@link from}.
   * @param context - stable session identity.
   * @returns detached header JSON carrying {@link to}.
   */
  migrateHeader(meta: unknown, context: SessionFormatContext): unknown
  /**
   * Lazily transform and validate events understood by this step. The output
   * must be detached, losslessly JSON-serializable, and contiguous by seq.
   * @param events - detached input records in durable sequence order.
   * @param context - stable session identity.
   * @returns a lazy output stream in the next format.
   */
  migrateEvents(events: AsyncIterable<unknown>, context: SessionFormatContext): AsyncIterable<unknown>
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
  /** Version observed before any format step ran. */
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

function buildStepIndex(steps: readonly SessionFormatStep[]): ReadonlyMap<number, SessionFormatStep> {
  const byFrom = new Map<number, SessionFormatStep>()
  for (const step of steps) {
    if (!Number.isSafeInteger(step.from) || step.from < 0 || step.to !== step.from + 1) {
      throw new TypeError(`Session format step must be an adjacent non-negative version, got v${step.from} -> v${step.to}`)
    }
    if (byFrom.has(step.from)) {
      throw new TypeError(`duplicate Session format step from v${step.from}`)
    }
    if (step.to > SESSION_FORMAT_VERSION) {
      throw new TypeError(`Session format step v${step.from} -> v${step.to} targets a version newer than this build's v${SESSION_FORMAT_VERSION}`)
    }
    byFrom.set(step.from, step)
  }
  // A missing step is a per-session concern, decided by planSteps() at decode
  // time: it refuses sessions at or below the gap, while later versions whose
  // path to the current version is complete still upgrade. Initialization
  // therefore checks only step legality and duplicates here.
  return byFrom
}

const STEP_BY_FROM = buildStepIndex(SESSION_FORMAT_STEPS)

interface DecodedHeader {
  readonly meta: SessionHeader
  readonly sourceVersion: number
  readonly steps: readonly SessionFormatStep[]
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

function planSteps(
  source: StoredHeaderSource,
  id: SessionId,
  fromVersion: number,
): readonly SessionFormatStep[] {
  const steps: SessionFormatStep[] = []
  for (let version = fromVersion; version < SESSION_FORMAT_VERSION; version++) {
    const step = STEP_BY_FROM.get(version)
    if (step === undefined) {
      throw unsupported(
        source,
        `session "${id}" uses log format v${fromVersion}, older than the supported v${SESSION_FORMAT_VERSION}, and this build has no upgrade path to it: missing v${version} -> v${version + 1}`,
      )
    }
    steps.push(step)
  }
  return steps
}

function decodeHeader(
  source: StoredHeaderSource,
  expectedId: SessionId,
): DecodedHeader {
  const stored = readSourceHeader(source, expectedId)
  const steps = planSteps(source, stored.id, stored.version)
  let meta: unknown = stored.meta
  for (const step of steps) {
    const context: SessionFormatContext = { sessionId: stored.id }
    try {
      meta = snapshotJsonValue(step.migrateHeader(meta, context))
    } catch (error: unknown) {
      throw new Error(
        `session "${stored.id}" header migration v${step.from} -> v${step.to} failed`,
        { cause: error },
      )
    }
    const record = asStoredRecord(meta)
    const actual = record?.['version']
    if (actual !== step.to) {
      throw new Error(`Session format step v${step.from} -> v${step.to} returned header version ${String(actual)}`)
    }
    if (record === undefined
      || record['id'] !== stored.id
      || record['cwd'] !== stored.meta['cwd']) {
      throw new Error(`Session format step v${step.from} -> v${step.to} changed session storage identity`)
    }
  }
  const current = Session.create(stored.id, undefined, meta as SessionHeader).header
  const compatibility = unversionedFormatCompatibility(stored.version)
  return {
    meta: current,
    sourceVersion: stored.version,
    steps,
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

function transformEvents(
  events: AsyncIterable<unknown>,
  steps: readonly SessionFormatStep[],
  id: SessionId,
): AsyncIterable<unknown> {
  let transformed = events
  for (const step of steps) {
    const input = transformed
    const context: SessionFormatContext = { sessionId: id }
    transformed = (async function* (): AsyncIterable<unknown> {
      try {
        yield* step.migrateEvents(input, context)
      } catch (error: unknown) {
        if (error instanceof SessionPersistenceRevisionConflictError) throw error
        throw new Error(
          `session "${id}" event migration v${step.from} -> v${step.to} failed`,
          { cause: error },
        )
      }
    })()
  }
  return transformed
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
  const migrating = header.steps.length > 0
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
        header.steps,
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
 * Decode one backend source through the static adjacent-version
 * steps and the current header/event validators. Format selection is complete
 * before any consumer-specific recovery runs.
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
