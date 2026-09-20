/**
 * Runtime vocabulary derived from the persisted work-details mode. Renderers
 * and seats select single fields of this policy; none of them compares the
 * mode enum, so adding a mode changes only the table below.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { TranscriptViewMode } from '../chat-settings.ts'

/** Presentation capabilities that one work-details mode enables. */
export interface ChatPresentationPolicy {
  /** Mode this policy was derived from; for diagnostics, never for branching in renderers. */
  readonly mode: TranscriptViewMode
  /** Whether a normally completed Turn folds its process rows behind the whole-Turn control. */
  readonly foldCompletedTurns: boolean
  /**
   * How consecutive process rows between Assistant replies present: `collapsed`
   * groups them behind a step-group row that starts closed; `none` renders
   * every row directly under the whole-Turn control with no group rows.
   */
  readonly stepGrouping: 'collapsed' | 'none'
  /** Whether a settled reasoning row previews its first line beside the Think title. */
  readonly settledReasoningPreview: boolean
}

const POLICIES: Readonly<Record<TranscriptViewMode, ChatPresentationPolicy>> = {
  compact: {
    mode: 'compact',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    settledReasoningPreview: false,
  },
  detailed: {
    mode: 'detailed',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    settledReasoningPreview: true,
  },
  expanded: {
    mode: 'expanded',
    foldCompletedTurns: true,
    stepGrouping: 'none',
    settledReasoningPreview: true,
  },
}

/**
 * Resolve the policy constant for one mode. The same mode always yields the
 * same object, so selectors over a policy see stable identities.
 * @param mode - persisted work-details mode.
 * @returns the mode's presentation policy.
 */
export function presentationPolicyFor(mode: TranscriptViewMode): ChatPresentationPolicy {
  return POLICIES[mode]
}

/**
 * Derive a policy observable from the mode observable without a subscription of
 * its own: reads are a table lookup and change notifications are the mode's.
 * @param mode - live work-details mode.
 * @returns observable policy that changes exactly when the mode changes.
 */
export function derivePresentationPolicy(
  mode: ObservableSnapshot<TranscriptViewMode>,
): ObservableSnapshot<ChatPresentationPolicy> {
  return {
    getSnapshot: () => POLICIES[mode.getSnapshot()],
    subscribe: listener => mode.subscribe(listener),
  }
}
