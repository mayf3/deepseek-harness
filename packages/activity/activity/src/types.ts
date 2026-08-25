import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { ActivityId } from './brand.ts'

export type { ActivityId } from './brand.ts'

/**
 * Producer-defined activity kinds. Plugins extend this map by declaration
 * merging; the registry treats every value as an opaque id namespace.
 */
export interface ActivityKindMap {
  bash: 'bash'
}

/** A registered activity kind — also the id prefix (`bash`, `workflow`, …). */
export type ActivityKind = ActivityKindMap[keyof ActivityKindMap]

/** Lifecycle state of one observable activity. */
export type ActivityStatus = 'running' | 'completed' | 'failed' | 'killed'

/**
 * Output stream label. Producers without distinct streams omit it; consumers
 * treat an unrecognized label like an absent one.
 */
export type ActivityChannel = 'stdout' | 'stderr'

/**
 * Links one activity to the records other domains keep for the same work, so a
 * consumer can attach the output stream to an existing card or row without
 * guessing from labels.
 */
export interface ActivityCorrelation {
  /** Tool call that started the work, when a tool produced it. */
  callId?: CallId
  /** Background job carrying the model-facing control surface, when one exists. */
  jobId?: JobId
}

/**
 * Producer declaration passed to {@link ActivityRegistry.open}. The registry
 * owns identity, retention, and observer delivery; the producer keeps its
 * execution resources and reports through the returned {@link ActivityHandle}.
 */
export interface ActivityOpen {
  /** Producer kind — also the id prefix. */
  kind: ActivityKind
  /** One-line human-facing label (the command; the run description). */
  label: string
  /**
   * Owning live agent. Visibility is fenced by its session id, and agent
   * disposal ends and removes the record. The instance must be the one
   * currently registered under its agent id. Omitting the owner creates an
   * unowned activity, visible to any caller until service disposal.
   */
  owner?: Agent
  /** Optional links to the tool call and background job for the same work. */
  correlation?: ActivityCorrelation
}

/** Terminal outcome reported through {@link ActivityHandle.end}. */
export interface ActivityOutcome {
  /** How the work ended: finished (`completed`), broke (`failed`), or was cancelled (`killed`). */
  status: 'completed' | 'failed' | 'killed'
  /** Kind-specific detail rendered into status lines ('exit code: 3'). */
  detail?: string
}

/** Options for one {@link ActivityHandle.append}. */
export interface ActivityAppendOptions {
  /** Stream label for the chunk; omitted for producers without distinct streams. */
  channel?: ActivityChannel
  /**
   * Marks that producer-side bytes between the previous chunk and this one
   * were lost (a source window slid before the producer could copy it), so a
   * consumer can render the discontinuity instead of a silent splice.
   */
  gapBefore?: true
}

/**
 * Producer face of one open activity. All methods are synchronous. After
 * {@link end} — including a registry-forced end during owner or service
 * teardown — `append` and `updateDetail` log and drop instead of throwing, so
 * a producer's trailing flush cannot break its own teardown path.
 */
export interface ActivityHandle {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: ActivityId
  /**
   * Append one output chunk. Offsets advance by the chunk's UTF-8 byte
   * length; an empty chunk is dropped without waking observers.
   * @param text - the chunk text, exactly as produced.
   * @param options - stream label and gap marker.
   */
  append(text: string, options?: ActivityAppendOptions): void
  /**
   * Replace the snapshot's status detail (a progress line such as `3/10`).
   * @param detail - the new detail line.
   */
  updateDetail(detail: string): void
  /**
   * Record the terminal outcome and trim retention to the settled cap.
   * First-wins: a later call — the producer's own report after a teardown
   * force-end, or a duplicate — is dropped silently.
   * @param outcome - terminal status and optional detail.
   */
  end(outcome: ActivityOutcome): void
}

/**
 * A read-only projection of one activity, safe to hand to listeners and
 * consumers — a fresh object per call, never live registry state.
 */
export interface ActivitySnapshot {
  /** The registry-issued id (`<kind>-N`). */
  id: ActivityId
  /** The producer kind the process was opened with. */
  kind: ActivityKind
  /** The producer-supplied one-line label. */
  label: string
  /** Owner session id used for visibility and grouping; absent for unowned activities. */
  ownerSession?: SessionId
  /** Links to the tool call and background job for the same work, when supplied. */
  correlation?: ActivityCorrelation
  /** Current lifecycle state. */
  status: ActivityStatus
  /** Kind-specific status detail, when the producer supplied one. */
  detail?: string
  /** Epoch ms when the activity was opened. */
  startedAt: number
  /** Epoch ms when the activity ended; absent while `running`. */
  finishedAt?: number
  /** Total UTF-8 bytes ever appended — the offset the next chunk starts at. */
  outputTotal: number
  /**
   * Offset of the oldest retained byte. Greater than zero exactly when
   * retention dropped the head; a reader starting below it gets a lossy read.
   */
  outputEarliest: number
}

/** One retained output chunk returned by {@link ActivityRegistry.read}. */
export interface ActivityOutputChunk {
  /** Absolute offset of the chunk's first byte. */
  at: number
  /** Chunk text exactly as appended (possibly tail-trimmed by retention). */
  text: string
  /** Stream label, when the producer supplied one. */
  channel?: ActivityChannel
  /** Producer-reported loss immediately before this chunk. */
  gapBefore?: true
}

/** Result of one non-consuming {@link ActivityRegistry.read}. */
export interface ActivityRead {
  /** Retained chunks overlapping `[from, total)`, in offset order. */
  chunks: readonly ActivityOutputChunk[]
  /**
   * Offset to resume from — the process' current `outputTotal`. Always a
   * chunk boundary: appends land whole and trimming only advances chunk
   * starts, and consumers concatenate `chunks` under that assumption, so a
   * provider serving partial chunks would silently duplicate text.
   */
  next: number
  /** True when `from` fell below the oldest retained byte, so bytes are missing before `chunks`. */
  lossy: boolean
}

/**
 * Observer of visible-set changes: opening, detail updates, settlement, and
 * removal. Receives the owner whose set changed, or `undefined` when an
 * unowned process changed and every caller's set did. Consumers re-read
 * rather than accumulating deltas.
 */
export type ActivitiesChangedListener = (owner: Agent | undefined) => void

/**
 * Observer of stream advancement for one activity: new appended output, or the
 * settlement that ends the stream. Carries no payload — a consumer schedules a
 * {@link ActivityRegistry.read} from its own cursor.
 */
export type ActivityOutputListener = (id: ActivityId) => void
