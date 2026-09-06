/**
 * Pure fold for the heuristic context-composition projection: system prompt
 * from the `system/message` surface node, tool schemas from the newest request
 * envelope, conversation from the rest of the live surface. Prices with the
 * same shared estimator as the meter service, so the three figures match
 * `measure()`'s heuristic vocabulary exactly.
 */

import { z } from 'zod'
import { canonicalHeader, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { estimateSystemMessage, estimateToolsTokens } from './estimate.ts'
import { foldSurfaceProjection } from './surface-projection.ts'
import type { SurfaceTokensFold } from './surface-projection.ts'
// Import for the `contextBreakdown` SessionProjectionStateMap key merge.
import type {} from './projection.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextBreakdown: ContextBreakdownState
  }
}

/** Non-negative integer token count (the shared figure shape). */
const tokenCount = z.number().int().nonnegative()
const sessionSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)

/** The context-breakdown state schema and source of its inferred type. */
const contextBreakdownStateSchema = z.object({
  systemTokens: tokenCount,
  toolsTokens: tokenCount,
  messageTokens: tokenCount,
  claim: z.object({
    start: sessionSeq,
    end: sessionSeq,
    tokens: tokenCount,
  }).optional(),
}).strict()
type ContextBreakdownState = z.infer<typeof contextBreakdownStateSchema>

const breakdownSchema = z.object({
  systemTokens: tokenCount,
  toolsTokens: tokenCount,
  messageTokens: tokenCount,
}).strict()

/**
 * Token-meter's context-composition projection unit.
 *
 * The system figure is last-wins per `system/message` — the loop's surface
 * node 0, appended once and replaced in place whenever the rendered prompt
 * changes — and the tools figure is last-wins per `request/header`. The
 * message figure rides {@link foldSurfaceProjection} — the same O(1) fold the
 * occupancy projection uses — over every other surface node, so fully metered
 * logs equal the sum of `measure().nodes[].heuristicTokens` minus the system
 * node at every event boundary and compaction shrinks the figure by its
 * logged shadow price; the route-priced `measure().surfaceTokens`
 * deliberately diverges by the routed model's image repricing. A replacement
 * without a claim preserves the previous total. The state is a fixed handful
 * of numbers, so the persisted checkpoint stays O(1) over the session's life.
 */
export const contextBreakdownProjectionDefinition = {
  key: 'contextBreakdown',
  stateVersion: 3,
  stateSchema: contextBreakdownStateSchema,
  init: () => ({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 }),
  apply: (state, event) => {
    let systemTokens = state.systemTokens
    let toolsTokens = state.toolsTokens
    let fold: SurfaceTokensFold
    if (event.type === 'system/message') {
      // The system node has its own figure, so it never enters the message
      // fold; like every non-metering event it expires an armed claim.
      systemTokens = estimateSystemMessage(event.data.message)
      fold = { deltaTokens: 0, claim: undefined }
    } else {
      fold = foldSurfaceProjection(state.claim, event)
      if (event.type === 'request/header') {
        toolsTokens = estimateToolsTokens(canonicalHeader(event.data.header))
      }
    }
    if (systemTokens === state.systemTokens
      && toolsTokens === state.toolsTokens
      && fold.deltaTokens === 0
      && fold.claim === undefined
      && state.claim === undefined) return state
    return {
      systemTokens,
      toolsTokens,
      messageTokens: state.messageTokens + fold.deltaTokens,
      ...fold.claim === undefined ? {} : { claim: fold.claim },
    }
  },
  wire: {
    viewSchema: breakdownSchema,
    view: ({ systemTokens, toolsTokens, messageTokens }) => ({ systemTokens, toolsTokens, messageTokens }),
  },
} satisfies ProjectionDefinition<'contextBreakdown', ContextBreakdownState>
