/**
 * Parent-owned durable subagent catalog events and their chunked projection.
 *
 * @module @deepseek-ai/dsh-subagent/catalog
 */

import { z } from 'zod'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SubagentCatalogEntry } from './projection-types.ts'

/** Current payload version for `subagent/catalog` events. */
export const SUBAGENT_CATALOG_VERSION = 0

/** One complete parent-owned catalog fact. */
export type SubagentCatalogEvent =
  & {
    readonly version: 0
    readonly childId: SessionId
    readonly childCreatedAt: number
  } & (
    | { readonly mode: 'one-shot'; readonly label?: string }
    | { readonly mode: 'continuable'; readonly label: string }
  )

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A direct child's complete discovery fact.
     * @param data - versioned parent-owned catalog entry.
     */
    'subagent/catalog': SubagentCatalogEvent
  }
}

/** A fixed-size persistent stack node; newest facts occupy the head chunk. */
interface CatalogChunk {
  readonly facts: readonly SubagentCatalogEvent[]
  readonly previous?: CatalogChunk | undefined
}

/** Host fold state for one parent catalog. */
export interface SubagentCatalogState {
  readonly inheritedEventCount: SessionLogOffset
  readonly head?: CatalogChunk | undefined
}

const CATALOG_CHUNK_CAPACITY = 64

const sessionIdSchema = z.string() as unknown as z.ZodType<SessionId>
const oneShotCatalogSchema = z.object({
  version: z.literal(SUBAGENT_CATALOG_VERSION),
  childId: sessionIdSchema,
  childCreatedAt: z.number().int().nonnegative(),
  mode: z.literal('one-shot'),
  label: z.string().optional(),
}).strict()
const continuableCatalogSchema = z.object({
  version: z.literal(SUBAGENT_CATALOG_VERSION),
  childId: sessionIdSchema,
  childCreatedAt: z.number().int().nonnegative(),
  mode: z.literal('continuable'),
  label: z.string(),
}).strict()
const eventDataSchema = z.union([
  oneShotCatalogSchema,
  continuableCatalogSchema,
]) as unknown as z.ZodType<SubagentCatalogEvent>
const viewSchema = z.array(z.union([
  oneShotCatalogSchema.omit({ version: true, childId: true, childCreatedAt: true }).extend({
    id: sessionIdSchema,
    createdAt: oneShotCatalogSchema.shape.childCreatedAt,
  }),
  continuableCatalogSchema.omit({ version: true, childId: true, childCreatedAt: true }).extend({
    id: sessionIdSchema,
    createdAt: continuableCatalogSchema.shape.childCreatedAt,
  }),
])) as unknown as z.ZodType<SubagentCatalogEntry[]>
const chunkSchema: z.ZodType<CatalogChunk> = z.lazy(() => z.object({
  facts: z.array(eventDataSchema).min(1).max(CATALOG_CHUNK_CAPACITY),
  previous: chunkSchema.optional(),
}).strict())
const stateSchema: z.ZodType<SubagentCatalogState> = z.object({
  inheritedEventCount: z.number().int().nonnegative() as unknown as z.ZodType<SessionLogOffset>,
  head: chunkSchema.optional(),
}).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    subagentCatalog: SubagentCatalogState
  }
}

/** Append one fact to the persistent chunk stack in constant bounded work. */
function appendFact(state: SubagentCatalogState, fact: SubagentCatalogEvent): SubagentCatalogState {
  const head = state.head
  if (head === undefined || head.facts.length === CATALOG_CHUNK_CAPACITY) {
    return { ...state, head: { facts: [fact], ...head === undefined ? {} : { previous: head } } }
  }
  return {
    ...state,
    head: {
      facts: [...head.facts, fact],
      ...head.previous === undefined ? {} : { previous: head.previous },
    },
  }
}

/**
 * Materialize direct children from their parent's successful creation facts.
 * @param state - parent catalog fold state.
 * @returns current direct-child rows in parent catalog event order.
 */
function subagentCatalogEntries(state: SubagentCatalogState): SubagentCatalogEntry[] {
  const chunks: CatalogChunk[] = []
  for (let chunk = state.head; chunk !== undefined; chunk = chunk.previous) chunks.push(chunk)
  const entries: SubagentCatalogEntry[] = []
  for (const chunk of chunks.reverse()) {
    for (const data of chunk.facts) {
      entries.push(data.mode === 'one-shot'
        ? {
          id: data.childId,
          createdAt: data.childCreatedAt,
          mode: data.mode,
          ...data.label === undefined ? {} : { label: data.label },
        }
        : {
          id: data.childId,
          createdAt: data.childCreatedAt,
          mode: data.mode,
          label: data.label,
        })
    }
  }
  return entries
}

/** Parent-owned direct-child catalog projection; invalid own facts reject restoration. */
export const subagentCatalogProjectionDefinition = {
  key: 'subagentCatalog',
  stateSchema,
  init: (_header: SessionHeader, inheritedEventCount: SessionLogOffset) => ({ inheritedEventCount }),
  apply: (state, event: SessionEvent) => {
    if (event.type !== 'subagent/catalog' || event.seq < state.inheritedEventCount) return state
    return appendFact(state, eventDataSchema.parse(event.data))
  },
  stateVersion: 1,
  wire: { viewSchema, view: subagentCatalogEntries },
} satisfies ProjectionDefinition<'subagentCatalog', SubagentCatalogState>

/**
 * Append a complete direct-child discovery fact to its parent Session.
 * @param parent - durable direct parent receiving the discovery fact.
 * @param child - established child's immutable Session metadata.
 * @param descriptor - mode-discriminated creation label frozen with the child.
 */
export function establishCatalogChild(
  parent: Session,
  child: SessionHeader,
  descriptor:
    | { readonly mode: 'one-shot'; readonly label?: string }
    | { readonly mode: 'continuable'; readonly label: string },
): void {
  parent.append('subagent/catalog', descriptor.mode === 'one-shot'
    ? {
      version: SUBAGENT_CATALOG_VERSION,
      childId: child.id,
      childCreatedAt: child.createdAt,
      mode: descriptor.mode,
      ...descriptor.label === undefined ? {} : { label: descriptor.label },
    }
    : {
      version: SUBAGENT_CATALOG_VERSION,
      childId: child.id,
      childCreatedAt: child.createdAt,
      mode: descriptor.mode,
      label: descriptor.label,
    })
}
