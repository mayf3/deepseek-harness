/** Chat display preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by the Chat target. */
export const CHAT_SETTINGS_NAMESPACE = 'ui-chat'

/** Field carrying the work details presentation mode. */
export const TRANSCRIPT_VIEW_FIELD = 'transcriptView'

/** Transcript presentation modes accepted at settings boundaries. */
export const TRANSCRIPT_VIEW_MODES = ['compact', 'detailed', 'expanded'] as const

/** Work details presentation. */
export type TranscriptViewMode = typeof TRANSCRIPT_VIEW_MODES[number]

/** Default preserves the compact process disclosure introduced by Chat. */
export const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode = 'compact'

/** Performance and usage detail levels accepted by user settings. */
export const PERFORMANCE_USAGE_MODES = ['compact', 'detailed'] as const

/** Performance and usage presentation. */
export type PerformanceUsageMode = typeof PERFORMANCE_USAGE_MODES[number]

/** Preserve detailed accounting for users without an explicit preference. */
export const DEFAULT_PERFORMANCE_USAGE: PerformanceUsageMode = 'detailed'

/** Durable Chat section shared by the Host schema and browser scope. */
export interface ChatSettings {
  /** Work details preference; normal is accepted only for existing saved settings. */
  transcriptView: TranscriptViewMode | 'normal'
  /** Detail level for composer statistics and completed-Turn usage. */
  performanceUsage: PerformanceUsageMode
}

/** Durable Chat schema; also the wire envelope the browser scope validates against. */
export const ChatSettingsSchema: z<ChatSettings> = z.object({
  performanceUsage: z.union([...PERFORMANCE_USAGE_MODES]).default(DEFAULT_PERFORMANCE_USAGE),
  [TRANSCRIPT_VIEW_FIELD]: z.union([...TRANSCRIPT_VIEW_MODES, 'normal']).default(DEFAULT_TRANSCRIPT_VIEW_MODE),
})
