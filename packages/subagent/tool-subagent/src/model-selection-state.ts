/** Durable per-session state for the user-controlled model-selection opt-in. */

import { z as zod } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records that this session's delegation tool exposes child provider,
     * model, and reasoning-effort selection. Appended before the first model
     * request; absence means the fixed-route definition. Log-only: it carries
     * no `surfaceOp` and never enters model history.
     */
    'subagent/model-selection-enabled': Record<string, never>
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Whether the session's delegation tool exposes child LLM route selection. */
    subagentModelSelectionEnabled: boolean
  }
}

/** Host-only projection of the durable model-selection decision. */
export const subagentModelSelectionProjectionDefinition = {
  key: 'subagentModelSelectionEnabled',
  stateVersion: 1,
  stateSchema: zod.boolean(),
  init: () => false,
  apply: (enabled, event) => enabled || event.type === 'subagent/model-selection-enabled',
} satisfies ProjectionDefinition<'subagentModelSelectionEnabled', boolean>
