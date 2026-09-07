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

/** One current direct-child discovery row materialized from parent facts. */
export type SubagentCatalogEntry =
  & {
    readonly id: SessionId
    readonly createdAt: number
  }
  & (
    | { readonly mode: 'one-shot'; readonly label?: string }
    | { readonly mode: 'continuable'; readonly label: string }
  )

/** A fixed-size persistent stack node; newest facts occupy the head chunk. */
interface CatalogChunk {
  readonly facts: readonly SubagentCatalogEvent[]
  readonly previous?: CatalogChunk | undefined
}

/**
 * Host fold state for one parent catalog. A cold reader detaches it from a
 * Session observation for direct-child materialization.
 */
export interface SubagentCatalogState {
  readonly inheritedEventCount: SessionLogOffset
  readonly head?: CatalogChunk | undefined
}

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
const chunkSchema: z.ZodType<CatalogChunk> = z.lazy(() => z.object({
  facts: z.array(eventDataSchema).min(1).max(64),
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
  if (head === undefined || head.facts.length === 64) {
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
 * @returns current direct-child rows in creation order.
 */
export function subagentCatalogEntries(state: SubagentCatalogState): SubagentCatalogEntry[] {
  const entries: SubagentCatalogEntry[] = []
  for (let chunk = state.head; chunk !== undefined; chunk = chunk.previous) {
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
  entries.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  return entries
}

/** Parent-owned direct-child catalog projection. */
export const subagentCatalogProjectionDefinition = {
  key: 'subagentCatalog',
  stateSchema,
  init: (_header: SessionHeader, inheritedEventCount: SessionLogOffset) => ({ inheritedEventCount }),
  apply: (state, event: SessionEvent) => {
    if (event.type !== 'subagent/catalog' || event.seq < state.inheritedEventCount) return state
    const parsed = eventDataSchema.safeParse(event.data)
    if (!parsed.success) return state
    return appendFact(state, parsed.data)
  },
  stateVersion: 1,
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
