/** Session-owned memory of pending plans already opened automatically. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

interface PlanReviewState {
  opened: Partial<Record<ToolCallId, true>>
}

type PlanReviewActions = {
  markOpened: (draft: PlanReviewState, callId: ToolCallId) => void
}

/**
 * Keep manual sidebar closure effective across review component remounts.
 * @returns a transient store handle whose instances belong to Session scopes.
 */
export function createPlanReviewStore(): EngineStoreHandle<PlanReviewState, PlanReviewActions> {
  return defineStore({
    init: (): PlanReviewState => ({ opened: {} }),
    actions: {
      markOpened: (draft, callId) => { draft.opened[callId] = true },
    },
  })
}
